import type { Database } from '@superjoin/db';

import { ModelError, type CompletionProvider } from '../model/index.ts';
import { extractPageText } from '../pdf-text.ts';
import { ProcessingError, type ProcessingContext, type StageHandler } from '../processor.ts';
import { heartbeat, recordIssue } from '../run-state.ts';
import { readObject } from '../storage.ts';
import { toLayoutText, buildLayout } from './layout.ts';
import {
  TRANSCRIPTION_PROMPT_VERSION,
  pagesNeedingTranscription,
  persistTranscription,
  transcribePage,
} from './transcribe.ts';

export interface VisualStageOptions {
  readonly client: CompletionProvider;
  readonly documentHash: (context: ProcessingContext) => Promise<string> | string;
  readonly maxPages?: number;
  readonly scale?: number;
}

const DEFAULTS = {
  maxPages: 40,
} as const;

export interface VisualSummary {
  readonly pagesConsidered: number;
  readonly pagesTranscribed: number;
  readonly pagesFailed: number;
  readonly blocksWritten: number;
}

export async function transcribeDocument(
  context: ProcessingContext,
  options: VisualStageOptions,
): Promise<VisualSummary> {
  const { db } = context.database;
  const maxPages = options.maxPages ?? DEFAULTS.maxPages;

  const producedBy = `${options.client.model}/${TRANSCRIPTION_PROMPT_VERSION}`;

  const candidates = await pagesNeedingTranscription(
    db as Database,
    context.job.documentId,
    producedBy,
  );
  const selected = candidates.slice(0, maxPages);

  if (selected.length === 0) {
    return {
      pagesConsidered: 0,
      pagesTranscribed: 0,
      pagesFailed: 0,
      blocksWritten: 0,
    };
  }

  const bytes = await readObject(context.storageDir, context.storageKey);
  const documentHash = await options.documentHash(context);

  let transcribed = 0;
  let failed = 0;
  let blocksWritten = 0;

  for (const physicalPage of selected) {
    await heartbeat(db, context.job.runId);

    try {
      const pageText = await extractPageText(bytes, physicalPage);
      const nativeText = toLayoutText(buildLayout(pageText));

      const result = await transcribePage(bytes, physicalPage, nativeText, {
        client: options.client,
        storageDir: context.storageDir,
        documentHash,
        ...(options.scale !== undefined ? { scale: options.scale } : {}),
      });

      blocksWritten += await persistTranscription(
        db,
        context.job.documentId,
        result,
        producedBy,
      );
      transcribed += 1;
    } catch (error) {
      const modelError = error instanceof ModelError ? error : null;
      const isThrottle = modelError?.kind === 'provider_rate_limited';

      if (modelError === null) failed += 1;

      await recordIssue(db, context.job.runId, {
        stage: 'parsing',
        failureKind: isThrottle ? 'visual_route_throttled' : 'visual_route_failed',
        failureClass: modelError !== null && modelError.retryable ? 'transient' : 'permanent',
        message: `physical page ${physicalPage}: ${(error as Error).message.slice(0, 300)}`,
        physicalPage,
      });

      if (modelError !== null) {
        throw new ProcessingError(
          `transcription call failed on physical page ${physicalPage}: ${modelError.message}`,
          modelError.kind,
          modelError.retryable ? 'transient' : 'permanent',
          'parsing',
          physicalPage,
        );
      }
    }
  }

  return {
    pagesConsidered: selected.length,
    pagesTranscribed: transcribed,
    pagesFailed: failed,
    blocksWritten,
  };
}

export function createVisualStage(options: VisualStageOptions): StageHandler {
  return {
    stage: 'parsing',
    async run(context) {
      await transcribeDocument(context, options);
    },
  };
}
