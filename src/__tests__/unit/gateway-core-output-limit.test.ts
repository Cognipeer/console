/**
 * The gateway core's output-limit detection (`executeModelCall`): what counts as a limit hit, what is only
 * a truncated answer, and what the error / event / outcome carry for the agent's raised retry.
 *
 * A scripted native client stands in for the provider where a test needs a chunk shape a real wire does
 * not produce (a Responses-API `incomplete` that arrives with a normalized `length` and no raw reason);
 * the OpenAI-wire cases run through the REAL provider with only the network scripted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeModelCall } from '@/lib/services/models/inferenceService';
import { normalizeInferenceError, OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import type { ModelStreamEvent } from '@/lib/services/models/gatewayTypes';
import { chunk, completion, flush, json, openAiRuntime, sse, stubUpstream } from '../helpers/nativeGateway';

vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
// Synchronous factory on purpose: the pure cost arithmetic is stood in for, the rows are recorded.
vi.mock('@/lib/services/models/usageLogger', () => ({
  logModelUsage: vi.fn().mockResolvedValue(undefined),
  calculateCost: (_pricing: unknown, usage: { inputTokens?: number; outputTokens?: number }) => {
    const inputCost = (usage.inputTokens ?? 0) * 0.00001;
    const outputCost = (usage.outputTokens ?? 0) * 0.00003;
    return { currency: 'USD', inputCost, outputCost, cachedCost: 0, cacheWriteCost: 0, totalCost: inputCost + outputCost };
  },
}));
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockResolvedValue(new Map()),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/guardrail/hooks/recordCache', () => ({ getCachedGuardrail: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({
    passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'g', guardrailName: 'g',
  }),
  createStreamGate: vi.fn(),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { logModelUsage } from '@/lib/services/models/usageLogger';

const model = (overrides: object = {}) => ({
  _id: 'm1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'M',
  key: 'm',
  providerKey: 'prov',
  providerDriver: 'openai',
  category: 'llm' as const,
  modelId: 'gpt-4o',
  settings: { maxTokens: 512 },
  pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 },
  ...overrides,
});

const BASE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', modelKey: 'm' };
const ASK = { messages: [{ role: 'user' as const, content: 'hello' }] };
const stubModel = (m: object) => (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(m);
const rows = () => (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);

const nativeUsage = { inputTokens: 100, outputTokens: 512, totalTokens: 612, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 };

type Chunk = Record<string, unknown>;

/** A native client whose provider answers are scripted, wired in as the model's runtime. */
function scriptedClient(script: { stream?: Chunk[]; complete?: Record<string, unknown> }, driver = 'openai') {
  const client = {
    driver,
    modelId: 'gpt-4o',
    provider: {},
    normalizeInlineReasoning: false,
    prepare: vi.fn(async (request: unknown) => request),
    complete: vi.fn(async () => ({
      id: 'r1', model: 'gpt-4o', content: null, toolCalls: [], usage: nativeUsage, finishReason: 'stop', raw: null, ...script.complete,
    })),
    stream: vi.fn(async function* () {
      for (const step of script.stream ?? []) yield { id: 'c1', model: 'gpt-4o', ...step };
    }),
  };
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
    runtime: { createNativeChatClient: vi.fn().mockResolvedValue(client) },
  });
  return client;
}

async function collect(stream: AsyncGenerator<ModelStreamEvent, void, void>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Streams through a scripted client. The default driver is Anthropic's: it has its own stop reasons (`max_tokens`), which an OpenAI-schema driver would put on the wire raw. */
async function runStream(script: Chunk[], extra: { onUsageSettled?: (...args: unknown[]) => void; route?: string; driver?: string } = {}) {
  scriptedClient({ stream: script }, extra.driver ?? 'anthropic');
  const outcome = await executeModelCall({
    ...BASE,
    request: ASK,
    stream: true,
    context: { onUsageSettled: extra.onUsageSettled as never, ...(extra.route ? { route: extra.route } : {}) },
  });
  const events = await collect(outcome.stream!);
  await flush();
  return events;
}

const done = (events: ModelStreamEvent[]) => events.find((e) => e.type === 'done') as Extract<ModelStreamEvent, { type: 'done' }>;
const limitEvent = (events: ModelStreamEvent[]) => events.find((e) => e.type === 'output_limit') as Extract<ModelStreamEvent, { type: 'output_limit' }> | undefined;
const toolDeltas = (events: ModelStreamEvent[]) => events.filter((e) => e.type === 'delta' && e.toolCalls?.length) as Array<Extract<ModelStreamEvent, { type: 'delta' }>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  stubModel(model());
});
afterEach(() => vi.unstubAllGlobals());

describe('stream: a limit hit carries the limit and the provider reason', () => {
  it('puts the sent limit and the raw stop reason on the output_limit event', async () => {
    const events = await runStream([
      { delta: { reasoning: { summary: 'thinking and thinking' } } },
      { delta: {}, finishReason: 'length', rawFinishReason: 'max_tokens', usage: nativeUsage },
    ]);

    expect(limitEvent(events)).toMatchObject({ type: 'output_limit', limit: 512, rawFinishReason: 'max_tokens' });
    expect(limitEvent(events)!.error).toMatchObject({ type: 'output_token_limit_exceeded', code: 'output_token_limit_exceeded' });
    expect(done(events)).toMatchObject({ outputLimitReached: true, wireFinishReason: 'length' });
    expect(done(events).truncated).toBeUndefined();
  });

  it('reports the context window as the raw reason when that is what filled up', async () => {
    const events = await runStream([
      { delta: {}, finishReason: 'length', rawFinishReason: 'model_context_window_exceeded', usage: nativeUsage },
    ]);

    expect(limitEvent(events)).toMatchObject({ limit: 512, rawFinishReason: 'model_context_window_exceeded' });
    expect(limitEvent(events)!.error.message).toContain('context window');
  });

  it('treats a normalized length without a raw reason as terminal (Responses-style incomplete)', async () => {
    const events = await runStream([
      { delta: { reasoning: { summary: 'still thinking' } } },
      { delta: {}, finishReason: 'length', usage: nativeUsage },
    ]);

    const limit = limitEvent(events);
    expect(limit).toMatchObject({ limit: 512 });
    expect(limit!.rawFinishReason).toBeUndefined();
    expect(done(events).outputLimitReached).toBe(true);
  });

  it('omits the limit when the call sent none', async () => {
    stubModel(model({ settings: {} }));
    const events = await runStream([{ delta: {}, finishReason: 'length', rawFinishReason: 'length', usage: nativeUsage }]);

    const limit = limitEvent(events)!;
    expect(limit.type).toBe('output_limit');
    expect('limit' in limit).toBe(false);
  });
});

describe('stream: finish length with tool calls', () => {
  const cutOffCall = [
    { delta: { toolCalls: [{ index: 0, id: 'c1', name: 'lookup', arguments: '' }] } },
    { delta: {}, finishReason: 'length', rawFinishReason: 'max_tokens', usage: nativeUsage },
  ];

  it('is a limit hit in the agent loop, never a done that carries the cut-off tool calls', async () => {
    const events = await runStream(cutOffCall, { route: 'agent.chat' });

    expect(limitEvent(events)).toMatchObject({ limit: 512, rawFinishReason: 'max_tokens' });
    const end = done(events);
    expect(end.outputLimitReached).toBe(true);
    expect(end.response.toolCalls).toEqual([]);
    expect(end.response.finishReason).toBe('length');
    expect(events.some((e) => e.type === 'delta' && e.finishReason === 'tool_calls')).toBe(false);
  });

  it('hands a client the partial tool call with finish length, as the provider API does', async () => {
    const events = await runStream(cutOffCall);

    expect(limitEvent(events)).toBeUndefined();
    const end = done(events);
    expect(end.outputLimitReached).toBe(false);
    expect(end.truncated).toBe(true);
    expect(end.response.finishReason).toBe('length');
    expect(end.response.toolCalls).toHaveLength(1);
    expect(toolDeltas(events)).not.toHaveLength(0);
  });

  it('does not complete the blank arguments of a cut-off call (the repair never runs on length)', async () => {
    for (const route of [undefined, 'agent.chat']) {
      vi.clearAllMocks();
      const events = await runStream(cutOffCall, route ? { route } : {});
      const repaired = toolDeltas(events).filter((e) => e.toolCalls!.some((call) => call.arguments === '{}'));
      expect(repaired).toEqual([]);
    }
  });

  it('still repairs blank arguments when the call finished normally (control)', async () => {
    const events = await runStream([
      { delta: { toolCalls: [{ index: 0, id: 'c1', name: 'lookup', arguments: '' }] } },
      { delta: {}, finishReason: 'tool_calls', rawFinishReason: 'tool_calls', usage: nativeUsage },
    ]);
    const repaired = toolDeltas(events).filter((e) => e.toolCalls!.some((call) => call.arguments === '{}'));
    expect(repaired).toHaveLength(1);
    expect(limitEvent(events)).toBeUndefined();
  });

  it('books the tokens once: one error row, one budget debit', async () => {
    const onUsageSettled = vi.fn();
    await runStream(cutOffCall, { onUsageSettled, route: 'agent.chat' });

    expect(onUsageSettled).toHaveBeenCalledTimes(1);
    expect(onUsageSettled.mock.calls[0][1]).toMatchObject({ inputTokens: 100, outputTokens: 512 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'error', finishReason: 'length', usage: { inputTokens: 100, outputTokens: 512 } });
  });

  it('is detected on the OpenAI wire too (tool call deltas, then finish_reason length)', async () => {
    stubUpstream(() => sse([
      chunk.tool(0, { id: 'c1', name: 'lookup', arguments: '{"q":"abc' }),
      chunk.finish('length'),
      chunk.usage({ prompt_tokens: 100, completion_tokens: 512, total_tokens: 612 }),
    ]));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: await openAiRuntime() });

    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true, context: { route: 'agent.chat' } });
    const events = await collect(outcome.stream!);
    await flush();

    expect(limitEvent(events)).toMatchObject({ limit: 512, rawFinishReason: 'length' });
    expect(done(events).response.toolCalls).toEqual([]);
    expect(rows()).toHaveLength(1);
  });
});

describe('stream: visible text the limit cut off is a truncated answer', () => {
  it('flags the done event and delivers the text unchanged (raw reason present)', async () => {
    const events = await runStream([
      { delta: { content: 'half an ans' } },
      { delta: {}, finishReason: 'length', rawFinishReason: 'max_tokens', usage: nativeUsage },
    ]);

    expect(limitEvent(events)).toBeUndefined();
    const end = done(events);
    expect(end).toMatchObject({ truncated: true, outputLimitReached: false, wireFinishReason: 'length' });
    expect(end.response.content).toBe('half an ans');
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { content?: string }).content).filter(Boolean)).toEqual(['half an ans']);
    expect(events.some((e) => e.type === 'delta' && e.finishReason === 'length')).toBe(true);
    // A truncated answer is a success row: the answer was delivered.
    expect(rows()[0]).toMatchObject({ status: 'success', finishReason: 'length' });
  });

  it('flags a Responses-style chunk (finishReason length, no raw reason) the same way', async () => {
    const events = await runStream([
      { delta: { content: 'half an ans' } },
      { delta: {}, finishReason: 'length', usage: nativeUsage },
    ]);

    const end = done(events);
    expect(end).toMatchObject({ truncated: true, outputLimitReached: false, wireFinishReason: 'length' });
    expect(end.response.finishReason).toBe('length');
    expect(end.response.content).toBe('half an ans');
  });

  it('does not flag a stream that stopped normally', async () => {
    const events = await runStream([
      { delta: { content: 'whole answer' } },
      { delta: {}, finishReason: 'stop', rawFinishReason: 'stop', usage: nativeUsage },
    ]);
    expect(done(events).truncated).toBeUndefined();
    expect(done(events).outputLimitReached).toBe(false);
  });

  it('flags a cut-off answer on the OpenAI wire (finish_reason length after text)', async () => {
    stubUpstream(() => sse([chunk.text('half an ans'), chunk.finish('length')]));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: await openAiRuntime() });

    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);

    expect(done(events)).toMatchObject({ truncated: true, outputLimitReached: false, wireFinishReason: 'length' });
  });
});

describe('non-stream', () => {
  it('flags visible text the limit cut off and returns it unchanged', async () => {
    stubUpstream(() => json(completion({ content: 'half an ans', finish: 'length' })));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: await openAiRuntime() });

    const outcome = await executeModelCall({ ...BASE, request: ASK });

    expect(outcome.truncated).toBe(true);
    expect(outcome.result?.response.content).toBe('half an ans');
    expect(outcome.result?.wireFinishReason).toBe('length');
  });

  it('does not flag a normal answer', async () => {
    stubUpstream(() => json(completion({ content: 'whole answer' })));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: await openAiRuntime() });

    const outcome = await executeModelCall({ ...BASE, request: ASK });
    expect(outcome.truncated).toBeUndefined();
  });

  it('judges the limit on the content AFTER the inline reasoning is split out', async () => {
    // The whole message is a leaked reasoning block: nothing visible was produced.
    scriptedClient({ complete: { content: '<reasoning>thinking all of it', finishReason: 'length', rawFinishReason: 'length' } });

    const error = await executeModelCall({ ...BASE, request: ASK }).catch((e: unknown) => e) as OutputTokenLimitError;

    expect(error).toBeInstanceOf(OutputTokenLimitError);
    expect(error.limit).toBe(512);
    expect(error.usageBooked).toBe(true);
  });

  it('keeps an answer that follows the leaked reasoning as a truncated one', async () => {
    scriptedClient({ complete: { content: '<reasoning>done thinking</reasoning>half an ans', finishReason: 'length', rawFinishReason: 'length' } });

    const outcome = await executeModelCall({ ...BASE, request: ASK });

    expect(outcome.truncated).toBe(true);
    expect(outcome.result?.response.content).toBe('half an ans');
  });

  it('returns a client the partial tool call with finish length (no 422)', async () => {
    scriptedClient({
      complete: {
        content: 'let me check',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"abc' }],
        finishReason: 'length',
        rawFinishReason: 'max_tokens',
      },
    });

    const outcome = await executeModelCall({ ...BASE, request: ASK });

    expect(outcome.truncated).toBe(true);
    expect(outcome.result?.response.toolCalls).toHaveLength(1);
    expect(outcome.result?.response.finishReason).toBe('length');
  });

  it('is a limit hit in the agent loop when a tool call was cut off, billed once', async () => {
    scriptedClient({
      complete: {
        content: 'let me check',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"abc' }],
        finishReason: 'length',
        rawFinishReason: 'max_tokens',
      },
    });
    const onUsageSettled = vi.fn();

    const error = await executeModelCall({ ...BASE, request: ASK, context: { onUsageSettled, route: 'agent.chat' } })
      .catch((e: unknown) => e) as OutputTokenLimitError;
    await flush();

    expect(error).toBeInstanceOf(OutputTokenLimitError);
    expect(error).toMatchObject({ limit: 512, rawFinishReason: 'max_tokens', usageBooked: true });
    expect(error.usage).toMatchObject({ inputTokens: 100, outputTokens: 512 });
    expect(onUsageSettled).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      status: 'error',
      finishReason: 'length',
      providerResponse: { finish_reason: 'length', output_token_limit: true, raw_finish_reason: 'max_tokens' },
    });
  });

  it('carries model_context_window_exceeded on the error and says the context was full', async () => {
    scriptedClient({ complete: { content: null, finishReason: 'length', rawFinishReason: 'model_context_window_exceeded' } }, 'bedrock');

    const error = await executeModelCall({ ...BASE, request: ASK }).catch((e: unknown) => e) as OutputTokenLimitError;

    expect(error.rawFinishReason).toBe('model_context_window_exceeded');
    expect(error.limit).toBe(512);
    expect(error.message).toContain('context window');
    expect(error.message).not.toContain('Increase');
    // The wire shape does not change.
    expect(normalizeInferenceError(error)).toMatchObject({
      status: 422,
      error: { type: 'output_token_limit_exceeded', code: 'output_token_limit_exceeded', param: 'max_completion_tokens' },
    });
  });

  it('names the parameter of the dialect the caller speaks', async () => {
    scriptedClient({ complete: { content: null, finishReason: 'length', rawFinishReason: 'max_tokens' } });

    const chat = await executeModelCall({ ...BASE, request: ASK }).catch((e: unknown) => e) as OutputTokenLimitError;
    const messages = await executeModelCall({ ...BASE, request: ASK, context: { route: 'messages' } }).catch((e: unknown) => e) as OutputTokenLimitError;
    const responses = await executeModelCall({ ...BASE, request: ASK, context: { route: 'responses' } }).catch((e: unknown) => e) as OutputTokenLimitError;

    expect(chat.message).toContain('max_completion_tokens');
    expect(messages.message).toContain('max_tokens on the request');
    expect(messages.message).not.toContain('max_completion_tokens');
    expect(responses.message).toContain('max_output_tokens');
  });
});

describe('OutputTokenLimitError wording', () => {
  it('keeps the chat wording, points at Default max tokens and never at the advertised maximum', () => {
    const error = new OutputTokenLimitError(512);

    expect(error.message).toContain('512 tokens');
    expect(error.message).toContain('Reasoning models');
    expect(error.message).toContain('max_completion_tokens');
    expect(error.message).toContain('Default max tokens');
    expect(error.message).not.toMatch(/maximum output tokens/i);
    expect(error.rawFinishReason).toBeUndefined();
    expect(error.dialect).toBeUndefined();
  });

  it('carries the raw reason and dialect it was built with, and keeps the 422 body for every dialect', () => {
    const error = new OutputTokenLimitError(256, { rawFinishReason: 'max_tokens', dialect: 'responses' });

    expect(error).toMatchObject({ limit: 256, rawFinishReason: 'max_tokens', dialect: 'responses' });
    expect(error.message).toContain('max_output_tokens');
    expect(normalizeInferenceError(error)).toEqual({
      status: 422,
      error: {
        message: error.message,
        type: 'output_token_limit_exceeded',
        param: 'max_completion_tokens',
        code: 'output_token_limit_exceeded',
      },
    });
  });
});
