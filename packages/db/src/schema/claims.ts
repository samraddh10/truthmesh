import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

import { documents } from './collections.ts';
import { claimStatus, evidenceEntailment, evidenceVerification } from './enums.ts';
import { entities, factGroups } from './entities.ts';
import { processingRuns } from './processing.ts';
import { sourceBlocks } from './sources.ts';

export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => processingRuns.id, { onDelete: 'set null' }),

    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    factGroupId: uuid('fact_group_id').references(() => factGroups.id, { onDelete: 'set null' }),

    subject: text('subject').notNull(),

    predicate: text('predicate').notNull(),

    originalStatement: text('original_statement').notNull(),

    rawValue: text('raw_value'),

    numericValue: numeric('numeric_value'),

    normalizedValue: numeric('normalized_value'),
    normalizedUnit: text('normalized_unit'),

    currency: text('currency'),
    scale: text('scale'),
    unit: text('unit'),

    valuePrecision: integer('value_precision'),

    periodLabel: text('period_label'),
    periodType: text('period_type'),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),

    scope: text('scope'),
    assertionStatus: text('assertion_status'),

    qualifiers: jsonb('qualifiers').notNull().default([]),

    normalization: jsonb('normalization'),

    status: claimStatus('status').notNull().default('needs_review'),
    statusReason: text('status_reason'),

    assertionFingerprint: text('assertion_fingerprint').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('claims_document_fingerprint_key').on(table.documentId, table.assertionFingerprint),
    index('claims_document_idx').on(table.documentId),
    index('claims_entity_predicate_idx').on(table.entityId, table.predicate),
    index('claims_predicate_idx').on(table.predicate),
    index('claims_status_idx').on(table.status),
    index('claims_fact_group_idx').on(table.factGroupId),
  ],
);

export const claimEvidence = pgTable(
  'claim_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    sourceBlockId: uuid('source_block_id')
      .notNull()
      .references(() => sourceBlocks.id, { onDelete: 'cascade' }),

    quote: text('quote').notNull(),
    quoteStart: integer('quote_start'),
    quoteEnd: integer('quote_end'),

    verification: evidenceVerification('verification').notNull().default('unchecked'),
    entailment: evidenceEntailment('entailment').notNull().default('unchecked'),
    verificationNote: text('verification_note'),

    supportRole: text('support_role').notNull().default('value'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('claim_evidence_claim_block_quote_key').on(
      table.claimId,
      table.sourceBlockId,
      table.quote,
    ),
    index('claim_evidence_claim_idx').on(table.claimId),
    index('claim_evidence_block_idx').on(table.sourceBlockId),
  ],
);

export const claimEmbeddings = pgTable(
  'claim_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),

    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    taskType: text('task_type').notNull(),

    embeddedText: text('embedded_text').notNull(),

    embedding: vector('embedding', { dimensions: 768 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('claim_embeddings_claim_model_key').on(table.claimId, table.model),
    index('claim_embeddings_model_idx').on(table.model),
  ],
);

export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type ClaimEvidence = typeof claimEvidence.$inferSelect;
export type NewClaimEvidence = typeof claimEvidence.$inferInsert;
export type ClaimEmbedding = typeof claimEmbeddings.$inferSelect;
export type NewClaimEmbedding = typeof claimEmbeddings.$inferInsert;
