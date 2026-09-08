import { and, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { entities, entityAliases } from '@superjoin/db';

import { ModelError, extractJson, type CompletionProvider } from '../model/index.ts';

export const ENTITY_MATCH_PROMPT_VERSION = 'entity-match@1';

const LEGAL_SUFFIXES = new Set([
  'limited',
  'ltd',
  'private',
  'pvt',
  'plc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'llp',
  'llc',
  'gmbh',
  'sa',
  'nv',
  'bv',
  'co',
  'company',
]);

export interface NormalizedEntityLabel {
  readonly normalized: string;
  readonly strippedSuffixes: readonly string[];
}

export function normalizeEntityLabel(raw: string): NormalizedEntityLabel {
  const tokens = raw
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/[^a-z0-9&\s-]/g, '')
    .split(/\s+/)
    .filter((token) => token !== '');

  const stripped: string[] = [];
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (!LEGAL_SUFFIXES.has(last)) break;
    stripped.unshift(tokens.pop()!);
  }

  return { normalized: tokens.join(' '), strippedSuffixes: stripped };
}

export type EntityResolutionMethod =
  | 'exact'
  | 'alias'
  | 'model'
  | 'created';

export interface EntityResolution {
  readonly entityId: string;
  readonly method: EntityResolutionMethod;
  readonly canonicalLabel: string;
  readonly reason: string;
  readonly rejectedCandidates: readonly string[];
  readonly adjudications: number;
  readonly adjudicationFailed: boolean;
}

export interface EntityCandidate {
  readonly id: string;
  readonly canonicalLabel: string;
  readonly normalizedLabel: string;
}

const GENERIC_SUBJECTS = new Set([
  'document',
  'documents',
  'this document',
  'presentation',
  'this presentation',
  'the presentation',
  'report',
  'this report',
  'the report',
  'company',
  'the company',
  'issuer',
  'the issuer',
  'it',
  'they',
  'we',
  'us',
  'our company',
  'the group',
  'group',
]);

export function isGenericSubject(subject: string): boolean {
  const folded = subject.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]$/, '');
  return folded === '' || GENERIC_SUBJECTS.has(folded);
}

export interface ResolveEntityOptions {
  readonly collectionId: string;
  readonly subject: string;
  readonly entityType?: string;
  readonly suggested?: readonly EntityCandidate[];
  readonly client?: CompletionProvider;
  readonly evidence?: readonly string[];
  readonly sourceBlockId?: string;
  readonly maxAdjudications?: number;
  readonly scopeKey?: string;
}

export async function resolveEntity(
  db: Database,
  options: ResolveEntityOptions,
): Promise<EntityResolution> {
  const { normalized, strippedSuffixes } = normalizeEntityLabel(options.subject);
  const base = normalized === '' ? options.subject.trim().toLowerCase() : normalized;
  const label = options.scopeKey === undefined ? base : `${base}#${options.scopeKey}`;

  const [exact] = await db
    .select({ id: entities.id, canonicalLabel: entities.canonicalLabel })
    .from(entities)
    .where(
      and(eq(entities.collectionId, options.collectionId), eq(entities.normalizedLabel, label)),
    )
    .limit(1);

  if (exact !== undefined) {
    return {
      entityId: exact.id,
      method: 'exact',
      canonicalLabel: exact.canonicalLabel,
      reason:
        strippedSuffixes.length > 0
          ? `matched after removing the legal form (${strippedSuffixes.join(' ')})`
          : 'the normalized name already exists in this collection',
      rejectedCandidates: [],
      adjudications: 0,
      adjudicationFailed: false,
    };
  }

  const [alias] = await db
    .select({ id: entities.id, canonicalLabel: entities.canonicalLabel })
    .from(entityAliases)
    .innerJoin(entities, eq(entityAliases.entityId, entities.id))
    .where(
      and(
        eq(entities.collectionId, options.collectionId),
        eq(entityAliases.normalizedAlias, label),
      ),
    )
    .limit(1);

  if (alias !== undefined) {
    return {
      entityId: alias.id,
      method: 'alias',
      canonicalLabel: alias.canonicalLabel,
      reason: 'a recorded alias points at this entity',
      rejectedCandidates: [],
      adjudications: 0,
      adjudicationFailed: false,
    };
  }

  const candidates = await gatherCandidates(db, options, label);
  const rejected: string[] = [];
  const budget = options.maxAdjudications ?? 1;
  let adjudications = 0;
  let adjudicationFailed = false;

  if (candidates.length > 0 && options.client !== undefined && budget > 0) {
    for (const candidate of candidates.slice(0, budget)) {
      adjudications += 1;
      const verdict = await adjudicate(options.client, options.subject, candidate, options.evidence ?? []);
      if (verdict.failed === true) adjudicationFailed = true;

      if (verdict.same) {
        await recordAlias(db, candidate.id, options.subject, label, options.sourceBlockId);
        return {
          entityId: candidate.id,
          method: 'model',
          canonicalLabel: candidate.canonicalLabel,
          reason: verdict.reason,
          rejectedCandidates: rejected,
          adjudications,
          adjudicationFailed,
        };
      }

      rejected.push(`${candidate.canonicalLabel}: ${verdict.reason}`);
    }
  } else {
    for (const candidate of candidates.slice(0, 3)) {
      rejected.push(
        `${candidate.canonicalLabel}: a similar name, left unmerged because no adjudication was available`,
      );
    }
  }

  const created = await createEntity(db, options.collectionId, options.subject, label, options.entityType);

  return {
    entityId: created.id,
    method: 'created',
    canonicalLabel: created.canonicalLabel,
    reason:
      rejected.length > 0
        ? 'similar names were found and none was confirmed, so this subject stays separate'
        : 'no existing entity matched this subject',
    rejectedCandidates: rejected,
    adjudications,
    adjudicationFailed,
  };
}

async function gatherCandidates(
  db: Database,
  options: ResolveEntityOptions,
  label: string,
): Promise<EntityCandidate[]> {
  const existing = await db
    .select({
      id: entities.id,
      canonicalLabel: entities.canonicalLabel,
      normalizedLabel: entities.normalizedLabel,
    })
    .from(entities)
    .where(eq(entities.collectionId, options.collectionId));

  const tokens = new Set(label.split(' ').filter((token) => token.length > 2));
  const byId = new Map<string, EntityCandidate>();

  for (const candidate of [...(options.suggested ?? []), ...existing]) {
    if (byId.has(candidate.id)) continue;

    const candidateTokens = candidate.normalizedLabel.split(' ');
    const shares = candidateTokens.some((token) => tokens.has(token));
    if (shares) byId.set(candidate.id, candidate);
  }

  return [...byId.values()];
}

interface Adjudication {
  readonly same: boolean;
  readonly reason: string;
  readonly failed?: boolean;
}

async function adjudicate(
  client: CompletionProvider,
  subject: string,
  candidate: EntityCandidate,
  evidence: readonly string[],
): Promise<Adjudication> {
  try {
    const result = await client.complete({
      messages: [
        {
          role: 'system',
          content: [
            'You decide whether two names taken from financial documents refer to the same legal entity.',
            'A parent company and its subsidiary are NOT the same entity, even when one name contains the other.',
            'A company and one of its business segments, brands or divisions are NOT the same entity.',
            'Differences of legal form alone (Limited, Ltd, Private Limited) do not make two names different.',
            'Answer no unless the passages make the identity clear.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Name A: ${subject}`,
            `Name B: ${candidate.canonicalLabel}`,
            '',
            evidence.length > 0
              ? `Passages mentioning them:\n${evidence.slice(0, 4).map((line) => `- ${line.slice(0, 400)}`).join('\n')}`
              : 'No passages are available.',
            '',
            'Reply as JSON: {"same_entity": true|false, "reason": "one sentence"}',
          ].join('\n'),
        },
      ],
      schema: {
        name: 'entity_match',
        schema: {
          type: 'object',
          properties: {
            same_entity: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['same_entity', 'reason'],
          additionalProperties: false,
        },
      },
      maxTokens: 300,
    });

    const parsed = extractJson(result.text) as { same_entity?: unknown; reason?: unknown };
    const same = parsed.same_entity === true;

    return {
      same,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim() !== ''
          ? parsed.reason.trim()
          : same
            ? 'the model judged these to be one entity'
            : 'the model judged these to be different entities',
    };
  } catch (error) {
    if (error instanceof ModelError) throw error;

    return {
      same: false,
      failed: true,
      reason: 'left unmerged: the adjudication could not be read',
    };
  }
}

async function recordAlias(
  db: Database,
  entityId: string,
  alias: string,
  normalizedAlias: string,
  sourceBlockId: string | undefined,
): Promise<void> {
  await db
    .insert(entityAliases)
    .values({
      entityId,
      alias,
      normalizedAlias,
      establishedBy: 'model_suggested',
      ...(sourceBlockId !== undefined ? { sourceBlockId } : {}),
    })
    .onConflictDoNothing();
}

async function createEntity(
  db: Database,
  collectionId: string,
  canonicalLabel: string,
  normalizedLabel: string,
  entityType: string | undefined,
): Promise<{ id: string; canonicalLabel: string }> {
  const inserted = await db
    .insert(entities)
    .values({
      collectionId,
      canonicalLabel: canonicalLabel.trim(),
      normalizedLabel,
      entityType: entityType ?? 'unknown',
    })
    .onConflictDoNothing()
    .returning({ id: entities.id, canonicalLabel: entities.canonicalLabel });

  if (inserted[0] !== undefined) return inserted[0];

  const [existing] = await db
    .select({ id: entities.id, canonicalLabel: entities.canonicalLabel })
    .from(entities)
    .where(and(eq(entities.collectionId, collectionId), eq(entities.normalizedLabel, normalizedLabel)))
    .limit(1);

  if (existing === undefined) {
    throw new Error(`entity ${normalizedLabel} could not be created or found`);
  }

  return existing;
}
