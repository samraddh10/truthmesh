import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, collections, createDatabase, type DatabaseHandle } from '@superjoin/db';

import { ModelError, type CompletionProvider, type CompletionResult } from '../model/index.ts';
import { isGenericSubject, normalizeEntityLabel, resolveEntity } from './entities.ts';
import { factGroupId } from './stage.ts';

const connectionString =
  process.env['DATABASE_URL'] ?? 'postgres://superjoin:superjoin@localhost:55432/superjoin';

const database: DatabaseHandle = createDatabase(connectionString);
const reachable = await database.pool
  .query('select 1')
  .then(() => true)
  .catch(() => false);

if (!reachable) await closeDatabase(database);
afterAll(async () => {
  if (reachable) await closeDatabase(database);
});

async function seedCollection(): Promise<{ collectionId: string }> {
  const [row] = await database.db
    .insert(collections)
    .values({ name: `entities-${randomUUID()}` })
    .returning({ id: collections.id });
  return { collectionId: row!.id };
}

function stubClient(
  asked: string[],
  verdict: { same: boolean; reason: string },
): CompletionProvider {
  return {
    model: 'stub/adjudicator',
    async complete(request): Promise<CompletionResult> {
      asked.push(JSON.stringify(request.messages).slice(0, 80));
      return {
        text: JSON.stringify(verdict),
        servedByModel: 'stub/adjudicator',
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
      };
    },
  };
}

describe('normalizeEntityLabel', () => {
  it('treats a legal form as spelling', () => {
    expect(normalizeEntityLabel('Delhivery Limited').normalized).toBe('delhivery');
    expect(normalizeEntityLabel('Delhivery Ltd.').normalized).toBe('delhivery');
    expect(normalizeEntityLabel('DELHIVERY PRIVATE LIMITED').normalized).toBe('delhivery');
  });

  it('records what it removed', () => {
    expect(normalizeEntityLabel('Delhivery Private Limited').strippedSuffixes).toEqual([
      'private',
      'limited',
    ]);
  });

  it('keeps a distinguishing word that is not a legal form', () => {
    const parent = normalizeEntityLabel('Delhivery Limited').normalized;
    const subsidiary = normalizeEntityLabel('Delhivery Express Parcel Private Limited').normalized;

    expect(parent).toBe('delhivery');
    expect(subsidiary).toBe('delhivery express parcel');
    expect(parent).not.toBe(subsidiary);
  });

  it('strips suffixes only from the end', () => {
    expect(normalizeEntityLabel('Company Secretary Services Limited').normalized).toBe(
      'company secretary services',
    );
  });

  it('never reduces a name to nothing', () => {
    expect(normalizeEntityLabel('Limited').normalized).toBe('limited');
  });
});

describe('factGroupId', () => {
  it('is the same for the same group key', () => {
    const a = factGroupId('col', 'ent', 'revenue', '{"period":"FY2024"}');
    const b = factGroupId('col', 'ent', 'revenue', '{"period":"FY2024"}');
    expect(a).toBe(b);
  });

  it('differs when any part of the key differs', () => {
    const base = factGroupId('col', 'ent', 'revenue', '{"period":"FY2024"}');
    expect(factGroupId('col', 'ent', 'revenue', '{"period":"FY2023"}')).not.toBe(base);
    expect(factGroupId('col', 'other', 'revenue', '{"period":"FY2024"}')).not.toBe(base);
    expect(factGroupId('other', 'ent', 'revenue', '{"period":"FY2024"}')).not.toBe(base);
  });

  it('is a well-formed version 5 UUID', () => {
    expect(factGroupId('col', 'ent', 'revenue', '{}')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe.skipIf(!reachable)('adjudication budget', () => {
  it('asks about one candidate by default, not three', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: false, reason: 'different companies' });

    for (const name of ['Acme Logistics Alpha', 'Acme Logistics Beta', 'Acme Logistics Gamma']) {
      await resolveEntity(database.db, { collectionId, subject: name });
    }

    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Acme Logistics Delta',
      client,
    });

    expect(asked).toHaveLength(1);
    expect(resolution.adjudications).toBe(1);
    expect(resolution.method).toBe('created');
  });

  it('honours a larger budget when one is given', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: false, reason: 'different companies' });

    for (const name of ['Beta Freight One', 'Beta Freight Two', 'Beta Freight Three']) {
      await resolveEntity(database.db, { collectionId, subject: name });
    }

    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Beta Freight Four',
      client,
      maxAdjudications: 3,
    });

    expect(asked.length).toBeGreaterThan(1);
    expect(resolution.adjudications).toBe(asked.length);
  });

  it('asks nothing when the budget is zero, and still resolves', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: true, reason: 'the same company' });

    await resolveEntity(database.db, { collectionId, subject: 'Gamma Cargo One' });

    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Gamma Cargo Two',
      client,
      maxAdjudications: 0,
    });

    expect(asked).toHaveLength(0);
    expect(resolution.adjudications).toBe(0);
    expect(resolution.method).toBe('created');
  });

  it('spends nothing when the name matches exactly', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: true, reason: 'the same company' });

    await resolveEntity(database.db, { collectionId, subject: 'Delta Shipping Limited' });
    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Delta Shipping',
      client,
    });

    expect(asked).toHaveLength(0);
    expect(resolution.adjudications).toBe(0);
    expect(resolution.method).toBe('exact');
  });
});

describe.skipIf(!reachable)('a failing adjudicator', () => {
  it('reports the failure rather than passing it off as "different"', async () => {
    const { collectionId } = await seedCollection();

    const failing: CompletionProvider = {
        model: 'stub/failing',
      async complete(): Promise<CompletionResult> {
        throw new ModelError('quota exhausted', 'provider_rate_limited', true);
      },
    };

    await resolveEntity(database.db, { collectionId, subject: 'Epsilon Roadways One' });

    await expect(
      resolveEntity(database.db, {
        collectionId,
        subject: 'Epsilon Roadways Two',
        client: failing,
      }),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it('does not report a failure when the adjudicator simply says no', async () => {
    const { collectionId } = await seedCollection();
    const asked: string[] = [];
    const client = stubClient(asked, { same: false, reason: 'a parent and its subsidiary' });

    await resolveEntity(database.db, { collectionId, subject: 'Zeta Haulage One' });
    const resolution = await resolveEntity(database.db, {
      collectionId,
      subject: 'Zeta Haulage Two',
      client,
    });

    expect(resolution.adjudications).toBe(1);
    expect(resolution.adjudicationFailed).toBe(false);
    expect(resolution.method).toBe('created');
  });
});

describe('generic subjects', () => {
  it('recognises document self-references, whatever the casing or padding', () => {
    for (const subject of ['document', 'This Presentation', '  the company ', 'The Report.']) {
      expect(isGenericSubject(subject), subject).toBe(true);
    }
  });

  it('leaves real names alone', () => {
    for (const subject of ['Delhivery Limited', 'Sahil Barua', 'Express Parcel', 'India']) {
      expect(isGenericSubject(subject), subject).toBe(false);
    }
  });
});

describe.skipIf(!reachable)('scoping a generic subject', () => {
  it('keeps two documents saying "document" apart', async () => {
    const { collectionId } = await seedCollection();

    const first = await resolveEntity(database.db, {
      collectionId,
      subject: 'document',
      scopeKey: 'doc-one',
    });
    const second = await resolveEntity(database.db, {
      collectionId,
      subject: 'document',
      scopeKey: 'doc-two',
    });

    expect(second.entityId).not.toBe(first.entityId);
    expect(second.canonicalLabel).toBe('document');
  });

  it('still merges the same generic subject within one document', async () => {
    const { collectionId } = await seedCollection();

    const first = await resolveEntity(database.db, {
      collectionId,
      subject: 'this presentation',
      scopeKey: 'doc-one',
    });
    const again = await resolveEntity(database.db, {
      collectionId,
      subject: 'this presentation',
      scopeKey: 'doc-one',
    });

    expect(again.entityId).toBe(first.entityId);
    expect(again.method).toBe('exact');
  });

  it('does not scope a real name', async () => {
    const { collectionId } = await seedCollection();

    const first = await resolveEntity(database.db, { collectionId, subject: 'Delhivery Limited' });
    const second = await resolveEntity(database.db, { collectionId, subject: 'Delhivery' });

    expect(second.entityId).toBe(first.entityId);
  });
});
