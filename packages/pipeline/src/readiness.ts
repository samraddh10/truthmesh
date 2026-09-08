import { checkStorageHealth, type StorageHealth } from '@superjoin/pipeline';
import type { DatabaseHandle } from '@superjoin/db';

export interface DependencyStatus {
  readonly ok: boolean;
  readonly detail: string | null;
}

export interface Readiness {
  readonly ok: boolean;
  readonly service: string;
  readonly database: DependencyStatus & { readonly migrationsApplied: boolean };
  readonly storage: DependencyStatus & { readonly root: string };
}

async function checkDatabase(
  handle: DatabaseHandle,
): Promise<DependencyStatus & { migrationsApplied: boolean }> {
  try {
    const result = await handle.pool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name in ('claims', 'documents', 'relationships', 'source_blocks')",
    );
    const present = Number(result.rows[0]?.count ?? '0');

    return {
      ok: present === 4,
      migrationsApplied: present === 4,
      detail:
        present === 4
          ? null
          : `expected 4 core tables, found ${present}; migrations may not have been applied`,
    };
  } catch (cause) {
    return { ok: false, migrationsApplied: false, detail: describeError(cause) };
  }
}

function describeError(cause: unknown): string {
  const error = cause as { message?: string; code?: string; address?: string; port?: number };
  const parts = [
    error.message !== undefined && error.message !== '' ? error.message : null,
    error.code !== undefined ? `code ${error.code}` : null,
    error.address !== undefined ? `at ${error.address}:${error.port ?? '?'}` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(' ') : 'connection failed with no diagnostic detail';
}

export async function checkReadiness(
  service: string,
  handle: DatabaseHandle,
  storageDir: string,
): Promise<Readiness> {
  const [database, storage]: [Awaited<ReturnType<typeof checkDatabase>>, StorageHealth] =
    await Promise.all([checkDatabase(handle), checkStorageHealth(storageDir)]);

  return {
    ok: database.ok && storage.writable,
    service,
    database,
    storage: { ok: storage.writable, detail: storage.detail, root: storage.root },
  };
}
