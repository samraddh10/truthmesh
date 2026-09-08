import { describe, expect, it } from 'vitest';

import { LocalEmbeddingProvider, describeClaim } from './index.ts';

describe('describeClaim', () => {
  it('leaves the value out of the embedded text', () => {
    const text = describeClaim({
      subject: 'Delhivery Limited',
      predicate: 'revenue_from_services',
      scope: 'consolidated',
      periodLabel: 'FY2024',
    });

    expect(text).toContain('Delhivery Limited');
    expect(text).toContain('revenue from services');
    expect(text).not.toContain('8142');
  });

  it('keeps the period and scope, which describe the claim without dominating it', () => {
    const text = describeClaim({
      subject: 'Delhivery Limited',
      predicate: 'ebitda',
      scope: 'standalone',
      periodLabel: 'FY2021',
    });

    expect(text).toContain('standalone');
    expect(text).toContain('FY2021');
  });

  it('includes qualifiers, so a differently qualified claim reads differently', () => {
    const text = describeClaim({
      subject: 'Delhivery Limited',
      predicate: 'workforce',
      qualifiers: [{ name: 'basis', value: 'including partner agents' }],
    });

    expect(text).toContain('including partner agents');
  });

  it('omits context the claim does not have rather than writing "null"', () => {
    const text = describeClaim({ subject: 'X', predicate: 'y', scope: null, periodLabel: null });
    expect(text).toBe('X, y');
  });
});

const provider = new LocalEmbeddingProvider({
  model: process.env['EMBEDDING_MODEL'] ?? 'Xenova/all-mpnet-base-v2',
  dimensions: 768,
});

const modelAvailable = await provider
  .embed(['probe'])
  .then(() => true)
  .catch(() => false);

describe.skipIf(!modelAvailable)('LocalEmbeddingProvider', () => {
  it('returns unit vectors of the configured width', async () => {
    const [vector] = await provider.embed(['Delhivery Limited, revenue from services, FY2024']);

    expect(vector).toHaveLength(768);
    const norm = Math.sqrt(vector!.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 3);
  }, 120_000);

  it('places two wordings of one claim closer than two different claims', async () => {
    const [a, b, c] = await provider.embed([
      'Delhivery Limited, revenue from services, consolidated, FY2024',
      'Delhivery Limited, service revenue, consolidated, FY2024',
      'Delhivery Limited, chief financial officer',
    ]);

    const dot = (x: number[], y: number[]) => x.reduce((sum, value, i) => sum + value * y[i]!, 0);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  }, 120_000);

  it('rejects a width that does not match the stored column', async () => {
    const wrong = new LocalEmbeddingProvider({ model: provider.model, dimensions: 384 });
    await expect(wrong.embed(['anything'])).rejects.toThrow(/dimensions/);
  }, 120_000);
});
