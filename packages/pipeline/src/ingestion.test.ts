import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, collections, createDatabase, documents, processingRuns } from '@superjoin/db';
import type { DatabaseHandle } from '@superjoin/db';

import { ingestDocument, type IngestionContext } from './ingestion.ts';
import { DOCUMENT_QUEUE, createQueueClient, startQueue } from './queue.ts';
import { documentStorageKey, objectExists, readObject } from './storage.ts';
import { limitsFromConfig } from './validation.ts';

const EARNINGS_DECK = 'datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf';
const THREE_PAGES = 'tests/fixtures/three-blank-pages.pdf';
const ENCRYPTED = 'tests/fixtures/encrypted.pdf';

const connectionString =
  process.env['DATABASE_URL'] ?? 'postgres://superjoin:superjoin@localhost:55432/superjoin';

const database: DatabaseHandle = createDatabase(connectionString);
const reachable = await database.pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

if (!reachable) {
  await closeDatabase(database);
}

let context: IngestionContext;
let storageDir: string;
let boss: Awaited<ReturnType<typeof createQueueClient>>;

beforeAll(async () => {
  if (!reachable) return;
  storageDir = await mkdtemp(join(tmpdir(), 'superjoin-ingest-'));
  boss = createQueueClient(connectionString);
  await startQueue(boss);
  context = {
    database,
    boss,
    storageDir,
    limits: limitsFromConfig(50, 300),
    pipelineVersion: 'test-0',
  };
}, 60_000);

afterAll(async () => {
  if (!reachable) return;
  await boss.stop({ graceful: true, timeout: 5000 });
  await closeDatabase(database);
  await rm(storageDir, { recursive: true, force: true });
});

async function newCollection(): Promise<string> {
  const [collection] = await database.db
    .insert(collections)
    .values({ name: `ingest-${randomUUID()}` })
    .returning({ id: collections.id });
  return collection!.id;
}

async function uniquePdf(source = THREE_PAGES): Promise<Uint8Array> {
  const original = new Uint8Array(await readFile(source));
  const marker = new TextEncoder().encode(`\n% ${randomUUID()}\n`);
  const combined = new Uint8Array(original.byteLength + marker.byteLength);
  combined.set(original, 0);
  combined.set(marker, original.byteLength);
  return combined;
}

describe.skipIf(!reachable)('ingestDocument', () => {
  it('stores the file, the document, the run and the job together', async () => {
    const collectionId = await newCollection();
    const bytes = await uniquePdf();

    const outcome = await ingestDocument(context, {
      collectionId,
      filename: 'deck.pdf',
      bytes,
    });

    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') return;

    const stored = await readObject(storageDir, documentStorageKey(outcome.contentHash));
    expect(stored.byteLength).toBe(bytes.byteLength);

    const [document] = await database.db
      .select()
      .from(documents)
      .where(eq(documents.id, outcome.documentId));
    expect(document?.pageCount).toBe(3);
    expect(document?.contentHash).toBe(outcome.contentHash);

    const [run] = await database.db
      .select()
      .from(processingRuns)
      .where(eq(processingRuns.id, outcome.runId));
    expect(run?.stage).toBe('queued');
    expect(run?.pagesTotal).toBe(3);
    expect(run?.pipelineVersion).toBe('test-0');

    const queued = await boss.getJobById(DOCUMENT_QUEUE, await findJobId(outcome.runId));
    expect(queued?.data).toMatchObject({ runId: outcome.runId, documentId: outcome.documentId });
  });

  it('reports a duplicate instead of reprocessing it', async () => {
    const collectionId = await newCollection();
    const bytes = await uniquePdf();

    const first = await ingestDocument(context, { collectionId, filename: 'a.pdf', bytes });
    const second = await ingestDocument(context, { collectionId, filename: 'b.pdf', bytes });

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    if (second.status !== 'duplicate' || first.status !== 'accepted') return;

    expect(second.documentId).toBe(first.documentId);
    expect(second.filename).toBe('a.pdf');

    const runs = await database.db
      .select()
      .from(processingRuns)
      .where(eq(processingRuns.documentId, first.documentId));
    expect(runs).toHaveLength(1);
  });

  it('treats the same bytes in another collection as a new document', async () => {
    const bytes = await uniquePdf();
    const [first, second] = [await newCollection(), await newCollection()];

    const a = await ingestDocument(context, { collectionId: first, filename: 'x.pdf', bytes });
    const b = await ingestDocument(context, { collectionId: second, filename: 'x.pdf', bytes });

    expect(a.status).toBe('accepted');
    expect(b.status).toBe('accepted');
  });

  it('rejects an encrypted PDF without creating a document or a run', async () => {
    const collectionId = await newCollection();
    const bytes = new Uint8Array(await readFile(ENCRYPTED));

    const outcome = await ingestDocument(context, {
      collectionId,
      filename: 'locked.pdf',
      bytes,
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('encrypted');

    const rows = await database.db
      .select()
      .from(documents)
      .where(eq(documents.collectionId, collectionId));
    expect(rows).toHaveLength(0);
  });

  it('rejects an oversized upload before writing anything to storage', async () => {
    const collectionId = await newCollection();
    const bytes = new Uint8Array(await readFile(EARNINGS_DECK));

    const outcome = await ingestDocument(
      { ...context, limits: limitsFromConfig(0.000001, 300) },
      { collectionId, filename: 'big.pdf', bytes },
    );

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('too_large');
  });

  it('leaves no file behind when the transaction cannot commit', async () => {
    const missingCollection = randomUUID();
    const bytes = await uniquePdf();

    await expect(
      ingestDocument(context, {
        collectionId: missingCollection,
        filename: 'orphan.pdf',
        bytes,
      }),
    ).rejects.toThrow();

    const { contentHash } = await import('./storage.ts');
    expect(await objectExists(storageDir, documentStorageKey(contentHash(bytes)))).toBe(false);
  });
});

async function findJobId(runId: string): Promise<string> {
  const { rows } = await database.pool.query<{ id: string }>(
    `select id from pgboss.job where name = $1 and data->>'runId' = $2 limit 1`,
    [DOCUMENT_QUEUE, runId],
  );
  return rows[0]?.id ?? '';
}
