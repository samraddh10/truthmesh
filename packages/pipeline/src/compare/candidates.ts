import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claimEmbeddings, claimEvidence, claims, documents } from '@superjoin/db';

import type { AssertionStatus, PeriodType, Qualifier } from '../extraction/contract.ts';
import {
  describeClaim,
  EmbeddingUnavailableError,
  type EmbeddingProvider,
} from '../embedding/index.ts';
import { normalizeEntityLabel } from '../normalize/entities.ts';
import { predicateRelation } from '../normalize/predicates.ts';
import type { ComparableClaim } from './checks.ts';

export type CandidateSource = 'exact' | 'semantic';

export interface CandidatePair {
  readonly a: ComparableClaim;
  readonly b: ComparableClaim;
  readonly sources: readonly CandidateSource[];
  readonly distance: number | null;
}

export async function loadComparableClaims(
  db: Database,
  collectionId: string,
): Promise<ComparableClaim[]> {
  const rows = await db
    .select({
      id: claims.id,
      documentId: claims.documentId,
      entityId: claims.entityId,
      subject: claims.subject,
      predicate: claims.predicate,
      originalStatement: claims.originalStatement,
      rawValue: claims.rawValue,
      numericValue: claims.numericValue,
      currency: claims.currency,
      scale: claims.scale,
      unit: claims.unit,
      periodLabel: claims.periodLabel,
      periodType: claims.periodType,
      periodStart: claims.periodStart,
      periodEnd: claims.periodEnd,
      scope: claims.scope,
      assertionStatus: claims.assertionStatus,
      qualifiers: claims.qualifiers,
      status: claims.status,
    })
    .from(claims)
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .where(
      and(
        eq(documents.collectionId, collectionId),
        inArray(claims.status, ['accepted', 'needs_review']),
      ),
    );

  if (rows.length === 0) return [];

  const evidence = await db
    .select({ claimId: claimEvidence.claimId, sourceBlockId: claimEvidence.sourceBlockId })
    .from(claimEvidence)
    .where(inArray(claimEvidence.claimId, rows.map((row) => row.id)));

  const blocksByClaim = new Map<string, string[]>();
  for (const row of evidence) {
    const existing = blocksByClaim.get(row.claimId);
    if (existing === undefined) blocksByClaim.set(row.claimId, [row.sourceBlockId]);
    else existing.push(row.sourceBlockId);
  }

  return rows.map((row) => ({
    ...row,
    periodType: (row.periodType as PeriodType | null) ?? null,
    assertionStatus: (row.assertionStatus as AssertionStatus | null) ?? null,
    qualifiers: (row.qualifiers as Qualifier[] | null) ?? [],
    status: row.status as 'accepted' | 'needs_review',
    sourceBlockIds: blocksByClaim.get(row.id) ?? [],
  }));
}

export interface EmbeddingOutcome {
  readonly available: boolean;
  readonly embedded: number;
  readonly reason: string | null;
}

export async function ensureClaimEmbeddings(
  db: Database,
  provider: EmbeddingProvider,
  toEmbed: readonly ComparableClaim[],
): Promise<EmbeddingOutcome> {
  if (toEmbed.length === 0) return { available: true, embedded: 0, reason: null };

  const existing = await db
    .select({ claimId: claimEmbeddings.claimId })
    .from(claimEmbeddings)
    .where(
      and(
        eq(claimEmbeddings.model, provider.model),
        inArray(claimEmbeddings.claimId, toEmbed.map((claim) => claim.id)),
      ),
    );

  const have = new Set(existing.map((row) => row.claimId));
  const missing = toEmbed.filter((claim) => !have.has(claim.id));
  if (missing.length === 0) return { available: true, embedded: 0, reason: null };

  const texts = missing.map((claim) =>
    describeClaim({
      subject: claim.subject,
      predicate: claim.predicate,
      scope: claim.scope,
      periodLabel: claim.periodLabel,
      unit: claim.unit,
      qualifiers: claim.qualifiers,
    }),
  );

  let vectors: number[][];
  try {
    vectors = await provider.embed(texts);
  } catch (error) {
    const reason =
      error instanceof EmbeddingUnavailableError
        ? error.message
        : `embedding failed: ${(error as Error).message}`;
    return { available: false, embedded: 0, reason };
  }

  const values = missing.map((claim, index) => ({
    claimId: claim.id,
    model: provider.model,
    dimensions: provider.dimensions,
    taskType: provider.taskType,
    embeddedText: texts[index]!,
    embedding: vectors[index]!,
  }));

  await db.insert(claimEmbeddings).values(values).onConflictDoNothing();

  return { available: true, embedded: values.length, reason: null };
}

function sameSubject(a: ComparableClaim, b: ComparableClaim): boolean {
  if (a.entityId !== null && b.entityId !== null) return a.entityId === b.entityId;
  return normalizeEntityLabel(a.subject).normalized === normalizeEntityLabel(b.subject).normalized;
}

export interface FindCandidatesOptions {
  readonly collectionId: string;
  readonly documentId: string;
  readonly topK?: number;
  readonly provider?: EmbeddingProvider;
}

export interface CandidateResult {
  readonly pairs: readonly CandidatePair[];
  readonly exactPairs: number;
  readonly semanticPairs: number;
  readonly embedding: EmbeddingOutcome;
}

export async function findCandidates(
  db: Database,
  options: FindCandidatesOptions,
): Promise<CandidateResult> {
  const topK = options.topK ?? 15;
  const all = await loadComparableClaims(db, options.collectionId);
  const mine = all.filter((claim) => claim.documentId === options.documentId);
  const others = all.filter((claim) => claim.documentId !== options.documentId);

  if (mine.length === 0 || others.length === 0) {
    return {
      pairs: [],
      exactPairs: 0,
      semanticPairs: 0,
      embedding: { available: true, embedded: 0, reason: null },
    };
  }

  const embedding =
    options.provider === undefined
      ? { available: false, embedded: 0, reason: 'no embedding provider was configured' }
      : await ensureClaimEmbeddings(db, options.provider, all);

  const pairs = new Map<string, { pair: CandidatePair; sources: Set<CandidateSource> }>();

  const add = (a: ComparableClaim, b: ComparableClaim, source: CandidateSource, distance: number | null) => {
    const [left, right] = a.id < b.id ? [a, b] : [b, a];
    const key = `${left.id}:${right.id}`;
    const existing = pairs.get(key);

    if (existing !== undefined) {
      existing.sources.add(source);
      return;
    }

    pairs.set(key, {
      pair: { a: left, b: right, sources: [source], distance },
      sources: new Set([source]),
    });
  };

  for (const claim of mine) {
    for (const other of others) {
      if (!sameSubject(claim, other)) continue;
      const relation = predicateRelation(claim.predicate, other.predicate).relation;
      if (relation === 'unrelated' || relation === 'explicitly_distinct') continue;
      add(claim, other, 'exact', null);
    }
  }

  const exactPairs = pairs.size;

  if (embedding.available && options.provider !== undefined) {
    const byId = new Map(others.map((claim) => [claim.id, claim]));

    for (const claim of mine) {
      const neighbours = await nearestNeighbours(db, {
        claimId: claim.id,
        collectionId: options.collectionId,
        excludeDocumentId: options.documentId,
        model: options.provider.model,
        topK,
      });

      for (const neighbour of neighbours) {
        const other = byId.get(neighbour.claimId);
        if (other === undefined) continue;
        add(claim, other, 'semantic', neighbour.distance);
      }
    }
  }

  const result = [...pairs.values()].map(({ pair, sources }) => ({
    ...pair,
    sources: [...sources],
  }));

  return {
    pairs: result,
    exactPairs,
    semanticPairs: pairs.size - exactPairs,
    embedding,
  };
}

interface Neighbour {
  readonly claimId: string;
  readonly distance: number;
}

async function nearestNeighbours(
  db: Database,
  options: {
    claimId: string;
    collectionId: string;
    excludeDocumentId: string;
    model: string;
    topK: number;
  },
): Promise<Neighbour[]> {
  const rows = await db.execute<{ claim_id: string; distance: number }>(sql`
    with query as (
      select embedding
      from ${claimEmbeddings}
      where ${claimEmbeddings.claimId} = ${options.claimId}
        and ${claimEmbeddings.model} = ${options.model}
      limit 1
    )
    select
      ${claimEmbeddings.claimId} as claim_id,
      (${claimEmbeddings.embedding} <=> (select embedding from query)) as distance
    from ${claimEmbeddings}
    join ${claims} on ${claims.id} = ${claimEmbeddings.claimId}
    join ${documents} on ${documents.id} = ${claims.documentId}
    where ${documents.collectionId} = ${options.collectionId}
      and ${claims.documentId} <> ${options.excludeDocumentId}
      and ${claims.status} in ('accepted', 'needs_review')
      and ${claimEmbeddings.model} = ${options.model}
      and exists (select 1 from query)
    order by distance
    limit ${options.topK}
  `);

  const list = Array.isArray(rows) ? rows : ((rows as { rows: unknown[] }).rows ?? []);

  return (list as { claim_id: string; distance: number | string }[]).map((row) => ({
    claimId: row.claim_id,
    distance: Number(row.distance),
  }));
}
