import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { PdfExtractionError } from '../pdf-text.ts';
import { isPng, renderPage } from './render.ts';

const EARNINGS_DECK = 'datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf';
const ANNUAL_REPORT = 'datasets/delhivery/02-delhivery-annual-report-fy24-excerpt.pdf';

let deck: Uint8Array;
let annualReport: Uint8Array;

beforeAll(async () => {
  deck = new Uint8Array(await readFile(EARNINGS_DECK));
  annualReport = new Uint8Array(await readFile(ANNUAL_REPORT));
}, 60_000);

describe('rendering a page', () => {
  it('produces a PNG for a table page', async () => {
    const rendered = await renderPage(deck, 7);

    expect(isPng(rendered.bytes)).toBe(true);
    expect(rendered.physicalPage).toBe(7);
    expect(rendered.mimeType).toBe('image/png');
    expect(rendered.bytes.byteLength).toBeGreaterThan(10_000);
  }, 60_000);

  it('renders a chart page differently from a divider', async () => {
    const [chart, divider] = await Promise.all([renderPage(deck, 8), renderPage(deck, 17)]);

    expect(isPng(chart.bytes)).toBe(true);
    expect(isPng(divider.bytes)).toBe(true);
    expect(chart.bytes.byteLength).toBeGreaterThan(divider.bytes.byteLength);
  }, 90_000);

  it('leaves the caller buffer intact', async () => {
    const before = deck.byteLength;
    await renderPage(deck, 5);
    expect(deck.byteLength).toBe(before);
  }, 60_000);

  it('can render twice from one buffer', async () => {
    const first = await renderPage(deck, 5);
    const second = await renderPage(deck, 7);
    expect(isPng(first.bytes)).toBe(true);
    expect(isPng(second.bytes)).toBe(true);
  }, 90_000);

  it('renders a larger image at a higher scale', async () => {
    const [low, high] = await Promise.all([
      renderPage(deck, 7, { scale: 1 }),
      renderPage(deck, 7, { scale: 2 }),
    ]);
    expect(high.bytes.byteLength).toBeGreaterThan(low.bytes.byteLength);
    expect(high.scale).toBe(2);
  }, 90_000);

  it('renders the two-up annual report sheet', async () => {
    const rendered = await renderPage(annualReport, 5);
    expect(isPng(rendered.bytes)).toBe(true);
  }, 60_000);
});

describe('refusing to render', () => {
  it('rejects a page index past the end of the document', async () => {
    await expect(renderPage(deck, 9999)).rejects.toThrow(PdfExtractionError);
  }, 60_000);

  it('rejects a negative page index', async () => {
    await expect(renderPage(deck, -1)).rejects.toThrow(PdfExtractionError);
  });

  it('reports an oversized render rather than sending it', async () => {
    const error = await renderPage(annualReport, 5, { scale: 3, maxBytes: 1024 }).catch(
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(PdfExtractionError);
    expect(error.message).toMatch(/above the/);
    expect(error.message).toMatch(/render it smaller/);
  }, 60_000);
});

describe('isPng', () => {
  it('recognises the PNG signature', () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
    expect(isPng(new Uint8Array())).toBe(false);
  });
});
