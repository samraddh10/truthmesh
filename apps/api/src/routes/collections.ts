import { randomUUID } from 'node:crypto';

import '@fastify/multipart';

import {
  createCollectionSchema,
  type UploadResponse,
  type UploadResult,
} from '@superjoin/contracts';
import { collections } from '@superjoin/db';
import { ingestDocument, type IngestionContext } from '@superjoin/pipeline';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export interface RouteDependencies {
  readonly ingestion: IngestionContext;
  readonly maxUploadBytes: number;
}

export async function registerCollectionRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): Promise<void> {
  const { db } = deps.ingestion.database;

  app.post('/collections', async (request, reply) => {
    const parsed = createCollectionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' };
    }

    const [created] = await db
      .insert(collections)
      .values({
        name: parsed.data.name,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      })
      .returning();

    reply.code(201);
    return {
      id: created!.id,
      name: created!.name,
      description: created!.description,
      createdAt: created!.createdAt.toISOString(),
    };
  });

  app.get('/collections', async () => {
    const rows = await db.select().from(collections).orderBy(desc(collections.createdAt));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
    }));
  });

  app.post('/collections/:id/documents', async (request, reply) => {
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

    if (!request.isMultipart()) {
      reply.code(415);
      return {
        error: 'unsupported_media_type',
        message: 'upload PDFs as multipart/form-data',
      };
    }

    const results: UploadResult[] = [];

    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;

      const filename = part.filename !== '' ? part.filename : `upload-${randomUUID()}.pdf`;
      let bytes: Uint8Array;

      try {
        bytes = new Uint8Array(await part.toBuffer());
      } catch (error) {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          results.push({
            status: 'rejected',
            filename,
            reason: 'too_large',
            message: `the file is above the ${(deps.maxUploadBytes / (1024 * 1024)).toFixed(0)}MB limit`,
          });
          continue;
        }
        throw error;
      }

      const outcome = await ingestDocument(deps.ingestion, { collectionId, filename, bytes });

      if (outcome.status === 'accepted') {
        results.push({
          status: 'accepted',
          filename,
          documentId: outcome.documentId,
          runId: outcome.runId,
          contentHash: outcome.contentHash,
          pageCount: outcome.pageCount,
        });
      } else if (outcome.status === 'duplicate') {
        results.push({
          status: 'duplicate',
          filename,
          documentId: outcome.documentId,
          contentHash: outcome.contentHash,
          existingFilename: outcome.filename,
        });
      } else {
        results.push({
          status: 'rejected',
          filename,
          reason: outcome.reason,
          message: outcome.message,
        });
      }
    }

    if (results.length === 0) {
      reply.code(400);
      return { error: 'no_files', message: 'the request contained no files' };
    }

    reply.code(202);
    return { collectionId, results } satisfies UploadResponse;
  });
}
