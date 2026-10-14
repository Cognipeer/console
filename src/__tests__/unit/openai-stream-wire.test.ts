/**
 * Unit tests - OpenAI streaming wire format
 *
 * Regression cover for the defects that made our SSE stream unusable to strict
 * OpenAI clients (Open WebUI among them). Each case below shipped:
 *  - usage never reached the usage rows, so every streamed request logged zero
 *    tokens and skipped budget/rate limits;
 *  - tool-call deltas lost their arguments, or lost the `index`/`id` framing
 *    parallel calls need;
 *  - each frame carried a fresh id, and no frame carried `delta.role`;
 *  - `delta.content` could be an array, which breaks `content += delta.content`.
 *
 * The provider contract, the agent-sdk provider and the adapter are all real; the
 * upstream is a scripted SSE body, so what is asserted is what a client reads.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import {
  anthropicRuntime,
  chunk,
  flush,
  openAiRuntime,
  readSse,
  sse,
  stubUpstream,
} from '../helpers/nativeGateway';

vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...original, logModelUsage: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockResolvedValue(new Map()),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({ action: 'allow', findings: [] }),
  createStreamGate: vi.fn(),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { logModelUsage } from '@/lib/services/models/usageLogger';

const makeModel = (driver = 'openai', overrides: object = {}) => ({
  _id: 'm1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'M',
  key: 'm',
  providerKey: 'prov',
  providerDriver: driver,
  category: 'llm' as const,
  modelId: driver === 'anthropic' ? 'claude-sonnet-4' : 'my-model',
  settings: {},
  pricing: {},
  ...overrides,
});

const PARAMS = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', modelKey: 'm', projectId: 'proj-1' };

let openai: ModelProviderRuntime;
let anthropic: ModelProviderRuntime;
beforeAll(async () => {
  openai = await openAiRuntime();
  anthropic = await anthropicRuntime();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel());
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: openai });
});
afterEach(() => vi.unstubAllGlobals());

/** Streams `events` through the gateway and returns the frames a client reads. */
async function stream(events: unknown[], body: Record<string, unknown> = {}) {
  const upstream = stubUpstream(() => sse(events));
  const result = await handleChatCompletion({
    ...PARAMS,
    body: { messages: [{ role: 'user', content: 'hi' }], ...body },
    stream: true,
  });
  const read = await readSse(result.stream!);
  await flush();
  return { ...read, upstream, chunks: read.frames.filter((f) => f !== '[DONE]') as any[] };
}

const deltas = (chunks: any[]) => chunks.map((c) => c.choices?.[0]?.delta).filter(Boolean);

describe('stream envelope', () => {
  it('keeps one id and created across every frame of a completion', async () => {
    const { chunks } = await stream([chunk.text('a'), chunk.text('b'), chunk.finish('stop')]);

    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    expect(chunks[0].id).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
    expect(new Set(chunks.map((c) => c.created)).size).toBe(1);
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks.every((c) => c.model === 'my-model')).toBe(true);
  });

  it('opens the stream with the assistant role and ends with [DONE]', async () => {
    const { chunks, raw } = await stream([chunk.text('a'), chunk.finish('stop')]);

    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks[0].choices[0].finish_reason).toBeNull();
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('emits a terminal frame for upstreams that never send finish_reason', async () => {
    const { chunks } = await stream([chunk.text('a')]);
    expect(chunks.at(-1).choices[0]).toMatchObject({ delta: {}, finish_reason: 'stop' });
  });

  it('a completion that ended in tool calls says so even when the upstream did not', async () => {
    const { chunks } = await stream([chunk.tool(0, { id: 'c1', name: 'f', arguments: '{}' })]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('delta.content is always a string', () => {
  it('passes the text through and omits content from a frame that carries none', async () => {
    const { chunks } = await stream([chunk.text('hello'), chunk.finish('stop')]);
    const d = deltas(chunks);
    expect(d[1].content).toBe('hello');
    expect(d.at(-1).content).toBeUndefined();
  });

  it('routes the upstream reasoning to reasoning_content rather than the answer', async () => {
    const { chunks } = await stream([chunk.reasoning('thinking...'), chunk.text('answer'), chunk.finish('stop')]);
    const d = deltas(chunks);
    expect(d[1]).toEqual({ reasoning_content: 'thinking...' });
    expect(d[2]).toEqual({ content: 'answer' });
  });

  it('hides the reasoning text when the request narrows it, and keeps the answer', async () => {
    const { chunks } = await stream(
      [chunk.reasoning('thinking...'), chunk.text('answer'), chunk.finish('stop')],
      { include_reasoning: false },
    );
    expect(deltas(chunks).some((d) => 'reasoning_content' in d)).toBe(false);
    expect(deltas(chunks).map((d) => d.content).filter(Boolean)).toEqual(['answer']);
  });

  it('pulls a <reasoning> block that leaks into the content out of the answer, across delta boundaries', async () => {
    const { chunks } = await stream([
      chunk.text('<reason'),
      chunk.text('ing>weigh it up'),
      chunk.text('</reasoning>The answer'),
      chunk.text(' is 42.'),
      chunk.finish('stop'),
    ]);
    const d = deltas(chunks);
    expect(d.map((x) => x.content ?? '').join('')).toBe('The answer is 42.');
    expect(d.map((x) => x.reasoning_content ?? '').join('')).toBe('weigh it up');
  });

  it('releases the text a stream cut off inside a tag was still holding', async () => {
    const { chunks } = await stream([chunk.text('hi <'), chunk.finish('stop')]);
    expect(deltas(chunks).map((x) => x.content ?? '').join('')).toBe('hi <');
  });
});

describe('tool-call deltas', () => {
  it('streams raw argument fragments with an index, not a re-serialized object', async () => {
    const { chunks } = await stream([
      chunk.tool(0, { id: 'call_1', name: 'get_weather', arguments: '{"ci' }),
      chunk.tool(0, { arguments: 'ty":"Berlin"}' }),
      chunk.finish('tool_calls'),
    ]);
    const calls = deltas(chunks).flatMap((d) => d.tool_calls ?? []);

    expect(calls[0]).toEqual({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"ci' },
    });
    // Continuation: index + arguments only, no id, per the OpenAI protocol.
    expect(calls[1]).toEqual({ index: 0, function: { arguments: 'ty":"Berlin"}' } });
  });

  it('concatenating the fragments reconstructs the arguments', async () => {
    const { chunks } = await stream([
      chunk.tool(0, { id: 'c', name: 'f', arguments: '{"ci' }),
      chunk.tool(0, { arguments: 'ty":' }),
      chunk.tool(0, { arguments: '"Berlin"}' }),
      chunk.finish('tool_calls'),
    ]);
    const assembled = deltas(chunks).flatMap((d) => d.tool_calls ?? []).map((c: any) => c.function.arguments).join('');
    expect(JSON.parse(assembled)).toEqual({ city: 'Berlin' });
  });

  it('never substitutes "{}" for a fragment that has not arrived yet', async () => {
    const { chunks } = await stream([
      chunk.tool(0, { id: 'call_2', name: 'f', arguments: '' }),
      chunk.tool(0, { arguments: '{"a":1}' }),
      chunk.finish('tool_calls'),
    ]);
    const calls = deltas(chunks).flatMap((d) => d.tool_calls ?? []);
    expect(calls[0].function.arguments).toBe('');
    expect(calls.map((c: any) => c.function.arguments).join('')).toBe('{"a":1}');
  });

  it('keeps parallel tool calls apart by index even when their fragments interleave', async () => {
    const { chunks } = await stream([
      chunk.tool(0, { id: 'a', name: 'one', arguments: '' }),
      chunk.tool(1, { id: 'b', name: 'two', arguments: '' }),
      chunk.tool(0, { arguments: '{"x":1}' }),
      chunk.tool(1, { arguments: '{"y":2}' }),
      chunk.finish('tool_calls'),
    ]);
    const calls = deltas(chunks).flatMap((d) => d.tool_calls ?? []);
    expect(calls).toEqual([
      { index: 0, id: 'a', type: 'function', function: { name: 'one', arguments: '' } },
      { index: 1, id: 'b', type: 'function', function: { name: 'two', arguments: '' } },
      { index: 0, function: { arguments: '{"x":1}' } },
      { index: 1, function: { arguments: '{"y":2}' } },
    ]);
  });

  it('completes a no-argument call whose upstream stopped at "{" (qwen3-coder over Bedrock) before the finish frame', async () => {
    const { chunks } = await stream([
      chunk.tool(0, { id: 'c1', name: 'get_time', arguments: '{' }),
      chunk.finish('tool_calls'),
    ]);
    const args = deltas(chunks).flatMap((d) => d.tool_calls ?? []).map((c: any) => c.function.arguments).join('');
    expect(JSON.parse(args)).toEqual({});
    // The correction is not left dangling after the terminal frame.
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it('completes a call with no arguments at all', async () => {
    const { chunks } = await stream([chunk.tool(0, { id: 'c1', name: 'get_time' }), chunk.finish('tool_calls')]);
    const args = deltas(chunks).flatMap((d) => d.tool_calls ?? []).map((c: any) => c.function.arguments).join('');
    expect(JSON.parse(args)).toEqual({});
  });

  it('leaves the arguments of a genuinely truncated call exactly as the model produced them', async () => {
    const { chunks } = await stream([
      chunk.tool(0, { id: 'c1', name: 'f', arguments: '{"city":"Ank' }),
      chunk.finish('length'),
    ]);
    const args = deltas(chunks).flatMap((d) => d.tool_calls ?? []).map((c: any) => c.function.arguments).join('');
    expect(args).toBe('{"city":"Ank');
  });
});

describe('usage', () => {
  it('reports the real counts to the usage row even when the caller did not ask for the frame', async () => {
    const { chunks } = await stream([
      chunk.text('x'),
      chunk.finish('stop'),
      chunk.usage({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 4 } }),
    ]);

    expect(chunks.every((c) => c.usage === undefined)).toBe(true);
    expect((logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2].usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      cachedInputTokens: 4,
    });
  });

  it('sends the usage-only frame as {choices: [], usage} last, after the finish frame, when asked', async () => {
    const { chunks } = await stream([
      chunk.text('x'),
      chunk.finish('stop'),
      chunk.usage({
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      }),
    ], { stream_options: { include_usage: true } });

    const last = chunks.at(-1);
    expect(last.choices).toEqual([]);
    expect(last.usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 7,
      cached_tokens: 4,
      total_tokens: 18,
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(chunks.at(-2).choices[0].finish_reason).toBe('stop');
  });

  it('keeps the finish_reason when the provider puts usage and finish_reason on one frame', async () => {
    // Gemini does this. Dropping the choice would throw away the only
    // finish_reason the client ever sees.
    const both = { ...chunk.finish('stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    const { chunks } = await stream([chunk.text('x'), both], { stream_options: { include_usage: true } });
    expect(chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
    expect(chunks.at(-1).usage).toMatchObject({ total_tokens: 2 });
  });
});

describe('finish_reason', () => {
  it.each(['stop', 'length', 'tool_calls', 'content_filter', 'function_call'])(
    'passes an OpenAI-schema upstream\'s %s through untouched',
    async (reason) => {
      const { chunks } = await stream([chunk.text('x'), chunk.finish(reason)]);
      expect(chunks.at(-1).choices[0].finish_reason).toBe(reason);
    },
  );

  it('passes a vendor-specific value of an OpenAI-compatible server through as it was sent', async () => {
    const { chunks } = await stream([chunk.text('x'), chunk.finish('eos_token')]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe('eos_token');
  });

  const anthropicStream = (stopReason: string, extraBlocks: unknown[] = []) => [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4', usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_stop', index: 0 },
    ...extraBlocks,
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];

  it.each([
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['stop_sequence', 'stop'],
  ])('puts Anthropic\'s %s on the wire as %s, never in Anthropic\'s own words', async (stop, wire) => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel('anthropic'));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    const { chunks } = await stream(anthropicStream(stop));
    expect(chunks.at(-1).choices[0].finish_reason).toBe(wire);
    expect(deltas(chunks).map((d) => d.content ?? '').join('')).toBe('Hello');
    // ...and the usage row stores the same normalized value, so analytics compare across providers.
    expect((logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2].finishReason).toBe(wire);
  });

  it('frames an Anthropic tool_use stream as tool_calls with index + id + name', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel('anthropic'));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    const { chunks } = await stream(anthropicStream('tool_use', [
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
      { type: 'content_block_stop', index: 1 },
    ]));
    const calls = deltas(chunks).flatMap((d) => d.tool_calls ?? []);
    expect(calls[0]).toMatchObject({ index: 0, id: 'toolu_1', type: 'function', function: { name: 'lookup' } });
    expect(calls.slice(1).every((c: any) => c.id === undefined && c.index === 0)).toBe(true);
    expect(JSON.parse(calls.map((c: any) => c.function.arguments).join(''))).toEqual({ q: 'x' });
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it('streams Anthropic thinking as reasoning_content', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel('anthropic'));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    const { chunks } = await stream(anthropicStream('end_turn', [
      { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'sig' } },
    ]));
    expect(deltas(chunks).map((d) => d.reasoning_content ?? '').join('')).toBe('hmm');
  });

  it('reports Anthropic usage with the cache reads counted in the prompt, like every other provider', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel('anthropic'));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    await stream([
      { type: 'message_start', message: { id: 'msg_1', model: 'c', usage: { input_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 30 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ]);
    expect((logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2].usage).toMatchObject({
      inputTokens: 550,
      cachedInputTokens: 500,
      outputTokens: 5,
      totalTokens: 555,
    });
  });
});

describe('error envelope', () => {
  it('maps upstream statuses onto OpenAI error types instead of a blanket server_error', () => {
    expect(normalizeInferenceError({ status: 400 }).status).toBe(400);
    expect(normalizeInferenceError({ status: 429 }).status).toBe(429);
    expect(normalizeInferenceError(new Error('boom')).status).toBe(500);
    expect(normalizeInferenceError(new Error('boom')).error.type).toBe('server_error');
  });

  it('reads the status and code of a provider error from its statusCode and body', () => {
    const providerError = Object.assign(new Error('OpenAI API error 429'), {
      statusCode: 429,
      responseBody: '{"error":{"code":"rate_limit_exceeded","message":"slow down"}}',
    });
    expect(normalizeInferenceError(providerError)).toMatchObject({
      status: 429,
      error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    });
  });
});
