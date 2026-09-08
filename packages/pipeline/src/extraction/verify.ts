import type { ExtractedClaim } from './contract.ts';

export interface EvidenceBlock {
  readonly id: string;
  readonly documentId: string;
  readonly physicalPage: number;
  readonly content: string;
  readonly extractionMethod: 'native_text' | 'model_transcription';
  readonly blockType?: string;
}

export type Verification =
  | 'verified_native_text'
  | 'visual_only'
  | 'quote_not_found'
  | 'block_not_found';

export type Entailment = 'supported' | 'unsupported' | 'unclear' | 'unchecked';

export interface VerifiedEvidence {
  readonly sourceBlockId: string | null;
  readonly citedRef: string;
  readonly quote: string;
  readonly quoteStart: number | null;
  readonly quoteEnd: number | null;
  readonly verification: Verification;
  readonly entailment: Entailment;
  readonly verificationNote: string | null;
  readonly supportRole: 'value' | 'context';
}

export interface ClaimVerification {
  readonly evidence: readonly VerifiedEvidence[];
  readonly status: 'accepted' | 'needs_review' | 'rejected';
  readonly statusReason: string;
}

const CHARACTER_MAP = new Map<string, string>([
  ['‘', "'"],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  ['–', '-'],
  ['—', '-'],
  ['−', '-'],
  ['­', ''],
  ['​', ''],
  ['﻿', ''],
]);

interface Normalized {
  readonly text: string;
  readonly offsets: readonly number[];
}

export function normalizeForMatch(input: string): Normalized {
  const chars: string[] = [];
  const offsets: number[] = [];
  let pendingSpace = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (/\s/.test(char)) {
      if (chars.length > 0) pendingSpace = true;
      continue;
    }

    const mapped = CHARACTER_MAP.get(char) ?? char;
    if (mapped === '') continue;

    if (pendingSpace) {
      chars.push(' ');
      offsets.push(index);
      pendingSpace = false;
    }

    chars.push(mapped);
    offsets.push(index);
  }

  return { text: chars.join(''), offsets };
}

export interface QuoteLocation {
  readonly start: number;
  readonly end: number;
}

export function locateQuote(quote: string, content: string): QuoteLocation | null {
  const needle = normalizeForMatch(quote);
  const haystack = normalizeForMatch(content);

  if (needle.text === '') return null;

  const at = haystack.text.indexOf(needle.text);
  if (at === -1) return null;

  const start = haystack.offsets[at]!;
  const lastNormalized = at + needle.text.length - 1;
  const end = haystack.offsets[lastNormalized]! + 1;

  return { start, end };
}

function digitsOf(value: string): string {
  return value.replace(/[^0-9.]/g, '').replace(/\.+$/, '');
}

export function statesValue(claim: ExtractedClaim, quote: string): boolean {
  const value = claim.numeric_value ?? claim.raw_value;
  if (value === null) return false;

  const wanted = digitsOf(value);
  if (wanted === '') return false;

  return digitsOf(quote).includes(wanted);
}

export function overlapsStatement(claim: ExtractedClaim, quote: string): boolean {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2),
    );

  const wanted = words(claim.original_statement);
  if (wanted.size === 0) return false;

  const found = words(quote);
  let shared = 0;
  for (const word of wanted) if (found.has(word)) shared += 1;

  return shared >= Math.ceil(wanted.size * 0.6);
}

export interface VerifyOptions {
  readonly documentId: string;
  readonly refToBlockId: ReadonlyMap<string, string>;
  readonly blocksById: ReadonlyMap<string, EvidenceBlock>;
  readonly nativeBlocksByPage?: ReadonlyMap<number, readonly EvidenceBlock[]>;
}

export function verifyClaim(claim: ExtractedClaim, options: VerifyOptions): ClaimVerification {
  const evidence: VerifiedEvidence[] = [];
  const seen = new Set<string>();

  for (const citedRef of claim.evidence_block_ids) {
    const blockId = options.refToBlockId.get(citedRef) ?? citedRef;
    const block = options.blocksById.get(blockId);

    if (block === undefined || block.documentId !== options.documentId) {
      evidence.push({
        sourceBlockId: null,
        citedRef,
        quote: claim.quote,
        quoteStart: null,
        quoteEnd: null,
        verification: 'block_not_found',
        entailment: 'unchecked',
        verificationNote:
          block === undefined
            ? 'the cited block is not part of the material this claim was extracted from'
            : 'the cited block belongs to a different document',
        supportRole: 'value',
      });
      continue;
    }

    if (seen.has(block.id)) continue;
    seen.add(block.id);

    const location = locateQuote(claim.quote, block.content);
    const carriesValue = statesValue(claim, claim.quote);

    if (location === null) {
      evidence.push({
        sourceBlockId: block.id,
        citedRef,
        quote: claim.quote,
        quoteStart: null,
        quoteEnd: null,
        verification: 'quote_not_found',
        entailment: 'unchecked',
        verificationNote: 'the quoted passage is not present in this block',
        supportRole: carriesValue ? 'value' : 'context',
      });
      continue;
    }

    const entailment: Entailment =
      claim.numeric_value !== null || claim.raw_value !== null
        ? carriesValue
          ? 'supported'
          : 'unsupported'
        : overlapsStatement(claim, claim.quote)
          ? 'supported'
          : 'unclear';

    evidence.push({
      sourceBlockId: block.id,
      citedRef,
      quote: claim.quote,
      quoteStart: location.start,
      quoteEnd: location.end,
      verification:
        block.extractionMethod === 'native_text' ? 'verified_native_text' : 'visual_only',
      entailment,
      verificationNote:
        block.extractionMethod === 'native_text'
          ? null
          : 'read from a model transcription of the page image, which cannot verify a claim the same model extracted',
      supportRole: carriesValue ? 'value' : 'context',
    });

    if (block.extractionMethod === 'model_transcription' && entailment === 'supported') {
      const crossCheck = crossCheckInNativeText(claim, block.physicalPage, options);
      if (crossCheck !== null) evidence.push(crossCheck);
    }
  }

  return {
    evidence,
    ...decideClaimStatus(evidence, claim.raw_value ?? claim.numeric_value ?? 'the reported value'),
  };
}

function crossCheckInNativeText(
  claim: ExtractedClaim,
  physicalPage: number,
  options: VerifyOptions,
): VerifiedEvidence | null {
  const candidates = options.nativeBlocksByPage?.get(physicalPage);
  if (candidates === undefined) return null;

  for (const candidate of candidates) {
    if (!statesValue(claim, candidate.content)) continue;

    return {
      sourceBlockId: candidate.id,
      citedRef: 'cross-check',
      quote: claim.quote,
      quoteStart: null,
      quoteEnd: null,
      verification: 'verified_native_text',
      entailment: 'supported',
      verificationNote:
        'the figure appears in this page text layer, which is independent of the transcription the claim cited',
      supportRole: 'value',
    };
  }

  return null;
}

export interface EvidenceVerdict {
  readonly verification: Verification | 'unchecked';
  readonly entailment: Entailment;
}

export function decideClaimStatus(
  evidence: readonly EvidenceVerdict[],
  valueLabel: string,
): { status: 'accepted' | 'needs_review' | 'rejected'; statusReason: string } {
  if (evidence.length === 0) {
    return { status: 'rejected', statusReason: 'the claim cited no evidence' };
  }

  const located = evidence.filter(
    (row) => row.verification === 'verified_native_text' || row.verification === 'visual_only',
  );

  if (located.length === 0) {
    const invented = evidence.some((row) => row.verification === 'block_not_found');
    return {
      status: 'rejected',
      statusReason: invented
        ? 'every cited block is outside the material this claim was extracted from'
        : 'the quoted passage was not found in any cited block',
    };
  }

  if (located.some((row) => row.entailment === 'unsupported')) {
    return {
      status: 'rejected',
      statusReason: `the cited passage does not state ${valueLabel}`,
    };
  }

  const nativeSupport = located.some(
    (row) => row.verification === 'verified_native_text' && row.entailment === 'supported',
  );

  if (nativeSupport) {
    return { status: 'accepted', statusReason: 'quoted passage located in the document text' };
  }

  if (located.some((row) => row.verification === 'visual_only')) {
    return {
      status: 'needs_review',
      statusReason:
        'supported only by a model transcription of the page image, which is not independent of the extraction',
    };
  }

  return {
    status: 'needs_review',
    statusReason: 'the quoted passage was located but does not clearly support the claim',
  };
}
