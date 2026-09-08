import { jsonb, pgTable, text, timestamp, uuid, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const MODEL_PROVIDERS = ['bedrock', 'groq'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const appSettings = pgTable(
  'app_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    activeProvider: text('active_provider').notNull().default('bedrock'),
    availableProviders: jsonb('available_providers').$type<string[]>().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    singleton: text('singleton').notNull().default('singleton'),
  },
  (table) => [
    check('app_settings_provider_known', sql`${table.activeProvider} in ('bedrock', 'groq')`),
    check('app_settings_single_row', sql`${table.singleton} = 'singleton'`),
  ],
);
