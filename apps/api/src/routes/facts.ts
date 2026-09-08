import { collections } from '@superjoin/db';
import { claims, documents } from '@superjoin/db';
import {
  factQuerySchema,
  type FactList,
  type FactSummary,
} from '@superjoin/contracts';
import type { IngestionContext } from '@superjoin/pipeline';
import { and, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  claimOrdering,
  claimQuery,
  countClaims,
  loadEvidenceIndex,
  loadFactDetails,
  loadPredicates,
  toFactSummary,
} from './facts-read.ts';

export interface FactRouteDependencies {
  readonly ingestion: IngestionContext;
}

export async function registerFactRoutes(
  app: FastifyInstance,
  deps: FactRouteDependencies,
): Promise<void> {
  const { db } = deps.ingestion.database;

  app.get('/collections/:id/facts', async (request, reply) => {
    const collectionId = (request.params as { id: string }).id;

    const parsed = factQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_query',
        message: parsed.error.issues[0]?.message ?? 'invalid query parameters',
      };
    }

    const [collection] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.id, collectionId))
      .limit(1);

    if (collection === undefined) {
      reply.code(404);
      return { error: 'collection_not_found', message: `no collection with id ${collectionId}` };
    }

    const { documentId, entityId, predicate, status, limit, offset } = parsed.data;

    const conditions: SQL[] = [eq(documents.collectionId, collectionId)];
    if (documentId !== undefined) conditions.push(eq(claims.documentId, documentId));
    if (entityId !== undefined) conditions.push(eq(claims.entityId, entityId));
    if (predicate !== undefined) conditions.push(eq(claims.predicate, predicate));
    if (status !== undefined) conditions.push(eq(claims.status, status));
    const where = and(...conditions);

    const [rows, total, predicates] = await Promise.all([
      claimQuery(db).where(where).orderBy(...claimOrdering).limit(limit).offset(offset),
      countClaims(db, where),
      loadPredicates(db, collectionId),
    ]);

    const index = await loadEvidenceIndex(
      db,
      rows.map((row) => row.claim.id),
    );

    const items: FactSummary[] = rows.map((row) => toFactSummary(row, index.get(row.claim.id)));

    return { items, total, limit, offset, predicates } satisfies FactList;
  });

  app.get('/facts/:id', async (request, reply) => {
    const claimId = (request.params as { id: string }).id;
    const details = await loadFactDetails(db, [claimId]);
    const detail = details.get(claimId);

    if (detail === undefined) {
      reply.code(404);
      return { error: 'fact_not_found', message: `no fact with id ${claimId}` };
    }
    return detail;
  });
}
