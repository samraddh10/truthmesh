import { z } from 'zod';

import { processingIssueSchema, runStageSchema } from './runs.ts';

export const claimStatusSchema = z.enum(['accepted', 'needs_review', 'rejected']);
export type ClaimStatusContract = z.infer<typeof claimStatusSchema>;

export const evidenceVerificationSchema = z.enum([
  'verified_native_text',
  'visual_only',
  'quote_not_found',
  'block_not_found',
  'unchecked',
]);
export type EvidenceVerificationContract = z.infer<typeof evidenceVerificationSchema>;

export const evidenceEntailmentSchema = z.enum([
  'supported',
  'unsupported',
  'unclear',
  'unchecked',
]);
export type EvidenceEntailmentContract = z.infer<typeof evidenceEntailmentSchema>;

export const relationshipLabelSchema = z.enum([
  'corroborates',
  'contradicts',
  'likely_contradiction',
  'reconciled_by_context',
  'insufficient_context',
  'unrelated',
]);
export type RelationshipLabelContract = z.infer<typeof relationshipLabelSchema>;

export const sourceBlockTypeSchema = z.enum([
  'paragraph',
  'heading',
  'list',
  'table',
  'table_cell',
  'chart',
  'figure',
  'caption',
  'other',
]);

export const extractionMethodSchema = z.enum(['native_text', 'model_transcription']);

export const sourceBlockRefSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  filename: z.string(),
  physicalPage: z.number().int().nonnegative(),
  printedPageLabel: z.string().nullable(),
  blockType: sourceBlockTypeSchema,
  extractionMethod: extractionMethodSchema,
  content: z.string(),
  tableHeaders: z.unknown().nullable(),
  bbox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
  coordinateOrigin: z.string(),
  pageWidthPt: z.number().nullable(),
  pageHeightPt: z.number().nullable(),
  pageRotation: z.number().int(),
  pageImageKey: z.string().nullable(),
});
export type SourceBlockRef = z.infer<typeof sourceBlockRefSchema>;

export const evidenceItemSchema = z.object({
  id: z.uuid(),
  quote: z.string(),
  quoteStart: z.number().int().nullable(),
  quoteEnd: z.number().int().nullable(),
  verification: evidenceVerificationSchema,
  entailment: evidenceEntailmentSchema,
  verificationNote: z.string().nullable(),
  supportRole: z.string(),
  block: sourceBlockRefSchema,
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const factSummarySchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  filename: z.string(),
  subject: z.string(),
  predicate: z.string(),
  originalStatement: z.string(),
  rawValue: z.string().nullable(),
  numericValue: z.string().nullable(),
  normalizedValue: z.string().nullable(),
  normalizedUnit: z.string().nullable(),
  currency: z.string().nullable(),
  scale: z.string().nullable(),
  unit: z.string().nullable(),
  periodLabel: z.string().nullable(),
  periodType: z.string().nullable(),
  scope: z.string().nullable(),
  assertionStatus: z.string().nullable(),
  status: claimStatusSchema,
  statusReason: z.string().nullable(),
  entityId: z.uuid().nullable(),
  entityLabel: z.string().nullable(),
  pages: z.array(z.number().int().nonnegative()),
  evidenceCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type FactSummary = z.infer<typeof factSummarySchema>;

export const factDetailSchema = factSummarySchema.extend({
  collectionId: z.uuid(),
  runId: z.uuid().nullable(),
  factGroupId: z.uuid().nullable(),
  valuePrecision: z.number().int().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  qualifiers: z.array(z.object({ name: z.string(), value: z.string() })),
  normalization: z.unknown().nullable(),
  evidence: z.array(evidenceItemSchema),
  relationshipCount: z.number().int().nonnegative(),
});
export type FactDetail = z.infer<typeof factDetailSchema>;

export const factListSchema = z.object({
  items: z.array(factSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  predicates: z.array(z.string()),
});
export type FactList = z.infer<typeof factListSchema>;

export const contextDifferenceSchema = z.object({
  dimension: z.enum([
    'period',
    'period_type',
    'scope',
    'assertion_status',
    'unit',
    'currency',
    'qualifier',
  ]),
  a: z.string().nullable(),
  b: z.string().nullable(),
  couldExplainGap: z.boolean(),
});
export type ContextDifferenceContract = z.infer<typeof contextDifferenceSchema>;

export const relationshipSummarySchema = z.object({
  id: z.uuid(),
  collectionId: z.uuid(),
  label: relationshipLabelSchema,
  rationale: z.string(),
  contextDifferences: z.array(contextDifferenceSchema),
  uncertaintyReasons: z.array(z.string()),
  method: z.string(),
  methodVersion: z.string(),
  modelName: z.string().nullable(),
  promptVersion: z.string().nullable(),
  claimA: factDetailSchema,
  claimB: factDetailSchema,
  createdAt: z.string(),
});
export type RelationshipSummary = z.infer<typeof relationshipSummarySchema>;

export const relationshipDetailSchema = relationshipSummarySchema.extend({
  deterministicChecks: z.unknown().nullable(),
  supportingEvidenceIds: z.array(z.string()),
});
export type RelationshipDetail = z.infer<typeof relationshipDetailSchema>;

export const relationshipListSchema = z.object({
  items: z.array(relationshipSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  counts: z.record(relationshipLabelSchema, z.number().int().nonnegative()),
});
export type RelationshipList = z.infer<typeof relationshipListSchema>;

export const documentSummarySchema = z.object({
  id: z.uuid(),
  collectionId: z.uuid(),
  filename: z.string(),
  contentHash: z.string(),
  byteSize: z.number().int().nonnegative(),
  pageCount: z.number().int().nullable(),
  publicationDate: z.string().nullable(),
  createdAt: z.string(),
  latestRun: z
    .object({
      id: z.uuid(),
      stage: runStageSchema,
      terminal: z.boolean(),
      stalled: z.boolean(),
      pagesTotal: z.number().int().nullable(),
      pagesProcessed: z.number().int(),
      chunksTotal: z.number().int().nullable(),
      chunksProcessed: z.number().int(),
      claimsExtracted: z.number().int(),
      claimsAccepted: z.number().int(),
      relationshipsCreated: z.number().int(),
      errorSummary: z.string().nullable(),
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      issues: z.array(processingIssueSchema),
    })
    .nullable(),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const documentListSchema = z.object({
  collectionId: z.uuid(),
  items: z.array(documentSummarySchema),
});
export type DocumentList = z.infer<typeof documentListSchema>;

export const factQuerySchema = z.object({
  documentId: z.uuid().optional(),
  entityId: z.uuid().optional(),
  predicate: z.string().min(1).max(200).optional(),
  status: claimStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type FactQuery = z.infer<typeof factQuerySchema>;

export const relationshipQuerySchema = z.object({
  label: relationshipLabelSchema.optional(),
  claimId: z.uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type RelationshipQuery = z.infer<typeof relationshipQuerySchema>;
