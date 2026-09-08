import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const collections = pgTable('collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    filename: text('filename').notNull(),

    contentHash: text('content_hash').notNull(),

    storageKey: text('storage_key').notNull(),

    byteSize: integer('byte_size').notNull(),

    pageCount: integer('page_count'),

    publicationDate: date('publication_date'),

    pdfMetadata: jsonb('pdf_metadata'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('documents_collection_content_hash_key').on(table.collectionId, table.contentHash),
    index('documents_collection_idx').on(table.collectionId),
  ],
);

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
