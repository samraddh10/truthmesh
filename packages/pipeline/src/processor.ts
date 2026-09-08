import { eq } from 'drizzle-orm';

import type { DatabaseHandle } from '@superjoin/db';
import { documents, processingRuns } from '@superjoin/db';

import type { DocumentJob } from './queue.ts';
import {
  beginRun,
  enterStage,
  finishRun,
  recordIssue,
  resolveOpenIssues,
  type FailureClass,
  type RunStage,
} from './run-state.ts';
import { objectExists } from './storage.ts';

export class ProcessingError extends Error {
  override readonly name = 'ProcessingError';

  constructor(
    message: string,
    readonly failureKind: string,
    readonly failureClass: FailureClass,
    readonly stage: RunStage,
    readonly physicalPage?: number,
  ) {
    super(message);
  }
}

export function classifyFailure(error: unknown): {
  failureKind: string;
  failureClass: FailureClass;
} {
  if (error instanceof ProcessingError) {
    return { failureKind: error.failureKind, failureClass: error.failureClass };
  }

  const code = (error as { code?: string }).code ?? '';
  const message = (error as { message?: string }).message ?? '';

  if (/rate.?limit|429|too many requests/i.test(message)) {
    return { failureKind: 'provider_rate_limited', failureClass: 'transient' };
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || /timeout/i.test(message)) {
    return { failureKind: 'provider_timeout', failureClass: 'transient' };
  }
  if (code === 'ECONNREFUSED') {
    return { failureKind: 'dependency_unavailable', failureClass: 'transient' };
  }

  return { failureKind: 'unexpected_error', failureClass: 'transient' };
}

export interface StageHandler {
  readonly stage: RunStage;
  run(context: ProcessingContext): Promise<void>;
}

export interface ProcessingContext {
  readonly database: DatabaseHandle;
  readonly storageDir: string;
  readonly job: DocumentJob;
  readonly storageKey: string;
  readonly pageCount: number;
}

export interface ProcessorOptions {
  readonly database: DatabaseHandle;
  readonly storageDir: string;
  readonly stages: readonly StageHandler[];
}

export type ProcessingOutcome =
  | { readonly runId: string; readonly status: 'finished'; readonly stage: RunStage }
  | { readonly runId: string; readonly status: 'abandoned'; readonly reason: 'run_deleted' };

export async function processDocumentJob(
  options: ProcessorOptions,
  job: DocumentJob,
): Promise<ProcessingOutcome> {
  const { db } = options.database;

  const [run] = await db
    .select({ id: processingRuns.id })
    .from(processingRuns)
    .where(eq(processingRuns.id, job.runId))
    .limit(1);

  if (run === undefined) {
    return { runId: job.runId, status: 'abandoned', reason: 'run_deleted' };
  }

  const [document] = await db
    .select({
      storageKey: documents.storageKey,
      pageCount: documents.pageCount,
    })
    .from(documents)
    .where(eq(documents.id, job.documentId))
    .limit(1);

  if (document === undefined) {
    await recordIssue(db, job.runId, {
      stage: 'parsing',
      failureKind: 'document_missing',
      failureClass: 'permanent',
      message: `document ${job.documentId} no longer exists`,
    });
    const stage = await finishRun(db, job.runId, {
      failed: true,
      errorSummary: 'the document row was deleted before processing began',
    });
    return { runId: job.runId, status: 'finished', stage };
  }

  await beginRun(db, job.runId, 'parsing');

  const attemptStartedAt = new Date();

  if (!(await objectExists(options.storageDir, document.storageKey))) {
    await recordIssue(db, job.runId, {
      stage: 'parsing',
      failureKind: 'stored_file_missing',
      failureClass: 'permanent',
      message: `no stored object at ${document.storageKey}`,
    });
    const stage = await finishRun(db, job.runId, {
      failed: true,
      errorSummary: 'the uploaded file is missing from storage',
    });
    return { runId: job.runId, status: 'finished', stage };
  }

  const context: ProcessingContext = {
    database: options.database,
    storageDir: options.storageDir,
    job,
    storageKey: document.storageKey,
    pageCount: document.pageCount ?? 0,
  };

  const stages =
    job.stages === undefined
      ? options.stages
      : options.stages.filter((handler) => job.stages!.includes(handler.stage));

  for (const handler of stages) {
    try {
      await enterStage(db, job.runId, handler.stage);
      await handler.run(context);
    } catch (error) {
      const { failureKind, failureClass } = classifyFailure(error);
      await recordIssue(db, job.runId, {
        stage: handler.stage,
        failureKind,
        failureClass,
        message: (error as Error).message,
      });

      if (failureClass === 'transient') {
        throw error;
      }

      const stage = await finishRun(db, job.runId, {
        failed: true,
        errorSummary: `${failureKind}: ${(error as Error).message}`,
      });
      return { runId: job.runId, status: 'finished', stage };
    }
  }

  await resolveOpenIssues(
    db,
    job.runId,
    'a later attempt completed this stage',
    attemptStartedAt,
  );

  const stage = await finishRun(db, job.runId, { failed: false });
  return { runId: job.runId, status: 'finished', stage };
}
