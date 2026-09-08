import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { collections } from './collections.ts';

export const predicateRegistry = pgTable(
  'predicate_registry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    canonicalName: text('canonical_name').notNull(),

    description: text('description'),

    aliases: jsonb('aliases').notNull().default([]),

    unitHint: text('unit_hint'),

    establishedBy: text('established_by').notNull().default('extracted'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('predicate_registry_collection_name_key').on(
      table.collectionId,
      table.canonicalName,
    ),
    index('predicate_registry_collection_idx').on(table.collectionId),
  ],
);

export type PredicateRegistryEntry = typeof predicateRegistry.$inferSelect;
export type NewPredicateRegistryEntry = typeof predicateRegistry.$inferInsert;
