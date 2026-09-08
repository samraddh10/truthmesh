import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { claims } from './claims.ts';
import { issueResolution, runStage } from './enums.ts';
import { processingRuns } from './processing.ts';
import { sourceBlocks } from './sources.ts';

export const processingIssues = pgTable(
  'processing_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processingRuns.id, { onDelete: 'cascade' }),

    stage: runStage('stage').notNull(),

    failureKind: text('failure_kind').notNull(),

    isTransient: boolean('is_transient'),

    physicalPage: integer('physical_page'),
    sourceBlockId: uuid('source_block_id').references(() => sourceBlocks.id, {
      onDelete: 'set null',
    }),
    claimId: uuid('claim_id').references(() => claims.id, { onDelete: 'set null' }),

    message: text('message').notNull(),
    detail: jsonb('detail'),

    attemptCount: integer('attempt_count').notNull().default(1),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),

    resolution: issueResolution('resolution').notNull().default('open'),
    resolutionNote: text('resolution_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('processing_issues_run_idx').on(table.runId),
    index('processing_issues_resolution_idx').on(table.resolution),
    index('processing_issues_kind_idx').on(table.failureKind),
  ],
);

export type ProcessingIssue = typeof processingIssues.$inferSelect;
export type NewProcessingIssue = typeof processingIssues.$inferInsert;
