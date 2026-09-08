import { renderPageAsImage } from 'unpdf';

import { PdfExtractionError } from '../pdf-text.ts';

export interface RenderOptions {
  readonly scale?: number;
  readonly maxBytes?: number;
}

const DEFAULTS = {
  scale: 2,
  maxBytes: 4 * 1024 * 1024,
} as const;

export interface RenderedPage {
  readonly physicalPage: number;
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png';
  readonly scale: number;
}

export async function renderPage(
  bytes: Uint8Array,
  physicalPage: number,
  options: RenderOptions = {},
): Promise<RenderedPage> {
  if (!Number.isInteger(physicalPage) || physicalPage < 0) {
    throw new PdfExtractionError(
      `physicalPage must be a non-negative integer, got ${physicalPage}`,
    );
  }

  const scale = options.scale ?? DEFAULTS.scale;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;

  let image: ArrayBuffer;
  try {
    image = await renderPageAsImage(new Uint8Array(bytes), physicalPage + 1, {
      scale,
      canvasImport: () => import('@napi-rs/canvas'),
    });
  } catch (cause) {
    throw new PdfExtractionError(
      `could not render physical page ${physicalPage}: ${(cause as Error).message}`,
      { cause },
    );
  }

  const rendered = new Uint8Array(image);

  if (rendered.byteLength > maxBytes) {
    throw new PdfExtractionError(
      `rendered page ${physicalPage} is ${(rendered.byteLength / 1024 / 1024).toFixed(1)}MB at scale ${scale}, above the ${(maxBytes / 1024 / 1024).toFixed(1)}MB limit; render it smaller`,
    );
  }

  return { physicalPage, bytes: rendered, mimeType: 'image/png', scale };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
