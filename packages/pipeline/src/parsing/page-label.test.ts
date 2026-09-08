import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { extractPageText, type PageText } from '../pdf-text.ts';
import { readPrintedPageLabel } from './page-label.ts';

const PROSPECTUS = 'datasets/delhivery/01-delhivery-prospectus-2022-excerpt.pdf';
const ANNUAL_REPORT = 'datasets/delhivery/02-delhivery-annual-report-fy24-excerpt.pdf';
const EARNINGS_DECK = 'datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf';

const pages = new Map<string, PageText>();

async function page(file: string, physicalPage: number): Promise<PageText> {
  const key = `${file}#${physicalPage}`;
  const cached = pages.get(key);
  if (cached !== undefined) return cached;
  const extracted = await extractPageText(new Uint8Array(await readFile(file)), physicalPage);
  pages.set(key, extracted);
  return extracted;
}

beforeAll(async () => {
  await Promise.all([
    page(PROSPECTUS, 43),
    page(PROSPECTUS, 83),
    page(ANNUAL_REPORT, 1),
    page(ANNUAL_REPORT, 5),
    page(EARNINGS_DECK, 5),
    page(EARNINGS_DECK, 13),
  ]);
}, 120_000);

describe('a single printed number', () => {
  it('reads 214 from prospectus physical page 43', async () => {
    const label = readPrintedPageLabel(await page(PROSPECTUS, 43));
    expect(label.label).toBe('214');
    expect(label.confidence).toBe('high');
  });

  it('reads 258 from prospectus physical page 83', async () => {
    expect(readPrintedPageLabel(await page(PROSPECTUS, 83)).label).toBe('258');
  });

  it('reads the deck page number from the bottom-right corner', async () => {
    expect(readPrintedPageLabel(await page(EARNINGS_DECK, 5)).label).toBe('5');
  });
});

describe('two printed numbers on one sheet', () => {
  it('reports both labels from the annual report spread', async () => {
    const label = readPrintedPageLabel(await page(ANNUAL_REPORT, 1));
    expect(label.label).toBe('2-3');
    expect(label.confidence).toBe('high');
    expect(label.reason).toContain('two printed labels');
  });

  it('reads them left to right, as a reader sees them', async () => {
    const label = readPrintedPageLabel(await page(ANNUAL_REPORT, 1));
    expect(label.candidates[0]).toBe('2');
  });
});

describe('declining to guess', () => {
  it('returns null when the margin holds a row of figures', async () => {
    const label = readPrintedPageLabel(await page(EARNINGS_DECK, 13), { marginFraction: 0.45 });
    expect(label.label).toBe(null);
    expect(label.confidence).toBe('none');
    expect(label.reason).toContain('data row');
  });

  it('returns null for a page with nothing in the margin', () => {
    const empty: PageText = {
      physicalPage: 0,
      widthPt: 595,
      heightPt: 842,
      rotation: 0,
      coordinateOrigin: 'bottom-left',
      items: [],
      characterCount: 0,
    };
    const label = readPrintedPageLabel(empty);
    expect(label.label).toBe(null);
    expect(label.reason).toContain('no short number');
  });

  it('ignores a long number that cannot be a page label', () => {
    const withRevenue: PageText = {
      physicalPage: 0,
      widthPt: 595,
      heightPt: 842,
      rotation: 0,
      coordinateOrigin: 'bottom-left',
      items: [
        {
          text: '81415',
          x: 100,
          y: 20,
          width: 30,
          height: 8,
          centerX: 115,
          readingIndex: 0,
        },
      ],
      characterCount: 5,
    };
    expect(readPrintedPageLabel(withRevenue).label).toBe(null);
  });
});
