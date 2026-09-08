import type { AssertionStatus, PeriodType, Qualifier } from '../extraction/contract.ts';

export type FiscalConvention = 'april-march' | 'january-december';

export interface ResolvedPeriod {
  readonly periodType: PeriodType;
  readonly label: string | null;
  readonly start: Date | null;
  readonly end: Date | null;
  readonly note: string | null;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

export function detectFiscalConvention(text: string): FiscalConvention | null {
  const lower = text.toLowerCase();

  if (/year\s+end(?:ed|ing)?[^.]{0,20}march\s*31/.test(lower)) return 'april-march';
  if (/year\s+end(?:ed|ing)?[^.]{0,20}december\s*31/.test(lower)) return 'january-december';
  if (/april\s*1[^.]{0,30}march\s*31/.test(lower)) return 'april-march';

  return null;
}

interface ParsedLabel {
  readonly kind: PeriodType;
  readonly year: number | null;
  readonly quarter: number | null;
  readonly half: number | null;
  readonly month: number | null;
  readonly day: number | null;
}

export function parsePeriodLabel(label: string): ParsedLabel | null {
  const text = label.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  const twoToFour = (value: string): number =>
    value.length === 2 ? 2000 + Number(value) : Number(value);

  const quarter = /\bq([1-4])\b/.exec(text);
  const half = /\bh([12])\b/.exec(text);
  const fiscal = /\b(?:fy|fiscal(?: year)?)\s*'?(\d{4}|\d{2})\b/.exec(text);
  const span = /\b(\d{4})\s*[-–/]\s*(\d{2,4})\b/.exec(text);

  const monthName = MONTHS.findIndex((month) => text.includes(month));
  const dayMatch = /\b(\d{1,2})\b/.exec(text.replace(/\bq[1-4]\b|\bh[12]\b/g, ''));
  const calendar = /\b(?:cy)?\s*(\d{4})\b/.exec(text);

  const fiscalYear =
    fiscal !== null
      ? twoToFour(fiscal[1]!)
      : span !== null
        ? twoToFour(span[2]!)
        : null;

  if (quarter !== null) {
    return {
      kind: 'quarter',
      year: fiscalYear ?? (calendar !== null ? Number(calendar[1]) : null),
      quarter: Number(quarter[1]),
      half: null,
      month: null,
      day: null,
    };
  }

  if (half !== null) {
    return {
      kind: 'half_year',
      year: fiscalYear ?? (calendar !== null ? Number(calendar[1]) : null),
      quarter: null,
      half: Number(half[1]),
      month: null,
      day: null,
    };
  }

  if (monthName !== -1 && /\d{1,2}/.test(text) && calendar !== null) {
    return {
      kind: 'as_of_date',
      year: Number(calendar[1]),
      quarter: null,
      half: null,
      month: monthName + 1,
      day: dayMatch !== null ? Number(dayMatch[1]) : null,
    };
  }

  if (fiscalYear !== null) {
    return { kind: 'fiscal_year', year: fiscalYear, quarter: null, half: null, month: null, day: null };
  }

  if (calendar !== null) {
    return {
      kind: 'calendar_year',
      year: Number(calendar[1]),
      quarter: null,
      half: null,
      month: null,
      day: null,
    };
  }

  return null;
}

const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

export function resolvePeriod(
  label: string | null,
  declaredType: PeriodType | null,
  convention: FiscalConvention | null,
): ResolvedPeriod {
  if (label === null || label.trim() === '') {
    return {
      periodType: declaredType ?? 'unknown',
      label: null,
      start: null,
      end: null,
      note: 'the source states no period',
    };
  }

  const parsed = parsePeriodLabel(label);
  if (parsed === null || parsed.year === null) {
    return {
      periodType: declaredType ?? 'unknown',
      label,
      start: null,
      end: null,
      note: 'the period label could not be resolved to a span',
    };
  }

  if (parsed.kind === 'as_of_date') {
    return {
      periodType: 'as_of_date',
      label,
      start: utc(parsed.year, parsed.month ?? 1, parsed.day ?? 1),
      end: utc(parsed.year, parsed.month ?? 1, parsed.day ?? 1),
      note: null,
    };
  }

  if (parsed.kind === 'calendar_year') {
    return {
      periodType: 'calendar_year',
      label,
      start: utc(parsed.year, 1, 1),
      end: utc(parsed.year, 12, 31),
      note: null,
    };
  }

  if (convention === null) {
    return {
      periodType: parsed.kind,
      label,
      start: null,
      end: null,
      note: 'the document does not state where its fiscal year begins, so no dates were resolved',
    };
  }

  const startMonth = convention === 'april-march' ? 4 : 1;
  const yearOfStart = convention === 'april-march' ? parsed.year - 1 : parsed.year;

  if (parsed.kind === 'fiscal_year') {
    return {
      periodType: 'fiscal_year',
      label,
      start: utc(yearOfStart, startMonth, 1),
      end: endOfMonth(yearOfStart + (convention === 'april-march' ? 1 : 0), startMonth === 1 ? 12 : 3),
      note: null,
    };
  }

  if (parsed.kind === 'quarter' && parsed.quarter !== null) {
    const offset = (parsed.quarter - 1) * 3;
    const month = ((startMonth - 1 + offset) % 12) + 1;
    const year = yearOfStart + Math.floor((startMonth - 1 + offset) / 12);
    return {
      periodType: 'quarter',
      label,
      start: utc(year, month, 1),
      end: endOfMonth(year + (month + 2 > 12 ? 1 : 0), ((month + 1) % 12) + 1),
      note: null,
    };
  }

  if (parsed.kind === 'half_year' && parsed.half !== null) {
    const offset = (parsed.half - 1) * 6;
    const month = ((startMonth - 1 + offset) % 12) + 1;
    const year = yearOfStart + Math.floor((startMonth - 1 + offset) / 12);
    return {
      periodType: 'half_year',
      label,
      start: utc(year, month, 1),
      end: endOfMonth(year + (month + 5 > 12 ? 1 : 0), ((month + 4) % 12) + 1),
      note: null,
    };
  }

  return { periodType: parsed.kind, label, start: null, end: null, note: 'unsupported period shape' };
}

function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

export function normalizeScope(scope: string | null): string | null {
  if (scope === null) return null;
  const text = scope.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  if (/\bconsolidated\b/.test(text)) return 'consolidated';
  if (/\bstandalone\b|\bseparate\b|\bunconsolidated\b/.test(text)) return 'standalone';

  return text;
}

export interface ClaimContext {
  readonly periodLabel: string | null;
  readonly periodType: PeriodType | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly scope: string | null;
  readonly assertionStatus: AssertionStatus | null;
  readonly qualifiers: readonly Qualifier[];
  readonly unit: string | null;
  readonly currency: string | null;
}

export interface ContextDifference {
  readonly dimension:
    | 'period'
    | 'period_type'
    | 'scope'
    | 'assertion_status'
    | 'unit'
    | 'currency'
    | 'qualifier';
  readonly a: string | null;
  readonly b: string | null;
  readonly couldExplainGap: boolean;
}

export function compareContext(
  a: ClaimContext,
  b: ClaimContext,
): ContextDifference[] {
  const differences: ContextDifference[] = [];

  if (!samePeriod(a, b)) {
    differences.push({
      dimension: 'period',
      a: a.periodLabel,
      b: b.periodLabel,
      couldExplainGap: true,
    });
  }

  if (a.periodType !== b.periodType && a.periodType !== null && b.periodType !== null) {
    differences.push({
      dimension: 'period_type',
      a: a.periodType,
      b: b.periodType,
      couldExplainGap: true,
    });
  }

  const bothStated = <T>(x: T | null, y: T | null): boolean => x !== null && y !== null;

  const scopeA = normalizeScope(a.scope);
  const scopeB = normalizeScope(b.scope);
  if (bothStated(scopeA, scopeB) && scopeA !== scopeB) {
    differences.push({ dimension: 'scope', a: scopeA, b: scopeB, couldExplainGap: true });
  }

  if (bothStated(a.assertionStatus, b.assertionStatus) && a.assertionStatus !== b.assertionStatus) {
    differences.push({
      dimension: 'assertion_status',
      a: a.assertionStatus,
      b: b.assertionStatus,
      couldExplainGap: true,
    });
  }

  const unitA = normalizeToken(a.unit);
  const unitB = normalizeToken(b.unit);
  if (bothStated(unitA, unitB) && unitA !== unitB) {
    differences.push({ dimension: 'unit', a: a.unit, b: b.unit, couldExplainGap: true });
  }

  const currencyA = normalizeToken(a.currency);
  const currencyB = normalizeToken(b.currency);
  if (bothStated(currencyA, currencyB) && currencyA !== currencyB) {
    differences.push({
      dimension: 'currency',
      a: a.currency,
      b: b.currency,
      couldExplainGap: false,
    });
  }

  for (const difference of compareQualifiers(a.qualifiers, b.qualifiers)) {
    differences.push(difference);
  }

  return differences;
}

function normalizeToken(value: string | null): string | null {
  if (value === null) return null;
  const text = value.trim().toLowerCase();
  return text === '' ? null : text;
}

function samePeriod(a: ClaimContext, b: ClaimContext): boolean {
  const labelA = normalizeToken(a.periodLabel)?.replace(/\s|'/g, '') ?? null;
  const labelB = normalizeToken(b.periodLabel)?.replace(/\s|'/g, '') ?? null;

  if (labelA !== null && labelB !== null) {
    if (labelA === labelB) return true;

    const parsedA = parsePeriodLabel(labelA);
    const parsedB = parsePeriodLabel(labelB);
    if (parsedA !== null && parsedB !== null) {
      if (
        parsedA.kind === parsedB.kind &&
        parsedA.year === parsedB.year &&
        parsedA.quarter === parsedB.quarter &&
        parsedA.half === parsedB.half
      ) {
        return true;
      }
    }
  }

  if (a.periodStart !== null && b.periodStart !== null && a.periodEnd !== null && b.periodEnd !== null) {
    return (
      a.periodStart.getTime() === b.periodStart.getTime() &&
      a.periodEnd.getTime() === b.periodEnd.getTime()
    );
  }

  return labelA === labelB;
}

function compareQualifiers(
  a: readonly Qualifier[],
  b: readonly Qualifier[],
): ContextDifference[] {
  const byName = (list: readonly Qualifier[]) =>
    new Map(list.map((entry) => [entry.name.trim().toLowerCase(), entry.value.trim()]));

  const left = byName(a);
  const right = byName(b);
  const differences: ContextDifference[] = [];

  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const valueA = left.get(name) ?? null;
    const valueB = right.get(name) ?? null;
    if (valueA === valueB) continue;

    differences.push({
      dimension: 'qualifier',
      a: valueA === null ? null : `${name}: ${valueA}`,
      b: valueB === null ? null : `${name}: ${valueB}`,
      couldExplainGap: true,
    });
  }

  return differences;
}
