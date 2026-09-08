import { z } from 'zod';

export const EXTRACTION_PROMPT_VERSION = 'claim-extract@3';

export const periodTypeSchema = z.enum([
  'fiscal_year',
  'calendar_year',
  'quarter',
  'half_year',
  'month',
  'as_of_date',
  'range',
  'unknown',
]);
export type PeriodType = z.infer<typeof periodTypeSchema>;

export const assertionStatusSchema = z.enum([
  'reported',
  'restated',
  'estimate',
  'forecast',
  'pro_forma',
  'target',
  'unknown',
]);
export type AssertionStatus = z.infer<typeof assertionStatusSchema>;

export const qualifierSchema = z.object({
  name: z.string().min(1).max(80),
  value: z.string().min(1).max(400),
});
export type Qualifier = z.infer<typeof qualifierSchema>;

export const extractedClaimSchema = z.object({
  subject: z.string().min(1).max(300),
  predicate: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, 'predicate must be lower_snake_case'),
  original_statement: z.string().min(1).max(2000),

  raw_value: z.string().max(200).nullable(),
  numeric_value: z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/, 'numeric_value must be a plain decimal string')
    .nullable(),
  currency: z.string().max(20).nullable(),
  scale: z.string().max(40).nullable(),
  unit: z.string().max(60).nullable(),

  period_label: z.string().max(80).nullable(),
  period_type: periodTypeSchema.nullable(),
  scope: z.string().max(120).nullable(),
  assertion_status: assertionStatusSchema.nullable(),

  qualifiers: z.array(qualifierSchema).max(12),

  evidence_block_ids: z.array(z.string().min(1).max(20)).min(1).max(8),
  quote: z.string().min(1).max(1200),
});
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;

export const extractionResponseSchema = z.object({
  claims: z.array(extractedClaimSchema).max(60),
});
export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          original_statement: { type: 'string' },
          raw_value: { type: ['string', 'null'] },
          numeric_value: { type: ['string', 'null'] },
          currency: { type: ['string', 'null'] },
          scale: { type: ['string', 'null'] },
          unit: { type: ['string', 'null'] },
          period_label: { type: ['string', 'null'] },
          period_type: {
            type: ['string', 'null'],
            enum: [...periodTypeSchema.options, null],
          },
          scope: { type: ['string', 'null'] },
          assertion_status: {
            type: ['string', 'null'],
            enum: [...assertionStatusSchema.options, null],
          },
          qualifiers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
          evidence_block_ids: { type: 'array', items: { type: 'string' } },
          quote: { type: 'string' },
        },
        required: [
          'subject',
          'predicate',
          'original_statement',
          'raw_value',
          'numeric_value',
          'currency',
          'scale',
          'unit',
          'period_label',
          'period_type',
          'scope',
          'assertion_status',
          'qualifiers',
          'evidence_block_ids',
          'quote',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
} as const;

export type ExtractionParse =
  | { readonly ok: true; readonly claims: readonly ExtractedClaim[] }
  | { readonly ok: false; readonly feedback: string };

export function parseExtraction(value: unknown): ExtractionParse {
  const parsed = extractionResponseSchema.safeParse(value);
  if (parsed.success) return { ok: true, claims: parsed.data.claims };

  const issues = parsed.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

  return { ok: false, feedback: issues };
}
