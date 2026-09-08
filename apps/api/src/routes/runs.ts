import { isTerminal, type ProcessingIssueResponse, type RunStatus } from '@superjoin/contracts';
import { documents, processingIssues, processingRuns } from '@superjoin/db';
import { DOCUMENT_QUEUE, enqueueDocumentJob, type IngestionContext } from '@superjoin/pipeline';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export interface RunRouteDependencies {
  readonly ingestion: IngestionContext;
  readonly stalledAfterMs: number;
}

export const DEFAULT_STALLED_AFTER_MS = 5 * 60 * 1000;

export async function registerRunRoutes(
  app: FastifyInstance,
  deps: RunRouteDependencies,
): Promise<void> {
  const { db } = deps.ingestion.database;

  async function loadRun(
    runId: string,
  ): Promise<{ status: RunStatus; collectionId: string } | null> {
    const [row] = await db
      .select({
        run: processingRuns,
        filename: documents.filename,
        collectionId: documents.collectionId,
      })
      .from(processingRuns)
      .innerJoin(documents, eq(documents.id, processingRuns.documentId))
      .where(eq(processingRuns.id, runId))
      .limit(1);

    if (row === undefined) return null;

    const issueRows = await db
      .select()
      .from(processingIssues)
      .where(eq(processingIssues.runId, runId))
      .orderBy(desc(processingIssues.createdAt));

    const issues: ProcessingIssueResponse[] = issueRows.map((issue) => ({
      id: issue.id,
      stage: issue.stage,
      failureKind: issue.failureKind,
      isTransient: issue.isTransient,
      physicalPage: issue.physicalPage,
      message: issue.message,
      attemptCount: issue.attemptCount,
      resolution: issue.resolution,
    }));

    const { run } = row;
    const terminal = isTerminal(run.stage);
    const lastTouched = run.heartbeatAt ?? run.startedAt ?? run.createdAt;

    const status: RunStatus = {
      id: run.id,
      documentId: run.documentId,
      filename: row.filename,
      stage: run.stage,
      terminal,
      progress: {
        pagesTotal: run.pagesTotal,
        pagesProcessed: run.pagesProcessed,
        chunksTotal: run.chunksTotal,
        chunksProcessed: run.chunksProcessed,
        claimsExtracted: run.claimsExtracted,
        claimsAccepted: run.claimsAccepted,
        relationshipsCreated: run.relationshipsCreated,
      },
      errorSummary: run.errorSummary,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      heartbeatAt: run.heartbeatAt?.toISOString() ?? null,
      stalled:
        !terminal &&
        run.stage !== 'queued' &&
        Date.now() - lastTouched.getTime() > deps.stalledAfterMs,
      issues,
    };

    return { status, collectionId: row.collectionId };
  }

  app.get('/runs/:id', async (request, reply) => {
    const runId = (request.params as { id: string }).id;
    const found = await loadRun(runId);

    if (found === null) {
      reply.code(404);
      return { error: 'run_not_found', message: `no run with id ${runId}` };
    }
    return found.status;
  });

  app.post('/runs/:id/retry', async (request, reply) => {
    const runId = (request.params as { id: string }).id;

    const requested = (request.query as { stages?: string }).stages;
    const stages =
      requested === undefined
        ? undefined
        : requested.split(',').map((name) => name.trim()).filter((name) => name !== '');

    if (stages !== undefined && stages.length === 0) {
      reply.code(400);
      return { error: 'invalid_stages', message: 'stages was given but named nothing' };
    }

    const found = await loadRun(runId);

    if (found === null) {
      reply.code(404);
      return { error: 'run_not_found', message: `no run with id ${runId}` };
    }

    const { status, collectionId } = found;

    if (!status.terminal && !status.stalled) {
      reply.code(409);
      return {
        error: 'run_in_progress',
        message: `run is at stage ${status.stage} and has not stalled; retry is not applicable`,
      };
    }

    await db.transaction(async (tx) => {
      await tx
        .update(processingRuns)
        .set({
          stage: 'queued',
          errorSummary: null,
          startedAt: null,
          finishedAt: null,
          heartbeatAt: null,
          ...(stages === undefined ? { pagesProcessed: 0, chunksProcessed: 0 } : {}),
        })
        .where(eq(processingRuns.id, runId));

      await enqueueDocumentJob(deps.ingestion.boss, tx, {
        runId,
        documentId: status.documentId,
        collectionId,
        ...(stages !== undefined ? { stages } : {}),
      });
    });

    reply.code(202);
    return { runId, stage: 'queued', queue: DOCUMENT_QUEUE, ...(stages !== undefined ? { stages } : {}) };
  });
}
