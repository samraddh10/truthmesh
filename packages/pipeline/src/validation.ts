import { getDocumentProxy } from 'unpdf';

import { contentHash } from './storage.ts';

export type RejectionReason =
  | 'empty_file'
  | 'too_large'
  | 'not_a_pdf'
  | 'encrypted'
  | 'malformed'
  | 'no_pages'
  | 'too_many_pages';

export interface ValidationLimits {
  readonly maxUploadBytes: number;
  readonly maxPages: number;
}

export type ValidationResult =
  | {
      readonly ok: true;
      readonly pageCount: number;
      readonly contentHash: string;
      readonly byteSize: number;
    }
  | {
      readonly ok: false;
      readonly reason: RejectionReason;
      readonly message: string;
    };

export function limitsFromConfig(maxUploadMb: number, maxPdfPages: number): ValidationLimits {
  return { maxUploadBytes: maxUploadMb * 1024 * 1024, maxPages: maxPdfPages };
}

const SIGNATURE_SEARCH_WINDOW = 1024;

function hasPdfSignature(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, SIGNATURE_SEARCH_WINDOW);
  const text = new TextDecoder('latin1').decode(window);
  return text.includes('%PDF-');
}

export function classifyOpenError(error: unknown): {
  reason: Extract<RejectionReason, 'encrypted' | 'malformed'>;
  message: string;
} {
  const named = error as { name?: string; message?: string; code?: number };
  const name = named.name ?? '';
  const message = named.message ?? String(error);

  if (name === 'PasswordException' || /password/i.test(message)) {
    return {
      reason: 'encrypted',
      message: `the PDF is password protected and cannot be read: ${message}`,
    };
  }

  return { reason: 'malformed', message: `the PDF structure could not be read: ${message}` };
}

export async function validateUpload(
  bytes: Uint8Array,
  limits: ValidationLimits,
): Promise<ValidationResult> {
  if (bytes.byteLength === 0) {
    return { ok: false, reason: 'empty_file', message: 'the uploaded file is empty' };
  }

  if (bytes.byteLength > limits.maxUploadBytes) {
    const asMb = (value: number) => (value / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: 'too_large',
      message: `the file is ${asMb(bytes.byteLength)}MB, above the ${asMb(limits.maxUploadBytes)}MB limit`,
    };
  }

  if (!hasPdfSignature(bytes)) {
    return {
      ok: false,
      reason: 'not_a_pdf',
      message: 'no %PDF- signature was found in the first 1024 bytes',
    };
  }

  const byteSize = bytes.byteLength;
  const hash = contentHash(bytes);

  let pageCount: number;
  try {
    const document = await getDocumentProxy(new Uint8Array(bytes));
    pageCount = document.numPages;
    await document.cleanup?.();
  } catch (error) {
    const { reason, message } = classifyOpenError(error);
    return { ok: false, reason, message };
  }

  if (pageCount === 0) {
    return { ok: false, reason: 'no_pages', message: 'the PDF contains no pages' };
  }

  if (pageCount > limits.maxPages) {
    return {
      ok: false,
      reason: 'too_many_pages',
      message: `the PDF has ${pageCount} pages, above the ${limits.maxPages}-page limit`,
    };
  }

  return { ok: true, pageCount, contentHash: hash, byteSize };
}
