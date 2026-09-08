import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { collections } from './collections.ts';
import { relationshipLabel } from './enums.ts';
import { claims } from './claims.ts';

export const relationships = pgTable(
  'relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    claimAId: uuid('claim_a_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    claimBId: uuid('claim_b_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),

    label: relationshipLabel('label').notNull(),

    rationale: text('rationale').notNull(),

    contextDifferences: jsonb('context_differences').notNull().default([]),

    uncertaintyReasons: jsonb('uncertainty_reasons').notNull().default([]),

    deterministicChecks: jsonb('deterministic_checks'),

    supportingEvidenceIds: jsonb('supporting_evidence_ids').notNull().default([]),

    method: text('method').notNull(),
    methodVersion: text('method_version').notNull(),
    modelName: text('model_name'),
    promptVersion: text('prompt_version'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('relationships_pair_method_key').on(
      table.claimAId,
      table.claimBId,
      table.methodVersion,
    ),
    index('relationships_collection_label_idx').on(table.collectionId, table.label),
    index('relationships_claim_a_idx').on(table.claimAId),
    index('relationships_claim_b_idx').on(table.claimBId),
  ],
);

export type Relationship = typeof relationships.$inferSelect;
export type NewRelationship = typeof relationships.$inferInsert;
