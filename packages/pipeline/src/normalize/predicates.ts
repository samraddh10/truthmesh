const MODIFIERS = new Set([
  'adjusted',
  'normalised',
  'normalized',
  'underlying',
  'pro',
  'forma',
  'proforma',
  'restated',
  'reported',
  'organic',
  'like',
  'total',
  'net',
  'gross',
  'excluding',
  'including',
  'ex',
  'before',
  'after',
  'per',
  'average',
  'median',
  'estimated',
  'projected',
  'annualised',
  'annualized',
]);

const KNOWN_DISTINCT: readonly (readonly [string, string])[] = [
  ['revenue_from_operations', 'total_income'],
  ['revenue_from_services', 'total_income'],
  ['revenue', 'total_income'],
  ['revenue_from_operations', 'other_income'],
  ['profit_after_tax', 'profit_before_tax'],
];

export function normalizePredicate(raw: string): string {
  const tokens = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token !== '')
    .filter((token) => !['the', 'a', 'an', 'of', 'for', 'in', 'on', 'to'].includes(token))
    .map(singularize);

  return tokens.join('_');
}

function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') || token.endsWith('xes')) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

const NORMALIZED_DISTINCT: readonly (readonly [string, string])[] = KNOWN_DISTINCT.map(
  ([one, other]) => [normalizePredicate(one), normalizePredicate(other)] as const,
);

export type PredicateRelation =
  | 'same'
  | 'explicitly_distinct'
  | 'modifier_variant'
  | 'related_form'
  | 'unrelated';

export interface PredicateComparison {
  readonly relation: PredicateRelation;
  readonly reason: string;
  readonly comparable: boolean;
}

export function predicateRelation(a: string, b: string): PredicateComparison {
  const left = normalizePredicate(a);
  const right = normalizePredicate(b);

  if (left === right) {
    return { relation: 'same', reason: 'the same predicate', comparable: true };
  }

  for (const [one, other] of NORMALIZED_DISTINCT) {
    if ((left === one && right === other) || (left === other && right === one)) {
      return {
        relation: 'explicitly_distinct',
        reason: `${left} and ${right} are different measures and must not be equated`,
        comparable: false,
      };
    }
  }

  const leftTokens = left.split('_');
  const rightTokens = right.split('_');
  const leftCore = leftTokens.filter((token) => !MODIFIERS.has(token));
  const rightCore = rightTokens.filter((token) => !MODIFIERS.has(token));

  if (leftCore.join('_') === rightCore.join('_') && leftCore.length > 0) {
    const extra = [...leftTokens, ...rightTokens].filter((token) => MODIFIERS.has(token));
    return {
      relation: 'modifier_variant',
      reason: `one is the other qualified by ${[...new Set(extra)].join(', ')}`,
      comparable: false,
    };
  }

  const shared = leftCore.filter((token) => rightCore.includes(token));
  if (shared.length > 0) {
    return {
      relation: 'related_form',
      reason: `both concern ${shared.join(', ')} but are not the same measure`,
      comparable: false,
    };
  }

  return { relation: 'unrelated', reason: 'the predicates have nothing in common', comparable: false };
}

export function predicateHead(predicate: string): string {
  const tokens = normalizePredicate(predicate).split('_').filter((token) => !MODIFIERS.has(token));
  return tokens[tokens.length - 1] ?? normalizePredicate(predicate);
}
