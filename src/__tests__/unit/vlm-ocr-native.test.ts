import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: vi.fn() }));

import { createVlmOcrRuntime } from '@/lib/providers/contracts/vlmOcrHelpers';
import { OpenAiModelProviderContract } from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';

const usage = (i: number, o: number) => ({
  inputTokens: i, outputTokens: o, totalTokens: i + o,
  cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0,
});

function fakeRuntime(content: string) {
  const complete = vi.fn().mockResolvedValue({
    id: 'r', model: 'm', content, toolCalls: [], usage: usage(30, 12), finishReason: 'stop', raw: { ok: true },
  });
  const createNativeChatClient = vi.fn().mockResolvedValue({ complete });
  const runtime: ModelProviderRuntime = { createNativeChatClient };
  return { runtime, complete, createNativeChatClient };
}

const config = { modelId: 'gpt-4o', category: 'ocr' as const };

describe('VLM OCR on the native client', () => {
  it('sends the image as a native base64 part and reads the JSON answer and usage', async () => {
    const { runtime, complete, createNativeChatClient } = fakeRuntime(
      '```json\n{"text":"hello world","language":"en"}\n```',
    );
    const result = await createVlmOcrRuntime(runtime, config).extract({
      document: { kind: 'bytes', data: Buffer.from('AAAA'), contentType: 'image/png' },
    } as never);

    expect(createNativeChatClient.mock.calls[0][0].category).toBe('llm');
    const [{ messages }] = complete.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0].content[0].type).toBe('text');
    expect(messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: Buffer.from('AAAA').toString('base64') },
    });
    expect(result.text).toBe('hello world');
    expect(result.language).toBe('en');
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 12, totalTokens: 42 });
    expect(result.invokedVia).toBe('vlm');
  });

  it('passes a remote image as a url part and falls back to plain text for non-JSON answers', async () => {
    const { runtime, complete } = fakeRuntime('just some text');
    const result = await createVlmOcrRuntime(runtime, config).extract({
      document: { kind: 'url', url: 'https://example.com/a.png' },
    } as never);
    expect(complete.mock.calls[0][0].messages[0].content[1]).toEqual({
      type: 'image', source: { type: 'url', url: 'https://example.com/a.png' },
    });
    expect(result.text).toBe('just some text');
  });

  it('folds anthropic cache read/write into the input and carries both subsets', async () => {
    const complete = vi.fn().mockResolvedValue({
      id: 'r', model: 'm', content: 'text', toolCalls: [], finishReason: 'stop', raw: {},
      usage: { ...usage(10, 4), cachedInputTokens: 90, cachedWriteTokens: 5 },
    });
    const runtime: ModelProviderRuntime = {
      createNativeChatClient: vi.fn().mockResolvedValue({ complete, driver: 'anthropic' }),
    };
    const result = await createVlmOcrRuntime(runtime, config).extract({
      document: { kind: 'bytes', data: Buffer.from('AAAA'), contentType: 'image/png' },
    } as never);
    expect(result.usage).toMatchObject({
      inputTokens: 105, outputTokens: 4, totalTokens: 109, cachedInputTokens: 90, cachedWriteTokens: 5,
    });
  });

  it('folds vertex thinking tokens into the output and keeps the reasoning subset', async () => {
    const complete = vi.fn().mockResolvedValue({
      id: 'r', model: 'm', content: 'text', toolCalls: [], finishReason: 'stop', raw: {},
      usage: { ...usage(20, 5), reasoningTokens: 7 },
    });
    const runtime: ModelProviderRuntime = {
      createNativeChatClient: vi.fn().mockResolvedValue({ complete, driver: 'vertex' }),
    };
    const result = await createVlmOcrRuntime(runtime, config).extract({
      document: { kind: 'bytes', data: Buffer.from('AAAA'), contentType: 'image/png' },
    } as never);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 12, totalTokens: 32, reasoningTokens: 7 });
    expect(result.usage).not.toHaveProperty('cachedInputTokens');
  });

  it('refuses a provider without a native chat client', () => {
    expect(() => createVlmOcrRuntime({}, config)).toThrow(/createNativeChatClient/);
  });

  it('works end to end through the real OpenAI driver with a mocked transport', async () => {
    const contract = await OpenAiModelProviderContract.createRuntime({ credentials: { apiKey: 'sk-test' }, settings: {} } as never);
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: 'c1', model: 'gpt-4o',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"text":"scan ok"}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never;
    const wrapped: ModelProviderRuntime = {
      createNativeChatClient: (cfg, transport) => contract.createNativeChatClient!(cfg, { ...transport, fetch: fetchImpl }),
    };
    const result = await createVlmOcrRuntime(wrapped, config).extract({
      document: { kind: 'bytes', data: Buffer.from('PNG'), contentType: 'image/png' },
    } as never);

    expect(result.text).toBe('scan ok');
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
    const content = bodies[0].messages[0].content;
    expect(content.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
  });
});
