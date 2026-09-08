import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { DocumentList, DocumentSummary, ProcessingIssueResponse } from '@superjoin/contracts';
import { isTerminal } from '@superjoin/contracts';
import { collections, documents, processingIssues, processingRuns } from '@superjoin/db';
import { resolvePath, StorageError, type IngestionContext } from '@superjoin/pipeline';
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export interface DocumentRouteDependencies {
  readonly ingestion: IngestionContext;
  readonly stalledAfterMs: number;
}

export async function registerDocumentRoutes(
  app: FastifyInstance,
  deps: DocumentRouteDependencies,
): Promise<void> {
  const { db } = deps.ingestion.database;
  const { storageDir } = deps.ingestion;

  app.get('/collections/:id/documents', async (request, reply) => {
    const collectionId = (request.params as { id: string }).id;

    const [collection] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.id, collectionId))
      .limit(1);

    if (collection === undefined) {
      reply.code(404);
      return { error: 'collection_not_found', message: `no collection with id ${collectionId}` };
    }

    const documentRows = await db
      .select()
      .from(documents)
      .where(eq(documents.collectionId, collectionId))
      .orderBy(documents.createdAt, documents.id);

    if (documentRows.length === 0) {
      return { collectionId, items: [] } satisfies DocumentList;
    }

    const documentIds = documentRows.map((row) => row.id);

    const runRows = await db
      .select()
      .from(processingRuns)
      .where(inArray(processingRuns.documentId, documentIds))
      .orderBy(desc(processingRuns.createdAt));

    const latestRun = new Map<string, (typeof runRows)[number]>();
    for (const run of runRows) {
      if (!latestRun.has(run.documentId)) latestRun.set(run.documentId, run);
    }

    const runIds = [...latestRun.values()].map((run) => run.id);
    const issueRows =
      runIds.length === 0
        ? []
        : await db
            .select()
            .from(processingIssues)
            .where(inArray(processingIssues.runId, runIds))
            .orderBy(desc(processingIssues.createdAt));

    const issuesByRun = new Map<string, ProcessingIssueResponse[]>();
    for (const issue of issueRows) {
      const list = issuesByRun.get(issue.runId) ?? [];
      list.push({
        id: issue.id,
        stage: issue.stage,
        failureKind: issue.failureKind,
        isTransient: issue.isTransient,
        physicalPage: issue.physicalPage,
        message: issue.message,
        attemptCount: issue.attemptCount,
        resolution: issue.resolution,
      });
      issuesByRun.set(issue.runId, list);
    }

    const now = Date.now();
    const items: DocumentSummary[] = documentRows.map((document) => {
      const run = latestRun.get(document.id);

      return {
        id: document.id,
        collectionId: document.collectionId,
        filename: document.filename,
        contentHash: document.contentHash,
        byteSize: document.byteSize,
        pageCount: document.pageCount,
        publicationDate: document.publicationDate,
        createdAt: document.createdAt.toISOString(),
        latestRun:
          run === undefined
            ? null
            : {
                id: run.id,
                stage: run.stage,
                terminal: isTerminal(run.stage),
                stalled:
                  !isTerminal(run.stage) &&
                  run.stage !== 'queued' &&
                  now - (run.heartbeatAt ?? run.startedAt ?? run.createdAt).getTime() >
                    deps.stalledAfterMs,
                pagesTotal: run.pagesTotal,
                pagesProcessed: run.pagesProcessed,
                chunksTotal: run.chunksTotal,
                chunksProcessed: run.chunksProcessed,
                claimsExtracted: run.claimsExtracted,
                claimsAccepted: run.claimsAccepted,
                relationshipsCreated: run.relationshipsCreated,
                errorSummary: run.errorSummary,
                startedAt: run.startedAt?.toISOString() ?? null,
                finishedAt: run.finishedAt?.toISOString() ?? null,
                issues: issuesByRun.get(run.id) ?? [],
              },
      };
    });

    return { collectionId, items } satisfies DocumentList;
  });

  app.get('/documents/:id/file', async (request, reply) => {
    const documentId = (request.params as { id: string }).id;

    const [document] = await db
      .select({
        id: documents.id,
        filename: documents.filename,
        storageKey: documents.storageKey,
        byteSize: documents.byteSize,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (document === undefined) {
      reply.code(404);
      return { error: 'document_not_found', message: `no document with id ${documentId}` };
    }

    let path: string;
    try {
      path = resolvePath(storageDir, document.storageKey);
    } catch (error) {
      if (error instanceof StorageError) {
        request.log.error({ documentId, key: document.storageKey }, 'storage key escapes root');
        reply.code(500);
        return { error: 'storage_error', message: 'the stored file could not be resolved' };
      }
      throw error;
    }

    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) {
      reply.code(410);
      return {
        error: 'file_missing',
        message: `the stored file for document ${documentId} is no longer present`,
      };
    }

    reply
      .header('content-type', 'application/pdf')
      .header('content-length', String(info.size))
      .header(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
      );

    return reply.send(createReadStream(path));
  });
}
