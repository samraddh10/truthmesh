import type { Database, ModelProvider } from '@superjoin/db';

import { BedrockClient } from './bedrock.ts';
import { GroqClient } from './groq.ts';
import { SwitchingClient, type ProviderEntry } from './switching.ts';
import { ModelError, type CompletionRequest, type CompletionResult } from './types.ts';

export { BedrockClient, type BedrockOptions } from './bedrock.ts';
export { GroqClient, type GroqOptions } from './groq.ts';
export { SwitchingClient, type SwitchingClientOptions, type ProviderEntry } from './switching.ts';

export {
  ModelError,
  extractJson,
  imageContentPart,
  withRetries,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
} from './types.ts';

export interface CompletionProvider {
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface ModelClientConfig {
  readonly awsRegion: string | undefined;
  readonly awsBearerToken: string | undefined;
  readonly awsAccessKeyId: string | undefined;
  readonly awsSecretAccessKey: string | undefined;
  readonly awsSessionToken: string | undefined;
  readonly bedrockModelId: string;
  readonly groqApiKey: string | undefined;
  readonly groqBaseUrl: string;
  readonly groqModel: string;
  readonly llmTimeoutMs: number;
  readonly providerMaxRetries: number;
}

export function configuredProviders(config: ModelClientConfig): ModelProvider[] {
  const available: ModelProvider[] = [];
  if (config.awsRegion !== undefined) available.push('bedrock');
  if (config.groqApiKey !== undefined) available.push('groq');
  return available;
}

export function createModelClient(
  config: ModelClientConfig,
  db?: Database,
): CompletionProvider {
  const available = configuredProviders(config);

  if (available.length === 0) {
    throw new ModelError(
      'no model provider is configured: set AWS_REGION for Bedrock or GROQ_API_KEY for Groq',
      'no_provider_configured',
      false,
    );
  }

  const providers: Partial<Record<ModelProvider, ProviderEntry>> = {};

  if (config.awsRegion !== undefined) {
    providers.bedrock = new BedrockClient({
      modelId: config.bedrockModelId,
      region: config.awsRegion,
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.providerMaxRetries,
      ...(config.awsBearerToken !== undefined ? { bearerToken: config.awsBearerToken } : {}),
      ...(config.awsAccessKeyId !== undefined ? { accessKeyId: config.awsAccessKeyId } : {}),
      ...(config.awsSecretAccessKey !== undefined ? { secretAccessKey: config.awsSecretAccessKey } : {}),
      ...(config.awsSessionToken !== undefined ? { sessionToken: config.awsSessionToken } : {}),
    });
  }

  if (config.groqApiKey !== undefined) {
    providers.groq = new GroqClient({
      apiKey: config.groqApiKey,
      baseUrl: config.groqBaseUrl,
      model: config.groqModel,
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.providerMaxRetries,
    });
  }

  const fallback = available[0] as ModelProvider;

  return db !== undefined
    ? new SwitchingClient({ db, providers, fallback })
    : (providers[fallback] as ProviderEntry);
}
