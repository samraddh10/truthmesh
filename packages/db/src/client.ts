import { loadConfig } from '@superjoin/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
}

export function createDatabase(connectionString?: string): DatabaseHandle {
  const url = connectionString ?? loadConfig().databaseUrl;
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function closeDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.pool.end();
}
