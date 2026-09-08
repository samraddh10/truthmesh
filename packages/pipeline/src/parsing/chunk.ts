export interface ChunkSourceBlock {
  readonly id: string;
  readonly physicalPage: number;
  readonly printedPageLabel: string | null;
  readonly blockType: string;
  readonly content: string;
}

export interface Chunk {
  readonly index: number;
  readonly text: string;
  readonly heading: string | null;
  readonly sourceBlockIds: readonly string[];
  readonly blockRefs: readonly BlockRef[];
  readonly physicalPages: readonly number[];
  readonly estimatedTokens: number;
}

export interface BlockRef {
  readonly ref: string;
  readonly sourceBlockId: string;
}

export interface ChunkOptions {
  readonly targetTokens?: number;
  readonly maxTokens?: number;
}

const DEFAULTS = {
  targetTokens: 1200,
  maxTokens: 2000,
} as const;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function render(heading: string | null, page: number, label: string | null, body: string): string {
  const location = label !== null ? `page ${page} (printed ${label})` : `page ${page}`;
  const parts = [`[${location}]`];
  if (heading !== null) parts.push(`[section: ${heading}]`);
  parts.push('', body);
  return parts.join('\n');
}

function splitOversized(content: string, maxTokens: number): string[] {
  const lines = content.split('\n');
  const pieces: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const candidate = [...current, line].join('\n');
    if (current.length > 0 && estimateTokens(candidate) > maxTokens) {
      pieces.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) pieces.push(current.join('\n'));
  return pieces;
}

export function chunkSourceBlocks(
  blocks: readonly ChunkSourceBlock[],
  options: ChunkOptions = {},
): Chunk[] {
  const targetTokens = options.targetTokens ?? DEFAULTS.targetTokens;
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;

  const chunks: Chunk[] = [];
  let heading: string | null = null;

  let buffer: string[] = [];
  let bufferIds: string[] = [];
  let bufferRefs: BlockRef[] = [];
  let bufferPage: number | null = null;
  let bufferLabel: string | null = null;

  const flush = () => {
    if (buffer.length === 0 || bufferPage === null) return;
    const body = buffer.join('\n\n');
    const text = render(heading, bufferPage, bufferLabel, body);
    chunks.push({
      index: chunks.length,
      text,
      heading,
      sourceBlockIds: [...bufferIds],
      blockRefs: [...bufferRefs],
      physicalPages: [bufferPage],
      estimatedTokens: estimateTokens(text),
    });
    buffer = [];
    bufferIds = [];
    bufferRefs = [];
  };

  const refFor = (blockId: string): string => {
    const existing = bufferRefs.find((entry) => entry.sourceBlockId === blockId);
    if (existing !== undefined) return existing.ref;
    const ref = `B${bufferRefs.length + 1}`;
    bufferRefs.push({ ref, sourceBlockId: blockId });
    return ref;
  };

  for (const block of blocks) {
    const content = block.content.trim();
    if (content === '') continue;

    if (bufferPage !== null && block.physicalPage !== bufferPage) flush();

    bufferPage = block.physicalPage;
    bufferLabel = block.printedPageLabel;

    if (block.blockType === 'heading') {
      flush();
      heading = content;
      bufferPage = block.physicalPage;
      bufferLabel = block.printedPageLabel;
      continue;
    }

    for (const piece of splitOversized(content, maxTokens)) {
      const projected = estimateTokens([...buffer, piece].join('\n\n'));
      if (buffer.length > 0 && projected > targetTokens) flush();
      bufferPage = block.physicalPage;
      bufferLabel = block.printedPageLabel;
      buffer.push(`[${refFor(block.id)}]\n${piece}`);
      if (!bufferIds.includes(block.id)) bufferIds.push(block.id);
    }
  }

  flush();
  return chunks;
}
