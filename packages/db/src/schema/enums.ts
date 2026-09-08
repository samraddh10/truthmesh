import { pgEnum } from 'drizzle-orm/pg-core';

export const runStage = pgEnum('run_stage', [
  'queued',
  'parsing',
  'extracting',
  'normalizing',
  'comparing',
  'completed',
  'completed_with_issues',
  'failed',
]);

export const claimStatus = pgEnum('claim_status', ['accepted', 'needs_review', 'rejected']);

export const evidenceVerification = pgEnum('evidence_verification', [
  'verified_native_text',
  'visual_only',
  'quote_not_found',
  'block_not_found',
  'unchecked',
]);

export const evidenceEntailment = pgEnum('evidence_entailment', [
  'supported',
  'unsupported',
  'unclear',
  'unchecked',
]);

export const relationshipLabel = pgEnum('relationship_label', [
  'corroborates',
  'contradicts',
  'likely_contradiction',
  'reconciled_by_context',
  'insufficient_context',
  'unrelated',
]);

export const sourceBlockType = pgEnum('source_block_type', [
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

export const extractionMethod = pgEnum('extraction_method', [
  'native_text',
  'model_transcription',
]);

export const issueResolution = pgEnum('issue_resolution', [
  'open',
  'retrying',
  'resolved',
  'abandoned',
]);
