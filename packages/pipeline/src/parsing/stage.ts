import type { StageHandler, ProcessingContext } from '../processor.ts';
import { extractPageText } from '../pdf-text.ts';
import { readObject } from '../storage.ts';
import { recordIssue, recordProgress } from '../run-state.ts';
import { buildLayout } from './layout.ts';
import { classifyPage, type PageClassification } from './classify.ts';
import { persistPageBlocks, PARSER_VERSION } from './persist.ts';

export interface ParseSummary {
  readonly pagesTotal: number;
  readonly pagesParsed: number;
  readonly pagesEmpty: number;
  readonly pagesFailed: number;
  readonly blocksWritten: number;
  readonly pagesNeedingVisualRoute: readonly number[];
}

const PROGRESS_INTERVAL = 5;

export async function parseDocument(context: ProcessingContext): Promise<ParseSummary> {
  const { db } = context.database;
  const bytes = await readObject(context.storageDir, context.storageKey);

  let pagesParsed = 0;
  let pagesEmpty = 0;
  let pagesFailed = 0;
  let blocksWritten = 0;
  const needsVisual: number[] = [];

  for (let physicalPage = 0; physicalPage < context.pageCount; physicalPage += 1) {
    try {
      const pageText = await extractPageText(bytes, physicalPage);
      const classification: PageClassification = classifyPage(buildLayout(pageText));

      if (classification.kind === 'empty' || classification.kind === 'sparse') {
        pagesEmpty += 1;
        pagesParsed += 1;
        continue;
      }

      const persisted = await persistPageBlocks(db, pageText, classification, {
        documentId: context.job.documentId,
        producedBy: PARSER_VERSION,
      });

      blocksWritten += persisted.blocksWritten;
      if (classification.needsVisualRoute) needsVisual.push(physicalPage);
      pagesParsed += 1;
    } catch (error) {
      pagesFailed += 1;
      await recordIssue(db, context.job.runId, {
        stage: 'parsing',
        failureKind: 'page_parse_failed',
        failureClass: 'permanent',
        message: `physical page ${physicalPage}: ${(error as Error).message}`,
        physicalPage,
      });
    }

    if (physicalPage % PROGRESS_INTERVAL === 0) {
      await recordProgress(db, context.job.runId, { pagesProcessed: pagesParsed });
    }
  }

  await recordProgress(db, context.job.runId, { pagesProcessed: pagesParsed });

  return {
    pagesTotal: context.pageCount,
    pagesParsed,
    pagesEmpty,
    pagesFailed,
    blocksWritten,
    pagesNeedingVisualRoute: needsVisual,
  };
}

export const parsingStage: StageHandler = {
  stage: 'parsing',
  async run(context) {
    await parseDocument(context);
  },
};
