import { predicateRegistry, type Database } from '@superjoin/db';
import { eq } from 'drizzle-orm';

import { normalizePredicate } from './predicates.ts';

export interface RegisteredPredicate {
  readonly canonicalName: string;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly unitHint: string | null;
}

function readAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export async function loadRegistry(
  db: Database,
  collectionId: string,
): Promise<RegisteredPredicate[]> {
  const rows = await db
    .select()
    .from(predicateRegistry)
    .where(eq(predicateRegistry.collectionId, collectionId))
    .orderBy(predicateRegistry.canonicalName);

  return rows.map((row) => ({
    canonicalName: row.canonicalName,
    description: row.description,
    aliases: readAliases(row.aliases),
    unitHint: row.unitHint,
  }));
}

export function renderRegistry(entries: readonly RegisteredPredicate[], limit = 60): string {
  if (entries.length === 0) return '';

  const lines = entries.slice(0, limit).map((entry) => {
    const parts = [entry.canonicalName];
    if (entry.description !== null && entry.description !== '') parts.push(`— ${entry.description}`);
    if (entry.unitHint !== null && entry.unitHint !== '') parts.push(`(usually ${entry.unitHint})`);
    return `- ${parts.join(' ')}`;
  });

  return lines.join('\n');
}

export function canonicalFor(
  predicate: string,
  entries: readonly RegisteredPredicate[],
): string | null {
  const normalized = normalizePredicate(predicate);

  for (const entry of entries) {
    if (normalizePredicate(entry.canonicalName) === normalized) return entry.canonicalName;
    if (entry.aliases.some((alias) => normalizePredicate(alias) === normalized)) {
      return entry.canonicalName;
    }
  }
  return null;
}

export interface RegistrationResult {
  readonly added: readonly string[];
  readonly aliased: readonly string[];
}

export async function registerPredicates(
  db: Database,
  collectionId: string,
  predicates: readonly { name: string; unit?: string | null }[],
): Promise<RegistrationResult> {
  const entries = await loadRegistry(db, collectionId);
  const known = new Set(entries.map((entry) => normalizePredicate(entry.canonicalName)));
  const aliasOf = new Map<string, string>();
  for (const entry of entries) {
    for (const alias of entry.aliases) aliasOf.set(normalizePredicate(alias), entry.canonicalName);
  }

  const added: string[] = [];
  const aliased: string[] = [];
  const seen = new Set<string>();

  for (const { name, unit } of predicates) {
    const normalized = normalizePredicate(name);
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);

    if (known.has(normalized) || aliasOf.has(normalized)) continue;

    await db
      .insert(predicateRegistry)
      .values({
        collectionId,
        canonicalName: normalized,
        ...(unit !== undefined && unit !== null && unit !== '' ? { unitHint: unit } : {}),
      })
      .onConflictDoNothing();

    known.add(normalized);
    added.push(normalized);
  }

  return { added, aliased };
}
