import { rm } from 'node:fs/promises';

import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { Database, DatabaseHandle } from '@superjoin/db';
import { documents, processingRuns } from '@superjoin/db';

import { enqueueDocumentJob } from './queue.ts';
import { documentStorageKey, resolvePath, writeObject } from './storage.ts';
import { validateUpload, type RejectionReason, type ValidationLimits } from './validation.ts';

export interface IngestionRequest {
  readonly collectionId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export interface IngestionContext {
  readonly database: DatabaseHandle;
  readonly boss: PgBoss;
  readonly storageDir: string;
  readonly limits: ValidationLimits;
  readonly pipelineVersion: string;
}

export type IngestionOutcome =
  | {
      readonly status: 'accepted';
      readonly documentId: string;
      readonly runId: string;
      readonly contentHash: string;
      readonly pageCount: number;
    }
  | {
      readonly status: 'duplicate';
      readonly documentId: string;
      readonly contentHash: string;
      readonly filename: string;
    }
  | {
      readonly status: 'rejected';
      readonly reason: RejectionReason;
      readonly message: string;
    };

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === UNIQUE_VIOLATION;
}

async function findExisting(db: Database, collectionId: string, hash: string) {
  const [existing] = await db
    .select({ id: documents.id, filename: documents.filename })
    .from(documents)
    .where(and(eq(documents.collectionId, collectionId), eq(documents.contentHash, hash)))
    .limit(1);
  return existing;
}

export async function ingestDocument(
  context: IngestionContext,
  request: IngestionRequest,
): Promise<IngestionOutcome> {
  const validation = await validateUpload(request.bytes, context.limits);
  if (!validation.ok) {
    return { status: 'rejected', reason: validation.reason, message: validation.message };
  }

  const { db } = context.database;
  const { contentHash: hash, pageCount, byteSize } = validation;

  const alreadyPresent = await findExisting(db, request.collectionId, hash);
  if (alreadyPresent !== undefined) {
    return {
      status: 'duplicate',
      documentId: alreadyPresent.id,
      filename: alreadyPresent.filename,
      contentHash: hash,
    };
  }

  const storageKey = documentStorageKey(hash);
  await writeObject(context.storageDir, storageKey, request.bytes);

  try {
    return await db.transaction(async (tx) => {
      const [document] = await tx
        .insert(documents)
        .values({
          collectionId: request.collectionId,
          filename: request.filename,
          contentHash: hash,
          storageKey,
          byteSize,
          pageCount,
        })
        .returning({ id: documents.id });

      const [run] = await tx
        .insert(processingRuns)
        .values({
          documentId: document!.id,
          stage: 'queued',
          pipelineVersion: context.pipelineVersion,
          pagesTotal: pageCount,
        })
        .returning({ id: processingRuns.id });

      await enqueueDocumentJob(context.boss, tx, {
        runId: run!.id,
        documentId: document!.id,
        collectionId: request.collectionId,
      });

      return {
        status: 'accepted' as const,
        documentId: document!.id,
        runId: run!.id,
        contentHash: hash,
        pageCount,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await findExisting(db, request.collectionId, hash);
      if (winner !== undefined) {
        return {
          status: 'duplicate',
          documentId: winner.id,
          filename: winner.filename,
          contentHash: hash,
        };
      }
    }

    await removeQuietly(context.storageDir, storageKey);
    throw error;
  }
}

async function removeQuietly(storageDir: string, key: string): Promise<void> {
  try {
    await rm(resolvePath(storageDir, key), { force: true });
  } catch {
  }
}
