import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a plain decimal string');

function nullish<T extends z.ZodType>(inner: T) {
  return inner.nullish().transform((value) => value ?? null);
}

export const goldClaimSchema = z.object({
  id: z.string(),
  document: z.string(),
  physical_page: z.number().int().nonnegative(),
  printed_page_label: nullish(z.string()),
  subject: z.string(),
  predicate: z.string(),
  numeric_value: nullish(decimalString),
  raw_value: nullish(z.string()),
  currency: nullish(z.string()),
  scale: nullish(z.string()),
  unit: nullish(z.string()),
  period_label: nullish(z.string()),
  period_type: nullish(z.string()),
  as_of: nullish(z.string()),
  scope: nullish(z.string()),
  assertion_status: nullish(z.string()),
  qualifiers: z.array(z.unknown()).optional(),
  notes: z.string().optional(),
  evidence_kind: z.enum(['narrative', 'table', 'chart', 'list']),
  quote: z.string().min(1),
});
export type GoldClaim = z.infer<typeof goldClaimSchema>;

export const goldPairSchema = z.object({
  id: z.string(),
  claim_a: z.string(),
  claim_b: z.string(),
  expected_label: z.enum([
    'corroborates',
    'contradicts',
    'likely_contradiction',
    'reconciled_by_context',
    'insufficient_context',
    'unrelated',
  ]),
  context_dimensions: z.array(z.string()),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  rationale: z.string(),
});
export type GoldPair = z.infer<typeof goldPairSchema>;

export const goldDocumentSchema = z.object({
  id: z.string(),
  file: z.string(),
  pages: z.number().int().positive(),
  published: z.string(),
});
export type GoldDocument = z.infer<typeof goldDocumentSchema>;

export const goldsetSchema = z.object({
  version: z.string(),
  created: z.string(),
  collection: z.string(),
  method: z.string(),
  conventions: z.record(z.string(), z.string()),
  documents: z.array(goldDocumentSchema).min(1),
  claims: z.array(goldClaimSchema).min(1),
  pairs: z.array(goldPairSchema),
});
export type Goldset = z.infer<typeof goldsetSchema>;

export class GoldsetError extends Error {}

export async function loadGoldset(path: string): Promise<Goldset> {
  const raw = await readFile(path, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new GoldsetError(`${path} is not valid JSON: ${(cause as Error).message}`);
  }

  const result = goldsetSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new GoldsetError(
      `${path} does not match the evaluation contract at ${issue?.path.join('.')}: ${issue?.message}`,
    );
  }
  const goldset = result.data;

  const documentIds = new Set(goldset.documents.map((document) => document.id));
  const claimIds = new Set<string>();

  for (const claim of goldset.claims) {
    if (claimIds.has(claim.id)) throw new GoldsetError(`duplicate claim id ${claim.id}`);
    claimIds.add(claim.id);

    if (!documentIds.has(claim.document)) {
      throw new GoldsetError(`claim ${claim.id} names unknown document ${claim.document}`);
    }
    const document = goldset.documents.find((entry) => entry.id === claim.document)!;
    if (claim.physical_page >= document.pages) {
      throw new GoldsetError(
        `claim ${claim.id} cites physical page ${claim.physical_page}, past the end of ${document.id} (${document.pages} pages)`,
      );
    }
  }

  const pairIds = new Set<string>();
  for (const pair of goldset.pairs) {
    if (pairIds.has(pair.id)) throw new GoldsetError(`duplicate pair id ${pair.id}`);
    pairIds.add(pair.id);

    for (const member of [pair.claim_a, pair.claim_b]) {
      if (!claimIds.has(member)) {
        throw new GoldsetError(`pair ${pair.id} names unknown claim ${member}`);
      }
    }
    if (pair.claim_a === pair.claim_b) {
      throw new GoldsetError(`pair ${pair.id} compares a claim with itself`);
    }
  }

  return goldset;
}

export function goldDocumentResolver(
  goldset: Goldset,
  filenameOf: (documentId: string) => string | undefined,
): (documentId: string) => string | undefined {
  const byBasename = new Map<string, string>();
  for (const document of goldset.documents) {
    const basename = document.file.split('/').pop() ?? document.file;
    byBasename.set(basename.toLowerCase(), document.id);
  }

  return (documentId: string) => {
    const filename = filenameOf(documentId);
    if (filename === undefined) return undefined;
    return byBasename.get(filename.toLowerCase());
  };
}

export function pairedClaimIds(goldset: Goldset): Set<string> {
  const ids = new Set<string>();
  for (const pair of goldset.pairs) {
    ids.add(pair.claim_a);
    ids.add(pair.claim_b);
  }
  return ids;
}
