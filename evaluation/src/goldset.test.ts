import { describe, expect, it } from 'vitest';

import { goldDocumentResolver, loadGoldset, pairedClaimIds } from './goldset.ts';

const goldset = await loadGoldset('evaluation/goldset.json');

describe('the gold set', () => {
  it('holds the set the evaluation README describes', () => {
    expect(goldset.claims).toHaveLength(50);
    expect(goldset.pairs).toHaveLength(25);
    expect(goldset.documents).toHaveLength(3);
  });

  it('reads as UTF-8, so currency symbols survive', () => {
    const withRupee = goldset.claims.filter((claim) => claim.quote.includes('₹'));
    expect(withRupee.length).toBeGreaterThan(0);
    for (const claim of goldset.claims) {
      expect(claim.quote).not.toContain('â‚¹');
    }
  });

  it('keeps every decimal a string, never a JSON number', () => {
    for (const claim of goldset.claims) {
      if (claim.numeric_value === null) continue;
      expect(typeof claim.numeric_value).toBe('string');
      expect(claim.numeric_value).toMatch(/^-?\d+(\.\d+)?$/);
    }
  });

  it('records losses as negative, whatever the source printed', () => {
    const negatives = goldset.claims.filter(
      (claim) => claim.numeric_value !== null && claim.numeric_value.startsWith('-'),
    );
    expect(negatives.length).toBeGreaterThan(0);
  });

  it('has the label distribution the README states', () => {
    const counts = new Map<string, number>();
    for (const pair of goldset.pairs) {
      counts.set(pair.expected_label, (counts.get(pair.expected_label) ?? 0) + 1);
    }
    expect(counts.get('corroborates')).toBe(14);
    expect(counts.get('reconciled_by_context')).toBe(5);
    expect(counts.get('likely_contradiction')).toBe(3);
    expect(counts.get('unrelated')).toBe(2);
    expect(counts.get('insufficient_context')).toBe(1);
    expect(counts.get('contradicts') ?? 0).toBe(0);
  });

  it('leaves eight claims outside any pair, as the README accounts for', () => {
    const paired = pairedClaimIds(goldset);
    expect(goldset.claims.length - paired.size).toBe(8);
  });

  it('resolves each gold document from the filename it was uploaded under', () => {
    const filenames = new Map(
      goldset.documents.map((document, index) => [
        `doc-${index}`,
        document.file.split('/').pop()!,
      ]),
    );
    const resolve = goldDocumentResolver(goldset, (id) => filenames.get(id));

    for (const [id, filename] of filenames) {
      expect(resolve(id), `${filename} should resolve`).toBeDefined();
    }
    expect(resolve('doc-0')).toBe(goldset.documents[0]!.id);
    expect(resolve('unknown')).toBeUndefined();
  });
});

describe('rejecting a broken set', () => {
  it('refuses a pair naming a claim that does not exist', async () => {
    await expect(loadGoldset('evaluation/fixtures/dangling-pair.json')).rejects.toThrow(
      /unknown claim/,
    );
  });

  it('refuses a claim citing a page past the end of its document', async () => {
    await expect(loadGoldset('evaluation/fixtures/page-out-of-range.json')).rejects.toThrow(
      /past the end/,
    );
  });
});
