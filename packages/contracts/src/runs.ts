import { z } from 'zod';

export const runStageSchema = z.enum([
  'queued',
  'parsing',
  'extracting',
  'normalizing',
  'comparing',
  'completed',
  'completed_with_issues',
  'failed',
]);
export type RunStage = z.infer<typeof runStageSchema>;

export const TERMINAL_STAGES: readonly RunStage[] = ['completed', 'completed_with_issues', 'failed'];

export function isTerminal(stage: RunStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export const runProgressSchema = z.object({
  pagesTotal: z.number().int().nullable(),
  pagesProcessed: z.number().int(),
  chunksTotal: z.number().int().nullable(),
  chunksProcessed: z.number().int(),
  claimsExtracted: z.number().int(),
  claimsAccepted: z.number().int(),
  relationshipsCreated: z.number().int(),
});
export type RunProgress = z.infer<typeof runProgressSchema>;

export const processingIssueSchema = z.object({
  id: z.uuid(),
  stage: runStageSchema,
  failureKind: z.string(),
  isTransient: z.boolean().nullable(),
  physicalPage: z.number().int().nullable(),
  message: z.string(),
  attemptCount: z.number().int(),
  resolution: z.enum(['open', 'retrying', 'resolved', 'abandoned']),
});
export type ProcessingIssueResponse = z.infer<typeof processingIssueSchema>;

export const runStatusSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  filename: z.string(),
  stage: runStageSchema,
  terminal: z.boolean(),
  progress: runProgressSchema,
  errorSummary: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  stalled: z.boolean(),
  issues: z.array(processingIssueSchema),
});
export type RunStatus = z.infer<typeof runStatusSchema>;
