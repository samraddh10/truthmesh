import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { collections } from './collections.ts';
import { sourceBlocks } from './sources.ts';

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    canonicalLabel: text('canonical_label').notNull(),

    entityType: text('entity_type').notNull(),

    normalizedLabel: text('normalized_label').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('entities_collection_normalized_key').on(table.collectionId, table.normalizedLabel),
    index('entities_collection_idx').on(table.collectionId),
  ],
);

export const entityAliases = pgTable(
  'entity_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),

    alias: text('alias').notNull(),
    normalizedAlias: text('normalized_alias').notNull(),

    sourceBlockId: uuid('source_block_id').references(() => sourceBlocks.id, {
      onDelete: 'set null',
    }),
    establishedBy: text('established_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('entity_aliases_entity_alias_key').on(table.entityId, table.normalizedAlias),
    index('entity_aliases_normalized_idx').on(table.normalizedAlias),
  ],
);

export const factGroups = pgTable(
  'fact_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),

    predicate: text('predicate').notNull(),

    contextKey: jsonb('context_key'),

    label: text('label'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('fact_groups_collection_predicate_idx').on(table.collectionId, table.predicate)],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;
export type FactGroup = typeof factGroups.$inferSelect;
export type NewFactGroup = typeof factGroups.$inferInsert;
