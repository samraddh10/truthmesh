import { z } from 'zod';

import type { Database } from '@superjoin/db';
import { sourceBlocks } from '@superjoin/db';
import { and, eq, inArray } from 'drizzle-orm';

import {
  ModelError,
  extractJson,
  imageContentPart,
  type CompletionProvider,
} from '../model/index.ts';
import { pageImageStorageKey, writeObject } from '../storage.ts';
import { renderPage } from './render.ts';

export const TRANSCRIPTION_PROMPT_VERSION = 'table-transcribe@1';

const cellSchema = z.object({
  text: z.string(),
  rowHeader: z.string().nullable(),
  columnHeader: z.string().nullable(),
  unit: z.string().nullable(),
  footnote: z.string().nullable(),
});

const transcriptionSchema = z.object({
  tables: z.array(
    z.object({
      title: z.string().nullable(),
      unitNote: z.string().nullable(),
      rows: z.array(z.array(cellSchema)),
    }),
  ),
});

export type Transcription = z.infer<typeof transcriptionSchema>;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    tables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: ['string', 'null'] },
          unitNote: { type: ['string', 'null'] },
          rows: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  rowHeader: { type: ['string', 'null'] },
                  columnHeader: { type: ['string', 'null'] },
                  unit: { type: ['string', 'null'] },
                  footnote: { type: ['string', 'null'] },
                },
                required: ['text', 'rowHeader', 'columnHeader', 'unit', 'footnote'],
                additionalProperties: false,
              },
            },
          },
        },
        required: ['title', 'unitNote', 'rows'],
        additionalProperties: false,
      },
    },
  },
  required: ['tables'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
  'You transcribe tables and charts from a page of a financial document.',
  'Report only what is visible on the page. Never infer, complete or correct a value.',
  'Bind every value to the row and column heading it sits under, and carry the unit',
  'stated for that table or column. If a value has a footnote marker, record the marker.',
  'If a cell is unreadable, give its text as an empty string rather than guessing.',
].join(' ');

export interface TranscribeOptions {
  readonly client: CompletionProvider;
  readonly storageDir: string;
  readonly documentHash: string;
  readonly scale?: number;
  readonly maxTokens?: number;
}

export interface TranscriptionResult {
  readonly physicalPage: number;
  readonly transcription: Transcription;
  readonly pageImageKey: string;
  readonly servedByModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export async function transcribePage(
  bytes: Uint8Array,
  physicalPage: number,
  nativeText: string,
  options: TranscribeOptions,
): Promise<TranscriptionResult> {
  const rendered = await renderPage(bytes, physicalPage, { scale: options.scale ?? 2 });

  const pageImageKey = pageImageStorageKey(options.documentHash, physicalPage);
  await writeObject(options.storageDir, pageImageKey, rendered.bytes);

  const result = await options.client.complete({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `This is physical page ${physicalPage} of a financial document.`,
              'Transcribe every table or chart on it.',
              '',
              'The text layer extracted from this page, for the exact digits:',
              nativeText.slice(0, 8000),
            ].join('\n'),
          },
          imageContentPart(rendered.bytes, rendered.mimeType),
        ],
      },
    ],
    schema: { name: 'page_transcription', schema: RESPONSE_SCHEMA },
    maxTokens: options.maxTokens ?? 8000,
  });

  const parsed = transcriptionSchema.safeParse(extractJson(result.text));
  if (!parsed.success) {
    throw new ModelError(
      `transcription did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      'schema_violation',
      true,
    );
  }

  return {
    physicalPage,
    transcription: parsed.data,
    pageImageKey,
    servedByModel: result.servedByModel,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
}

export function renderTranscription(transcription: Transcription): string {
  return transcription.tables
    .map((table) => {
      const header = [table.title, table.unitNote].filter((part) => part !== null).join(' — ');
      const rows = table.rows
        .map((row) => row.map((cell) => cell.text).join(' | '))
        .join('\n');
      return header !== '' ? `${header}\n${rows}` : rows;
    })
    .join('\n\n');
}

export async function persistTranscription(
  db: Database,
  documentId: string,
  result: TranscriptionResult,
  producedBy: string,
): Promise<number> {
  const existing = await db
    .select({ id: sourceBlocks.id })
    .from(sourceBlocks)
    .where(
      and(
        eq(sourceBlocks.documentId, documentId),
        eq(sourceBlocks.physicalPage, result.physicalPage),
        eq(sourceBlocks.producedBy, producedBy),
      ),
    )
    .limit(1);

  if (existing.length > 0) return 0;

  const rows = result.transcription.tables.map((table, index) => ({
    documentId,
    physicalPage: result.physicalPage,
    printedPageLabel: null,
    blockType: 'table' as const,
    extractionMethod: 'model_transcription' as const,
    blockIndex: 10_000 + index,
    content: renderTranscription({ tables: [table] }),
    tableHeaders: table.rows[0]?.map((cell) => cell.columnHeader) ?? null,
    pageImageKey: result.pageImageKey,
    coordinateOrigin: 'bottom-left',
    pageRotation: 0,
    producedBy,
  }));

  if (rows.length === 0) return 0;

  await db.insert(sourceBlocks).values(rows).onConflictDoNothing();
  return rows.length;
}

export async function pagesNeedingTranscription(
  db: Database,
  documentId: string,
  producedBy?: string,
): Promise<number[]> {
  const rows = await db
    .selectDistinct({ physicalPage: sourceBlocks.physicalPage })
    .from(sourceBlocks)
    .where(
      and(
        eq(sourceBlocks.documentId, documentId),
        inArray(sourceBlocks.blockType, ['table', 'chart']),
        eq(sourceBlocks.extractionMethod, 'native_text'),
      ),
    )
    .orderBy(sourceBlocks.physicalPage);

  const candidates = rows.map((row) => row.physicalPage);
  if (producedBy === undefined) return candidates;

  const done = await db
    .selectDistinct({ physicalPage: sourceBlocks.physicalPage })
    .from(sourceBlocks)
    .where(
      and(
        eq(sourceBlocks.documentId, documentId),
        eq(sourceBlocks.extractionMethod, 'model_transcription'),
        eq(sourceBlocks.producedBy, producedBy),
      ),
    );

  const transcribed = new Set(done.map((row) => row.physicalPage));
  return candidates.filter((page) => !transcribed.has(page));
}
