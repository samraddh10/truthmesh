import type { PageText, PositionedText } from '../pdf-text.ts';

export interface TextLine {
  readonly text: string;
  readonly items: readonly PositionedText[];
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  readonly height: number;
}

export interface TextBlock {
  readonly lines: readonly TextLine[];
  readonly text: string;
  readonly x0: number;
  readonly x1: number;
  readonly yTop: number;
  readonly yBottom: number;
}

export interface LayoutRegion {
  readonly index: number;
  readonly x0: number;
  readonly x1: number;
  readonly blocks: readonly TextBlock[];
}

export interface Gutter {
  readonly x0: number;
  readonly x1: number;
  readonly width: number;
}

export interface PageLayout {
  readonly physicalPage: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly regions: readonly LayoutRegion[];
  readonly gutters: readonly Gutter[];
  readonly medianTextHeight: number;
}

export interface LayoutOptions {
  readonly gutterWidthInTextHeights?: number;
  readonly lineToleranceInTextHeights?: number;
  readonly blockGapInTextHeights?: number;
}

const DEFAULTS = {
  gutterWidthInTextHeights: 2.5,
  lineToleranceInTextHeights: 0.5,
  blockGapInTextHeights: 1.6,
} as const;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function detectGutters(
  items: readonly PositionedText[],
  widthPt: number,
  minWidthPt: number,
): Gutter[] {
  if (items.length === 0) return [];

  const width = Math.ceil(widthPt);
  const occupied = new Uint8Array(width + 2);

  for (const item of items) {
    const from = Math.max(0, Math.floor(item.x));
    const to = Math.min(width, Math.ceil(item.x + item.width));
    for (let x = from; x <= to; x += 1) occupied[x] = 1;
  }

  let textStart = 0;
  while (textStart <= width && occupied[textStart] !== 1) textStart += 1;
  let textEnd = width;
  while (textEnd >= 0 && occupied[textEnd] !== 1) textEnd -= 1;

  const gutters: Gutter[] = [];
  let runStart: number | null = null;

  for (let x = textStart; x <= textEnd; x += 1) {
    if (occupied[x] !== 1) {
      if (runStart === null) runStart = x;
      continue;
    }
    if (runStart !== null) {
      const gutterWidth = x - runStart;
      if (gutterWidth >= minWidthPt) gutters.push({ x0: runStart, x1: x - 1, width: gutterWidth });
      runStart = null;
    }
  }

  return gutters;
}

export function groupLines(items: readonly PositionedText[], tolerance: number): TextLine[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PositionedText[][] = [];

  for (const item of sorted) {
    const current = groups[groups.length - 1];
    const reference = current?.[0];

    if (current !== undefined && reference !== undefined && Math.abs(reference.y - item.y) <= tolerance) {
      current.push(item);
    } else {
      groups.push([item]);
    }
  }

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    return {
      text: ordered.map((item) => item.text).join(' '),
      items: ordered,
      y: ordered[0]?.y ?? 0,
      x0: Math.min(...ordered.map((item) => item.x)),
      x1: Math.max(...ordered.map((item) => item.x + item.width)),
      height: Math.max(...ordered.map((item) => item.height)),
    };
  });
}

function buildBlocks(lines: readonly TextLine[], maxGap: number): TextBlock[] {
  if (lines.length === 0) return [];

  const blocks: TextBlock[] = [];
  let current: TextLine[] = [];

  const flush = () => {
    if (current.length === 0) return;
    blocks.push({
      lines: current,
      text: current.map((line) => line.text).join('\n'),
      x0: Math.min(...current.map((line) => line.x0)),
      x1: Math.max(...current.map((line) => line.x1)),
      yTop: Math.max(...current.map((line) => line.y)),
      yBottom: Math.min(...current.map((line) => line.y)),
    });
    current = [];
  };

  for (const line of lines) {
    const previous = current[current.length - 1];
    if (previous !== undefined && previous.y - line.y > maxGap) flush();
    current.push(line);
  }
  flush();

  return blocks;
}

export function buildLayout(page: PageText, options: LayoutOptions = {}): PageLayout {
  const gutterFactor = options.gutterWidthInTextHeights ?? DEFAULTS.gutterWidthInTextHeights;
  const lineFactor = options.lineToleranceInTextHeights ?? DEFAULTS.lineToleranceInTextHeights;
  const blockFactor = options.blockGapInTextHeights ?? DEFAULTS.blockGapInTextHeights;

  const heights = page.items.map((item) => item.height).filter((height) => height > 0);
  const textHeight = median(heights) || 10;

  const gutters = detectGutters(page.items, page.widthPt, textHeight * gutterFactor);

  const boundaries = gutters.map((gutter) => (gutter.x0 + gutter.x1) / 2);
  const edges = [Number.NEGATIVE_INFINITY, ...boundaries, Number.POSITIVE_INFINITY];

  const regions: LayoutRegion[] = [];

  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index]!;
    const to = edges[index + 1]!;
    const members = page.items.filter((item) => {
      const centre = item.centerX;
      return centre >= from && centre < to;
    });

    if (members.length === 0) continue;

    const lines = groupLines(members, textHeight * lineFactor);
    regions.push({
      index: regions.length,
      x0: Math.min(...members.map((item) => item.x)),
      x1: Math.max(...members.map((item) => item.x + item.width)),
      blocks: buildBlocks(lines, textHeight * blockFactor),
    });
  }

  return {
    physicalPage: page.physicalPage,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    regions,
    gutters,
    medianTextHeight: textHeight,
  };
}

export function toLayoutText(layout: PageLayout): string {
  return layout.regions
    .map((region) => region.blocks.map((block) => block.text).join('\n\n'))
    .join('\n\n');
}
