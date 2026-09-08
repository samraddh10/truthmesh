import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, createDatabase, type DatabaseHandle } from './client.ts';
import { claimEmbeddings, claims } from './schema/claims.ts';
import { collections, documents } from './schema/collections.ts';
import { relationships } from './schema/relationships.ts';

const handle: DatabaseHandle = createDatabase();
const reachable = await handle.pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

if (!reachable) {
  await closeDatabase(handle);
}

afterAll(async () => {
  if (reachable) await closeDatabase(handle);
});

async function seedCollection(db: DatabaseHandle['db'], name: string) {
  const [collection] = await db
    .insert(collections)
    .values({ name: `${name}-${randomUUID()}` })
    .returning();
  return collection!;
}

async function seedDocument(db: DatabaseHandle['db'], collectionId: string, filename: string) {
  const [document] = await db
    .insert(documents)
    .values({
      collectionId,
      filename,
      contentHash: randomUUID(),
      storageKey: `test/${randomUUID()}`,
      byteSize: 1024,
    })
    .returning();
  return document!;
}

const claimDefaults = {
  subject: 'Delhivery Limited',
  predicate: 'ebitda',
  originalStatement: 'EBITDA, Fiscal 2021: (1,003.79) million',
  periodLabel: 'FY2021',
  scope: 'consolidated',
};

describe.skipIf(!reachable)('schema invariants', () => {
  it('keeps conflicting claims from two documents side by side', async () => {
    const { db } = handle;

    const collection = await seedCollection(db, 'conflict');
    const prospectus = await seedDocument(db, collection.id, 'prospectus.pdf');
    const annualReport = await seedDocument(db, collection.id, 'annual-report.pdf');

    await db.insert(claims).values([
      {
        ...claimDefaults,
        documentId: prospectus.id,
        rawValue: '(1,003.79)',
        numericValue: '-1003.79',
        assertionFingerprint: 'ebitda:FY2021:consolidated',
      },
      {
        ...claimDefaults,
        documentId: annualReport.id,
        rawValue: '(1,229)',
        numericValue: '-1229',
        assertionFingerprint: 'ebitda:FY2021:consolidated',
      },
    ]);

    const stored = await db.select().from(claims).where(eq(claims.predicate, 'ebitda'));
    const forThisCollection = stored.filter((claim) =>
      [prospectus.id, annualReport.id].includes(claim.documentId),
    );

    expect(forThisCollection).toHaveLength(2);
    expect(forThisCollection.map((c) => c.rawValue).sort()).toEqual(['(1,003.79)', '(1,229)']);
  });

  it('rejects the same assertion twice within one document', async () => {
    const { db } = handle;

    const collection = await seedCollection(db, 'idempotent');
    const document = await seedDocument(db, collection.id, 'deck.pdf');
    const row = {
      ...claimDefaults,
      documentId: document.id,
      assertionFingerprint: 'revenue:FY2024:consolidated',
    };

    await db.insert(claims).values(row);

    await expect(db.insert(claims).values(row)).rejects.toThrow();
  });

  it('reports a duplicate upload within a collection', async () => {
    const { db } = handle;

    const collection = await seedCollection(db, 'duplicate');
    const contentHash = randomUUID();
    const upload = {
      collectionId: collection.id,
      filename: 'same.pdf',
      contentHash,
      storageKey: `test/${randomUUID()}`,
      byteSize: 2048,
    };

    await db.insert(documents).values(upload);
    await expect(
      db.insert(documents).values({ ...upload, storageKey: `test/${randomUUID()}` }),
    ).rejects.toThrow();
  });

  it('treats the same file in two collections as two documents', async () => {
    const { db } = handle;

    const first = await seedCollection(db, 'boundary-a');
    const second = await seedCollection(db, 'boundary-b');
    const contentHash = randomUUID();

    await db.insert(documents).values({
      collectionId: first.id,
      filename: 'shared.pdf',
      contentHash,
      storageKey: `test/${randomUUID()}`,
      byteSize: 512,
    });
    await db.insert(documents).values({
      collectionId: second.id,
      filename: 'shared.pdf',
      contentHash,
      storageKey: `test/${randomUUID()}`,
      byteSize: 512,
    });

    const rows = await db.select().from(documents).where(eq(documents.contentHash, contentHash));
    expect(rows).toHaveLength(2);
  });

  it('stores a 768-dimension embedding and rejects another width', async () => {
    const { db } = handle;

    const collection = await seedCollection(db, 'embedding');
    const document = await seedDocument(db, collection.id, 'deck.pdf');
    const [claim] = await db
      .insert(claims)
      .values({
        ...claimDefaults,
        documentId: document.id,
        assertionFingerprint: `embed:${randomUUID()}`,
      })
      .returning();

    const vector = Array.from({ length: 768 }, () => 0.01);
    await db.insert(claimEmbeddings).values({
      claimId: claim!.id,
      model: 'Xenova/all-mpnet-base-v2',
      dimensions: 768,
      taskType: 'sentence-similarity',
      embeddedText: 'Delhivery Limited EBITDA consolidated FY2021',
      embedding: vector,
    });

    await expect(
      db.insert(claimEmbeddings).values({
        claimId: claim!.id,
        model: 'other-model',
        dimensions: 512,
        taskType: 'sentence-similarity',
        embeddedText: 'wrong width',
        embedding: Array.from({ length: 512 }, () => 0.01),
      }),
    ).rejects.toThrow();
  });

  it('keeps both claims when a relationship between them is deleted', async () => {
    const { db } = handle;

    const collection = await seedCollection(db, 'audit');
    const document = await seedDocument(db, collection.id, 'report.pdf');
    const inserted = await db
      .insert(claims)
      .values([
        { ...claimDefaults, documentId: document.id, assertionFingerprint: `a:${randomUUID()}` },
        { ...claimDefaults, documentId: document.id, assertionFingerprint: `b:${randomUUID()}` },
      ])
      .returning();

    const [claimA, claimB] = inserted;
    const [relationship] = await db
      .insert(relationships)
      .values({
        collectionId: collection.id,
        claimAId: claimA!.id,
        claimBId: claimB!.id,
        label: 'likely_contradiction',
        rationale: 'Adjacent year agrees exactly, so the definitions match.',
        method: 'model',
        methodVersion: 'test-0',
      })
      .returning();

    await db.delete(relationships).where(eq(relationships.id, relationship!.id));

    const survivors = await db
      .select()
      .from(claims)
      .where(and(eq(claims.documentId, document.id)));
    expect(survivors).toHaveLength(2);
  });

  it('has no column for a relationship confidence score', () => {
    const columns = Object.keys(relationships);
    expect(columns.some((name) => /confidence|score|probability/i.test(name))).toBe(false);
  });
});
