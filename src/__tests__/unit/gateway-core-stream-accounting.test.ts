/**
 * What the gateway core (`executeModelCall`) books and reports when a call does not end the clean way:
 *
 *  - U8: a stream that stopped short of its terminal chunk (hang-up, failure, guardrail block) books its
 *    output at the larger of the provider's floor (Anthropic's message_start says ~1) and the estimate;
 *  - OL-M2: a stream with NO finish reason whose usage says the sent output limit is spent is a limit hit;
 *  - VTX-10: a call the provider ended in its own error finish (Gemini MALFORMED_FUNCTION_CALL, Bedrock
 *    malformed_tool_use) fails as an upstream 502 - with the tokens it burned booked once - instead of a `stop`;
 *  - GAP3-M2: evaluation calls never touch the semantic cache.
 *
 * A scripted native client stands in for the provider where a test needs a chunk shape (or a way of ending)
 * a real wire does not give; the cache cases run through the REAL OpenAI provider with only the network scripted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeModelCall, handleChatCompletion } from '@/lib/services/models/inferenceService';
import { isUsageBookedError, normalizeInferenceError, UpstreamFinishError } from '@/lib/services/models/openaiErrors';
import type { ModelStreamEvent } from '@/lib/services/models/gatewayTypes';
import { completion, flush, json, openAiRuntime, readSse, stubUpstream } from '../helpers/nativeGateway';

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
import { isSemanticCacheEnabled, lookupCache, storeInCache } from '@/lib/services/models/semanticCacheService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { createStreamGate } from '@/lib/services/guardrail';

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

const nativeUsage = (over: Record<string, number> = {}) => ({
  inputTokens: 100, outputTokens: 512, totalTokens: 612, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0,
  ...over,
});
/** Anthropic's message_start: the exact prompt (40 uncached + 30 cache read) and an output of about 1. */
const START_OF_STREAM = nativeUsage({ inputTokens: 40, outputTokens: 1, totalTokens: 41, cachedInputTokens: 30 });

type Chunk = Record<string, unknown>;

interface Script {
  stream?: Chunk[];
  /**
   * How the stream ends after its last chunk: normally (default); `abort` the caller's controller and fail the
   * way a hung-up socket does; or throw this error (a mid-stream fault).
   */
  after?: 'end' | { abort: AbortController } | Error;
  complete?: Record<string, unknown>;
}

/** A native client whose provider answers are scripted, wired in as the model's runtime. */
function scriptedClient(script: Script, driver = 'anthropic') {
  const client = {
    driver,
    modelId: 'gpt-4o',
    provider: {},
    normalizeInlineReasoning: false,
    prepare: vi.fn(async (request: unknown) => request),
    complete: vi.fn(async () => ({
      id: 'r1', model: 'gpt-4o', content: null, toolCalls: [], usage: nativeUsage(), finishReason: 'stop', raw: null, ...script.complete,
    })),
    stream: vi.fn(async function* () {
      for (const step of script.stream ?? []) yield { id: 'c1', model: 'gpt-4o', ...step };
      const after = script.after;
      if (after instanceof Error) throw after;
      if (after && after !== 'end') {
        after.abort.abort();
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
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

interface RunOptions {
  onUsageSettled?: (...args: unknown[]) => void;
  route?: string;
  driver?: string;
  signal?: AbortSignal;
}

async function runStream(script: Script, options: RunOptions = {}) {
  scriptedClient(script, options.driver ?? 'anthropic');
  const outcome = await executeModelCall({
    ...BASE,
    request: ASK,
    stream: true,
    context: {
      onUsageSettled: options.onUsageSettled as never,
      ...(options.route ? { route: options.route } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  });
  const events = await collect(outcome.stream!);
  await flush();
  return events;
}

const done = (events: ModelStreamEvent[]) => events.find((e) => e.type === 'done') as Extract<ModelStreamEvent, { type: 'done' }>;
const failed = (events: ModelStreamEvent[]) => events.find((e) => e.type === 'failed') as Extract<ModelStreamEvent, { type: 'failed' }> | undefined;
const limitEvent = (events: ModelStreamEvent[]) => events.find((e) => e.type === 'output_limit') as Extract<ModelStreamEvent, { type: 'output_limit' }> | undefined;
const finishEvent = (events: ModelStreamEvent[]) => events.find((e) => e.type === 'finish') as Extract<ModelStreamEvent, { type: 'finish' }> | undefined;
const finishDeltas = (events: ModelStreamEvent[]) => events.filter((e) => e.type === 'delta' && e.finishReason) as Array<Extract<ModelStreamEvent, { type: 'delta' }>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
  (createStreamGate as ReturnType<typeof vi.fn>).mockReset();
  stubModel(model());
});
afterEach(() => vi.unstubAllGlobals());

// ── U8 ────────────────────────────────────────────────────────────────────

describe('U8: a stream that stopped short books its output at the larger of the floor and the estimate', () => {
  /** 400 chars of answer: an estimate of 100 tokens, far above the ~1 of message_start. */
  const longAnswer = 'x'.repeat(400);

  it('a hang-up: exact prompt and cache counts from the provider, the output from the estimate, flagged', async () => {
    const controller = new AbortController();
    const onUsageSettled = vi.fn();
    const events = await runStream(
      { stream: [{ delta: {}, usage: START_OF_STREAM }, { delta: { content: longAnswer } }], after: { abort: controller } },
      { signal: controller.signal, onUsageSettled },
    );

    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'cancelled']);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      status: 'cancelled',
      usage: { inputTokens: 70, outputTokens: 100, totalTokens: 170, cachedInputTokens: 30 },
      providerResponse: { cancelled: 'client_disconnected', output_tokens_estimated: true, usage_estimated: true },
    });
    expect(onUsageSettled).toHaveBeenCalledTimes(1);
    expect(onUsageSettled.mock.calls[0][1]).toMatchObject({ inputTokens: 70, outputTokens: 100, totalTokens: 170, cachedInputTokens: 30 });
  });

  it('counts the reasoning summary and the tool-call arguments in the estimate (the one estimator)', async () => {
    const controller = new AbortController();
    await runStream(
      {
        stream: [
          { delta: {}, usage: START_OF_STREAM },
          { delta: { reasoning: { summary: 'some thinking' } } },
          { delta: { toolCalls: [{ index: 0, id: 'c1', name: 'lookup', arguments: '{"q":"abcdefgh"}' }] } },
        ],
        after: { abort: controller },
      },
      { signal: controller.signal },
    );

    expect(rows()[0].usage.outputTokens).toBe(Math.ceil(('some thinking' + '{"q":"abcdefgh"}').length / 4));
    expect(rows()[0].usage.inputTokens).toBe(70);
  });

  it('keeps the provider\'s usage, unflagged, when its own output is already the larger count', async () => {
    const controller = new AbortController();
    await runStream(
      { stream: [{ delta: {}, usage: nativeUsage({ inputTokens: 40, outputTokens: 300, totalTokens: 340, cachedInputTokens: 30 }) }, { delta: { content: 'short' } }], after: { abort: controller } },
      { signal: controller.signal },
    );

    expect(rows()[0]).toMatchObject({ status: 'cancelled', usage: { inputTokens: 70, outputTokens: 300, totalTokens: 370 } });
    expect(rows()[0].providerResponse.usage_estimated).toBeUndefined();
    expect(rows()[0].providerResponse.output_tokens_estimated).toBeUndefined();
  });

  it('keeps the provider\'s usage when the stream had already finished (the terminal chunk\'s count is final)', async () => {
    const controller = new AbortController();
    await runStream(
      {
        stream: [
          { delta: {}, usage: START_OF_STREAM },
          { delta: { content: longAnswer } },
          { delta: {}, finishReason: 'stop', rawFinishReason: 'end_turn', usage: nativeUsage({ inputTokens: 40, outputTokens: 80, totalTokens: 120, cachedInputTokens: 30 }) },
        ],
        after: { abort: controller },
      },
      { signal: controller.signal },
    );

    // 80 reported, 100 estimated: the finished stream's own count stands.
    expect(rows()[0]).toMatchObject({ status: 'cancelled', usage: { inputTokens: 70, outputTokens: 80, totalTokens: 150 } });
    expect(rows()[0].providerResponse.usage_estimated).toBeUndefined();
  });

  it('a mid-stream failure: booked once with the floored output, flagged, and the failure still reported', async () => {
    const onUsageSettled = vi.fn();
    const events = await runStream(
      { stream: [{ delta: {}, usage: START_OF_STREAM }, { delta: { content: longAnswer } }], after: new Error('upstream connection reset') },
      { onUsageSettled },
    );

    expect(failed(events)).toMatchObject({ type: 'failed', status: 503 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      status: 'error',
      usage: { inputTokens: 70, outputTokens: 100, totalTokens: 170, cachedInputTokens: 30 },
      providerResponse: { usage_estimated: true },
    });
    expect(onUsageSettled).toHaveBeenCalledTimes(1);
    expect(onUsageSettled.mock.calls[0][1]).toMatchObject({ inputTokens: 70, outputTokens: 100 });
  });

  it('a mid-stream failure whose provider count is the larger one is not flagged', async () => {
    await runStream({
      stream: [{ delta: {}, usage: nativeUsage({ inputTokens: 40, outputTokens: 300, totalTokens: 340 }) }, { delta: { content: 'short' } }],
      after: new Error('upstream connection reset'),
    });

    expect(rows()[0]).toMatchObject({ status: 'error', usage: { outputTokens: 300 } });
    expect(rows()[0].providerResponse.usage_estimated).toBeUndefined();
  });

  it('a guardrail block mid-stream books what the provider generated, not the ~1 of message_start', async () => {
    stubModel(model({ outputGuardrailKey: 'gr' }));
    (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      push: vi.fn(async () => ({
        emit: [],
        blocked: true,
        verdict: { guardrailKey: 'gr', message: { body: 'blocked by policy', reasonClass: 'policy' }, codes: ['X'], riskScore: 0.9 },
      })),
      end: vi.fn(async () => ({ emit: [], blocked: false })),
    }));
    const onUsageSettled = vi.fn();

    const events = await runStream(
      { stream: [{ delta: {}, usage: START_OF_STREAM }, { delta: { content: longAnswer } }] },
      { onUsageSettled },
    );

    expect(events.some((e) => e.type === 'blocked')).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      status: 'error',
      finishReason: 'content_filter',
      usage: { inputTokens: 70, outputTokens: 100, totalTokens: 170 },
      providerResponse: { guardrail_blocked: true, output_tokens_estimated: true, usage_estimated: true },
    });
    expect(onUsageSettled).toHaveBeenCalledTimes(1);
  });

  it('leaves a stream that completed with its terminal chunk exactly as the provider reported it', async () => {
    const events = await runStream({
      stream: [
        { delta: {}, usage: START_OF_STREAM },
        { delta: { content: longAnswer } },
        { delta: {}, finishReason: 'stop', rawFinishReason: 'end_turn', usage: nativeUsage({ inputTokens: 40, outputTokens: 80, totalTokens: 120, cachedInputTokens: 30 }) },
      ],
    });

    expect(done(events)).toMatchObject({ outputLimitReached: false, wireFinishReason: 'stop' });
    expect(done(events).usageEstimated).toBeUndefined();
    expect(done(events).usage).toMatchObject({ inputTokens: 70, outputTokens: 80, totalTokens: 150 });
    expect(rows()[0]).toMatchObject({ status: 'success', usage: { outputTokens: 80 } });
  });
});

// ── OL-M2 ─────────────────────────────────────────────────────────────────

describe('OL-M2: a stream with no finish reason whose usage says the sent limit is spent', () => {
  const spent = nativeUsage(); // 100 in, 512 out; the model sends a limit of 512
  const cutOffCall = { delta: { toolCalls: [{ index: 0, id: 'c1', name: 'lookup', arguments: '' }] } };

  it('is a limit hit when nothing visible was said: output_limit event with the sent limit, booked once as an error', async () => {
    const onUsageSettled = vi.fn();
    const events = await runStream(
      { stream: [{ delta: { reasoning: { summary: 'thinking and thinking' } } }, { delta: {}, usage: spent }] },
      { onUsageSettled },
    );

    expect(limitEvent(events)).toMatchObject({ type: 'output_limit', limit: 512 });
    expect(limitEvent(events)!.rawFinishReason).toBeUndefined();
    expect(limitEvent(events)!.error).toMatchObject({ type: 'output_token_limit_exceeded', code: 'output_token_limit_exceeded' });
    expect(done(events)).toMatchObject({ outputLimitReached: true, wireFinishReason: 'length' });
    expect(done(events).response.finishReason).toBe('length');
    expect(done(events).usage).toMatchObject({ inputTokens: 100, outputTokens: 512 });
    // No synthetic `stop` for a stream that was cut off.
    expect(finishEvent(events)).toBeUndefined();
    expect(finishDeltas(events)).toEqual([]);
    expect(onUsageSettled).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'error', finishReason: 'length', usage: { inputTokens: 100, outputTokens: 512 } });
  });

  it('returns visible text with finish length, flagged truncated (no error)', async () => {
    const events = await runStream({ stream: [{ delta: { content: 'half an ans' } }, { delta: {}, usage: spent }] });

    expect(limitEvent(events)).toBeUndefined();
    const end = done(events);
    expect(end).toMatchObject({ truncated: true, outputLimitReached: false, wireFinishReason: 'length' });
    expect(end.response.content).toBe('half an ans');
    expect(end.response.finishReason).toBe('length');
    expect(finishDeltas(events).map((e) => e.finishReason)).toEqual(['length']);
    expect(finishEvent(events)).toBeUndefined();
    expect(rows()[0]).toMatchObject({ status: 'success', finishReason: 'length' });
  });

  it('is a limit hit for a tool call in the agent loop, whose arguments are not to be trusted', async () => {
    const events = await runStream({ stream: [cutOffCall, { delta: {}, usage: spent }] }, { route: 'agent.chat' });

    expect(limitEvent(events)).toMatchObject({ limit: 512 });
    expect(done(events)).toMatchObject({ outputLimitReached: true, wireFinishReason: 'length' });
    expect(done(events).response.toolCalls).toEqual([]);
    expect(rows()[0]).toMatchObject({ status: 'error', finishReason: 'length' });
  });

  it('hands a client the partial tool call with finish length, as the provider API does', async () => {
    const events = await runStream({ stream: [cutOffCall, { delta: {}, usage: spent }] });

    expect(limitEvent(events)).toBeUndefined();
    const end = done(events);
    expect(end).toMatchObject({ truncated: true, outputLimitReached: false, wireFinishReason: 'length' });
    expect(end.response.toolCalls).toHaveLength(1);
    expect(finishDeltas(events).map((e) => e.finishReason)).toEqual(['length']);
    // The blank-argument repair never runs on a cut-off call.
    expect(events.some((e) => e.type === 'delta' && e.toolCalls?.some((call) => call.arguments === '{}'))).toBe(false);
  });

  it('keeps today\'s synthetic finish when the output is below the limit', async () => {
    const below = nativeUsage({ outputTokens: 100, totalTokens: 200 });

    const text = await runStream({ stream: [{ delta: { content: 'a whole answer' } }, { delta: {}, usage: below }] });
    expect(finishEvent(text)).toMatchObject({ finishReason: 'stop' });
    expect(done(text)).toMatchObject({ outputLimitReached: false, wireFinishReason: 'stop' });
    expect(done(text).truncated).toBeUndefined();

    const tool = await runStream({ stream: [cutOffCall, { delta: {}, usage: below }] }, { route: 'agent.chat' });
    expect(limitEvent(tool)).toBeUndefined();
    expect(finishEvent(tool)).toMatchObject({ finishReason: 'tool_calls' });
  });

  it('keeps today\'s synthetic finish when the stream carries no usage', async () => {
    const events = await runStream({ stream: [{ delta: { content: 'a whole answer' } }] });

    expect(limitEvent(events)).toBeUndefined();
    expect(finishEvent(events)).toMatchObject({ finishReason: 'stop' });
    expect(done(events)).toMatchObject({ outputLimitReached: false, usageEstimated: true });
  });

  it('keeps today\'s synthetic finish when the call sent no limit', async () => {
    stubModel(model({ settings: {} }));
    const events = await runStream({ stream: [{ delta: { content: 'a whole answer' } }, { delta: {}, usage: spent }] }, { driver: 'openai' });

    expect(limitEvent(events)).toBeUndefined();
    expect(finishEvent(events)).toMatchObject({ finishReason: 'stop' });
    expect(done(events).outputLimitReached).toBe(false);
  });

  it('never overrides a finish reason the provider did send', async () => {
    const events = await runStream({
      stream: [{ delta: { content: 'a whole answer' } }, { delta: {}, finishReason: 'stop', rawFinishReason: 'end_turn', usage: spent }],
    });

    expect(limitEvent(events)).toBeUndefined();
    expect(done(events)).toMatchObject({ outputLimitReached: false, wireFinishReason: 'stop' });
    expect(done(events).truncated).toBeUndefined();
  });
});

// ── VTX-10 ────────────────────────────────────────────────────────────────

describe('VTX-10: a call the provider ended in its own error finish fails as an upstream 502', () => {
  const gemini = { finishReason: 'error', rawFinishReason: 'MALFORMED_FUNCTION_CALL' };

  describe('non-streamed', () => {
    it('throws an UpstreamFinishError that names the raw reason, and books the burned tokens once', async () => {
      scriptedClient({ complete: { ...gemini, content: null, usage: nativeUsage({ outputTokens: 30, totalTokens: 130 }) } }, 'vertex');
      const onUsageSettled = vi.fn();

      const error = await executeModelCall({ ...BASE, request: ASK, context: { onUsageSettled } }).catch((e: unknown) => e) as UpstreamFinishError;
      await flush();

      expect(error).toBeInstanceOf(UpstreamFinishError);
      expect(error).toMatchObject({ status: 502, code: 'malformed_function_call', rawFinishReason: 'MALFORMED_FUNCTION_CALL', usageBooked: true });
      expect(error.message).toContain('MALFORMED_FUNCTION_CALL');
      expect(error.usage).toMatchObject({ inputTokens: 100, outputTokens: 30 });
      expect(error.cost).toBeDefined();
      expect(isUsageBookedError(error)).toBe(true);

      // One budget debit and one row: the core's `logFailedCall` must not add an empty second one.
      expect(onUsageSettled).toHaveBeenCalledTimes(1);
      expect(onUsageSettled.mock.calls[0][0]).toBe(error.cost);
      expect(onUsageSettled.mock.calls[0][1]).toMatchObject({ inputTokens: 100, outputTokens: 30 });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        status: 'error',
        finishReason: 'MALFORMED_FUNCTION_CALL',
        usage: { inputTokens: 100, outputTokens: 30 },
        providerResponse: { finish_reason: 'MALFORMED_FUNCTION_CALL', raw_finish_reason: 'MALFORMED_FUNCTION_CALL' },
        errorMessage: error.message,
      });
    });

    it('is the 502 server_error the wire shows, with the code its raw reason names', async () => {
      scriptedClient({ complete: gemini }, 'vertex');

      const error = await executeModelCall({ ...BASE, request: ASK }).catch((e: unknown) => e);

      expect(normalizeInferenceError(error)).toMatchObject({
        status: 502,
        error: { type: 'server_error', code: 'malformed_function_call', message: expect.stringContaining('MALFORMED_FUNCTION_CALL') },
      });
    });

    it('also fails a Bedrock call that reaches the gateway as a plain stop with a malformed raw reason (agent-sdk 0.21)', async () => {
      scriptedClient({ complete: { finishReason: 'stop', rawFinishReason: 'malformed_tool_use' } }, 'bedrock');

      const error = await executeModelCall({ ...BASE, request: ASK }).catch((e: unknown) => e) as UpstreamFinishError;

      expect(error).toBeInstanceOf(UpstreamFinishError);
      expect(error).toMatchObject({ status: 502, code: 'malformed_tool_use', usageBooked: true });
    });

    it('names no reason when the provider sent none (a bare error finish)', async () => {
      scriptedClient({ complete: { finishReason: 'error' } });

      const error = await executeModelCall({ ...BASE, request: ASK }).catch((e: unknown) => e) as UpstreamFinishError;
      await flush();

      expect(error).toBeInstanceOf(UpstreamFinishError);
      expect(error.rawFinishReason).toBeUndefined();
      expect(error.code).toBe('provider_error');
      expect(rows()[0]).toMatchObject({ status: 'error', finishReason: 'error' });
    });

    it('does not write a second row for a caller that asked for failures to be logged', async () => {
      scriptedClient({ complete: gemini }, 'vertex');

      await executeModelCall({ ...BASE, request: ASK, context: { logFailures: true } }).catch(() => undefined);
      await flush();

      expect(rows()).toHaveLength(1);
    });

    it('passes through the HTTP edge entry point as the same booked error', async () => {
      scriptedClient({ complete: gemini }, 'vertex');

      const error = await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'hi' }] } }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UpstreamFinishError);
      expect(isUsageBookedError(error)).toBe(true);
    });

    it('leaves a call that finished normally alone (control)', async () => {
      scriptedClient({ complete: { content: 'fine', finishReason: 'stop', rawFinishReason: 'STOP' } }, 'vertex');

      const outcome = await executeModelCall({ ...BASE, request: ASK });
      await flush();

      expect(outcome.result?.response.content).toBe('fine');
      expect(rows()[0]).toMatchObject({ status: 'success' });
    });
  });

  describe('streamed', () => {
    it('ends in a failed event (502, the raw reason in the message) and never a stop; the tokens are booked once', async () => {
      const onUsageSettled = vi.fn();
      const events = await runStream(
        { stream: [{ delta: { content: 'Let me ' } }, { delta: {}, ...gemini, usage: nativeUsage({ outputTokens: 30, totalTokens: 130 }) }] },
        { driver: 'vertex', onUsageSettled },
      );

      expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'failed']);
      expect(failed(events)).toMatchObject({
        type: 'failed',
        status: 502,
        error: { type: 'server_error', code: 'malformed_function_call', message: expect.stringContaining('MALFORMED_FUNCTION_CALL') },
      });
      expect(finishDeltas(events)).toEqual([]);
      expect(finishEvent(events)).toBeUndefined();
      expect(onUsageSettled).toHaveBeenCalledTimes(1);
      expect(onUsageSettled.mock.calls[0][1]).toMatchObject({ inputTokens: 100, outputTokens: 30 });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        status: 'error',
        finishReason: 'MALFORMED_FUNCTION_CALL',
        usage: { inputTokens: 100, outputTokens: 30 },
        providerResponse: { raw_finish_reason: 'MALFORMED_FUNCTION_CALL' },
      });
      expect(rows()[0].providerResponse.usage_estimated).toBeUndefined();
    });

    it('reads the stream on to its end and books the usage that trails the error finish', async () => {
      const events = await runStream(
        {
          stream: [
            { delta: {}, finishReason: 'error', rawFinishReason: 'insufficient_system_resource' },
            { delta: {}, usage: nativeUsage({ outputTokens: 12, totalTokens: 112 }) },
          ],
        },
        { driver: 'openai' },
      );

      expect(failed(events)).toMatchObject({ status: 502, error: { code: 'insufficient_system_resource' } });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ status: 'error', usage: { inputTokens: 100, outputTokens: 12 } });
      expect(rows()[0].providerResponse.usage_estimated).toBeUndefined();
    });

    it('delivers nothing of the failing chunk itself', async () => {
      const events = await runStream({
        stream: [{ delta: { content: 'a partial call' }, ...gemini, usage: nativeUsage() }],
      }, { driver: 'vertex' });

      expect(events.map((e) => e.type)).toEqual(['start', 'failed']);
    });

    it('books an estimate when the failing call carried no usage at all, flagged', async () => {
      const onUsageSettled = vi.fn();
      const events = await runStream({ stream: [{ delta: {}, ...gemini }] }, { driver: 'vertex', onUsageSettled });

      expect(failed(events)).toMatchObject({ status: 502 });
      expect(onUsageSettled).toHaveBeenCalledTimes(1);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ status: 'error', providerResponse: { usage_estimated: true } });
      expect(rows()[0].usage.inputTokens).toBeGreaterThan(0);
    });

    it('also fails a Bedrock stream that says stop with a malformed raw reason (agent-sdk 0.21)', async () => {
      const events = await runStream(
        { stream: [{ delta: { content: 'x' } }, { delta: {}, finishReason: 'stop', rawFinishReason: 'malformed_model_output', usage: nativeUsage() }] },
        { driver: 'bedrock' },
      );

      expect(failed(events)).toMatchObject({ status: 502, error: { code: 'malformed_model_output' } });
      expect(done(events)).toBeUndefined();
    });

    it('writes the error frame and [DONE] on the OpenAI stream, and no finish_reason stop', async () => {
      scriptedClient({ stream: [{ delta: { content: 'Let me ' } }, { delta: {}, ...gemini, usage: nativeUsage() }] }, 'vertex');

      const result = await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'hi' }] }, stream: true });
      const { frames } = await readSse(result.stream!);
      await flush();

      const chunks = frames.filter((f): f is Record<string, any> => f !== '[DONE]');
      const errorFrame = chunks.find((f) => f.error);
      expect(errorFrame).toMatchObject({ error: { type: 'server_error', code: 'malformed_function_call' } });
      expect(chunks.some((f) => f.choices?.[0]?.finish_reason)).toBe(false);
      expect(frames.at(-1)).toBe('[DONE]');
      expect(rows()).toHaveLength(1);
    });
  });
});

// ── GAP3-M2 ───────────────────────────────────────────────────────────────

describe('GAP3-M2: evaluation calls never touch the semantic cache', () => {
  const enableCache = async () => {
    stubModel(model({ semanticCache: { indexKey: 'i', threshold: 0.9 } }));
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    stubUpstream(() => json(completion()));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: await openAiRuntime() });
  };

  it('answers a plain chat call through the cache (control)', async () => {
    await enableCache();

    await executeModelCall({ ...BASE, request: ASK });

    expect(lookupCache).toHaveBeenCalledTimes(1);
    expect(storeInCache).toHaveBeenCalledTimes(1);
  });

  it.each(['evaluation', 'evaluation.judge', 'evaluation.dataset_generation', 'evaluation.prompt_optimizer'])(
    'bypasses the cache for the route %s: no lookup, no store',
    async (route) => {
      await enableCache();

      await executeModelCall({ ...BASE, request: ASK, context: { route } });
      await flush();

      expect(lookupCache).not.toHaveBeenCalled();
      expect(storeInCache).not.toHaveBeenCalled();
    },
  );

  it('is never served a cached answer, even when the cache holds one', async () => {
    await enableCache();
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: true, response: completion({ content: 'cached answer' }) });

    const outcome = await executeModelCall({ ...BASE, request: ASK, context: { route: 'evaluation.judge' } });

    expect(outcome.cacheHit).toBe(false);
    expect(outcome.result?.response.content).not.toBe('cached answer');
  });
});
