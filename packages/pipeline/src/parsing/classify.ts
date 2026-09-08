import type { LayoutRegion, PageLayout, TextBlock } from './layout.ts';

export type RegionKind = 'empty' | 'sparse' | 'narrative' | 'structured';

const NUMERIC = /^[₹$€£]?\s?\(?-?\d[\d,]*(\.\d+)?\)?\s?%?$/;

export interface RegionFeatures {
  readonly characterCount: number;
  readonly runCount: number;
  readonly numericRatio: number;
  readonly alignedColumns: number;
  readonly meanRunLength: number;
}

export interface RegionClassification {
  readonly kind: RegionKind;
  readonly features: RegionFeatures;
  readonly reasons: readonly string[];
}

export interface PageClassification {
  readonly physicalPage: number;
  readonly kind: RegionKind;
  readonly regions: readonly RegionClassification[];
  readonly needsVisualRoute: boolean;
  readonly characterCount: number;
  readonly reasons: readonly string[];
}

export interface ClassifyOptions {
  readonly sparseCharacterLimit?: number;
  readonly sparseRunLimit?: number;
  readonly numericRatioThreshold?: number;
  readonly alignedColumnThreshold?: number;
  readonly meanRunLengthThreshold?: number;
}

const DEFAULTS = {
  sparseCharacterLimit: 700,
  sparseRunLimit: 25,
  numericRatioThreshold: 0.3,
  alignedColumnThreshold: 4,
  meanRunLengthThreshold: 15,
} as const;

const COLUMN_BUCKET_PT = 3;

const MIN_RUNS_TO_JUDGE = 8;

function describeRuns(runs: readonly { text: string; x: number }[]): RegionFeatures {

  if (runs.length === 0) {
    return {
      characterCount: 0,
      runCount: 0,
      numericRatio: 0,
      alignedColumns: 0,
      meanRunLength: 0,
    };
  }

  const characterCount = runs.reduce((total, run) => total + run.text.length, 0);
  const numeric = runs.filter((run) => NUMERIC.test(run.text)).length;

  const columns = new Map<number, number>();
  for (const run of runs) {
    const bucket = Math.round(run.x / COLUMN_BUCKET_PT);
    columns.set(bucket, (columns.get(bucket) ?? 0) + 1);
  }

  return {
    characterCount,
    runCount: runs.length,
    numericRatio: numeric / runs.length,
    alignedColumns: [...columns.values()].filter((count) => count >= 3).length,
    meanRunLength: characterCount / runs.length,
  };
}

export function describeBlock(block: TextBlock): RegionFeatures {
  return describeRuns(block.lines.flatMap((line) => line.items));
}

export function describeRegion(region: LayoutRegion): RegionFeatures {
  return describeRuns(region.blocks.flatMap((block) => block.lines.flatMap((line) => line.items)));
}

function scoreStructure(
  features: RegionFeatures,
  options: ClassifyOptions,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const numericThreshold = options.numericRatioThreshold ?? DEFAULTS.numericRatioThreshold;
  const columnThreshold = options.alignedColumnThreshold ?? DEFAULTS.alignedColumnThreshold;
  const lengthThreshold = options.meanRunLengthThreshold ?? DEFAULTS.meanRunLengthThreshold;

  let score = 0;

  if (features.numericRatio >= numericThreshold) {
    score += 1;
    reasons.push(`${Math.round(features.numericRatio * 100)}% of runs are bare numbers`);
  }
  if (features.alignedColumns >= columnThreshold) {
    score += 1;
    reasons.push(`${features.alignedColumns} left edges shared by three or more runs`);
  }
  if (features.meanRunLength <= lengthThreshold) {
    score += 1;
    reasons.push(
      `runs average ${features.meanRunLength.toFixed(1)} characters, cell-length rather than sentence-length`,
    );
  }

  return { score, reasons };
}

export function classifyRegion(
  region: LayoutRegion,
  options: ClassifyOptions = {},
): RegionClassification {
  const sparseChars = options.sparseCharacterLimit ?? DEFAULTS.sparseCharacterLimit;
  const sparseRuns = options.sparseRunLimit ?? DEFAULTS.sparseRunLimit;

  const features = describeRegion(region);

  if (features.runCount === 0) {
    return { kind: 'empty', features, reasons: ['no text runs'] };
  }

  if (features.characterCount < sparseChars && features.runCount < sparseRuns) {
    return {
      kind: 'sparse',
      features,
      reasons: [
        `only ${features.characterCount} characters across ${features.runCount} runs; a divider or title rather than a failure`,
      ],
    };
  }

  const { score: regionScore, reasons: regionReasons } = scoreStructure(features, options);
  if (regionScore >= 2) {
    return { kind: 'structured', features, reasons: regionReasons };
  }

  for (const block of region.blocks) {
    const blockFeatures = describeBlock(block);
    if (blockFeatures.runCount < MIN_RUNS_TO_JUDGE) continue;

    const { score, reasons: blockReasons } = scoreStructure(blockFeatures, options);
    if (score >= 2) {
      return {
        kind: 'structured',
        features,
        reasons: [`a block of ${blockFeatures.runCount} runs is tabular: ${blockReasons.join('; ')}`],
      };
    }
  }

  return {
    kind: 'narrative',
    features,
    reasons:
      regionReasons.length > 0
        ? regionReasons
        : ['prose-length runs with little numeric content'],
  };
}

export function classifyPage(layout: PageLayout, options: ClassifyOptions = {}): PageClassification {
  const regions = layout.regions.map((region) => classifyRegion(region, options));

  const characterCount = regions.reduce(
    (total, region) => total + region.features.characterCount,
    0,
  );

  if (regions.length === 0 || characterCount === 0) {
    return {
      physicalPage: layout.physicalPage,
      kind: 'empty',
      regions,
      needsVisualRoute: false,
      characterCount,
      reasons: ['the page yielded no native text'],
    };
  }

  const hasStructured = regions.some((region) => region.kind === 'structured');
  const hasNarrative = regions.some((region) => region.kind === 'narrative');

  const kind: RegionKind = hasStructured ? 'structured' : hasNarrative ? 'narrative' : 'sparse';

  return {
    physicalPage: layout.physicalPage,
    kind,
    regions,
    needsVisualRoute: hasStructured,
    characterCount,
    reasons: regions.flatMap((region) => region.reasons),
  };
}

export function isLegitimatelyEmpty(classification: PageClassification): boolean {
  return classification.kind === 'empty' || classification.kind === 'sparse';
}
