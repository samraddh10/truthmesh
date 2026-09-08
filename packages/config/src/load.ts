import { z } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const intInRange = (min: number, max: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const trimmed = raw?.trim();
      return trimmed === undefined || trimmed === '' ? fallback : Number(trimmed);
    })
    .pipe(z.number().int().min(min).max(max));

const nonEmpty = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? fallback : raw.trim()));

const optionalValue = z
  .string()
  .optional()
  .transform((raw) => {
    const trimmed = raw?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });

const schema = z.object({
  DATABASE_URL: nonEmpty('postgres://superjoin:superjoin@localhost:55432/superjoin'),
  STORAGE_DIR: nonEmpty('./storage'),
  PORT: intInRange(1, 65535, 3000),

  AWS_REGION: optionalValue,

  AWS_BEARER_TOKEN_BEDROCK: optionalValue,

  AWS_ACCESS_KEY_ID: optionalValue,
  AWS_SECRET_ACCESS_KEY: optionalValue,
  AWS_SESSION_TOKEN: optionalValue,

  BEDROCK_MODEL_ID: nonEmpty('moonshotai.kimi-k2.5'),

  GROQ_API_KEY: optionalValue,
  GROQ_BASE_URL: nonEmpty('https://api.groq.com/openai/v1'),
  GROQ_MODEL: nonEmpty('qwen/qwen3.8-27b'),

  EMBEDDING_MODEL: nonEmpty('Xenova/all-mpnet-base-v2'),
  EMBEDDING_DIMENSIONS: intInRange(1, 3072, 768),

  MAX_UPLOAD_MB: intInRange(1, 500, 50),
  MAX_PDF_PAGES: intInRange(1, 5000, 300),

  LLM_CONCURRENCY: intInRange(1, 32, 2),
  CANDIDATE_TOP_K: intInRange(1, 200, 15),

  EXTRACTION_BATCH_TOKENS: intInRange(0, 100_000, 3000),
  EXTRACTION_BATCH_CHUNKS: intInRange(1, 20, 4),

  DOCUMENT_TOKEN_BUDGET: intInRange(1000, 100_000_000, 1_500_000),
  LLM_TIMEOUT_MS: intInRange(1000, 600_000, 120_000),
  PROVIDER_MAX_RETRIES: intInRange(0, 20, 5),
});

export interface Config {
  readonly databaseUrl: string;
  readonly storageDir: string;
  readonly port: number;

  readonly awsRegion: string | undefined;
  readonly awsBearerToken: string | undefined;
  readonly awsAccessKeyId: string | undefined;
  readonly awsSecretAccessKey: string | undefined;
  readonly awsSessionToken: string | undefined;
  readonly bedrockModelId: string;
  readonly groqApiKey: string | undefined;
  readonly groqBaseUrl: string;
  readonly groqModel: string;

  readonly embeddingModel: string;
  readonly embeddingDimensions: number;

  readonly maxUploadMb: number;
  readonly maxPdfPages: number;

  readonly llmConcurrency: number;
  readonly candidateTopK: number;

  readonly extractionBatchTokens: number;
  readonly extractionBatchChunks: number;

  readonly documentTokenBudget: number;
  readonly llmTimeoutMs: number;
  readonly providerMaxRetries: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`invalid environment: ${problems}`);
  }

  const value = parsed.data;

  return {
    databaseUrl: value.DATABASE_URL,
    storageDir: value.STORAGE_DIR,
    port: value.PORT,

    awsRegion: value.AWS_REGION,
    awsBearerToken: value.AWS_BEARER_TOKEN_BEDROCK,
    awsAccessKeyId: value.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: value.AWS_SECRET_ACCESS_KEY,
    awsSessionToken: value.AWS_SESSION_TOKEN,
    bedrockModelId: value.BEDROCK_MODEL_ID,
    groqApiKey: value.GROQ_API_KEY,
    groqBaseUrl: value.GROQ_BASE_URL,
    groqModel: value.GROQ_MODEL,

    embeddingModel: value.EMBEDDING_MODEL,
    embeddingDimensions: value.EMBEDDING_DIMENSIONS,

    maxUploadMb: value.MAX_UPLOAD_MB,
    maxPdfPages: value.MAX_PDF_PAGES,

    llmConcurrency: value.LLM_CONCURRENCY,
    candidateTopK: value.CANDIDATE_TOP_K,

    extractionBatchTokens: value.EXTRACTION_BATCH_TOKENS,
    extractionBatchChunks: value.EXTRACTION_BATCH_CHUNKS,

    documentTokenBudget: value.DOCUMENT_TOKEN_BUDGET,
    llmTimeoutMs: value.LLM_TIMEOUT_MS,
    providerMaxRetries: value.PROVIDER_MAX_RETRIES,
  };
}

export function requireModelAccess(config: Config): void {
  if (config.awsRegion === undefined && config.groqApiKey === undefined) {
    throw new ConfigError(
      'no model provider is configured: set AWS_REGION for Bedrock or GROQ_API_KEY for Groq. This service calls a model on every document, and there is no offline mode to fall back to',
    );
  }
}
