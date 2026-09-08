import { describe, expect, it } from 'vitest';

import { deterministicLabel, runDeterministicChecks, type ComparableClaim } from './checks.ts';
import { promiseOf } from './stage.ts';

const claim = (overrides: Partial<ComparableClaim> = {}): ComparableClaim => ({
  id: 'claim-a',
  documentId: 'doc-1',
  entityId: 'entity-1',
  subject: 'Delhivery Limited',
  predicate: 'revenue_from_services',
  originalStatement: 'Revenue from services was 8,142 Cr in FY24.',
  rawValue: '8,142 Cr',
  numericValue: '8142',
  currency: 'INR',
  scale: 'crore',
  unit: null,
  periodLabel: 'FY2024',
  periodType: 'fiscal_year',
  periodStart: null,
  periodEnd: null,
  scope: 'consolidated',
  assertionStatus: 'reported',
  qualifiers: [],
  status: 'accepted',
  sourceBlockIds: ['block-1'],
  ...overrides,
});

const report = (overrides: Partial<ComparableClaim> = {}): ComparableClaim =>
  claim({
    id: 'claim-b',
    documentId: 'doc-2',
    rawValue: '81,415',
    numericValue: '81415',
    scale: 'million',
    sourceBlockIds: ['block-2'],
    ...overrides,
  });

describe('runDeterministicChecks', () => {
  it('finds the FY24 revenue pair comparable and agreeing', () => {
    const checks = runDeterministicChecks(claim(), report());

    expect(checks.entityMatch).toBe('same');
    expect(checks.predicate.relation).toBe('same');
    expect(checks.contextDifferences).toEqual([]);
    expect(checks.value?.agreement).toBe('agree');
    expect(checks.worthComparing).toBe(true);
  });

  it('reports a period difference without ruling the pair out', () => {
    const checks = runDeterministicChecks(claim(), report({ periodLabel: 'FY2023' }));

    expect(checks.contextDifferences[0]?.dimension).toBe('period');
    expect(checks.worthComparing).toBe(true);
  });

  it('rules out a pair whose measures must never be equated', () => {
    const checks = runDeterministicChecks(
      claim({ predicate: 'revenue_from_operations' }),
      report({ predicate: 'total_income' }),
    );

    expect(checks.predicate.relation).toBe('explicitly_distinct');
    expect(checks.worthComparing).toBe(false);
  });

  it('rules out a pair about two different entities', () => {
    const checks = runDeterministicChecks(claim(), report({ entityId: 'entity-2' }));
    expect(checks.entityMatch).toBe('different');
    expect(checks.worthComparing).toBe(false);
  });

  it('says identity is by name only when a subject was left unresolved', () => {
    const checks = runDeterministicChecks(claim(), report({ entityId: null }));
    expect(checks.entityMatch).toBe('unresolved');
    expect(checks.notes.some((note) => note.includes('by name only'))).toBe(true);
  });

  it('flags a pair whose claims rest on the same passage', () => {
    const checks = runDeterministicChecks(claim(), report({ sourceBlockIds: ['block-1'] }));

    expect(checks.sharedSourceBlocks).toEqual(['block-1']);
    expect(checks.notes.some((note) => note.includes('one passage read twice'))).toBe(true);
  });

  it('names a clean power-of-ten gap for what it usually is', () => {
    const checks = runDeterministicChecks(claim(), report({ numericValue: '8142', scale: 'million' }));

    expect(checks.scaleRatio).toBe('10');
    expect(checks.notes.some((note) => note.includes('scale word'))).toBe(true);
  });

  it('makes no numerical comparison when one claim has no figure', () => {
    const checks = runDeterministicChecks(claim(), report({ numericValue: null, rawValue: null }));

    expect(checks.value).toBeNull();
    expect(checks.notes.some((note) => note.includes('no figure'))).toBe(true);
  });

  it('marks a pair provisional when either claim is held for review', () => {
    const checks = runDeterministicChecks(claim(), report({ status: 'needs_review' }));
    expect(checks.bothAccepted).toBe(false);
  });
});

describe('deterministicLabel', () => {
  it('never reaches a contradiction, whatever the arithmetic says', () => {
    const checks = runDeterministicChecks(
      claim({ predicate: 'ebitda', numericValue: '-1229', scale: 'million', periodLabel: 'FY2021' }),
      report({ predicate: 'ebitda', numericValue: '-1003.79', scale: 'million', periodLabel: 'FY2021' }),
    );

    const decided = deterministicLabel(checks);
    expect(checks.value?.agreement).toBe('disagree');
    expect(decided.label).toBe('insufficient_context');
  });

  it('corroborates two independent accepted claims that agree in the same context', () => {
    const decided = deterministicLabel(runDeterministicChecks(claim(), report()));

    expect(decided.label).toBe('corroborates');
    expect(decided.rationale).toContain('rounding');
  });

  it('refuses to corroborate when neither claim states a period', () => {
    const checks = runDeterministicChecks(
      claim({ periodLabel: null, periodType: null }),
      report({ periodLabel: null, periodType: null }),
    );

    expect(checks.contextDifferences).toEqual([]);
    expect(checks.contextConfirmed).toBe(false);
    expect(deterministicLabel(checks).label).toBe('insufficient_context');
  });

  it('refuses to corroborate when identity rests on the subject line alone', () => {
    const checks = runDeterministicChecks(claim({ entityId: null }), report({ entityId: null }));

    expect(checks.entityMatch).toBe('unresolved');
    expect(deterministicLabel(checks).label).toBe('insufficient_context');
  });

  it('refuses to corroborate two claims resting on one passage', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(claim(), report({ sourceBlockIds: ['block-1'] })),
    );
    expect(decided.label).toBe('insufficient_context');
  });

  it('refuses to corroborate within one document', () => {
    const decided = deterministicLabel(runDeterministicChecks(claim(), report({ documentId: 'doc-1' })));
    expect(decided.label).toBe('insufficient_context');
  });

  it('refuses to corroborate when a claim is held for review', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(claim(), report({ status: 'needs_review' })),
    );
    expect(decided.label).toBe('insufficient_context');
  });

  it('abstains when the contexts differ, rather than reconciling them itself', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(claim(), report({ periodLabel: 'FY2023', numericValue: '72236' })),
    );

    expect(decided.label).toBe('insufficient_context');
    expect(decided.uncertaintyReasons.some((reason) => reason.includes('period'))).toBe(true);
  });

  it('calls a pair unrelated when the names have nothing in common', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(claim({ predicate: 'chief_financial_officer' }), report()),
    );
    expect(decided.label).toBe('unrelated');
  });

  it('calls a pair unrelated when a rule exists to keep the measures apart', () => {
    const decided = deterministicLabel(
      runDeterministicChecks(
        claim({ predicate: 'revenue_from_operations' }),
        report({ predicate: 'total_income' }),
      ),
    );

    expect(decided.label).toBe('unrelated');
    expect(decided.rationale).toContain('not expected to agree');
  });
});

describe('placeholder subjects across documents', () => {
  const dated = (documentId: string, value: string): ComparableClaim => ({
    ...claim(),
    id: `c-${documentId}`,
    documentId,
    entityId: null,
    subject: 'document',
    predicate: 'date',
    rawValue: value,
    numericValue: null,
  });

  it('refuses to compare two documents that both call their subject "document"', () => {
    const checks = runDeterministicChecks(dated('doc-1', 'May 14, 2022'), dated('doc-2', 'May 17, 2024'));

    expect(checks.worthComparing).toBe(false);
    expect(checks.notes.join(' ')).toContain('name the document itself');
    expect(['unrelated', 'insufficient_context']).toContain(deterministicLabel(checks).label);
  });

  it('still compares two placeholder claims inside one document', () => {
    const checks = runDeterministicChecks(dated('doc-1', 'May 14, 2022'), dated('doc-1', 'May 17, 2024'));
    expect(checks.notes.join(' ')).not.toContain('name the document itself');
  });

  it('leaves real subjects comparable across documents', () => {
    const a = { ...dated('doc-1', '8,142 Cr'), subject: 'Delhivery Limited', predicate: 'revenue' };
    const b = { ...dated('doc-2', '8,142 Cr'), subject: 'Delhivery Limited', predicate: 'revenue' };
    expect(runDeterministicChecks(a, b).worthComparing).toBe(true);
  });
});

describe('ordering pairs by promise', () => {
  const other = (overrides: Partial<ComparableClaim> = {}): ComparableClaim =>
    claim({ id: 'claim-b', documentId: 'doc-2', ...overrides });

  const promiseFor = (a: ComparableClaim, b: ComparableClaim): number =>
    promiseOf(runDeterministicChecks(a, b));

  it('ranks a pair that could be a corroboration above one that could not', () => {
    const promising = promiseFor(claim(), other());
    const vague = promiseFor(
      claim({ numericValue: null, rawValue: null }),
      other({ numericValue: null, rawValue: null }),
    );

    expect(promising).toBeGreaterThan(vague);
  });

  it('ranks a cross-document pair above the same comparison inside one document', () => {
    const across = promiseFor(claim(), other());
    const within = promiseFor(claim(), other({ documentId: 'doc-1' }));
    expect(across).toBeGreaterThan(within);
  });

  it('ranks two accepted claims above a pair resting on one held for review', () => {
    const confident = promiseFor(claim(), other());
    const provisional = promiseFor(claim(), other({ status: 'needs_review' }));
    expect(confident).toBeGreaterThan(provisional);
  });

  it('demotes a pair whose claims read the same passage twice', () => {
    const independent = promiseFor(
      claim({ sourceBlockIds: ['block-1'] }),
      other({ sourceBlockIds: ['block-2'] }),
    );
    const shared = promiseFor(
      claim({ sourceBlockIds: ['block-1'] }),
      other({ sourceBlockIds: ['block-1'] }),
    );
    expect(independent).toBeGreaterThan(shared);
  });

  it('sorts a pair the gate refuses below every pair that would be asked', () => {
    const refused = promiseFor(claim(), other({ entityId: 'entity-2' }));
    const weakest = promiseFor(
      claim({ numericValue: null, rawValue: null, status: 'needs_review' }),
      other({ numericValue: null, rawValue: null, status: 'needs_review', documentId: 'doc-1' }),
    );
    expect(refused).toBeLessThan(weakest);
  });
});

describe('unstated context', () => {
  const stated = claim({ scope: 'consolidated', assertionStatus: 'reported' });

  it('corroborates when the other document simply does not state the scope', () => {
    const silent = claim({
      id: 'claim-b',
      documentId: 'doc-2',
      scope: null,
      sourceBlockIds: ['block-2'],
    });

    const checks = runDeterministicChecks(stated, silent);
    expect(checks.contextDifferences.map((d) => d.dimension)).not.toContain('scope');
    expect(deterministicLabel(checks).label).toBe('corroborates');
  });

  it('still records a difference when both documents state and disagree', () => {
    const standalone = claim({
      id: 'claim-b',
      documentId: 'doc-2',
      scope: 'standalone',
      sourceBlockIds: ['block-2'],
    });

    const checks = runDeterministicChecks(stated, standalone);
    expect(checks.contextDifferences.map((d) => d.dimension)).toContain('scope');
    expect(deterministicLabel(checks).label).not.toBe('corroborates');
  });

  it('does not invent a currency conflict from one document staying silent', () => {
    const noCurrency = claim({
      id: 'claim-b',
      documentId: 'doc-2',
      currency: null,
      sourceBlockIds: ['block-2'],
    });

    const checks = runDeterministicChecks(stated, noCurrency);
    expect(checks.contextDifferences.map((d) => d.dimension)).not.toContain('currency');
  });
});
