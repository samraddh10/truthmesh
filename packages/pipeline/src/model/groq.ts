import { z } from 'zod';

import {
  ModelError,
  withRetries,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentPart,
} from './types.ts';

export interface GroqOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

const usageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
});

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
            reasoning: z.string().nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: usageSchema.optional(),
});

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function toWireContent(content: string | readonly ContentPart[]): unknown {
  if (typeof content === 'string') return content;

  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.base64}` } },
  );
}

function toWireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: toWireContent(message.content),
  }));
}

export class GroqClient {
  constructor(private readonly options: GroqOptions) {}

  get model(): string {
    return this.options.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return withRetries(this.options.maxRetries, () => this.send(request));
  }

  private async send(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const signal = AbortSignal.timeout(this.options.timeoutMs);

    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: toWireMessages(request.messages),
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0,
    };

    if (request.seed !== undefined) body['seed'] = request.seed;

    if (request.schema !== undefined) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema },
      };
    }

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const aborted =
        (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError';
      throw new ModelError(
        aborted ? `request exceeded ${this.options.timeoutMs}ms` : (error as Error).message,
        aborted ? 'provider_timeout' : 'network_error',
        true,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ModelError(
        `Groq returned ${response.status}: ${detail.slice(0, 400)}`,
        response.status === 429 ? 'provider_rate_limited' : `http_${response.status}`,
        isRetryableStatus(response.status),
        parseRetryAfter(response.headers.get('retry-after')),
        response.status,
      );
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ModelError(
        `unrecognised response envelope: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'malformed_response',
        true,
      );
    }

    const choice = parsed.data.choices[0];
    const text = choice?.message?.content ?? '';

    if (text.trim() === '') {
      const truncated = choice?.finish_reason === 'length';
      const thought = choice?.message?.reasoning ?? '';

      if (truncated) {
        throw new ModelError(
          `the model spent its ${request.maxTokens ?? 4096}-token budget on reasoning and returned no answer` +
            (thought === '' ? '' : ` (${thought.length} characters of it)`),
          'reasoning_budget_exhausted',
          false,
        );
      }

      throw new ModelError(
        `empty completion (finish_reason: ${choice?.finish_reason ?? 'none'})`,
        'empty_completion',
        true,
      );
    }

    return {
      text,
      servedByModel: parsed.data.model ?? this.options.model,
      promptTokens: parsed.data.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
