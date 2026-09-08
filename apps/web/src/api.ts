import {
  collectionSchema,
  documentListSchema,
  factDetailSchema,
  factListSchema,
  relationshipDetailSchema,
  relationshipListSchema,
  runStatusSchema,
  uploadResponseSchema,
  type CollectionResponse,
  type DocumentList,
  type FactDetail,
  type FactList,
  type RelationshipDetail,
  type RelationshipList,
  type RunStatus,
  type UploadResponse,
} from '@superjoin/contracts';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const errorBodySchema = z.object({ error: z.string(), message: z.string() });

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const parsed = errorBodySchema.safeParse(body);
    throw new ApiError(
      response.status,
      parsed.success ? parsed.data.error : 'unexpected_error',
      parsed.success ? parsed.data.message : `${response.status} ${response.statusText}`,
    );
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      'invalid_response',
      `the API returned a shape this build does not understand: ${parsed.error.issues[0]?.path.join('.')}`,
    );
  }
  return parsed.data;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export function listCollections(): Promise<CollectionResponse[]> {
  return request('/collections', z.array(collectionSchema));
}

export function createCollection(name: string): Promise<CollectionResponse> {
  return request('/collections', collectionSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function uploadDocuments(
  collectionId: string,
  files: readonly File[],
): Promise<UploadResponse> {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);

  return request(`/collections/${collectionId}/documents`, uploadResponseSchema, {
    method: 'POST',
    body: form,
  });
}

export function listDocuments(collectionId: string): Promise<DocumentList> {
  return request(`/collections/${collectionId}/documents`, documentListSchema);
}

export function getRun(runId: string): Promise<RunStatus> {
  return request(`/runs/${runId}`, runStatusSchema);
}

export function retryRun(runId: string): Promise<unknown> {
  return request(`/runs/${runId}/retry`, z.unknown(), { method: 'POST' });
}

export interface FactFilters {
  readonly documentId?: string | undefined;
  readonly predicate?: string | undefined;
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export function listFacts(collectionId: string, filters: FactFilters = {}): Promise<FactList> {
  return request(`/collections/${collectionId}/facts${query({ ...filters })}`, factListSchema);
}

export function getFact(factId: string): Promise<FactDetail> {
  return request(`/facts/${factId}`, factDetailSchema);
}

export interface RelationshipFilters {
  readonly label?: string | undefined;
  readonly claimId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export function listRelationships(
  collectionId: string,
  filters: RelationshipFilters = {},
): Promise<RelationshipList> {
  return request(
    `/collections/${collectionId}/relationships${query({ ...filters })}`,
    relationshipListSchema,
  );
}

export function getRelationship(relationshipId: string): Promise<RelationshipDetail> {
  return request(`/relationships/${relationshipId}`, relationshipDetailSchema);
}

export function documentFileUrl(documentId: string): string {
  return `/documents/${documentId}/file`;
}

const settingsSchema = z.object({
  activeProvider: z.enum(['bedrock', 'groq']),
  providers: z.array(
    z.object({
      id: z.enum(['bedrock', 'groq']),
      configured: z.boolean(),
      model: z.string().nullable(),
    }),
  ),
});

export type SettingsResponse = z.infer<typeof settingsSchema>;
export type ProviderId = SettingsResponse['activeProvider'];

export function readSettings(): Promise<SettingsResponse> {
  return request('/settings', settingsSchema);
}

export function setProvider(provider: ProviderId): Promise<SettingsResponse> {
  return request('/settings', settingsSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
}
