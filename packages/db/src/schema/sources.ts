import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { documents } from './collections.ts';
import { extractionMethod, sourceBlockType } from './enums.ts';

export const sourceBlocks = pgTable(
  'source_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    physicalPage: integer('physical_page').notNull(),

    printedPageLabel: text('printed_page_label'),

    blockType: sourceBlockType('block_type').notNull(),
    extractionMethod: extractionMethod('extraction_method').notNull(),

    blockIndex: integer('block_index').notNull(),

    content: text('content').notNull(),

    positionedItems: jsonb('positioned_items'),

    tableRowIndex: integer('table_row_index'),
    tableColumnIndex: integer('table_column_index'),
    tableHeaders: jsonb('table_headers'),

    bboxX: doublePrecision('bbox_x'),
    bboxY: doublePrecision('bbox_y'),
    bboxWidth: doublePrecision('bbox_width'),
    bboxHeight: doublePrecision('bbox_height'),

    coordinateOrigin: text('coordinate_origin').notNull().default('bottom-left'),
    pageWidthPt: doublePrecision('page_width_pt'),
    pageHeightPt: doublePrecision('page_height_pt'),
    pageRotation: integer('page_rotation').notNull().default(0),

    pageImageKey: text('page_image_key'),

    producedBy: text('produced_by').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('source_blocks_identity_key').on(
      table.documentId,
      table.physicalPage,
      table.blockIndex,
      table.producedBy,
    ),
    index('source_blocks_document_page_idx').on(table.documentId, table.physicalPage),
  ],
);

export type SourceBlock = typeof sourceBlocks.$inferSelect;
export type NewSourceBlock = typeof sourceBlocks.$inferInsert;
