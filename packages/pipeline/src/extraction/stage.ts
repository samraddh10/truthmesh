import { asc, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claims, processingRuns, sourceBlocks } from '@superjoin/db';

import { ModelError, type CompletionProvider } from '../model/index.ts';
import { chunkSourceBlocks, type Chunk, type ChunkSourceBlock } from '../parsing/chunk.ts';
import { ProcessingError, type ProcessingContext, type StageHandler } from '../processor.ts';
import { recordIssue, recordProgress } from '../run-state.ts';
import { loadRegistry, registerPredicates, renderRegistry } from '../normalize/registry.ts';
import {
  chunkFingerprint,
  loadCompletedChunks,
  recordCompletedChunk,
  type ExtractionIdentity,
} from './checkpoint.ts';
import { EXTRACTION_PROMPT_VERSION } from './contract.ts';
import { apportion, planBatches, type ChunkBatch } from './batch.ts';
import { extractBatch } from './extract.ts';
import { persistClaim } from './persist.ts';
import { verifyClaim, type EvidenceBlock } from './verify.ts';

export interface ExtractionStageOptions {
  readonly client: CompletionProvider;
  readonly tokenBudget?: number;
  readonly concurrency?: number;
  readonly batchInputTokens?: number;
  readonly batchMaxChunks?: number;
  readonly maxConsecutiveFailures?: number;
  readonly maxConsecutiveAny?: number;
}

const DEFAULTS = {
  tokenBudget: 1_500_000,
  concurrency: 2,
  maxConsecutiveFailures: 4,
  maxConsecutiveAny: 12,
} as const;

export type FailureRun = 'throttled' | 'malformed' | 'other';

export function classifyFailure(error: unknown): FailureRun {
  const kind = error instanceof ModelError ? error.kind : null;
  if (kind === 'provider_rate_limited') return 'throttled';
  if (kind === 'schema_violation' || kind === 'schema_violation_after_repair') {
    return 'malformed';
  }
  return 'other';
}

export interface ExtractionSummary {
  readonly chunksTotal: number;
  readonly chunksProcessed: number;
  readonly chunksResumed: number;
  readonly chunksFailed: number;
  readonly claimsExtracted: number;
  readonly claimsAccepted: number;
  readonly claimsNeedingReview: number;
  readonly claimsRejected: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly spentPromptTokens: number;
  readonly spentCompletionTokens: number;
  readonly stoppedEarly: boolean;
}

interface StoredBlock extends EvidenceBlock, ChunkSourceBlock {
  readonly blockType: string;
  readonly blockIndex: number;
  readonly printedPageLabel: string | null;
}

async function loadBlocks(db: Database, documentId: string): Promise<StoredBlock[]> {
  const rows = await db
    .select({
      id: sourceBlocks.id,
      documentId: sourceBlocks.documentId,
      physicalPage: sourceBlocks.physicalPage,
      printedPageLabel: sourceBlocks.printedPageLabel,
      blockType: sourceBlocks.blockType,
      blockIndex: sourceBlocks.blockIndex,
      content: sourceBlocks.content,
      extractionMethod: sourceBlocks.extractionMethod,
    })
    .from(sourceBlocks)
    .where(eq(sourceBlocks.documentId, documentId))
    .orderBy(asc(sourceBlocks.physicalPage), asc(sourceBlocks.blockIndex));

  return rows.map((row) => ({
    id: row.id,
    documentId: row.documentId,
    physicalPage: row.physicalPage,
    printedPageLabel: row.printedPageLabel,
    blockType: row.blockType,
    blockIndex: row.blockIndex,
    content: row.content,
    extractionMethod: row.extractionMethod,
  }));
}

export function selectExtractionBlocks(blocks: readonly StoredBlock[]): StoredBlock[] {
  const transcribedPages = new Set(
    blocks
      .filter((block) => block.extractionMethod === 'model_transcription')
      .map((block) => block.physicalPage),
  );

  return blocks.filter((block) => {
    if (block.extractionMethod === 'model_transcription') return true;
    if (!transcribedPages.has(block.physicalPage)) return true;
    return block.blockType !== 'table' && block.blockType !== 'chart';
  });
}

function nativeBlocksByPage(
  blocks: readonly StoredBlock[],
): Map<number, readonly EvidenceBlock[]> {
  const byPage = new Map<number, EvidenceBlock[]>();

  for (const block of blocks) {
    if (block.extractionMethod !== 'native_text') continue;
    const existing = byPage.get(block.physicalPage);
    if (existing === undefined) byPage.set(block.physicalPage, [block]);
    else existing.push(block);
  }

  return byPage;
}

export async function extractDocument(
  context: ProcessingContext,
  options: ExtractionStageOptions,
): Promise<ExtractionSummary> {
  const { db } = context.database;
  const tokenBudget = options.tokenBudget ?? DEFAULTS.tokenBudget;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const maxConsecutive = options.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures;
  const maxAny = options.maxConsecutiveAny ?? DEFAULTS.maxConsecutiveAny;

  const blocks = await loadBlocks(db, context.job.documentId);
  const blocksById = new Map(blocks.map((block) => [block.id, block as EvidenceBlock]));
  const byPage = nativeBlocksByPage(blocks);

  const chunks = chunkSourceBlocks(selectExtractionBlocks(blocks));

  const vocabulary = renderRegistry(await loadRegistry(db, context.job.collectionId));

  const identity: ExtractionIdentity = {
    promptVersion: EXTRACTION_PROMPT_VERSION,
    modelName: options.client.model,
    vocabulary,
  };

  const fingerprints = new Map(chunks.map((chunk) => [chunk.index, chunkFingerprint(chunk, identity)]));
  const completed = await loadCompletedChunks(
    db,
    context.job.documentId,
    [...fingerprints.values()],
    identity,
  );

  await recordProgress(db, context.job.runId, { chunksTotal: chunks.length, chunksProcessed: 0 });

  await db
    .update(processingRuns)
    .set({ modelName: options.client.model, promptVersion: EXTRACTION_PROMPT_VERSION })
    .where(eq(processingRuns.id, context.job.runId));

  if (chunks.length === 0) {
    return {
      chunksTotal: 0,
      chunksProcessed: 0,
      chunksResumed: 0,
      chunksFailed: 0,
      claimsExtracted: 0,
      claimsAccepted: 0,
      claimsNeedingReview: 0,
      claimsRejected: 0,
      promptTokens: 0,
      completionTokens: 0,
      spentPromptTokens: 0,
      spentCompletionTokens: 0,
      stoppedEarly: false,
    };
  }

  const pending: Chunk[] = [];
  let next = 0;
  let processed = 0;
  let resumed = 0;
  let failed = 0;
  let extracted = 0;
  let accepted = 0;
  let needsReview = 0;
  let rejected = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let spentPromptTokens = 0;
  let spentCompletionTokens = 0;
  let consecutive = 0;
  let consecutiveAny = 0;
  let stoppedEarly = false;

  const stop = async (reason: string, failureKind: string): Promise<void> => {
    if (stoppedEarly) return;
    stoppedEarly = true;
    await recordIssue(db, context.job.runId, {
      stage: 'extracting',
      failureKind,
      failureClass: 'transient',
      message: reason,
    });
  };

  const runBatch = async (batch: ChunkBatch): Promise<void> => {
    const result = await extractBatch(batch, { client: options.client, vocabulary });

    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    spentPromptTokens += result.promptTokens;
    spentCompletionTokens += result.completionTokens;
    extracted += result.claims.length;

    const chunkOfBlock = new Map<string, number>();
    for (const passage of batch.passages) {
      for (const ref of passage.chunk.blockRefs) {
        chunkOfBlock.set(ref.sourceBlockId, passage.chunk.index);
      }
    }

    const tally = new Map<number, { extracted: number; accepted: number; review: number; rejected: number }>();
    for (const passage of batch.passages) {
      tally.set(passage.chunk.index, { extracted: 0, accepted: 0, review: 0, rejected: 0 });
    }

    let unattributed = 0;

    for (const claim of result.claims) {
      const verification = verifyClaim(claim, {
        documentId: context.job.documentId,
        refToBlockId: batch.refToBlockId,
        blocksById,
        nativeBlocksByPage: byPage,
      });

      const stored = await persistClaim(db, claim, verification.evidence, {
        documentId: context.job.documentId,
        runId: context.job.runId,
      });

      if (stored.status === 'accepted') accepted += 1;
      else if (stored.status === 'needs_review') needsReview += 1;
      else rejected += 1;

      const owner = claim.evidence_block_ids
        .map((ref) => batch.refToBlockId.get(ref))
        .find((blockId) => blockId !== undefined && chunkOfBlock.has(blockId));
      const counts = owner === undefined ? undefined : tally.get(chunkOfBlock.get(owner) ?? -1);

      if (counts === undefined) {
        unattributed += 1;
        continue;
      }

      counts.extracted += 1;
      if (stored.status === 'accepted') counts.accepted += 1;
      else if (stored.status === 'needs_review') counts.review += 1;
      else counts.rejected += 1;
    }

    const weights = batch.passages.map((passage) => passage.chunk.estimatedTokens);
    const promptShares = apportion(result.promptTokens, weights);
    const completionShares = apportion(result.completionTokens, weights);

    for (const [position, passage] of batch.passages.entries()) {
      const counts = tally.get(passage.chunk.index);
      if (counts === undefined || counts.rejected > 0 || unattributed > 0) continue;

      const fingerprint =
        fingerprints.get(passage.chunk.index) ?? chunkFingerprint(passage.chunk, identity);

      await recordCompletedChunk(db, context.job.documentId, passage.chunk, fingerprint, identity, {
        claimsExtracted: counts.extracted,
        claimsAccepted: counts.accepted,
        claimsNeedingReview: counts.review,
        claimsRejected: 0,
        promptTokens: promptShares[position] ?? 0,
        completionTokens: completionShares[position] ?? 0,
      });
    }
  };

  for (const chunk of chunks) {
    const fingerprint = fingerprints.get(chunk.index) ?? chunkFingerprint(chunk, identity);
    const cached = completed.get(fingerprint);

    if (cached === undefined) {
      pending.push(chunk);
      continue;
    }

    promptTokens += cached.promptTokens;
    completionTokens += cached.completionTokens;
    extracted += cached.claimsExtracted;
    accepted += cached.claimsAccepted;
    needsReview += cached.claimsNeedingReview;
    rejected += cached.claimsRejected;
    processed += 1;
    resumed += 1;
  }

  const batches = planBatches(pending, {
    ...(options.batchInputTokens !== undefined ? { maxInputTokens: options.batchInputTokens } : {}),
    ...(options.batchMaxChunks !== undefined ? { maxChunks: options.batchMaxChunks } : {}),
  });

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stoppedEarly) return;

      if (spentPromptTokens + spentCompletionTokens >= tokenBudget) {
        await stop(
          `stopped after ${spentPromptTokens + spentCompletionTokens} tokens, the per-document budget; ${chunks.length - processed - failed} chunks were not attempted`,
          'token_budget_exhausted',
        );
        return;
      }

      if (consecutive >= maxConsecutive) {
        await stop(
          `stopped after ${consecutive} consecutive chunks the provider would not serve; ${chunks.length - processed - failed} chunks were not attempted`,
          'extraction_abandoned',
        );
        return;
      }

      if (consecutiveAny >= maxAny) {
        await stop(
          `stopped after ${consecutiveAny} consecutive failed chunks; ${chunks.length - processed - failed} chunks were not attempted`,
          'extraction_abandoned',
        );
        return;
      }

      const index = next;
      next += 1;
      const batch = batches[index];
      if (batch === undefined) return;

      const first = batch.passages[0]?.chunk;
      const pages = [...new Set(batch.passages.flatMap((passage) => passage.chunk.physicalPages))];

      try {
        await runBatch(batch);
        processed += batch.passages.length;
        consecutive = 0;
        consecutiveAny = 0;
      } catch (error) {
        failed += batch.passages.length;

        const modelError = error instanceof ModelError ? error : null;
        const run = classifyFailure(error);

        consecutiveAny += 1;
        if (run !== 'malformed') consecutive += 1;

        await recordIssue(db, context.job.runId, {
          stage: 'extracting',
          failureKind: modelError?.kind ?? 'extraction_failed',
          failureClass: modelError !== null && modelError.retryable ? 'transient' : 'permanent',
          message: `${batch.passages.length === 1 ? `chunk ${first?.index}` : `chunks ${batch.passages.map((passage) => passage.chunk.index).join(', ')}`} (page ${pages.join(', ')}): ${(error as Error).message.slice(0, 300)}`,
          ...(pages[0] !== undefined ? { physicalPage: pages[0] } : {}),
        });

        if (modelError !== null) {
          throw new ProcessingError(
            `extraction call failed on chunk ${first?.index ?? 0}: ${modelError.message}`,
            modelError.kind,
            modelError.retryable ? 'transient' : 'permanent',
            'extracting',
            pages[0],
          );
        }
      }

      await recordProgress(db, context.job.runId, {
        chunksProcessed: processed,
        claimsExtracted: extracted,
        claimsAccepted: accepted,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()),
  );

  await db
    .update(processingRuns)
    .set({ inputTokens: promptTokens, outputTokens: completionTokens })
    .where(eq(processingRuns.id, context.job.runId));

  await recordProgress(db, context.job.runId, {
    chunksProcessed: processed,
    claimsExtracted: extracted,
    claimsAccepted: accepted,
  });

  const used = await db
    .selectDistinct({ predicate: claims.predicate, unit: claims.unit })
    .from(claims)
    .where(eq(claims.documentId, context.job.documentId));

  if (used.length > 0) {
    await registerPredicates(
      db,
      context.job.collectionId,
      used.map((row) => ({ name: row.predicate, unit: row.unit })),
    );
  }

  return {
    chunksTotal: chunks.length,
    chunksProcessed: processed,
    chunksResumed: resumed,
    chunksFailed: failed,
    claimsExtracted: extracted,
    claimsAccepted: accepted,
    claimsNeedingReview: needsReview,
    claimsRejected: rejected,
    promptTokens,
    completionTokens,
    spentPromptTokens,
    spentCompletionTokens,
    stoppedEarly,
  };
}

export function createExtractionStage(options: ExtractionStageOptions): StageHandler {
  return {
    stage: 'extracting',
    async run(context) {
      await extractDocument(context, options);
    },
  };
}
