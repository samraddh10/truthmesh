import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { classifyOpenError, limitsFromConfig, validateUpload } from './validation.ts';

const GENEROUS = limitsFromConfig(50, 300);

const EARNINGS_DECK = 'datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf';
const ENCRYPTED = 'tests/fixtures/encrypted.pdf';
const THREE_PAGES = 'tests/fixtures/three-blank-pages.pdf';

const read = async (path: string) => new Uint8Array(await readFile(path));

describe('accepting a valid PDF', () => {
  it('reports the page count and content hash', async () => {
    const result = await validateUpload(await read(EARNINGS_DECK), GENEROUS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageCount).toBe(27);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteSize).toBeGreaterThan(0);
  });

  it("leaves the caller's buffer intact", async () => {
    const bytes = await read(EARNINGS_DECK);
    const sizeBefore = bytes.byteLength;

    await validateUpload(bytes, GENEROUS);

    expect(bytes.byteLength).toBe(sizeBefore);
  });

  it('gives the same hash on a second read of the same file', async () => {
    const [first, second] = await Promise.all([
      validateUpload(await read(THREE_PAGES), GENEROUS),
      validateUpload(await read(THREE_PAGES), GENEROUS),
    ]);

    expect(first.ok && second.ok && first.contentHash === second.contentHash).toBe(true);
  });
});

describe('rejecting with a specific reason', () => {
  it('names an empty file', async () => {
    const result = await validateUpload(new Uint8Array(0), GENEROUS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_file');
  });

  it('names a file over the size limit, and does so before parsing it', async () => {
    const result = await validateUpload(await read(EARNINGS_DECK), limitsFromConfig(0.000001, 300));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_large');
    expect(result.message).toMatch(/above the/);
  });

  it('names something that is not a PDF', async () => {
    const result = await validateUpload(new TextEncoder().encode('this is a text file'), GENEROUS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_a_pdf');
  });

  it('names an encrypted PDF, against a genuinely encrypted file', async () => {
    const result = await validateUpload(await read(ENCRYPTED), GENEROUS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('encrypted');
  });

  it('names a malformed PDF when the body is truncated', async () => {
    const whole = await read(EARNINGS_DECK);
    const truncated = whole.subarray(0, 2048);

    const result = await validateUpload(truncated, GENEROUS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  it('names a PDF over the page limit, and reports both numbers', async () => {
    const result = await validateUpload(await read(THREE_PAGES), limitsFromConfig(50, 2));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_many_pages');
    expect(result.message).toContain('3 pages');
    expect(result.message).toContain('2-page limit');
  });

  it('accepts a PDF exactly at the page limit', async () => {
    const result = await validateUpload(await read(THREE_PAGES), limitsFromConfig(50, 3));
    expect(result.ok).toBe(true);
  });
});

describe('classifyOpenError', () => {
  it('treats a PDF.js password exception as encrypted', () => {
    expect(classifyOpenError({ name: 'PasswordException', message: 'No password given' }).reason).toBe(
      'encrypted',
    );
  });

  it('treats an unnamed password complaint as encrypted', () => {
    expect(classifyOpenError(new Error('Incorrect Password')).reason).toBe('encrypted');
  });

  it('treats anything else as malformed', () => {
    expect(classifyOpenError(new Error('Invalid XRef stream header')).reason).toBe('malformed');
  });

  it('never loses the underlying message', () => {
    expect(classifyOpenError(new Error('Invalid XRef stream header')).message).toContain(
      'Invalid XRef stream header',
    );
  });
});
