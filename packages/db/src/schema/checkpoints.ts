import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { documents } from './collections.ts';

export const chunkExtractions = pgTable(
  'chunk_extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    chunkFingerprint: text('chunk_fingerprint').notNull(),

    chunkIndex: integer('chunk_index').notNull(),

    promptVersion: text('prompt_version').notNull(),
    modelName: text('model_name').notNull(),

    claimsExtracted: integer('claims_extracted').notNull().default(0),
    claimsAccepted: integer('claims_accepted').notNull().default(0),
    claimsNeedingReview: integer('claims_needing_review').notNull().default(0),
    claimsRejected: integer('claims_rejected').notNull().default(0),

    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('chunk_extractions_identity_key').on(
      table.documentId,
      table.chunkFingerprint,
      table.promptVersion,
      table.modelName,
    ),
    index('chunk_extractions_document_idx').on(table.documentId),
  ],
);

export type ChunkExtraction = typeof chunkExtractions.$inferSelect;
export type NewChunkExtraction = typeof chunkExtractions.$inferInsert;
