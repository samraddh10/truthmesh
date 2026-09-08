import { predicateRelation } from '@superjoin/pipeline';
import { Decimal } from 'decimal.js';

import type { GoldClaim } from './goldset.ts';

export interface ProducedClaim {
  readonly id: string;
  readonly documentId: string;
  readonly filename: string;
  readonly subject: string;
  readonly predicate: string;
  readonly numericValue: string | null;
  readonly scale: string | null;
  readonly currency: string | null;
  readonly unit: string | null;
  readonly periodLabel: string | null;
  readonly periodType: string | null;
  readonly scope: string | null;
  readonly status: 'accepted' | 'needs_review' | 'rejected';
  readonly pages: readonly number[];
  readonly evidence: readonly ProducedEvidence[];
}

export interface ProducedEvidence {
  readonly id: string;
  readonly quote: string;
  readonly blockDocumentId: string;
  readonly blockContent: string;
  readonly physicalPage: number;
  readonly verification:
    | 'verified_native_text'
    | 'visual_only'
    | 'quote_not_found'
    | 'block_not_found'
    | 'unchecked';
  readonly entailment: 'supported' | 'unsupported' | 'unclear' | 'unchecked';
}

const SCALE_MULTIPLIER: Record<string, string> = {
  crore: '1e7',
  lakh: '1e5',
  million: '1e6',
  billion: '1e9',
  thousand: '1e3',
};

export function baseUnits(
  numericValue: string | null,
  scale: string | null,
): Decimal | null {
  if (numericValue === null) return null;

  let value: Decimal;
  try {
    value = new Decimal(numericValue);
  } catch {
    return null;
  }

  if (scale === null || scale === '') return value;

  const key = scale.trim().toLowerCase();
  const multiplier = SCALE_MULTIPLIER[key];
  if (multiplier === undefined) return null;

  return value.times(new Decimal(multiplier));
}

export function predicatesAgree(a: string, b: string): boolean {
  return predicateRelation(a, b).relation === 'same';
}

export type ValueVerdict = 'equal' | 'different' | 'incomparable' | 'both_absent';

export function compareFigures(gold: GoldClaim, produced: ProducedClaim): ValueVerdict {
  const goldValue = baseUnits(gold.numeric_value, gold.scale);
  const producedValue = baseUnits(produced.numericValue, produced.scale);

  if (gold.numeric_value === null && produced.numericValue === null) return 'both_absent';
  if (gold.numeric_value === null || produced.numericValue === null) return 'different';
  if (goldValue === null || producedValue === null) return 'incomparable';

  return goldValue.equals(producedValue) ? 'equal' : 'different';
}

export function foldPeriodLabel(label: string | null): string | null {
  if (label === null) return null;
  const trimmed = label.trim().toUpperCase().replace(/\s+/g, '');
  return trimmed.replace(/FY(\d{2})\b/g, (_, digits: string) => `FY20${digits}`);
}

export interface MatchOutcome {
  readonly gold: GoldClaim;
  readonly produced: ProducedClaim | null;
  readonly valueVerdict: ValueVerdict | null;
  readonly periodAgrees: boolean | null;
  readonly scopeAgrees: boolean | null;
}

export function subjectsAgree(a: string, b: string): boolean {
  const fold = (text: string): string =>
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[.,]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return fold(a) === fold(b);
}

function scopeAgrees(gold: GoldClaim, produced: ProducedClaim): boolean {
  if (gold.scope === null) return produced.scope === null || produced.scope === '';
  return (produced.scope ?? '').trim().toLowerCase() === gold.scope.trim().toLowerCase();
}

export function matchClaim(
  gold: GoldClaim,
  produced: readonly ProducedClaim[],
  goldDocumentOf: (documentId: string) => string | undefined,
): MatchOutcome {
  const candidates = produced.filter((claim) => {
    if (goldDocumentOf(claim.documentId) !== gold.document) return false;
    if (!claim.pages.includes(gold.physical_page)) return false;
    if (!predicatesAgree(gold.predicate, claim.predicate)) return false;

    const verdict = compareFigures(gold, claim);
    if (verdict === 'equal') return true;
    if (verdict === 'both_absent') return subjectsAgree(gold.subject, claim.subject);
    return false;
  });

  if (candidates.length === 0) {
    return { gold, produced: null, valueVerdict: null, periodAgrees: null, scopeAgrees: null };
  }

  const ranked = [...candidates].sort((a, b) => {
    const score = (claim: ProducedClaim): number =>
      (foldPeriodLabel(claim.periodLabel) === foldPeriodLabel(gold.period_label) ? 2 : 0) +
      (scopeAgrees(gold, claim) ? 1 : 0);
    return score(b) - score(a);
  });

  const best = ranked[0]!;
  return {
    gold,
    produced: best,
    valueVerdict: compareFigures(gold, best),
    periodAgrees: foldPeriodLabel(best.periodLabel) === foldPeriodLabel(gold.period_label),
    scopeAgrees: scopeAgrees(gold, best),
  };
}

export function quoteLocates(quote: string, blockContent: string): boolean {
  const fold = (text: string): string =>
    text
      .normalize('NFKC')
      .replace(/[‐-―−]/g, '-')
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  const needle = fold(quote);
  return needle !== '' && fold(blockContent).includes(needle);
}
