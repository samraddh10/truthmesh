import type { AssertionStatus, PeriodType, Qualifier } from '../extraction/contract.ts';
import { isGenericSubject } from '../normalize/entities.ts';
import {
  compareContext,
  normalizeScope,
  type ClaimContext,
  type ContextDifference,
} from '../normalize/context.ts';
import {
  compareValues,
  normalizeValue,
  scaleRatio,
  type NormalizedValue,
  type ValueComparison,
} from '../normalize/numbers.ts';
import { predicateRelation, type PredicateComparison } from '../normalize/predicates.ts';

export const CHECKS_VERSION = 'checks@3';

export interface ComparableClaim {
  readonly id: string;
  readonly documentId: string;
  readonly entityId: string | null;
  readonly subject: string;
  readonly predicate: string;
  readonly originalStatement: string;
  readonly rawValue: string | null;
  readonly numericValue: string | null;
  readonly currency: string | null;
  readonly scale: string | null;
  readonly unit: string | null;
  readonly periodLabel: string | null;
  readonly periodType: PeriodType | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly scope: string | null;
  readonly assertionStatus: AssertionStatus | null;
  readonly qualifiers: readonly Qualifier[];
  readonly status: 'accepted' | 'needs_review' | 'rejected';
  readonly sourceBlockIds: readonly string[];
}

export type EntityMatch = 'same' | 'different' | 'unresolved';

export interface DeterministicChecks {
  readonly version: string;
  readonly sameDocument: boolean;
  readonly sharedSourceBlocks: readonly string[];
  readonly entityMatch: EntityMatch;
  readonly predicate: PredicateComparison;
  readonly contextDifferences: readonly ContextDifference[];
  readonly contextConfirmed: boolean;
  readonly value: ValueComparison | null;
  readonly scaleRatio: string | null;
  readonly bothAccepted: boolean;
  readonly worthComparing: boolean;
  readonly notes: readonly string[];
}

function contextOf(claim: ComparableClaim): ClaimContext {
  return {
    periodLabel: claim.periodLabel,
    periodType: claim.periodType,
    periodStart: claim.periodStart,
    periodEnd: claim.periodEnd,
    scope: claim.scope,
    assertionStatus: claim.assertionStatus,
    qualifiers: claim.qualifiers,
    unit: claim.unit,
    currency: claim.currency,
  };
}

function normalizedOf(claim: ComparableClaim): NormalizedValue | null {
  if (claim.numericValue === null) return null;
  return normalizeValue({
    numericValue: claim.numericValue,
    scale: claim.scale,
    unit: claim.unit,
    currency: claim.currency,
  });
}

export function runDeterministicChecks(
  a: ComparableClaim,
  b: ComparableClaim,
): DeterministicChecks {
  const notes: string[] = [];

  const entityMatch: EntityMatch =
    a.entityId !== null && b.entityId !== null
      ? a.entityId === b.entityId
        ? 'same'
        : 'different'
      : 'unresolved';

  if (entityMatch === 'unresolved') {
    notes.push('at least one subject was not resolved to an entity, so identity is by name only');
  }

  const predicate = predicateRelation(a.predicate, b.predicate);
  const contextDifferences = compareContext(contextOf(a), contextOf(b));

  const periodStated = (claim: ComparableClaim): boolean =>
    (claim.periodLabel !== null && claim.periodLabel.trim() !== '') ||
    (claim.periodStart !== null && claim.periodEnd !== null);

  const contextConfirmed =
    contextDifferences.length === 0 && periodStated(a) && periodStated(b);

  if (contextDifferences.length === 0 && !contextConfirmed) {
    notes.push(
      'at least one claim states no reporting period, so the two contexts are neither known to differ nor known to match',
    );
  }

  const normalizedA = normalizedOf(a);
  const normalizedB = normalizedOf(b);
  const value =
    normalizedA !== null && normalizedB !== null ? compareValues(normalizedA, normalizedB) : null;

  if (value === null) {
    notes.push('at least one claim states no figure, so no numerical comparison was made');
  }

  const ratio =
    normalizedA !== null && normalizedB !== null ? scaleRatio(normalizedA, normalizedB) : null;

  if (ratio !== null && value?.agreement === 'disagree') {
    notes.push(
      `the figures differ by a factor of exactly ${ratio}, which usually means a scale word was read differently on one side`,
    );
  }

  const sharedSourceBlocks = a.sourceBlockIds.filter((id) => b.sourceBlockIds.includes(id));
  if (sharedSourceBlocks.length > 0) {
    notes.push(
      'both claims rest on the same source block, so agreement between them is one passage read twice rather than two sources',
    );
  }

  const sameDocument = a.documentId === b.documentId;
  if (sameDocument) {
    notes.push('both claims come from the same document');
  }

  const scopeA = normalizeScope(a.scope);
  const scopeB = normalizeScope(b.scope);
  if (scopeA !== scopeB && scopeA !== null && scopeB !== null) {
    notes.push(`the reporting scope differs: ${scopeA} against ${scopeB}`);
  }

  const genericAcrossDocuments =
    !sameDocument && isGenericSubject(a.subject) && isGenericSubject(b.subject);
  if (genericAcrossDocuments) {
    notes.push(
      'both subjects name the document itself rather than an entity, so the two are not comparable across files',
    );
  }

  const bothAccepted = a.status === 'accepted' && b.status === 'accepted';
  if (!bothAccepted) {
    notes.push(
      'at least one claim is held for review, so any conclusion drawn from this pair is provisional',
    );
  }

  return {
    version: CHECKS_VERSION,
    sameDocument,
    sharedSourceBlocks,
    entityMatch,
    predicate,
    contextDifferences,
    contextConfirmed,
    value,
    scaleRatio: ratio,
    bothAccepted,
    worthComparing:
      entityMatch !== 'different' &&
      predicate.relation !== 'unrelated' &&
      predicate.relation !== 'explicitly_distinct' &&
      !genericAcrossDocuments,
    notes,
  };
}

export function isPlainCorroboration(checks: DeterministicChecks): boolean {
  return (
    checks.entityMatch === 'same' &&
    checks.predicate.relation === 'same' &&
    checks.contextConfirmed &&
    checks.value?.agreement === 'agree' &&
    checks.bothAccepted &&
    !checks.sameDocument &&
    checks.sharedSourceBlocks.length === 0
  );
}

export function deterministicLabel(checks: DeterministicChecks): {
  readonly label:
    | 'corroborates'
    | 'reconciled_by_context'
    | 'insufficient_context'
    | 'unrelated';
  readonly rationale: string;
  readonly uncertaintyReasons: readonly string[];
} {
  if (checks.entityMatch === 'different') {
    return {
      label: 'unrelated',
      rationale: 'the two claims are about different entities',
      uncertaintyReasons: [],
    };
  }

  if (checks.predicate.relation === 'unrelated') {
    return {
      label: 'unrelated',
      rationale: checks.predicate.reason,
      uncertaintyReasons: [],
    };
  }

  if (checks.predicate.relation === 'explicitly_distinct') {
    return {
      label: 'unrelated',
      rationale: `${checks.predicate.reason}, so their values are not expected to agree`,
      uncertaintyReasons: [],
    };
  }

  if (isPlainCorroboration(checks)) {
    return {
      label: 'corroborates',
      rationale: `two documents state the same measure for the same stated period and ${checks.value?.reason ?? 'their figures agree'}`,
      uncertaintyReasons: [],
    };
  }

  return {
    label: 'insufficient_context',
    rationale:
      'the deterministic checks could not settle this pair and no classifier was available to read the evidence',
    uncertaintyReasons: [
      'classification was not run for this pair',
      ...checks.notes,
      ...checks.contextDifferences.map(
        (difference) => `${difference.dimension} differs: ${difference.a} against ${difference.b}`,
      ),
    ],
  };
}
