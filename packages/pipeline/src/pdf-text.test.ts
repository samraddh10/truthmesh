import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

import { bindToAxisLabels, columnPitch } from './axis-binding.ts';
import { extractPageText, type PageText, type PositionedText } from './pdf-text.ts';

const ANNUAL_REPORT = 'datasets/delhivery/02-delhivery-annual-report-fy24-excerpt.pdf';

const CHART_PAGE = 5;

const ROW_TOLERANCE_PT = 5;

function inRow(items: readonly PositionedText[], y: number, minX: number, maxX: number): PositionedText[] {
  return inBand(items, y - ROW_TOLERANCE_PT, y + ROW_TOLERANCE_PT, minX, maxX);
}

function inBand(
  items: readonly PositionedText[],
  minY: number,
  maxY: number,
  minX: number,
  maxX: number,
): PositionedText[] {
  return items
    .filter((item) => item.y >= minY && item.y <= maxY && item.centerX >= minX && item.centerX <= maxX)
    .sort((a, b) => a.centerX - b.centerX);
}

describe('positional extraction of doc-02 physical page 5', () => {
  let page: PageText;

  beforeAll(async () => {
    page = await extractPageText(new Uint8Array(await readFile(ANNUAL_REPORT)), CHART_PAGE);
  });

  it('can extract twice from one buffer', async () => {
    const bytes = new Uint8Array(await readFile(ANNUAL_REPORT));

    const first = await extractPageText(bytes, CHART_PAGE);
    const second = await extractPageText(bytes, 20);

    expect(first.items.length).toBeGreaterThan(0);
    expect(second.physicalPage).toBe(20);
    expect(second.items.length).toBeGreaterThan(0);
  });

  it('reports the two-up sheet geometry the annual report is laid out on', () => {
    expect(page.widthPt > page.heightPt, 'expected a landscape sheet').toBe(true);
    expect(page.physicalPage).toBe(CHART_PAGE);
    expect(page.characterCount > 1000, `expected a dense page, got ${page.characterCount} characters`).toBe(true);
  });

  describe('the adjusted-EBITDA chart', () => {
    const VALUE_ROW_Y = 486.6;
    const LABEL_ROW_Y = 381;
    const CHART_MIN_X = 950;
    const CHART_MAX_X = 1090;

    it('emits the two adjacent values in an order that inverts the years', () => {
      const values = inRow(page.items, VALUE_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^\(\d,\d{3}\)$/.test(item.text));

      const byReadingOrder = [...values].sort((a, b) => a.readingIndex - b.readingIndex);
      expect(byReadingOrder[0]?.text).toBe('(2,533)');
      expect(byReadingOrder[1]?.text).toBe('(2,532)');

      expect(byReadingOrder[0]?.text).not.toBe('(2,532)');
    });

    it('binds each value to the correct fiscal year by horizontal position', () => {
      const labels = inRow(page.items, LABEL_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^FY\d{2}$/.test(item.text));
      const values = inRow(page.items, VALUE_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^\(\d,\d{3}\)$/.test(item.text));

      expect(labels.map((l) => l.text)).toEqual(['FY20', 'FY21', 'FY22', 'FY23', 'FY24']);

      const bound = bindToAxisLabels(values, labels);
      const mapping = new Map(bound.map((b) => [b.value.text, b.label?.text ?? null]));

      expect(mapping.get('(2,532)')).toBe('FY20');
      expect(mapping.get('(2,533)')).toBe('FY21');
      expect(mapping.get('(4,039)')).toBe('FY23');

      for (const binding of bound) {
        expect(binding.ambiguous).toBe(false, `${binding.value.text}: ${binding.reason}`);
      }
    });

    it('separates the columns far enough that the binding is not a close call', () => {
      const labels = inRow(page.items, LABEL_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^FY\d{2}$/.test(item.text));

      const pitch = columnPitch(labels);
      expect(pitch !== null && pitch > 20, `expected a measurable column pitch, got ${pitch}`).toBe(true);

      const values = inRow(page.items, VALUE_ROW_Y, CHART_MIN_X, CHART_MAX_X)
        .filter((item) => /^\(\d,\d{3}\)$/.test(item.text));
      for (const binding of bindToAxisLabels(values, labels)) {
        expect(binding.deltaX < (pitch ?? 0) * 0.1, `${binding.value.text} sits ${binding.deltaX.toFixed(1)}pt from its column, which is not a clean match`).toBe(true);
      }
    });
  });

  it('emits the neighbouring chart left to right, so the inversion is local', () => {
    const values = inBand(page.items, 220, 250, 950, 1090).filter((item) => /^\d{2}\.\d$/.test(item.text));
    expect(values.length).toBe(5);

    const byReadingOrder = [...values].sort((a, b) => a.readingIndex - b.readingIndex);
    expect(byReadingOrder.map((item) => item.text), 'expected this chart to be emitted in column order').toEqual(['41.8', '42.7', '40.5', '39.1', '38.4']);

    const labels = inRow(page.items, 113.5, 950, 1090).filter((item) => /^FY\d{2}$/.test(item.text));
    const mapping = new Map(bindToAxisLabels(values, labels).map((b) => [b.value.text, b.label?.text ?? null]));
    expect(mapping.get('41.8')).toBe('FY20');
    expect(mapping.get('42.7')).toBe('FY21');
  });
});
