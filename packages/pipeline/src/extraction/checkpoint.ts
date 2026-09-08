import { createHash } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { chunkExtractions } from '@superjoin/db';

import type { Chunk } from '../parsing/chunk.ts';

export interface ChunkOutcome {
  readonly claimsExtracted: number;
  readonly claimsAccepted: number;
  readonly claimsNeedingReview: number;
  readonly claimsRejected: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface ExtractionIdentity {
  readonly promptVersion: string;
  readonly modelName: string;
  readonly vocabulary: string;
}

export function chunkFingerprint(chunk: Chunk, identity: ExtractionIdentity): string {
  const hash = createHash('sha256');

  const field = (value: string): void => {
    hash.update(value);
    hash.update('\u001f');
  };

  field(chunk.text);
  field(chunk.heading ?? '');

  for (const ref of chunk.blockRefs) {
    field(`${ref.ref}=${ref.sourceBlockId}`);
  }

  field(identity.vocabulary);
  field(identity.promptVersion);
  field(identity.modelName);

  return hash.digest('hex');
}

export async function loadCompletedChunks(
  db: Database,
  documentId: string,
  fingerprints: readonly string[],
  identity: ExtractionIdentity,
): Promise<Map<string, ChunkOutcome>> {
  if (fingerprints.length === 0) return new Map();

  const rows = await db
    .select({
      chunkFingerprint: chunkExtractions.chunkFingerprint,
      claimsExtracted: chunkExtractions.claimsExtracted,
      claimsAccepted: chunkExtractions.claimsAccepted,
      claimsNeedingReview: chunkExtractions.claimsNeedingReview,
      claimsRejected: chunkExtractions.claimsRejected,
      promptTokens: chunkExtractions.promptTokens,
      completionTokens: chunkExtractions.completionTokens,
    })
    .from(chunkExtractions)
    .where(
      and(
        eq(chunkExtractions.documentId, documentId),
        eq(chunkExtractions.promptVersion, identity.promptVersion),
        eq(chunkExtractions.modelName, identity.modelName),
        inArray(chunkExtractions.chunkFingerprint, [...fingerprints]),
      ),
    );

  const completed = new Map<string, ChunkOutcome>();

  for (const row of rows) {
    completed.set(row.chunkFingerprint, {
      claimsExtracted: row.claimsExtracted,
      claimsAccepted: row.claimsAccepted,
      claimsNeedingReview: row.claimsNeedingReview,
      claimsRejected: row.claimsRejected,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
    });
  }

  return completed;
}

export async function recordCompletedChunk(
  db: Database,
  documentId: string,
  chunk: Chunk,
  fingerprint: string,
  identity: ExtractionIdentity,
  outcome: ChunkOutcome,
): Promise<void> {
  await db
    .insert(chunkExtractions)
    .values({
      documentId,
      chunkFingerprint: fingerprint,
      chunkIndex: chunk.index,
      promptVersion: identity.promptVersion,
      modelName: identity.modelName,
      ...outcome,
    })
    .onConflictDoNothing();
}
