import { and, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { sourceBlocks } from '@superjoin/db';

import type { PageText } from '../pdf-text.ts';
import type { PageClassification } from './classify.ts';
import { buildLayout, type PageLayout, type TextBlock } from './layout.ts';
import { readPrintedPageLabel } from './page-label.ts';

export const PARSER_VERSION = 'native-text@1';

export type BlockType = 'paragraph' | 'heading' | 'list' | 'table' | 'chart' | 'other';

export interface PersistPageOptions {
  readonly documentId: string;
  readonly producedBy?: string;
}

export interface PersistedPage {
  readonly physicalPage: number;
  readonly blocksWritten: number;
  readonly blocksSkipped: number;
  readonly printedPageLabel: string | null;
}

function looksLikeHeading(block: TextBlock, medianTextHeight: number): boolean {
  if (block.lines.length !== 1) return false;
  const line = block.lines[0]!;
  return line.height > medianTextHeight * 1.15 && line.text.length <= 80;
}

function looksLikeList(block: TextBlock): boolean {
  if (block.lines.length < 3) return false;
  const left = block.lines[0]!.x0;
  const aligned = block.lines.filter((line) => Math.abs(line.x0 - left) < 2).length;
  const short = block.lines.filter((line) => line.text.length <= 60).length;
  return aligned >= block.lines.length * 0.8 && short >= block.lines.length * 0.8;
}

export function classifyBlockType(
  block: TextBlock,
  layout: PageLayout,
  page: PageClassification,
): BlockType {
  if (looksLikeHeading(block, layout.medianTextHeight)) return 'heading';

  if (page.kind === 'structured') {
    const runs = block.lines.flatMap((line) => line.items);
    if (runs.length >= 8) return 'table';
  }

  if (looksLikeList(block)) return 'list';
  return 'paragraph';
}

export async function persistPageBlocks(
  db: Database,
  pageText: PageText,
  classification: PageClassification,
  options: PersistPageOptions,
): Promise<PersistedPage> {
  const producedBy = options.producedBy ?? PARSER_VERSION;
  const layout = buildLayout(pageText);
  const printed = readPrintedPageLabel(pageText);

  const existing = await db
    .select({ id: sourceBlocks.id })
    .from(sourceBlocks)
    .where(
      and(
        eq(sourceBlocks.documentId, options.documentId),
        eq(sourceBlocks.physicalPage, pageText.physicalPage),
        eq(sourceBlocks.producedBy, producedBy),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return {
      physicalPage: pageText.physicalPage,
      blocksWritten: 0,
      blocksSkipped: 1,
      printedPageLabel: printed.label,
    };
  }

  const rows = [];
  let blockIndex = 0;

  for (const region of layout.regions) {
    for (const block of region.blocks) {
      const runs = block.lines.flatMap((line) => line.items);

      rows.push({
        documentId: options.documentId,
        physicalPage: pageText.physicalPage,
        printedPageLabel: printed.label,
        blockType: classifyBlockType(block, layout, classification),
        extractionMethod: 'native_text' as const,
        blockIndex: blockIndex++,
        content: block.text,
        positionedItems: runs.map((run) => ({
          text: run.text,
          x: run.x,
          y: run.y,
          width: run.width,
          height: run.height,
          readingIndex: run.readingIndex,
        })),
        bboxX: block.x0,
        bboxY: block.yBottom,
        bboxWidth: block.x1 - block.x0,
        bboxHeight: block.yTop - block.yBottom,
        coordinateOrigin: pageText.coordinateOrigin,
        pageWidthPt: pageText.widthPt,
        pageHeightPt: pageText.heightPt,
        pageRotation: pageText.rotation,
        producedBy,
      });
    }
  }

  if (rows.length === 0) {
    return {
      physicalPage: pageText.physicalPage,
      blocksWritten: 0,
      blocksSkipped: 0,
      printedPageLabel: printed.label,
    };
  }

  await db.insert(sourceBlocks).values(rows).onConflictDoNothing();

  return {
    physicalPage: pageText.physicalPage,
    blocksWritten: rows.length,
    blocksSkipped: 0,
    printedPageLabel: printed.label,
  };
}
