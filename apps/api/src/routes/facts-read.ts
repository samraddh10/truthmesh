import type { EvidenceItem, FactDetail, FactSummary } from '@superjoin/contracts';
import {
  claimEvidence,
  claims,
  documents,
  entities,
  relationships,
  sourceBlocks,
  type Database,
} from '@superjoin/db';
import { and, count, eq, inArray, or, sql } from 'drizzle-orm';

export interface ClaimRow {
  readonly claim: typeof claims.$inferSelect;
  readonly filename: string;
  readonly collectionId: string;
  readonly entityLabel: string | null;
}

export const claimSelection = {
  claim: claims,
  filename: documents.filename,
  collectionId: documents.collectionId,
  entityLabel: entities.canonicalLabel,
} as const;

export function claimQuery(db: Database) {
  return db
    .select(claimSelection)
    .from(claims)
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .leftJoin(entities, eq(entities.id, claims.entityId));
}

function readQualifiers(value: unknown): { name: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, value: qualifierValue } = entry as { name?: unknown; value?: unknown };
    if (typeof name !== 'string' || typeof qualifierValue !== 'string') return [];
    return [{ name, value: qualifierValue }];
  });
}

export async function loadEvidenceIndex(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, { pages: number[]; evidenceCount: number }>> {
  const index = new Map<string, { pages: number[]; evidenceCount: number }>();
  if (claimIds.length === 0) return index;

  const rows = await db
    .select({
      claimId: claimEvidence.claimId,
      physicalPage: sourceBlocks.physicalPage,
    })
    .from(claimEvidence)
    .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
    .where(inArray(claimEvidence.claimId, [...claimIds]));

  for (const row of rows) {
    const entry = index.get(row.claimId) ?? { pages: [], evidenceCount: 0 };
    entry.evidenceCount += 1;
    if (!entry.pages.includes(row.physicalPage)) entry.pages.push(row.physicalPage);
    index.set(row.claimId, entry);
  }
  for (const entry of index.values()) entry.pages.sort((a, b) => a - b);
  return index;
}

export function toFactSummary(
  row: ClaimRow,
  evidence: { pages: number[]; evidenceCount: number } | undefined,
): FactSummary {
  const { claim } = row;
  return {
    id: claim.id,
    documentId: claim.documentId,
    filename: row.filename,
    subject: claim.subject,
    predicate: claim.predicate,
    originalStatement: claim.originalStatement,
    rawValue: claim.rawValue,
    numericValue: claim.numericValue,
    normalizedValue: claim.normalizedValue,
    normalizedUnit: claim.normalizedUnit,
    currency: claim.currency,
    scale: claim.scale,
    unit: claim.unit,
    periodLabel: claim.periodLabel,
    periodType: claim.periodType,
    scope: claim.scope,
    assertionStatus: claim.assertionStatus,
    status: claim.status,
    statusReason: claim.statusReason,
    entityId: claim.entityId,
    entityLabel: row.entityLabel,
    pages: evidence?.pages ?? [],
    evidenceCount: evidence?.evidenceCount ?? 0,
    createdAt: claim.createdAt.toISOString(),
  };
}

export async function loadEvidence(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, EvidenceItem[]>> {
  const byClaim = new Map<string, EvidenceItem[]>();
  if (claimIds.length === 0) return byClaim;

  const rows = await db
    .select({
      evidence: claimEvidence,
      block: sourceBlocks,
      filename: documents.filename,
    })
    .from(claimEvidence)
    .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
    .innerJoin(documents, eq(documents.id, sourceBlocks.documentId))
    .where(inArray(claimEvidence.claimId, [...claimIds]))
    .orderBy(sourceBlocks.physicalPage, sourceBlocks.blockIndex);

  for (const row of rows) {
    const { evidence, block } = row;
    const hasBox =
      block.bboxX !== null &&
      block.bboxY !== null &&
      block.bboxWidth !== null &&
      block.bboxHeight !== null;

    const item: EvidenceItem = {
      id: evidence.id,
      quote: evidence.quote,
      quoteStart: evidence.quoteStart,
      quoteEnd: evidence.quoteEnd,
      verification: evidence.verification,
      entailment: evidence.entailment,
      verificationNote: evidence.verificationNote,
      supportRole: evidence.supportRole,
      block: {
        id: block.id,
        documentId: block.documentId,
        filename: row.filename,
        physicalPage: block.physicalPage,
        printedPageLabel: block.printedPageLabel,
        blockType: block.blockType,
        extractionMethod: block.extractionMethod,
        content: block.content,
        tableHeaders: block.tableHeaders ?? null,
        bbox: hasBox
          ? {
              x: block.bboxX!,
              y: block.bboxY!,
              width: block.bboxWidth!,
              height: block.bboxHeight!,
            }
          : null,
        coordinateOrigin: block.coordinateOrigin,
        pageWidthPt: block.pageWidthPt,
        pageHeightPt: block.pageHeightPt,
        pageRotation: block.pageRotation,
        pageImageKey: block.pageImageKey,
      },
    };

    const list = byClaim.get(evidence.claimId);
    if (list === undefined) byClaim.set(evidence.claimId, [item]);
    else list.push(item);
  }

  return byClaim;
}

export async function loadRelationshipCounts(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (claimIds.length === 0) return counts;

  const ids = [...claimIds];
  const wanted = new Set(ids);
  const rows = await db
    .select({ claimAId: relationships.claimAId, claimBId: relationships.claimBId })
    .from(relationships)
    .where(
      or(inArray(relationships.claimAId, ids), inArray(relationships.claimBId, ids)),
    );

  for (const row of rows) {
    for (const id of [row.claimAId, row.claimBId]) {
      if (!wanted.has(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export async function loadFactDetails(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, FactDetail>> {
  const details = new Map<string, FactDetail>();
  if (claimIds.length === 0) return details;

  const rows = await claimQuery(db).where(inArray(claims.id, [...claimIds]));
  const ids = rows.map((row) => row.claim.id);

  const [index, evidence, relationshipCounts] = await Promise.all([
    loadEvidenceIndex(db, ids),
    loadEvidence(db, ids),
    loadRelationshipCounts(db, ids),
  ]);

  for (const row of rows) {
    const { claim } = row;
    details.set(claim.id, {
      ...toFactSummary(row, index.get(claim.id)),
      collectionId: row.collectionId,
      runId: claim.runId,
      factGroupId: claim.factGroupId,
      valuePrecision: claim.valuePrecision,
      periodStart: claim.periodStart?.toISOString() ?? null,
      periodEnd: claim.periodEnd?.toISOString() ?? null,
      qualifiers: readQualifiers(claim.qualifiers),
      normalization: claim.normalization ?? null,
      evidence: evidence.get(claim.id) ?? [],
      relationshipCount: relationshipCounts.get(claim.id) ?? 0,
    });
  }

  return details;
}

export async function loadPredicates(
  db: Database,
  collectionId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ predicate: claims.predicate })
    .from(claims)
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .where(eq(documents.collectionId, collectionId))
    .orderBy(claims.predicate);
  return rows.map((row) => row.predicate);
}

export async function countClaims(
  db: Database,
  where: ReturnType<typeof and>,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(claims)
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .where(where);
  return row?.total ?? 0;
}

export const claimOrdering = [
  documents.filename,
  sql`(
    select min(sb.physical_page)
    from claim_evidence ce
    join source_blocks sb on sb.id = ce.source_block_id
    where ce.claim_id = ${claims.id}
  ) nulls last`,
  claims.id,
];
