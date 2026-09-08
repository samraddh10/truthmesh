import { getDocumentProxy } from 'unpdf';

export type CoordinateOrigin = 'bottom-left';

export interface PositionedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly readingIndex: number;
}

export interface PageText {
  readonly physicalPage: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly rotation: number;
  readonly coordinateOrigin: CoordinateOrigin;
  readonly items: readonly PositionedText[];
  readonly characterCount: number;
}

export class PdfExtractionError extends Error {
  override readonly name = 'PdfExtractionError';
}

interface RawTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

function toPositioned(items: readonly unknown[]): PositionedText[] {
  const positioned: PositionedText[] = [];

  for (const raw of items) {
    const item = raw as RawTextItem;
    if (typeof item.str !== 'string') continue;

    const text = item.str.trim();
    if (text === '') continue;

    const transform = item.transform;
    if (transform === undefined || transform.length < 6) continue;

    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    const width = item.width ?? 0;

    positioned.push({
      text,
      x,
      y,
      width,
      height: item.height ?? 0,
      centerX: x + width / 2,
      readingIndex: positioned.length,
    });
  }

  return positioned;
}

async function openDocument(bytes: Uint8Array) {
  try {
    return await getDocumentProxy(new Uint8Array(bytes));
  } catch (cause) {
    throw new PdfExtractionError(`could not open PDF: ${(cause as Error).message}`, { cause });
  }
}

async function release(doc: { cleanup?: () => unknown }): Promise<void> {
  try {
    await doc.cleanup?.();
  } catch {
  }
}

export async function extractPageText(bytes: Uint8Array, physicalPage: number): Promise<PageText> {
  if (!Number.isInteger(physicalPage) || physicalPage < 0) {
    throw new PdfExtractionError(`physicalPage must be a non-negative integer, got ${physicalPage}`);
  }

  const doc = await openDocument(bytes);
  try {
    if (physicalPage >= doc.numPages) {
      throw new PdfExtractionError(
        `physical page ${physicalPage} is out of range for a ${doc.numPages}-page document`,
      );
    }

    const page = await doc.getPage(physicalPage + 1);
    try {
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });
      const items = toPositioned(content.items);

      return {
        physicalPage,
        widthPt: viewport.width,
        heightPt: viewport.height,
        rotation: viewport.rotation,
        coordinateOrigin: 'bottom-left',
        items,
        characterCount: items.reduce((total, item) => total + item.text.length, 0),
      };
    } finally {
      page.cleanup();
    }
  } finally {
    await release(doc);
  }
}

export async function countPages(bytes: Uint8Array): Promise<number> {
  const doc = await openDocument(bytes);
  try {
    return doc.numPages;
  } finally {
    await release(doc);
  }
}

export function toReadingOrderText(page: PageText): string {
  return page.items.map((item) => item.text).join(' ');
}
