import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { documents } from './collections.ts';
import { runStage } from './enums.ts';

export const processingRuns = pgTable(
  'processing_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    stage: runStage('stage').notNull().default('queued'),

    pipelineVersion: text('pipeline_version').notNull(),
    modelName: text('model_name'),
    promptVersion: text('prompt_version'),
    embeddingModel: text('embedding_model'),

    pagesTotal: integer('pages_total'),
    pagesProcessed: integer('pages_processed').notNull().default(0),
    chunksTotal: integer('chunks_total'),
    chunksProcessed: integer('chunks_processed').notNull().default(0),
    claimsExtracted: integer('claims_extracted').notNull().default(0),
    claimsAccepted: integer('claims_accepted').notNull().default(0),
    relationshipsCreated: integer('relationships_created').notNull().default(0),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),

    errorSummary: text('error_summary'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('processing_runs_document_idx').on(table.documentId),
    index('processing_runs_stage_idx').on(table.stage),
  ],
);

export type ProcessingRun = typeof processingRuns.$inferSelect;
export type NewProcessingRun = typeof processingRuns.$inferInsert;
