/**
 * The gateway core (`executeModelCall`) with the REAL provider contracts and the
 * REAL agent-sdk providers; only the network and the I/O services are scripted.
 *
 * What is pinned here is what an in-process caller (an agent, a judge) relies on
 * and what the HTTP facade must not have broken: the stage order, native events,
 * cancellation, caller attribution, once-per-turn input guardrails, replica
 * failover before the first byte, retry layering, and the request rules a Model
 * Hub record applies to every caller.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeModelCall, handleChatCompletion } from '@/lib/services/models/inferenceService';
import { noteRoutingRun, runWithRoutingCaller } from '@/lib/services/models/routingCallerContext';
import type { GatewayChatRequest, ModelStreamEvent } from '@/lib/services/models/gatewayTypes';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import {
  anthropicRuntime,
  bedrockRuntime,
  chunk,
  completion,
  controlledStream,
  flush,
  json,
  openAiRuntime,
  sse,
  stubUpstream,
} from '../helpers/nativeGateway';

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return {
        ...config,
        gateway: {
          ...config.gateway,
          retryEnabled: true,
          retryMaxAttempts: 3,
          retryInitialDelayMs: 1,
          circuitBreakerEnabled: false,
        },
      };
    },
  };
});
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
import { createStreamGate, evaluateGuardrail } from '@/lib/services/guardrail';

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
  settings: {},
  pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 },
  ...overrides,
});

const BASE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', modelKey: 'm' };
const ASK: GatewayChatRequest = { messages: [{ role: 'user', content: 'hello' }] };

const runtimes = new Map<string, ModelProviderRuntime>();
let anthropic: ModelProviderRuntime;
let bedrock: ModelProviderRuntime;
beforeAll(async () => {
  anthropic = await anthropicRuntime();
  bedrock = await bedrockRuntime();
});

/** A runtime per provider key; the key is the API key, so the upstream knows who is calling. */
const openAiPerKey = () => (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(
  async (_db: string, _t: string, providerKey: string) => {
    if (!runtimes.has(providerKey)) runtimes.set(providerKey, await openAiRuntime({}, providerKey));
    return { runtime: runtimes.get(providerKey) };
  },
);
const stubModel = (m: object) => (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(m);
const apiKeyOf = (call: { headers: Record<string, string> }) => call.headers.authorization?.replace('Bearer ', '');
const rows = () => (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);

async function collect(stream: AsyncGenerator<ModelStreamEvent, void, void>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
  (createStreamGate as ReturnType<typeof vi.fn>).mockReset();
  (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
    passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'g', guardrailName: 'g',
  });
  openAiPerKey();
});
afterEach(() => vi.unstubAllGlobals());

describe('stage order', () => {
  it('runs input guardrails, cache lookup, the provider, the usage row, output guardrails, then the cache store', async () => {
    const order: string[] = [];
    stubModel(model({
      guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }, { key: 'gr-out', hooks: ['output.pre'] }],
      semanticCache: { indexKey: 'idx', threshold: 0.9 },
    }));
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockImplementation(async ({ phase, guardrailKey }: { phase: string; guardrailKey: string }) => {
      order.push(`guardrail:${phase}`);
      return { passed: true, blocked: false, action: 'allow', findings: [], guardrailKey, guardrailName: guardrailKey };
    });
    (lookupCache as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('cache:lookup');
      return { hit: false, response: null };
    });
    (logModelUsage as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('usage-row'); });
    (storeInCache as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('cache:store'); });
    stubUpstream(() => {
      order.push('provider');
      return json(completion({ content: 'answer' }));
    });

    await executeModelCall({ ...BASE, request: ASK });
    await flush();

    expect(order).toEqual(['guardrail:input', 'cache:lookup', 'provider', 'usage-row', 'guardrail:output', 'cache:store']);
  });

  it('a Dynamic LLM routes BEFORE any guardrail of the child runs', async () => {
    const router = model({
      key: 'router', providerKey: 'dynamic', providerDriver: 'dynamic',
      settings: { dynamic: { strategy: 'rule-based', defaultModelKey: 'child' } },
    });
    const child = model({ key: 'child', providerKey: 'p-child', guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }] });
    (getModelByKey as ReturnType<typeof vi.fn>).mockImplementation(async (_db: string, key: string) =>
      key === 'router' ? router : key === 'child' ? child : null);
    stubUpstream(() => json(completion()));

    const outcome = await executeModelCall({ ...BASE, modelKey: 'router', request: ASK });

    expect(outcome.routing?.chosenModelKey).toBe('child');
    expect(evaluateGuardrail).toHaveBeenCalledWith(expect.objectContaining({ guardrailKey: 'gr-in', phase: 'input' }));
  });
});

describe('native events of a streamed call', () => {
  it('yields start, deltas, the terminal step, the usage frame and a done event holding the whole answer', async () => {
    stubModel(model());
    stubUpstream(() => sse([
      chunk.reasoning('thinking '),
      chunk.text('Hel'),
      chunk.text('lo'),
      chunk.tool(0, { id: 'c1', name: 'lookup', arguments: '{"q":' }),
      chunk.tool(0, { arguments: '"x"}' }),
      chunk.finish('tool_calls'),
      chunk.usage({ prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, completion_tokens_details: { reasoning_tokens: 2 } }),
    ]));

    const outcome = await executeModelCall({
      ...BASE,
      request: ASK,
      wire: { messages: [{ role: 'user', content: 'hello' }], stream_options: { include_usage: true } },
      stream: true,
    });
    const events = await collect(outcome.stream!);

    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'delta', 'delta', 'delta', 'delta', 'usage', 'done']);
    const done = events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>;
    expect(done.response).toMatchObject({
      content: 'Hello',
      toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }],
      reasoning: { summary: 'thinking ' },
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    });
    expect(done.usage).toMatchObject({ inputTokens: 10, outputTokens: 6, totalTokens: 16, reasoningTokens: 2, toolCalls: 1 });
    expect(done.wireFinishReason).toBe('tool_calls');
    // The provider reported usage, so nothing here is an estimate.
    expect(done.usageEstimated).toBeUndefined();
    // The terminal step carries the finish reason and nothing else.
    const terminal = events.filter((e) => e.type === 'delta').at(-1) as Extract<ModelStreamEvent, { type: 'delta' }>;
    expect(terminal.finishReason).toBe('tool_calls');
    expect(terminal.content).toBeUndefined();
  });

  it('keeps the signed reasoning blocks and the tool call of an Anthropic thinking turn, for the next request of an agent loop', async () => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    stubModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5', settings: { reasoning: { effort: 'low' }, maxTokens: 9000 } }));
    const upstream = stubUpstream(() => sse([
      { type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me check' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-123' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]));

    const first = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(first.stream!);
    const done = events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>;

    expect(done.response.reasoning?.blocks).toEqual([{ type: 'thinking', text: 'let me check', signature: 'SIG-123' }]);
    expect(done.response.toolCalls).toMatchObject([{ id: 'toolu_1', name: 'lookup', arguments: '{"q":"x"}' }]);
    expect(upstream.calls[0].body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });

    // The loop's next request replays the assistant turn with its signed block intact.
    stubUpstream(() => json({
      id: 'msg_2', model: 'claude', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 },
    }));
    const replayed = stubUpstream(() => json({
      id: 'msg_2', model: 'claude', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 },
    }));
    await executeModelCall({
      ...BASE,
      request: {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: '', toolCalls: done.response.toolCalls, reasoning: done.response.reasoning },
          { role: 'tool', content: 'result', toolCallId: 'toolu_1' },
        ],
      },
    });
    const assistant = replayed.calls[0].body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'thinking', thinking: 'let me check', signature: 'SIG-123' });
    expect(assistant.content.some((b: any) => b.type === 'tool_use' && b.id === 'toolu_1')).toBe(true);
  });

  it('never hides reasoning from a native caller, whatever the Model Hub switch says', async () => {
    stubModel(model({ settings: { returnReasoning: false } }));
    stubUpstream(() => sse([chunk.reasoning('private'), chunk.text('public'), chunk.finish('stop')]));
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);
    expect(events.some((e) => e.type === 'delta' && e.reasoning === 'private')).toBe(true);
    expect(outcome.includeReasoning).toBe(false);
  });

  it('completes a lone "{" tool argument so the agent loop can parse it', async () => {
    stubModel(model());
    stubUpstream(() => sse([chunk.tool(0, { id: 'c1', name: 'now', arguments: '{' }), chunk.finish('tool_calls')]));
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);
    const done = events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>;
    expect(done.response.toolCalls[0].arguments).toBe('{}');
  });
});

describe('cancellation', () => {
  it('aborts the upstream of a non-streamed call', async () => {
    stubModel(model());
    const upstream = stubUpstream((call) => new Promise<Response>((_, reject) => {
      call.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const controller = new AbortController();

    const pending = executeModelCall({ ...BASE, request: ASK, context: { signal: controller.signal } });
    await flush();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].signal?.aborted).toBe(true);
  });

  it('logs a streamed call whose signal aborts as cancelled, with the partial usage estimated, and settles it', async () => {
    stubModel(model());
    stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.text('a partial answer'));
      return live.response;
    });
    const controller = new AbortController();
    const onUsageSettled = vi.fn();

    const outcome = await executeModelCall({
      ...BASE,
      request: ASK,
      wire: { messages: [{ role: 'user', content: 'twelve chars' }] },
      stream: true,
      context: { signal: controller.signal, onUsageSettled },
    });
    const seen: string[] = [];
    for await (const event of outcome.stream!) {
      seen.push(event.type);
      if (event.type === 'delta') controller.abort();
    }
    await flush();

    expect(seen).toEqual(['start', 'delta', 'cancelled']);
    expect(rows().at(-1)).toMatchObject({ status: 'cancelled', route: 'chat.completions' });
    expect(rows().at(-1).usage.outputTokens).toBe(Math.ceil('a partial answer'.length / 4));
    // The prompt was billed too: the request we sent is estimated, not booked as free.
    expect(rows().at(-1).usage.inputTokens).toBe(Math.ceil('twelve chars'.length / 4));
    expect(rows().at(-1).providerResponse).toMatchObject({ output_tokens_estimated: true, usage_estimated: true });
    expect(onUsageSettled).toHaveBeenCalledTimes(1);
    expect(onUsageSettled.mock.calls[0][1]).toMatchObject({ inputTokens: Math.ceil('twelve chars'.length / 4) });
  });

  it('estimates the output of a cancelled stream from its tool-call arguments and reasoning too', async () => {
    stubModel(model());
    stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.reasoning('some thinking'));
      live.send(chunk.tool(0, { id: 'c1', name: 'lookup', arguments: '{"q":"abcdefgh"}' }));
      return live.response;
    });
    const controller = new AbortController();

    const outcome = await executeModelCall({
      ...BASE,
      request: ASK,
      wire: { messages: [{ role: 'user', content: 'hello' }] },
      stream: true,
      context: { signal: controller.signal },
    });
    let deltas = 0;
    for await (const event of outcome.stream!) {
      if (event.type === 'delta' && ++deltas === 2) controller.abort();
    }
    await flush();

    expect(rows().at(-1)).toMatchObject({ status: 'cancelled' });
    expect(rows().at(-1).usage.outputTokens).toBe(Math.ceil(('some thinking' + '{"q":"abcdefgh"}').length / 4));
  });

  it('settles a stream whose upstream never sent usage on an estimate and flags it, without a usage frame', async () => {
    stubModel(model());
    stubUpstream(() => sse([chunk.text('Hello there'), chunk.finish('stop')]));
    const onUsageSettled = vi.fn();

    const outcome = await executeModelCall({
      ...BASE,
      request: ASK,
      wire: { messages: [{ role: 'user', content: 'twelve chars' }], stream_options: { include_usage: true } },
      stream: true,
      context: { onUsageSettled },
    });
    const events = await collect(outcome.stream!);
    await flush();

    expect(events.some((e) => e.type === 'usage')).toBe(false);
    const done = events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>;
    expect(done.usageEstimated).toBe(true);
    expect(done.usage).toMatchObject({
      inputTokens: Math.ceil('twelve chars'.length / 4),
      outputTokens: Math.ceil('Hello there'.length / 4),
    });
    expect(done.nativeUsage).toBeUndefined();
    expect(rows().at(-1)).toMatchObject({
      status: 'success',
      providerResponse: expect.objectContaining({ usage_estimated: true }),
    });
    expect(onUsageSettled).toHaveBeenCalledTimes(1);
    expect(onUsageSettled.mock.calls[0][1]).toEqual(done.usage);
  });

  it('is cancelled before the provider is touched when the signal is already aborted', async () => {
    stubModel(model());
    const upstream = stubUpstream(() => json(completion()));
    const controller = new AbortController();
    controller.abort();
    await expect(executeModelCall({ ...BASE, request: ASK, context: { signal: controller.signal } }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe('caller attribution', () => {
  it('writes ONE usage row per call, on the caller\'s route and with the caller\'s attribution', async () => {
    stubModel(model());
    stubUpstream(() => json(completion()));

    await executeModelCall({
      ...BASE,
      request: ASK,
      context: { route: 'agent.chat', attribution: { userId: 'u1', apiTokenId: 't1' } },
    });
    await flush();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ route: 'agent.chat', attribution: { userId: 'u1', apiTokenId: 't1' }, status: 'success' });
  });

  it('stamps the caller\'s channel and run on the usage row, as known when the call settled', async () => {
    stubModel(model());
    stubUpstream(() => json(completion()));
    const run = { conversationId: 'conv-1', turnId: 'turn-1' };
    await executeModelCall({
      ...BASE,
      request: ASK,
      context: { route: 'agent.chat', callerContext: { channel: 'dashboard', agentKey: 'helper', run } },
    });
    await flush();
    run.turnId = 'turn-2'; // the snapshot on the row does not follow later changes
    expect(rows()[0]).toMatchObject({ agentKey: 'helper', channel: 'dashboard', run: { conversationId: 'conv-1', turnId: 'turn-1' } });
  });

  it('stamps the AMBIENT caller (an agent run\'s scope) when the call passes no explicit callerContext', async () => {
    stubModel(model());
    stubUpstream(() => json(completion()));
    const run = { conversationId: 'conv-9' };
    await runWithRoutingCaller({ channel: 'playground', agentKey: 'helper', run }, async () => {
      noteRoutingRun({ turnId: 'turn-9', traceSessionId: 'sess-9' });
      await executeModelCall({ ...BASE, request: ASK, context: { route: 'agent.chat' } });
    });
    await flush();
    expect(rows()[0]).toMatchObject({ agentKey: 'helper', channel: 'playground', run: { conversationId: 'conv-9', turnId: 'turn-9', traceSessionId: 'sess-9' } });
  });

  it('keeps the gateway\'s own route and no attribution key for an ordinary call', async () => {
    stubModel(model());
    stubUpstream(() => json(completion()));
    await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect(rows()[0].route).toBe('chat.completions');
    expect(rows()[0]).not.toHaveProperty('attribution');
  });

  it('names the caller\'s route on the stream and its guardrail evaluations too', async () => {
    stubModel(model({ outputGuardrailKey: 'gr' }));
    (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      push: vi.fn(async (frame: unknown) => ({ emit: [frame], blocked: false })),
      end: vi.fn(async () => ({ emit: [], blocked: false })),
    }));
    stubUpstream(() => sse([chunk.text('hi'), chunk.finish('stop')]));

    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true, context: { route: 'agent.subagent' } });
    await collect(outcome.stream!);
    await flush();

    expect(rows().at(-1).route).toBe('agent.subagent');
    expect(createStreamGate).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ source: 'agent.subagent:stream' }),
    }));
    expect(evaluateGuardrail).toHaveBeenCalledWith(expect.objectContaining({ source: 'agent.subagent:stream', phase: 'output' }));
  });
});

describe('input guardrails once per turn', () => {
  // The verdict memory is module-level (it has to outlive one call), so every test names its own turns.
  let runs = 0;
  let key = 'run-0';
  beforeEach(() => { runs += 1; key = `run-${runs}`; });
  const turn = (extra: object = {}) => ({
    ...BASE,
    request: { messages: [{ role: 'user' as const, content: 'my email is a@b.com' }] },
    context: { guardrailTurnKey: key, ...extra },
  });

  it('evaluates the latest user message once for a turn, however many model calls the turn makes', async () => {
    stubModel(model({ guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }] }));
    stubUpstream(() => json(completion()));

    await executeModelCall(turn());
    await executeModelCall(turn());
    await executeModelCall(turn());

    expect(evaluateGuardrail).toHaveBeenCalledTimes(1);
  });

  it('re-applies the redaction to the later calls of the turn, whose history still carries the original text', async () => {
    stubModel(model({ guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }] }));
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: true, blocked: false, action: 'redact', guardrailKey: 'gr-in', guardrailName: 'gr-in',
      findings: [{ type: 'pii' }], redactedText: 'my email is [EMAIL]',
    });
    const upstream = stubUpstream(() => json(completion()));

    await executeModelCall(turn());
    await executeModelCall(turn());

    expect(upstream.calls.map((c) => c.body.messages[0].content)).toEqual(['my email is [EMAIL]', 'my email is [EMAIL]']);
    expect(evaluateGuardrail).toHaveBeenCalledTimes(1);
  });

  it('evaluates again for a new turn, a new message, or a caller that names no turn', async () => {
    stubModel(model({ guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }] }));
    stubUpstream(() => json(completion()));

    await executeModelCall(turn());
    await executeModelCall({ ...turn(), context: { guardrailTurnKey: `${key}-next` } });
    await executeModelCall({ ...turn(), request: { messages: [{ role: 'user', content: 'something else' }] } });
    await executeModelCall({ ...BASE, request: ASK });
    await executeModelCall({ ...BASE, request: ASK });

    expect(evaluateGuardrail).toHaveBeenCalledTimes(5);
  });

  it('a blocked turn is not remembered as passed', async () => {
    stubModel(model({ guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }] }));
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false, blocked: true, action: 'block', guardrailKey: 'gr-in', guardrailName: 'Strict', findings: [{ block: true, message: 'no' }],
    });
    stubUpstream(() => json(completion()));

    await expect(executeModelCall(turn())).rejects.toThrow('Input blocked');
    await expect(executeModelCall(turn())).rejects.toThrow('Input blocked');
    expect(evaluateGuardrail).toHaveBeenCalledTimes(2);
  });
});

describe('routing depth', () => {
  it('refuses a call that is already as deep as a Dynamic LLM chain may go', async () => {
    const router = model({ key: 'router', providerKey: 'dynamic', providerDriver: 'dynamic', settings: { dynamic: { strategy: 'rule-based', defaultModelKey: 'child' } } });
    stubModel(router);
    stubUpstream(() => json(completion()));
    await expect(executeModelCall({ ...BASE, modelKey: 'router', request: ASK, context: { routingDepth: 10 } }))
      .rejects.toThrow(/Dynamic routing depth exceeded/);
  });
});

describe('replica failover', () => {
  const pooled = (extra: object = {}) => model({
    providerKey: 'a',
    replicas: [{ providerKey: 'a', modelId: 'gpt-4o', weight: 1000 }, { providerKey: 'b', modelId: 'gpt-4o', weight: 1 }],
    ...extra,
  });
  const originalRandom = Math.random;
  beforeEach(() => { Math.random = () => 0; });
  afterEach(() => { Math.random = originalRandom; });

  it('moves a non-streamed call to the next replica when the first is down, and never reveals which served it', async () => {
    stubModel(pooled());
    const upstream = stubUpstream((call) => apiKeyOf(call) === 'a'
      ? json({ error: { message: 'overloaded' } }, 503)
      : json(completion({ content: 'from b' })));

    const outcome = await executeModelCall({ ...BASE, request: ASK });
    await flush();

    expect(outcome.result?.response.content).toBe('from b');
    expect(outcome.wire).toMatchObject({ model: 'gpt-4o' });
    expect(new Set(upstream.calls.map(apiKeyOf))).toEqual(new Set(['a', 'b']));
    expect(rows()[0].providerRequest.replica).toMatchObject({ providerKey: 'b', failedOver: ['a:gpt-4o'] });
  });

  it('fails over a stream only BEFORE the first byte', async () => {
    stubModel(pooled());
    stubUpstream((call) => apiKeyOf(call) === 'a'
      ? json({ error: { message: 'bad gateway' } }, 502)
      : sse([chunk.text('b is up'), chunk.finish('stop')]));

    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);

    expect((events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>).response.content).toBe('b is up');
  });

  it('does not splice two completions: a stream that dies after its first byte stays failed', async () => {
    stubModel(pooled());
    const upstream = stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.text('half an answ'));
      setTimeout(() => live.fail(new Error('connection reset')), 5);
      return live.response;
    });

    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);

    expect(events.at(-1)?.type).toBe('failed');
    expect(new Set(upstream.calls.map(apiKeyOf))).toEqual(new Set(['a']));
  });

  it('does not travel with the caller\'s own mistakes', async () => {
    stubModel(pooled());
    const upstream = stubUpstream(() => json({ error: { message: 'bad request', type: 'invalid_request_error' } }, 400));
    await expect(executeModelCall({ ...BASE, request: ASK })).rejects.toMatchObject({ statusCode: 400 });
    expect(upstream.calls).toHaveLength(1);
  });

  it('resolves the request rules for each replica\'s own model id', async () => {
    stubModel(model({
      providerKey: 'a',
      settings: { temperature: 0.5 },
      replicas: [{ providerKey: 'a', modelId: 'gpt-4o', weight: 1000 }, { providerKey: 'b', modelId: 'o3-mini', weight: 1 }],
    }));
    const upstream = stubUpstream((call) => apiKeyOf(call) === 'a'
      ? json({ error: { message: 'down' } }, 503)
      : json(completion()));
    await executeModelCall({ ...BASE, request: ASK });
    const first = upstream.calls.find((c) => apiKeyOf(c) === 'a')!;
    const second = upstream.calls.find((c) => apiKeyOf(c) === 'b')!;
    expect(first.body).toMatchObject({ model: 'gpt-4o', temperature: 0.5 });
    // The reasoning model rejects sampling; the rule is per replica, not per request.
    expect(second.body.model).toBe('o3-mini');
    expect(second.body.temperature).toBeUndefined();
  });
});

describe('retry layering', () => {
  it('lets the gateway\'s resilience own the retries: a 500 costs exactly its attempts, not attempts x SDK retries', async () => {
    stubModel(model());
    const upstream = stubUpstream(() => json({ error: { message: 'boom' } }, 500));
    await expect(executeModelCall({ ...BASE, request: ASK })).rejects.toMatchObject({ statusCode: 500 });
    expect(upstream.calls).toHaveLength(3);
  });

  it('does not retry a 400 at all', async () => {
    stubModel(model());
    const upstream = stubUpstream(() => json({ error: { message: 'bad', type: 'invalid_request_error' } }, 400));
    await expect(executeModelCall({ ...BASE, request: ASK })).rejects.toBeDefined();
    expect(upstream.calls).toHaveLength(1);
  });

  it('retries the opening of a stream too, and the retry gets a fresh request', async () => {
    stubModel(model());
    const upstream = stubUpstream((_call, index) => index === 0
      ? json({ error: { message: 'blip' } }, 503)
      : sse([chunk.text('ok'), chunk.finish('stop')]));
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);
    expect(events.at(-1)?.type).toBe('done');
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[1].signal?.aborted).toBe(false);
  });

  it('explains the error of a failed provider call with the status the upstream gave', async () => {
    stubModel(model());
    stubUpstream(() => json({ error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, 429));
    await expect(handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }] } }))
      .rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('the request rules of the Model Hub record reach the upstream, whoever calls', () => {
  it('requestDefaults are sent; the reserved keys among them are not', async () => {
    stubModel(model({ settings: { requestDefaults: { top_k: 40, model: 'evil', stream: true, messages: [], api_key: 'x' } } }));
    const upstream = stubUpstream(() => json(completion()));
    await executeModelCall({ ...BASE, request: ASK });
    expect(upstream.calls[0].body).toMatchObject({ top_k: 40, model: 'gpt-4o', stream: false, messages: [{ role: 'user', content: 'hello' }] });
    expect(upstream.calls[0].body).not.toHaveProperty('api_key');
  });

  it('a caller\'s unknown fields pass through only when the model allows it, and never override the reserved ones', async () => {
    const wire = { messages: [{ role: 'user', content: 'hello' }], chat_template_kwargs: { enable_thinking: false }, model: 'evil' };
    stubModel(model({ settings: {} }));
    const closed = stubUpstream(() => json(completion()));
    await executeModelCall({ ...BASE, request: ASK, wire });
    expect(closed.calls[0].body).not.toHaveProperty('chat_template_kwargs');

    stubModel(model({ settings: { allowUnknownPassthrough: true } }));
    const open = stubUpstream(() => json(completion()));
    await executeModelCall({ ...BASE, request: ASK, wire });
    expect(open.calls[0].body).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, model: 'gpt-4o' });
  });

  it('strips the parameters the model declares unsupported, from the request as well as from the record', async () => {
    stubModel(model({ settings: { temperature: 0.4, unsupportedParams: ['temperature', 'top_p', 'presence_penalty'] } }));
    const upstream = stubUpstream(() => json(completion()));
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }], temperature: 0.9, top_p: 0.5, presence_penalty: 0.2, frequency_penalty: 0.1 } });
    expect(upstream.calls[0].body.temperature).toBeUndefined();
    expect(upstream.calls[0].body.top_p).toBeUndefined();
    expect(upstream.calls[0].body.presence_penalty).toBeUndefined();
    expect(upstream.calls[0].body.frequency_penalty).toBe(0.1);
  });

  it('forces reasoning_effort none next to function tools on GPT-5, and sends the effort otherwise', async () => {
    stubModel(model({ modelId: 'gpt-5.2', settings: { reasoning: { effort: 'high' }, maxTokens: 400 } }));
    const upstream = stubUpstream(() => json(completion()));
    const tool = { name: 'lookup', description: 'd', parameters: { type: 'object' } };
    await executeModelCall({ ...BASE, request: ASK });
    await executeModelCall({ ...BASE, request: { ...ASK, tools: [tool] } });
    expect(upstream.calls.map((c) => c.body.reasoning_effort)).toEqual(['high', 'none']);
    // Reasoning tokens count against the limit: the model's small 400 is raised to the table value of effort high.
    expect(upstream.calls[0].body.max_completion_tokens).toBe(32768);
  });

  it('renames the token budget when the model declares max_tokens unsupported', async () => {
    stubModel(model({ modelId: 'vanity-model', settings: { unsupportedParams: ['max_tokens'] } }));
    const upstream = stubUpstream(() => json(completion()));
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }], max_tokens: 77 } });
    expect(upstream.calls[0].body.max_completion_tokens).toBe(77);
    expect(upstream.calls[0].body.max_tokens).toBeUndefined();
  });

  it('opts out of stream_options when the model declares them unsupported', async () => {
    stubModel(model({ settings: { unsupportedParams: ['stream_options'] } }));
    const upstream = stubUpstream(() => sse([chunk.text('x'), chunk.finish('stop')]));
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    await collect(outcome.stream!);
    expect(upstream.calls[0].body.stream).toBe(true);
    expect(upstream.calls[0].body).not.toHaveProperty('stream_options');
  });

  it('sends the usage option by default on a stream, so the usage row carries real counts', async () => {
    stubModel(model());
    const upstream = stubUpstream(() => sse([chunk.text('x'), chunk.finish('stop')]));
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    await collect(outcome.stream!);
    expect(upstream.calls[0].body.stream_options).toEqual({ include_usage: true });
  });

  it('applies the same rules to a Bedrock Converse model: additionalModelRequestFields carries the extra body', async () => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: bedrock });
    stubModel(model({ providerDriver: 'bedrock', modelId: 'amazon.nova-pro-v1:0', settings: { requestDefaults: { topK: 20 }, maxTokens: 300 } }));
    const upstream = stubUpstream(() => json({
      output: { message: { role: 'assistant', content: [{ text: 'hi from nova' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    }));
    const outcome = await executeModelCall({ ...BASE, request: ASK });
    expect(upstream.calls[0].body.additionalModelRequestFields).toEqual({ topK: 20 });
    expect(upstream.calls[0].body.inferenceConfig).toMatchObject({ maxTokens: 300 });
    expect(outcome.result?.response.content).toBe('hi from nova');
  });
});

describe('finish_reason on the wire, per driver', () => {
  const bedrockAnswer = (stopReason: string, content: unknown[]) => json({
    output: { message: { role: 'assistant', content } },
    stopReason,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  });

  it.each([
    ['end_turn', [{ text: 'ok' }], 'stop'],
    ['max_tokens', [{ text: 'cut' }], 'length'],
    ['tool_use', [{ toolUse: { toolUseId: 't1', name: 'lookup', input: { q: 1 } } }], 'tool_calls'],
    ['guardrail_intervened', [{ text: 'blocked' }], 'content_filter'],
  ])('Bedrock %s is %s', async (stopReason, content, wire) => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: bedrock });
    stubModel(model({ providerDriver: 'bedrock', modelId: 'amazon.nova-pro-v1:0' }));
    stubUpstream(() => bedrockAnswer(stopReason, content));
    const outcome = await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect((outcome.wire as any).choices[0].finish_reason).toBe(wire);
    // The usage row carries the normalized reason, not the provider's own word.
    expect(rows()[0].finishReason).toBe(wire);
  });

  it('Anthropic\'s non-streamed turn: end_turn is stop, tool_use is tool_calls, and the row is normalized', async () => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    stubModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' }));
    stubUpstream(() => json({
      id: 'm', model: 'c', type: 'message', role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 1 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 100 },
    }));
    const outcome = await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect((outcome.wire as any).choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: { tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
    });
    expect(rows()[0].finishReason).toBe('tool_calls');
    expect(outcome.usage).toMatchObject({ inputTokens: 120, cachedInputTokens: 100, outputTokens: 5, totalTokens: 125, toolCalls: 1 });
  });
});

describe('a native request, as an agent makes it', () => {
  it('stamps the agent key onto the usage row so the rollup can bucket by agent', async () => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    stubModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' }));
    stubUpstream(() => json({
      id: 'm', model: 'c', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
    }));
    await executeModelCall({
      ...BASE, request: ASK,
      context: { route: 'agent.chat', callerContext: { agentKey: 'triage' }, requestTags: { agentKey: 'triage', sessionId: 's1' } },
    });
    await flush();
    expect(rows()[0]).toMatchObject({ agentKey: 'triage', finishReason: 'stop' });
  });

  it('carries messages with images, tools, tool choice and a response format to the upstream', async () => {
    stubModel(model());
    const upstream = stubUpstream(() => json(completion({ content: '{"a":1}' })));
    await executeModelCall({
      ...BASE,
      request: {
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }] },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{}' }] },
          { role: 'tool', content: 'r', toolCallId: 'c1' },
        ],
        tools: [{ name: 'lookup', description: 'find', parameters: { type: 'object' }, strict: true }],
        toolChoice: 'required',
        responseFormat: { type: 'json_schema', name: 'answer', schema: { type: 'object' } },
        temperature: 0.1,
        maxTokens: 50,
        stop: ['END'],
        parallelToolCalls: false,
      },
    });
    const body = upstream.calls[0].body;
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
    ]);
    expect(body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'lookup', strict: true } }],
      tool_choice: 'required',
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
      temperature: 0.1,
      max_tokens: 50,
      stop: ['END'],
      parallel_tool_calls: false,
    });
  });

  it('keeps an image detail hint and drops an unknown content part only for providers that cannot read it', async () => {
    stubModel(model());
    const upstream = stubUpstream(() => json(completion()));
    const future = { type: 'input_video', input_video: { url: 'https://x/y.mp4' } };
    const wireMessages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'https://cdn/x.png', detail: 'high' } },
        future,
      ],
    }];
    await handleChatCompletion({ ...BASE, body: { messages: wireMessages } });
    expect(upstream.calls[0].body.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'https://cdn/x.png', detail: 'high' } },
      future,
    ]);

    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    stubModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' }));
    const claude = stubUpstream(() => json({
      id: 'm', model: 'c', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
    await handleChatCompletion({ ...BASE, body: { messages: wireMessages } });
    expect(JSON.stringify(claude.calls[0].body.messages)).not.toContain('input_video');
    expect(claude.calls[0].body.messages[0].content[0]).toMatchObject({ type: 'image' });
  });

  it('answers a semantic cache hit natively too', async () => {
    stubModel(model({ semanticCache: { indexKey: 'i', threshold: 0.9 } }));
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: true,
      response: completion({ content: 'cached answer', reasoning: 'why' }),
    });
    const outcome = await executeModelCall({ ...BASE, request: ASK });
    expect(outcome.cacheHit).toBe(true);
    expect(outcome.result?.response).toMatchObject({ content: 'cached answer', reasoning: { summary: 'why' } });
  });
});

describe('the stream gate and tool calls', () => {
  it('hands tool-call fragments through the gate with their framing intact, and writes parallel calls back apart', async () => {
    stubModel(model({ outputGuardrailKey: 'gr' }));
    const gate = {
      push: vi.fn(async (frame: unknown) => ({ emit: [frame], blocked: false })),
      end: vi.fn(async () => ({ emit: [], blocked: false })),
    };
    (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => gate);
    stubUpstream(() => sse([
      chunk.tool(0, { id: 'a', name: 'one', arguments: '' }),
      chunk.tool(1, { id: 'b', name: 'two', arguments: '' }),
      chunk.tool(0, { arguments: '{"x":1}' }),
      chunk.tool(1, { arguments: '{"y":2}' }),
      chunk.finish('tool_calls'),
    ]));

    const result = await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }] }, stream: true });
    const { readSse } = await import('../helpers/nativeGateway');
    const { frames } = await readSse(result.stream!);
    const calls = frames.filter((f: any) => f !== '[DONE]').flatMap((f: any) => f.choices?.[0]?.delta?.tool_calls ?? []);

    expect(calls).toEqual([
      { index: 0, id: 'a', type: 'function', function: { name: 'one', arguments: '' } },
      { index: 1, id: 'b', type: 'function', function: { name: 'two', arguments: '' } },
      { index: 0, function: { arguments: '{"x":1}' } },
      { index: 1, function: { arguments: '{"y":2}' } },
    ]);
    // The terminal frame goes through the gate too (it flushes what the gate holds back first).
    expect(gate.push.mock.calls.at(-1)?.[0]).toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] });
    expect((frames as any[]).filter((f) => f !== '[DONE]').at(-1).choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('a streamed Dynamic LLM', () => {
  it('serves the child\'s stream, tells the caller which model answered only through routing, and logs one row per model', async () => {
    const router = model({
      key: 'router', providerKey: 'dynamic', providerDriver: 'dynamic', modelId: 'router-id',
      settings: { dynamic: { strategy: 'rule-based', defaultModelKey: 'child' } },
    });
    const child = model({ key: 'child', providerKey: 'p-child', modelId: 'child-model' });
    (getModelByKey as ReturnType<typeof vi.fn>).mockImplementation(async (_db: string, key: string) =>
      key === 'router' ? router : key === 'child' ? child : null);
    stubUpstream(() => sse([chunk.text('routed'), chunk.finish('stop'), chunk.usage()]));

    const result = await handleChatCompletion({
      ...BASE, modelKey: 'router', body: { messages: [{ role: 'user', content: 'x' }] }, stream: true,
    });
    const { readSse } = await import('../helpers/nativeGateway');
    const { frames } = await readSse(result.stream!);
    await flush();

    expect(result.routing).toMatchObject({ role: 'router', chosenModelKey: 'child' });
    expect((frames[0] as any).model).toBe('child-model');
    expect(rows().map((row) => row.route).sort()).toEqual(['chat.completions', 'chat.completions.router']);
    expect(rows().find((row) => row.route === 'chat.completions')).toMatchObject({ routing: { role: 'child' }, status: 'success' });
  });
});

describe('the Messages edge on top of the core', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  it('translates a streamed OpenAI-schema answer with a tool call into balanced Messages events', async () => {
    const { anthropicRequestToOpenAi, openAiStreamToAnthropic } = await import('@/lib/services/models/anthropicWire');
    stubModel(model());
    stubUpstream(() => sse([
      chunk.text('Let me check. '),
      chunk.tool(0, { id: 'call_1', name: 'lookup', arguments: '{"q":' }),
      chunk.tool(0, { arguments: '"x"}' }),
      chunk.finish('tool_calls'),
      chunk.usage({ prompt_tokens: 30, completion_tokens: 8, total_tokens: 38, prompt_tokens_details: { cached_tokens: 10 } }),
    ]));
    const body = anthropicRequestToOpenAi({
      model: 'm', max_tokens: 100, stream: true, messages,
      tools: [{ name: 'lookup', description: 'find', input_schema: { type: 'object' } }],
    } as never);

    const result = await handleChatCompletion({ ...BASE, body: body as never, stream: true });
    const text = await new Response(openAiStreamToAnthropic(result.stream!, 'm')).text();
    const events = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ]);
    expect(events[4].content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'lookup' });
    expect(events.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('')).toBe('{"q":"x"}');
    expect(events.at(-2).delta.stop_reason).toBe('tool_use');
    expect(events.at(-2).usage).toMatchObject({ output_tokens: 8 });
  });

  it('translates a non-streamed answer, with the stop reason of the upstream\'s own vocabulary', async () => {
    const { anthropicRequestToOpenAi, openAiResponseToAnthropic } = await import('@/lib/services/models/anthropicWire');
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    stubModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' }));
    stubUpstream(() => json({
      id: 'm', model: 'c', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'cut off' }],
      stop_reason: 'max_tokens', usage: { input_tokens: 7, output_tokens: 3 },
    }));
    const body = anthropicRequestToOpenAi({ model: 'm', max_tokens: 3, messages } as never);

    const result = await handleChatCompletion({ ...BASE, body: body as never });
    const message = openAiResponseToAnthropic(result.response as never, 'm') as any;

    expect(message.stop_reason).toBe('max_tokens');
    expect(message.content).toEqual([{ type: 'text', text: 'cut off' }]);
    expect(message.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
  });
});
