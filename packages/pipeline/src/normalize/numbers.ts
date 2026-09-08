import { Decimal } from 'decimal.js';

const SCALE_MULTIPLIERS = new Map<string, string>([
  ['hundred', '100'],
  ['thousand', '1000'],
  ['k', '1000'],
  ['lakh', '100000'],
  ['lakhs', '100000'],
  ['lac', '100000'],
  ['lacs', '100000'],
  ['million', '1000000'],
  ['mn', '1000000'],
  ['mln', '1000000'],
  ['m', '1000000'],
  ['crore', '10000000'],
  ['crores', '10000000'],
  ['cr', '10000000'],
  ['billion', '1000000000'],
  ['bn', '1000000000'],
  ['trillion', '1000000000000'],
  ['tn', '1000000000000'],
]);

const CURRENCY_TOKENS = new Map<string, string>([
  ['₹', 'INR'],
  ['rs', 'INR'],
  ['rs.', 'INR'],
  ['inr', 'INR'],
  ['rupees', 'INR'],
  ['$', 'USD'],
  ['us$', 'USD'],
  ['usd', 'USD'],
  ['€', 'EUR'],
  ['eur', 'EUR'],
  ['£', 'GBP'],
  ['gbp', 'GBP'],
]);

const PROPORTION_UNITS = new Map<string, string>([
  ['%', 'percent'],
  ['percent', 'percent'],
  ['pct', 'percent'],
  ['percentage', 'percent'],
  ['bps', 'basis_point'],
  ['basis points', 'basis_point'],
  ['pp', 'percentage_point'],
  ['ppt', 'percentage_point'],
  ['percentage point', 'percentage_point'],
  ['percentage points', 'percentage_point'],
]);

export type ValueKind = 'point' | 'range' | 'approximate';

export interface ParsedNumber {
  readonly value: Decimal;
  readonly kind: ValueKind;
  readonly rangeLow: Decimal | null;
  readonly rangeHigh: Decimal | null;
  readonly decimalPlaces: number;
  readonly scale: string | null;
  readonly currency: string | null;
  readonly unit: string | null;
  readonly negative: boolean;
}

export function parseNumeric(raw: string): ParsedNumber | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  const parenthesised = /^\(.*\)$/.test(text);
  const body = parenthesised ? text.slice(1, -1) : text;

  const approximate = /\b(about|approx\.?|approximately|around|circa|~)\b|^~/.test(body);

  const currency = findCurrency(body);
  const proportion = findProportion(body);
  const scale = proportion === null ? findScale(body) : null;

  const numbers = [...body.matchAll(/-?\d+(?:[.,]\d+)*(?:\.\d+)?/g)].map((match) => match[0]);
  if (numbers.length === 0) return null;

  const isRange =
    numbers.length >= 2 && /\d\s*(?:-|to|–|—)\s*\d/.test(body.replace(/,/g, ''));

  const first = toDecimal(numbers[0]!);
  if (first === null) return null;

  const second = isRange ? toDecimal(numbers[1]!) : null;

  const sign = parenthesised || /^-/.test(body.trim()) ? -1 : 1;
  const signed = first.times(sign);

  return {
    value: isRange && second !== null ? signed.plus(second.times(sign)).dividedBy(2) : signed,
    kind: isRange && second !== null ? 'range' : approximate ? 'approximate' : 'point',
    rangeLow: isRange && second !== null ? signed : null,
    rangeHigh: isRange && second !== null ? second.times(sign) : null,
    decimalPlaces: decimalPlacesOf(numbers[0]!),
    scale,
    currency,
    unit: proportion,
    negative: signed.isNegative(),
  };
}

function toDecimal(token: string): Decimal | null {
  const cleaned = token.replace(/,/g, '');
  try {
    const value = new Decimal(cleaned);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
}

function decimalPlacesOf(token: string): number {
  const fraction = /\.(\d+)$/.exec(token.replace(/,/g, ''));
  return fraction?.[1]?.length ?? 0;
}

function findCurrency(text: string): string | null {
  for (const [token, code] of CURRENCY_TOKENS) {
    if (/^[a-z.$]+$/.test(token)) {
      if (new RegExp(`(^|\\s)${escape(token)}(\\s|\\d|$)`).test(text)) return code;
    } else if (text.includes(token)) {
      return code;
    }
  }
  return null;
}

function findProportion(text: string): string | null {
  const tokens = [...PROPORTION_UNITS.keys()].sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const pattern = /^[a-z ]+$/.test(token)
      ? new RegExp(`(^|[\\s\\d])${escape(token)}(\\s|$)`)
      : new RegExp(escape(token));
    if (pattern.test(text)) return PROPORTION_UNITS.get(token)!;
  }
  return null;
}

function findScale(text: string): string | null {
  const tokens = [...SCALE_MULTIPLIERS.keys()].sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    if (new RegExp(`(^|[\\s\\d])${escape(token)}\\b`).test(text)) return token;
  }
  return null;
}

function escape(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NormalizationStep {
  readonly step: string;
  readonly from: string;
  readonly to: string;
  readonly factor?: string;
}

export interface NormalizedValue {
  readonly value: string;
  readonly unit: string;
  readonly roundingHalfWidth: string;
  readonly steps: readonly NormalizationStep[];
}

export interface NormalizeInput {
  readonly numericValue: string;
  readonly scale?: string | null;
  readonly unit?: string | null;
  readonly currency?: string | null;
}

export function normalizeValue(input: NormalizeInput): NormalizedValue | null {
  let value: Decimal;
  try {
    value = new Decimal(input.numericValue);
  } catch {
    return null;
  }
  if (!value.isFinite()) return null;

  const steps: NormalizationStep[] = [];
  const decimals = decimalPlacesOf(input.numericValue);
  const proportion = input.unit === null || input.unit === undefined
    ? null
    : (PROPORTION_UNITS.get(input.unit.trim().toLowerCase()) ?? null);

  if (proportion !== null) {
    if (proportion === 'basis_point') {
      const converted = value.dividedBy(100);
      steps.push({ step: 'basis_points_to_percent', from: value.toString(), to: converted.toString(), factor: '0.01' });
      return {
        value: converted.toString(),
        unit: 'percent',
        roundingHalfWidth: halfWidth(decimals).dividedBy(100).toString(),
        steps,
      };
    }

    return {
      value: value.toString(),
      unit: proportion,
      roundingHalfWidth: halfWidth(decimals).toString(),
      steps,
    };
  }

  const scaleKey = input.scale?.trim().toLowerCase() ?? null;
  const multiplier = scaleKey === null ? null : (SCALE_MULTIPLIERS.get(scaleKey) ?? null);

  let scaled = value;
  if (multiplier !== null) {
    scaled = value.times(new Decimal(multiplier));
    steps.push({
      step: 'apply_scale',
      from: `${value.toString()} ${scaleKey}`,
      to: scaled.toString(),
      factor: multiplier,
    });
  } else if (scaleKey !== null && scaleKey !== '') {
    return {
      value: value.toString(),
      unit: `${input.currency ?? input.unit ?? 'count'}/${scaleKey}`,
      roundingHalfWidth: halfWidth(decimals).toString(),
      steps: [{ step: 'unrecognised_scale', from: scaleKey, to: 'left unconverted' }],
    };
  }

  const unit =
    input.currency !== null && input.currency !== undefined && input.currency !== ''
      ? input.currency
      : input.unit !== null && input.unit !== undefined && input.unit !== ''
        ? input.unit
        : 'count';

  return {
    value: scaled.toString(),
    unit,
    roundingHalfWidth: halfWidth(decimals)
      .times(multiplier === null ? 1 : new Decimal(multiplier))
      .toString(),
    steps,
  };
}

function halfWidth(decimalPlaces: number): Decimal {
  return new Decimal(10).pow(-decimalPlaces).dividedBy(2);
}

export type ValueAgreement = 'agree' | 'disagree' | 'incomparable';

export interface ValueComparison {
  readonly agreement: ValueAgreement;
  readonly reason: string;
  readonly difference: string | null;
  readonly relativeDifference: string | null;
  readonly intervalA: readonly [string, string] | null;
  readonly intervalB: readonly [string, string] | null;
}

export function compareValues(a: NormalizedValue, b: NormalizedValue): ValueComparison {
  if (a.unit !== b.unit) {
    return {
      agreement: 'incomparable',
      reason:
        isCurrency(a.unit) && isCurrency(b.unit)
          ? `${a.unit} and ${b.unit} need an explicit exchange-rate basis, which the documents do not supply`
          : `${a.unit} and ${b.unit} are different quantities`,
      difference: null,
      relativeDifference: null,
      intervalA: null,
      intervalB: null,
    };
  }

  const valueA = new Decimal(a.value);
  const valueB = new Decimal(b.value);
  const lowA = valueA.minus(a.roundingHalfWidth);
  const highA = valueA.plus(a.roundingHalfWidth);
  const lowB = valueB.minus(b.roundingHalfWidth);
  const highB = valueB.plus(b.roundingHalfWidth);

  const overlap = lowA.lessThanOrEqualTo(highB) && lowB.lessThanOrEqualTo(highA);

  const difference = valueA.minus(valueB).abs();
  const larger = Decimal.max(valueA.abs(), valueB.abs());

  return {
    agreement: overlap ? 'agree' : 'disagree',
    reason: overlap
      ? 'the intervals implied by each source rounding overlap'
      : `the figures differ by ${difference.toString()} ${a.unit}, more than either rounding allows`,
    difference: difference.toString(),
    relativeDifference: larger.isZero() ? null : difference.dividedBy(larger).toString(),
    intervalA: [lowA.toString(), highA.toString()],
    intervalB: [lowB.toString(), highB.toString()],
  };
}

function isCurrency(unit: string): boolean {
  return [...CURRENCY_TOKENS.values()].includes(unit);
}

export function scaleRatio(a: NormalizedValue, b: NormalizedValue): string | null {
  const valueA = new Decimal(a.value);
  const valueB = new Decimal(b.value);
  if (valueA.isZero() || valueB.isZero()) return null;

  const ratio = valueA.dividedBy(valueB).abs();
  const log = Decimal.log10(ratio);

  return log.isInteger() && !log.isZero() ? ratio.toString() : null;
}

export function significantDigits(value: string): number {
  const digits = value.replace(/[^0-9]/g, '').replace(/^0+/, '');
  return digits.length;
}
