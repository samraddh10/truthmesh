import { eq, sql } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { processingIssues, processingRuns } from '@superjoin/db';

export type RunStage =
  | 'queued'
  | 'parsing'
  | 'extracting'
  | 'normalizing'
  | 'comparing'
  | 'completed'
  | 'completed_with_issues'
  | 'failed';

export type FailureClass = 'transient' | 'permanent';

export interface FailureRecord {
  readonly stage: RunStage;
  readonly failureKind: string;
  readonly failureClass: FailureClass;
  readonly message: string;
  readonly physicalPage?: number;
  readonly detail?: Record<string, unknown>;
}

export async function beginRun(db: Database, runId: string, stage: RunStage): Promise<void> {
  await db
    .update(processingRuns)
    .set({
      stage,
      startedAt: sql`coalesce(${processingRuns.startedAt}, now())`,
      heartbeatAt: new Date(),
      finishedAt: null,
    })
    .where(eq(processingRuns.id, runId));
}

export async function enterStage(db: Database, runId: string, stage: RunStage): Promise<void> {
  await db
    .update(processingRuns)
    .set({ stage, heartbeatAt: new Date() })
    .where(eq(processingRuns.id, runId));
}

export async function heartbeat(db: Database, runId: string): Promise<void> {
  await db
    .update(processingRuns)
    .set({ heartbeatAt: new Date() })
    .where(eq(processingRuns.id, runId));
}

export interface ProgressUpdate {
  readonly pagesProcessed?: number;
  readonly chunksTotal?: number;
  readonly chunksProcessed?: number;
  readonly claimsExtracted?: number;
  readonly claimsAccepted?: number;
  readonly relationshipsCreated?: number;
}

export async function recordProgress(
  db: Database,
  runId: string,
  progress: ProgressUpdate,
): Promise<void> {
  const values: Record<string, unknown> = { heartbeatAt: new Date() };
  for (const [key, value] of Object.entries(progress)) {
    if (value !== undefined) values[key] = value;
  }

  await db.update(processingRuns).set(values).where(eq(processingRuns.id, runId));
}

export async function recordIssue(
  db: Database,
  runId: string,
  failure: FailureRecord,
): Promise<string> {
  const existing = await db
    .select({ id: processingIssues.id, attemptCount: processingIssues.attemptCount })
    .from(processingIssues)
    .where(
      sql`${processingIssues.runId} = ${runId}
        and ${processingIssues.failureKind} = ${failure.failureKind}
        and ${processingIssues.physicalPage} is not distinct from ${failure.physicalPage ?? null}`,
    )
    .limit(1);

  const first = existing[0];
  if (first !== undefined) {
    await db
      .update(processingIssues)
      .set({
        attemptCount: first.attemptCount + 1,
        lastAttemptAt: new Date(),
        message: failure.message,
        resolution: 'retrying',
      })
      .where(eq(processingIssues.id, first.id));
    return first.id;
  }

  const [created] = await db
    .insert(processingIssues)
    .values({
      runId,
      stage: failure.stage,
      failureKind: failure.failureKind,
      isTransient: failure.failureClass === 'transient',
      message: failure.message,
      lastAttemptAt: new Date(),
      ...(failure.physicalPage !== undefined ? { physicalPage: failure.physicalPage } : {}),
      ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
    })
    .returning({ id: processingIssues.id });

  return created!.id;
}

export async function resolveOpenIssues(
  db: Database,
  runId: string,
  note: string,
  attemptStartedAt: Date,
): Promise<void> {
  await db
    .update(processingIssues)
    .set({ resolution: 'resolved', resolutionNote: note })
    .where(
      sql`${processingIssues.runId} = ${runId}
        and ${processingIssues.resolution} in ('open', 'retrying')
        and coalesce(${processingIssues.lastAttemptAt}, ${processingIssues.createdAt}) < ${attemptStartedAt}`,
    );
}

export async function finishRun(
  db: Database,
  runId: string,
  outcome: { readonly failed: boolean; readonly errorSummary?: string },
): Promise<RunStage> {
  const [counts] = await db
    .select({
      unresolved: sql<number>`count(*) filter (where ${processingIssues.resolution} in ('open', 'retrying', 'abandoned'))`,
    })
    .from(processingIssues)
    .where(eq(processingIssues.runId, runId));

  const hasIssues = Number(counts?.unresolved ?? 0) > 0;
  const stage: RunStage = outcome.failed
    ? 'failed'
    : hasIssues
      ? 'completed_with_issues'
      : 'completed';

  await db
    .update(processingRuns)
    .set({
      stage,
      finishedAt: new Date(),
      heartbeatAt: new Date(),
      errorSummary: outcome.errorSummary ?? null,
    })
    .where(eq(processingRuns.id, runId));

  return stage;
}

export async function abandonIssue(db: Database, issueId: string, note: string): Promise<void> {
  await db
    .update(processingIssues)
    .set({ resolution: 'abandoned', resolutionNote: note })
    .where(eq(processingIssues.id, issueId));
}
