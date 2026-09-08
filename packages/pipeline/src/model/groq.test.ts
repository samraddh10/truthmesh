import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroqClient } from './groq.ts';

const OPTIONS = {
  apiKey: 'test-key',
  baseUrl: 'https://api.groq.test/openai/v1',
  model: 'openai/gpt-oss-120b',
  timeoutMs: 5_000,
  maxRetries: 0,
};

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function choice(message: unknown, finishReason: string) {
  return {
    model: 'openai/gpt-oss-120b',
    choices: [{ message, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GroqClient', () => {
  it('returns the content of a normal answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(choice({ content: '{"claims":[]}' }, 'stop'))),
    );

    const result = await new GroqClient(OPTIONS).complete({
      messages: [{ role: 'user', content: 'extract' }],
    });

    expect(result.text).toBe('{"claims":[]}');
    expect(result.promptTokens).toBe(10);
  });

  it('does not retry an answer starved by the model’s own reasoning', async () => {
    const fetchMock = vi.fn(async () =>
      reply(choice({ content: '', reasoning: 'thinking about the question' }, 'length')),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GroqClient({ ...OPTIONS, maxRetries: 8 });

    await expect(
      client.complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 4000 }),
    ).rejects.toMatchObject({ kind: 'reasoning_budget_exhausted', retryable: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the budget in the message, so the remedy is obvious', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(choice({ content: '', reasoning: 'abc' }, 'length'))),
    );

    await expect(
      new GroqClient(OPTIONS).complete({
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 4000,
      }),
    ).rejects.toThrow(/4000-token budget on reasoning/);
  });

  it('still retries an empty answer that was not truncated', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(choice({ content: '   ' }, 'stop')))
      .mockResolvedValue(reply(choice({ content: 'recovered' }, 'stop')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GroqClient({ ...OPTIONS, maxRetries: 2 }).complete({
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(result.text).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats 429 as retryable and a 400 as permanent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ error: 'slow down' }, 429)));
    await expect(
      new GroqClient(OPTIONS).complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'provider_rate_limited', retryable: true });

    vi.stubGlobal('fetch', vi.fn(async () => reply({ error: 'bad schema' }, 400)));
    await expect(
      new GroqClient(OPTIONS).complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'http_400', retryable: false });
  });

  it('sends a schema as response_format and images as data URLs', async () => {
    const fetchMock = vi.fn(async () => reply(choice({ content: 'ok' }, 'stop')));
    vi.stubGlobal('fetch', fetchMock);

    await new GroqClient(OPTIONS).complete({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', mimeType: 'image/png', base64: 'AAAA' },
          ],
        },
      ],
      schema: { name: 'claims', schema: { type: 'object' } },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.response_format.json_schema.name).toBe('claims');
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AAAA');
  });
});
