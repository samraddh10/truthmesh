import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type ImageFormat,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';

import {
  ModelError,
  withRetries,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
} from './types.ts';

export interface BedrockOptions {
  readonly modelId: string;
  readonly region: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly bearerToken?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
}

function imageFormat(mimeType: string): ImageFormat {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      throw new ModelError(
        `Bedrock accepts png, jpeg, gif and webp images; got ${mimeType}`,
        'unsupported_image_format',
        false,
      );
  }
}

function toContentBlocks(content: string | readonly ContentPart[]): ContentBlock[] {
  if (typeof content === 'string') return [{ text: content }];

  return content.map((part): ContentBlock => {
    if (part.type === 'text') return { text: part.text };
    return {
      image: {
        format: imageFormat(part.mimeType),
        source: { bytes: Buffer.from(part.base64, 'base64') },
      },
    };
  });
}

function splitMessages(messages: readonly ChatMessage[]): {
  system: SystemContentBlock[];
  conversation: Message[];
} {
  const system: SystemContentBlock[] = [];
  const conversation: Message[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
      if (text.trim() !== '') system.push({ text });
      continue;
    }

    conversation.push({
      role: message.role,
      content: toContentBlocks(message.content),
    });
  }

  return { system, conversation };
}

function classify(error: unknown): ModelError {
  const name = (error as { name?: string }).name ?? 'UnknownError';
  const message = (error as Error).message ?? String(error);
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

  switch (name) {
    case 'ThrottlingException':
    case 'TooManyRequestsException':
      return new ModelError(
        `Bedrock throttled the request: ${message}`,
        'provider_rate_limited',
        true,
        undefined,
        status,
      );

    case 'ModelTimeoutException':
    case 'TimeoutError':
    case 'AbortError':
      return new ModelError(`Bedrock request timed out: ${message}`, 'provider_timeout', true, undefined, status);

    case 'ModelNotReadyException':
    case 'ServiceUnavailableException':
    case 'InternalServerException':
      return new ModelError(`Bedrock is unavailable: ${message}`, 'provider_unavailable', true, undefined, status);

    case 'ServiceQuotaExceededException':
      return new ModelError(
        `Bedrock quota exceeded: ${message}`,
        'provider_quota_exceeded',
        false,
        undefined,
        status,
      );

    case 'AccessDeniedException':
      return new ModelError(
        `Bedrock denied access to ${name}: ${message}. Model access is granted per region in the Bedrock console.`,
        'provider_access_denied',
        false,
        undefined,
        status,
      );

    case 'ValidationException':
      return new ModelError(`Bedrock rejected the request: ${message}`, 'invalid_request', false, undefined, status);

    case 'ResourceNotFoundException':
      return new ModelError(
        `Bedrock has no such model in this region: ${message}`,
        'model_not_found',
        false,
        undefined,
        status,
      );

    default:
      return new ModelError(message, `bedrock_${name}`, true, undefined, status);
  }
}

function readReply(output: ConverseCommandOutput, wantedTool: string | undefined): string {
  const blocks = output.output?.message?.content ?? [];

  if (wantedTool !== undefined) {
    for (const block of blocks) {
      if (block.toolUse?.name === wantedTool && block.toolUse.input !== undefined) {
        return JSON.stringify(block.toolUse.input);
      }
    }
  }

  return blocks
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

export class BedrockClient {
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly options: BedrockOptions) {
    this.client = new BedrockRuntimeClient({
      region: options.region,
      maxAttempts: 1,
      ...(options.bearerToken !== undefined
        ? {
            token: { token: options.bearerToken },
            authSchemePreference: ['httpBearerAuth'],
          }
        : options.accessKeyId !== undefined && options.secretAccessKey !== undefined
          ? {
              credentials: {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
                ...(options.sessionToken !== undefined ? { sessionToken: options.sessionToken } : {}),
              },
            }
          : {}),
    });
  }

  get model(): string {
    return this.options.modelId;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return withRetries(this.options.maxRetries, () => this.send(request));
  }

  private async send(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const { system, conversation } = splitMessages(request.messages);

    if (conversation.length === 0) {
      throw new ModelError('a Converse request needs at least one non-system message', 'invalid_request', false);
    }

    const command = new ConverseCommand({
      modelId: this.options.modelId,
      messages: conversation,
      ...(system.length > 0 ? { system } : {}),
      inferenceConfig: {
        maxTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0,
      },
      ...(request.schema !== undefined
        ? {
            toolConfig: {
              tools: [
                {
                  toolSpec: {
                    name: request.schema.name,
                    description: `Return the result as ${request.schema.name}.`,
                    inputSchema: { json: request.schema.schema as DocumentType },
                  },
                },
              ],
              toolChoice: { tool: { name: request.schema.name } },
            },
          }
        : {}),
    });

    let output: ConverseCommandOutput;
    try {
      output = await this.client.send(command, {
        abortSignal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw classify(error);
    }

    const text = readReply(output, request.schema?.name);

    if (text.trim() === '') {
      throw new ModelError(
        `empty completion (stopReason: ${output.stopReason ?? 'none'})`,
        'empty_completion',
        true,
      );
    }

    return {
      text,
      servedByModel: this.options.modelId,
      promptTokens: output.usage?.inputTokens ?? 0,
      completionTokens: output.usage?.outputTokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
