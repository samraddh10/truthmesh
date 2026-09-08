import type { Chunk } from '../parsing/chunk.ts';
import { estimateTokens } from '../parsing/chunk.ts';

export interface BatchOptions {
  readonly maxInputTokens?: number;
  readonly maxChunks?: number;
}

const DEFAULTS = {
  maxInputTokens: 3000,
  maxChunks: 4,
} as const;

export interface BatchPassage {
  readonly label: string;
  readonly chunk: Chunk;
  readonly text: string;
  readonly handles: readonly string[];
}

export interface ChunkBatch {
  readonly passages: readonly BatchPassage[];
  readonly refToBlockId: ReadonlyMap<string, string>;
  readonly estimatedTokens: number;
}

export function planBatches(
  chunks: readonly Chunk[],
  options: BatchOptions = {},
): ChunkBatch[] {
  const maxInputTokens = options.maxInputTokens ?? DEFAULTS.maxInputTokens;
  const maxChunks = Math.max(1, options.maxChunks ?? DEFAULTS.maxChunks);

  const batches: ChunkBatch[] = [];
  let current: Chunk[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push(buildBatch(current));
    current = [];
    currentTokens = 0;
  };

  for (const chunk of chunks) {
    const full = current.length >= maxChunks;
    const wouldOverflow = current.length > 0 && currentTokens + chunk.estimatedTokens > maxInputTokens;

    if (full || wouldOverflow) flush();

    current.push(chunk);
    currentTokens += chunk.estimatedTokens;
  }

  flush();
  return batches;
}

function buildBatch(chunks: readonly Chunk[]): ChunkBatch {
  const refToBlockId = new Map<string, string>();
  const passages: BatchPassage[] = [];

  chunks.forEach((chunk, index) => {
    const prefix = chunks.length === 1 ? '' : `P${index + 1}`;
    const handles: string[] = [];

    for (const ref of chunk.blockRefs) {
      const handle = `${prefix}${ref.ref}`;
      refToBlockId.set(handle, ref.sourceBlockId);
      handles.push(handle);
    }

    passages.push({
      label: `P${index + 1}`,
      chunk,
      text: prefix === '' ? chunk.text : rewriteHandles(chunk.text, prefix),
      handles,
    });
  });

  return {
    passages,
    refToBlockId,
    estimatedTokens: chunks.reduce((total, chunk) => total + chunk.estimatedTokens, 0),
  };
}

function rewriteHandles(text: string, prefix: string): string {
  return text.replace(/^\[(B\d+)\]$/gm, (_match, ref: string) => `[${prefix}${ref}]`);
}

export function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((running, weight) => running + weight, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    const even = Math.floor(total / weights.length);
    return weights.map((_weight, index) =>
      index === weights.length - 1 ? total - even * (weights.length - 1) : even,
    );
  }

  const shares = weights.map((weight) => Math.floor((total * weight) / sum));
  const assigned = shares.reduce((running, share) => running + share, 0);
  const last = shares.length - 1;
  shares[last] = (shares[last] ?? 0) + (total - assigned);
  return shares;
}

export { estimateTokens };
