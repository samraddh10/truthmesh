export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly base64: string };

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string | readonly ContentPart[];
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly schema?: { readonly name: string; readonly schema: Record<string, unknown> };
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly seed?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly servedByModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
}

export class ModelError extends Error {
  override readonly name = 'ModelError';

  constructor(
    message: string,
    readonly kind: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function imageContentPart(bytes: Uint8Array, mimeType = 'image/png'): ContentPart {
  return { type: 'image', mimeType, base64: Buffer.from(bytes).toString('base64') };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetries<T>(
  maxRetries: number,
  send: () => Promise<T>,
): Promise<T> {
  let lastError: ModelError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const modelError =
        error instanceof ModelError
          ? error
          : new ModelError((error as Error).message, 'unexpected_error', true);

      if (!modelError.retryable || attempt === maxRetries) throw modelError;

      lastError = modelError;

      const ceiling = Math.min(30_000, 1000 * 2 ** attempt);
      const waitMs =
        modelError.retryAfterSeconds !== undefined
          ? modelError.retryAfterSeconds * 1000
          : Math.round(ceiling * (0.5 + Math.random() * 0.5));
      await sleep(waitMs);
    }
  }

  throw lastError ?? new ModelError('retries exhausted', 'retries_exhausted', false);
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
    }
  }

  const firstBrace = trimmed.search(/[[{]/);
  const lastBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
    }
  }

  throw new ModelError('the completion contained no parsable JSON', 'unparsable_json', false);
}
