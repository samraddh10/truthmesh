import { z } from 'zod';

export const rejectionReasonSchema = z.enum([
  'empty_file',
  'too_large',
  'not_a_pdf',
  'encrypted',
  'malformed',
  'no_pages',
  'too_many_pages',
]);
export type RejectionReasonContract = z.infer<typeof rejectionReasonSchema>;

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});
export type CreateCollectionRequest = z.infer<typeof createCollectionSchema>;

export const collectionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
});
export type CollectionResponse = z.infer<typeof collectionSchema>;

export const uploadResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    filename: z.string(),
    documentId: z.uuid(),
    runId: z.uuid(),
    contentHash: z.string(),
    pageCount: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('duplicate'),
    filename: z.string(),
    documentId: z.uuid(),
    contentHash: z.string(),
    existingFilename: z.string(),
  }),
  z.object({
    status: z.literal('rejected'),
    filename: z.string(),
    reason: rejectionReasonSchema,
    message: z.string(),
  }),
]);
export type UploadResult = z.infer<typeof uploadResultSchema>;

export const uploadResponseSchema = z.object({
  collectionId: z.uuid(),
  results: z.array(uploadResultSchema),
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
