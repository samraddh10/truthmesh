import type { GoldPair, Goldset } from './goldset.ts';
import {
  matchClaim,
  quoteLocates,
  type MatchOutcome,
  type ProducedClaim,
} from './match.ts';

export interface ProducedRelationship {
  readonly id: string;
  readonly claimAId: string;
  readonly claimBId: string;
  readonly label:
    | 'corroborates'
    | 'contradicts'
    | 'likely_contradiction'
    | 'reconciled_by_context'
    | 'insufficient_context'
    | 'unrelated';
  readonly method: string;
}

export interface ProducedCandidate {
  readonly claimAId: string;
  readonly claimBId: string;
}

export interface RunCost {
  readonly documents: number;
  readonly pagesTotal: number;
  readonly pagesProcessed: number;
  readonly chunksTotal: number;
  readonly chunksProcessed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly claimsExtracted: number;
  readonly claimsAccepted: number;
  readonly relationshipsCreated: number;
  readonly wallClockMs: number | null;
  readonly issuesByKind: ReadonlyMap<string, number>;
  readonly stages: ReadonlyMap<string, number>;
}

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
}

export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator };
}

export function asPercent(value: Rate): string {
  if (value.denominator === 0) return 'n/a';
  return `${((value.numerator / value.denominator) * 100).toFixed(1)}%`;
}

export interface CoverageResult {
  readonly matched: readonly MatchOutcome[];
  readonly missed: readonly MatchOutcome[];
  readonly recall: Rate;
  readonly contextAgreement: Rate;
  readonly byEvidenceKind: ReadonlyMap<string, Rate>;
}

export function measureCoverage(
  goldset: Goldset,
  produced: readonly ProducedClaim[],
  goldDocumentOf: (documentId: string) => string | undefined,
): CoverageResult {
  const outcomes = goldset.claims.map((claim) => matchClaim(claim, produced, goldDocumentOf));
  const matched = outcomes.filter((outcome) => outcome.produced !== null);
  const missed = outcomes.filter((outcome) => outcome.produced === null);

  const withContext = matched.filter(
    (outcome) => outcome.periodAgrees === true && outcome.scopeAgrees === true,
  );

  const byEvidenceKind = new Map<string, Rate>();
  for (const kind of ['narrative', 'table', 'chart', 'list']) {
    const ofKind = outcomes.filter((outcome) => outcome.gold.evidence_kind === kind);
    byEvidenceKind.set(
      kind,
      rate(ofKind.filter((outcome) => outcome.produced !== null).length, ofKind.length),
    );
  }

  return {
    matched,
    missed,
    recall: rate(matched.length, outcomes.length),
    contextAgreement: rate(withContext.length, matched.length),
    byEvidenceKind,
  };
}

export interface GroundingResult {
  readonly precision: Rate;
  readonly wrongValue: readonly string[];
  readonly wrongContext: readonly string[];
  readonly scope: string;
}

export function measureGrounding(
  goldset: Goldset,
  produced: readonly ProducedClaim[],
  goldDocumentOf: (documentId: string) => string | undefined,
): GroundingResult {
  const goldPages = new Set(
    goldset.claims.map((claim) => `${claim.document}#${claim.physical_page}`),
  );

  const inScope = produced.filter((claim) => {
    if (claim.status !== 'accepted') return false;
    const filename = goldDocumentOf(claim.documentId);
    if (filename === undefined) return false;
    return claim.pages.some((page) => goldPages.has(`${filename}#${page}`));
  });

  const matchedProducedIds = new Set(
    goldset.claims
      .map((claim) => matchClaim(claim, produced, goldDocumentOf))
      .filter((outcome) => outcome.produced !== null)
      .map((outcome) => outcome.produced!.id),
  );

  const wrongValue: string[] = [];
  const wrongContext: string[] = [];
  for (const claim of inScope) {
    if (matchedProducedIds.has(claim.id)) continue;
    wrongValue.push(claim.id);
  }

  for (const gold of goldset.claims) {
    const outcome = matchClaim(gold, produced, goldDocumentOf);
    if (outcome.produced === null) continue;
    if (outcome.produced.status !== 'accepted') continue;
    if (outcome.periodAgrees === false || outcome.scopeAgrees === false) {
      wrongContext.push(`${gold.id}/${outcome.produced.id}`);
    }
  }

  return {
    precision: rate(inScope.filter((claim) => matchedProducedIds.has(claim.id)).length, inScope.length),
    wrongValue,
    wrongContext,
    scope: 'accepted claims whose evidence lands on a page the gold set covers',
  };
}

export interface EvidenceResult {
  readonly referenceValidity: Rate;
  readonly recordedVerified: Rate;
  readonly semanticSupport: Rate;
  readonly visualOnly: Rate;
  readonly disagreements: readonly string[];
}

export function measureEvidence(produced: readonly ProducedClaim[]): EvidenceResult {
  const rows = produced.flatMap((claim) => claim.evidence);

  let locates = 0;
  let recordedVerified = 0;
  let supported = 0;
  let visualOnly = 0;
  const disagreements: string[] = [];

  for (const row of rows) {
    const found = quoteLocates(row.quote, row.blockContent);
    if (found) locates += 1;
    if (row.verification === 'verified_native_text') recordedVerified += 1;
    if (row.verification === 'visual_only') visualOnly += 1;
    if (row.entailment === 'supported') supported += 1;

    if (found !== (row.verification === 'verified_native_text')) {
      disagreements.push(row.id);
    }
  }

  return {
    referenceValidity: rate(locates, rows.length),
    recordedVerified: rate(recordedVerified, rows.length),
    semanticSupport: rate(supported, rows.length),
    visualOnly: rate(visualOnly, rows.length),
    disagreements,
  };
}

export interface CandidateRecallResult {
  readonly recall: Rate;
  readonly reachable: number;
  readonly unreachable: readonly string[];
  readonly missed: readonly string[];
}

export function measureCandidateRecall(
  goldset: Goldset,
  produced: readonly ProducedClaim[],
  candidates: readonly ProducedCandidate[],
  goldDocumentOf: (documentId: string) => string | undefined,
): CandidateRecallResult {
  const producedFor = new Map<string, ProducedClaim>();
  for (const gold of goldset.claims) {
    const outcome = matchClaim(gold, produced, goldDocumentOf);
    if (outcome.produced !== null) producedFor.set(gold.id, outcome.produced);
  }

  const surfaced = new Set(
    candidates.flatMap((candidate) => [
      `${candidate.claimAId}|${candidate.claimBId}`,
      `${candidate.claimBId}|${candidate.claimAId}`,
    ]),
  );

  const unreachable: string[] = [];
  const missed: string[] = [];
  let found = 0;
  let reachable = 0;

  for (const pair of goldset.pairs) {
    const a = producedFor.get(pair.claim_a);
    const b = producedFor.get(pair.claim_b);
    if (a === undefined || b === undefined) {
      unreachable.push(pair.id);
      continue;
    }
    reachable += 1;
    if (surfaced.has(`${a.id}|${b.id}`)) found += 1;
    else missed.push(pair.id);
  }

  return { recall: rate(found, reachable), reachable, unreachable, missed };
}

export type LabelName = GoldPair['expected_label'];

export const LABELS: readonly LabelName[] = [
  'corroborates',
  'contradicts',
  'likely_contradiction',
  'reconciled_by_context',
  'insufficient_context',
  'unrelated',
];

export interface RelationshipResult {
  readonly matrix: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly scored: number;
  readonly notProduced: readonly string[];
  readonly agreement: Rate;
  readonly falseContradictions: readonly string[];
  readonly missedContradictions: readonly string[];
  readonly abstentions: Rate;
}

export function measureRelationships(
  goldset: Goldset,
  produced: readonly ProducedClaim[],
  relationships: readonly ProducedRelationship[],
  goldDocumentOf: (documentId: string) => string | undefined,
): RelationshipResult {
  const producedFor = new Map<string, ProducedClaim>();
  for (const gold of goldset.claims) {
    const outcome = matchClaim(gold, produced, goldDocumentOf);
    if (outcome.produced !== null) producedFor.set(gold.id, outcome.produced);
  }

  const byPair = new Map<string, ProducedRelationship>();
  for (const relationship of relationships) {
    byPair.set(`${relationship.claimAId}|${relationship.claimBId}`, relationship);
    byPair.set(`${relationship.claimBId}|${relationship.claimAId}`, relationship);
  }

  const matrix = new Map<string, Map<string, number>>();
  for (const expected of LABELS) matrix.set(expected, new Map(LABELS.map((l) => [l, 0])));

  const notProduced: string[] = [];
  const falseContradictions: string[] = [];
  const missedContradictions: string[] = [];
  let agreed = 0;
  let scored = 0;
  let abstained = 0;

  const CONFLICT: readonly string[] = ['contradicts', 'likely_contradiction'];

  for (const pair of goldset.pairs) {
    const a = producedFor.get(pair.claim_a);
    const b = producedFor.get(pair.claim_b);
    if (a === undefined || b === undefined) {
      notProduced.push(pair.id);
      continue;
    }
    const relationship = byPair.get(`${a.id}|${b.id}`);
    if (relationship === undefined) {
      notProduced.push(pair.id);
      continue;
    }

    scored += 1;
    matrix.get(pair.expected_label)!.set(
      relationship.label,
      (matrix.get(pair.expected_label)!.get(relationship.label) ?? 0) + 1,
    );

    if (relationship.label === pair.expected_label) agreed += 1;
    if (relationship.label === 'insufficient_context') abstained += 1;

    if (CONFLICT.includes(relationship.label) && !CONFLICT.includes(pair.expected_label)) {
      falseContradictions.push(pair.id);
    }
    if (!CONFLICT.includes(relationship.label) && CONFLICT.includes(pair.expected_label)) {
      missedContradictions.push(pair.id);
    }
  }

  return {
    matrix,
    scored,
    notProduced,
    agreement: rate(agreed, scored),
    falseContradictions,
    missedContradictions,
    abstentions: rate(abstained, scored),
  };
}
