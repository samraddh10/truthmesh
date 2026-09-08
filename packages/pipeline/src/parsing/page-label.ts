import type { PageText, PositionedText } from '../pdf-text.ts';

export type LabelConfidence = 'high' | 'none';

export interface PrintedPageLabel {
  readonly label: string | null;
  readonly confidence: LabelConfidence;
  readonly candidates: readonly string[];
  readonly reason: string;
}

export interface PageLabelOptions {
  readonly marginFraction?: number;
  readonly maxCandidates?: number;
}

const DEFAULTS = {
  marginFraction: 0.07,
  maxCandidates: 2,
} as const;

const PAGE_NUMBER = /^\d{1,4}$/;

const ROMAN = /^[ivxlcdm]{1,7}$/i;

function isLabelShaped(text: string): boolean {
  return PAGE_NUMBER.test(text) || ROMAN.test(text);
}

export function readPrintedPageLabel(
  page: PageText,
  options: PageLabelOptions = {},
): PrintedPageLabel {
  const marginFraction = options.marginFraction ?? DEFAULTS.marginFraction;
  const maxCandidates = options.maxCandidates ?? DEFAULTS.maxCandidates;
  const margin = page.heightPt * marginFraction;

  const inMargin = (item: PositionedText): boolean =>
    item.y <= margin || item.y >= page.heightPt - margin;

  const candidates = page.items.filter((item) => inMargin(item) && isLabelShaped(item.text));

  if (candidates.length === 0) {
    return {
      label: null,
      confidence: 'none',
      candidates: [],
      reason: 'no short number in the top or bottom margin',
    };
  }

  if (candidates.length > maxCandidates) {
    return {
      label: null,
      confidence: 'none',
      candidates: candidates.map((item) => item.text),
      reason: `${candidates.length} numbers in the margin; a data row rather than a page number`,
    };
  }

  const ordered = [...candidates].sort((a, b) => a.x - b.x).map((item) => item.text);
  const unique = [...new Set(ordered)];

  return {
    label: unique.join('-'),
    confidence: 'high',
    candidates: ordered,
    reason:
      unique.length > 1
        ? 'two printed labels on one physical sheet, which is how this document is set'
        : 'a single number alone in the margin',
  };
}
