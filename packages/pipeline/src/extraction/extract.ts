import {
  ModelError,
  extractJson,
  type ChatMessage,
  type CompletionProvider,
} from '../model/index.ts';
import type { Chunk } from '../parsing/chunk.ts';
import { planBatches, type ChunkBatch } from './batch.ts';
import {
  EXTRACTION_RESPONSE_SCHEMA,
  parseExtraction,
  type ExtractedClaim,
} from './contract.ts';
import { buildBatchMessages, buildRepairMessages } from './prompt.ts';

export interface ExtractChunkOptions {
  readonly client: CompletionProvider;
  readonly maxTokens?: number;
  readonly allowRepair?: boolean;
  readonly vocabulary?: string;
}

export interface ChunkExtraction {
  readonly chunkIndex: number;
  readonly claims: readonly ExtractedClaim[];
  readonly servedByModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly repaired: boolean;
}

export async function extractBatch(
  batch: ChunkBatch,
  options: ExtractChunkOptions,
): Promise<ChunkExtraction> {
  const messages: ChatMessage[] = buildBatchMessages(batch, options.vocabulary ?? '');
  const maxTokens = options.maxTokens ?? outputAllowance(batch.passages.length);
  const chunkIndex = batch.passages[0]?.chunk.index ?? 0;

  const first = await options.client.complete({
    messages,
    schema: { name: 'extracted_claims', schema: EXTRACTION_RESPONSE_SCHEMA },
    maxTokens,
  });

  const firstParse = parseExtraction(readJson(first.text));
  if (firstParse.ok) {
    return {
      chunkIndex,
      claims: firstParse.claims,
      servedByModel: first.servedByModel,
      promptTokens: first.promptTokens,
      completionTokens: first.completionTokens,
      latencyMs: first.latencyMs,
      repaired: false,
    };
  }

  if (options.allowRepair === false) {
    throw new ModelError(
      `extraction did not match the schema: ${firstParse.feedback}`,
      'schema_violation',
      true,
    );
  }

  const second = await options.client.complete({
    messages: buildRepairMessages(messages, first.text, firstParse.feedback),
    schema: { name: 'extracted_claims', schema: EXTRACTION_RESPONSE_SCHEMA },
    maxTokens,
  });

  const secondParse = parseExtraction(readJson(second.text));
  if (!secondParse.ok) {
    throw new ModelError(
      `extraction did not match the schema after one repair: ${secondParse.feedback}`,
      'schema_violation_after_repair',
      false,
    );
  }

  return {
    chunkIndex,
    claims: secondParse.claims,
    servedByModel: second.servedByModel,
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    latencyMs: first.latencyMs + second.latencyMs,
    repaired: true,
  };
}

export async function extractChunk(
  chunk: Chunk,
  options: ExtractChunkOptions,
): Promise<ChunkExtraction> {
  const [batch] = planBatches([chunk]);
  if (batch === undefined) {
    return {
      chunkIndex: chunk.index,
      claims: [],
      servedByModel: options.client.model,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      repaired: false,
    };
  }

  return extractBatch(batch, options);
}

function outputAllowance(passages: number): number {
  return Math.min(8000, 4000 + 2000 * Math.max(0, passages - 1));
}

function readJson(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return { claims: null };
  }
}
