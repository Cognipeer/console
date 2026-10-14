/**
 * An agent's model is the gateway (gatewayChatModel.ts): every rule configured on the
 * Model Hub record applies to an agent call, and the agent adds its attribution, its
 * spend settlement, its abort and its reasoning pick on top. The REAL provider
 * contracts, gateway core and agent-sdk run (a real agent loop where a loop matters);
 * only the network and the I/O services are scripted.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicRuntime, chunk, completion, controlledStream, flush, json, openAiRuntime, sse, stubUpstream,
  type Upstream,
} from '../helpers/nativeGateway';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return { ...config, gateway: { ...config.gateway, retryEnabled: true, retryMaxAttempts: 2, retryInitialDelayMs: 1, circuitBreakerEnabled: false } };
    },
  };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('v'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: vi.fn().mockResolvedValue(undefined),
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
  evaluateGuardrail: vi.fn(),
  createStreamGate: vi.fn(),
}));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { runWithRoutingCaller } from '@/lib/services/models/routingCallerContext';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { createStreamGate, evaluateGuardrail } from '@/lib/services/guardrail';
import { isSemanticCacheEnabled, lookupCache, storeInCache } from '@/lib/services/models/semanticCacheService';
import { buildGatewayChatModel, type GatewayChatModelInput } from '@/lib/services/agents/gatewayChatModel';
import { createRunUsageSink, runWithUsageSink } from '@/lib/services/agents/runUsage';

const llm = (key: string, extra: object = {}) => ({
  _id: `${key}-id`, tenantId: 't', projectId: 'p', name: key, key, providerKey: `prov-${key}`, providerDriver: 'openai',
  category: 'llm' as const, modelId: key, settings: {}, pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 }, ...extra,
});
const models: Record<string, any> = {};
const useModels = (...list: Array<ReturnType<typeof llm>>) => {
  for (const key of Object.keys(models)) delete models[key];
  for (const m of list) models[m.key] = m;
};

const runtimes = new Map<string, ModelProviderRuntime>();
let anthropic: ModelProviderRuntime;
beforeAll(async () => {
  anthropic = await anthropicRuntime();
  // A guardrail block is reported through agentService's error class, loaded on first use: warm it up
  // here so no single test pays for the load.
  await import('@/lib/services/agents/agentService');
}, 60_000);
/** The provider key is the API key, so the upstream knows which model it is serving. */
const useRuntimes = () => (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(
  async (_db: string, _t: string, providerKey: string) => {
    if (providerKey === 'prov-claude') return { runtime: anthropic };
    if (!runtimes.has(providerKey)) runtimes.set(providerKey, await openAiRuntime({}, providerKey));
    return { runtime: runtimes.get(providerKey) };
  },
);
const servedBy = (call: { headers: Record<string, string> }) => call.headers.authorization.replace('Bearer ', '');
const rows = () => (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);

const GUARD_PASS = { passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'gr-in', guardrailName: 'gr-in' };
const USER = [{ role: 'user', content: 'hi' }];

const build = (key: string, extra: Partial<GatewayChatModelInput> = {}) =>
  buildGatewayChatModel({ tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', model: models[key], ...extra });

async function lookupTool(run: (args: { q: string }) => string = (args) => `found ${args.q}`) {
  const { createTool } = await import('@cognipeer/agent-sdk');
  const { z } = await import('zod');
  return createTool({ name: 'lookup', description: 'Find a thing', schema: z.object({ q: z.string() }), func: async (args: { q: string }) => run(args) });
}

async function runAgent(model: unknown, config: { stream?: boolean; signal?: AbortSignal } = {}) {
  const { createSmartAgent } = await import('@cognipeer/agent-sdk');
  const agent = createSmartAgent({ model, tools: [await lookupTool()], systemPrompt: 'Be brief.' } as never);
  return agent.invoke(
    { messages: [{ role: 'user', content: 'find apples' }] } as never,
    (config.stream ? { stream: true, onStream: () => undefined, ...(config.signal ? { signal: config.signal } : {}) } : (config.signal ? { signal: config.signal } : undefined)) as never,
  ) as Promise<{ content?: string; messages: Array<Record<string, any>> }>;
}

/** An OpenAI tool-calling turn followed by a final answer. */
const toolThenAnswer = (usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }) => (call: any, index: number) => json(index === 0
  ? completion({ content: null, toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"apples"}' }], usage })
  : completion({ content: `answered by ${servedBy(call)}`, usage }));

let upstream: Upstream;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (getModelByKey as ReturnType<typeof vi.fn>).mockImplementation(async (_db: string, key: string) => models[key] ?? null);
  (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(GUARD_PASS);
  (createStreamGate as ReturnType<typeof vi.fn>).mockReset();
  useModels(llm('m'));
  useRuntimes();
  upstream = stubUpstream(toolThenAnswer());
});
afterEach(() => vi.unstubAllGlobals());

describe('attribution and usage', () => {
  it('a real agent loop writes ONE usage row per model call, on the agent route, attributed to the agent and the user, without the prompt', async () => {
    const result = await runAgent(await build('m', {
      route: 'agent.chat', agentKey: 'support-bot', sessionId: 'sess-1', userId: 'user-7',
    }));
    await flush();

    expect(result.content).toBe('answered by prov-m');
    expect(upstream.calls).toHaveLength(2);
    expect(rows()).toHaveLength(2);
    for (const row of rows()) {
      expect(row).toMatchObject({
        route: 'agent.chat',
        status: 'success',
        attribution: { userId: 'user-7' },
        providerRequest: { agentKey: 'support-bot', sessionId: 'sess-1' },
        usage: { inputTokens: 100, outputTokens: 10 },
      });
      // The context of an agent step is the whole conversation; the trace holds it, the row only its size.
      expect(row.providerRequest).not.toHaveProperty('messages.0');
      expect(row.providerRequest.messages).toMatchObject({ count: expect.any(Number) });
    }
  });

  it('a title or model check names its purpose on the row', async () => {
    const model = await build('m', { route: 'agent.title', purpose: 'title', agentKey: 'a1' });
    await model.invoke(USER);
    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ route: 'agent.title', providerRequest: { purpose: 'title', agentKey: 'a1' } });
  });

  it('settles every request once through onCost (the model\'s own price) and feeds the run\'s token tally', async () => {
    const onCost = vi.fn();
    const sink = createRunUsageSink();
    await runWithUsageSink(sink, async () => runAgent(await build('m', { onCost })));
    expect(onCost).toHaveBeenCalledTimes(2);
    // 100 in x $10/M + 10 out x $30/M per request
    expect(onCost.mock.calls[0][0].totalCost).toBeCloseTo(0.0013, 6);
    expect(sink.totalTokens).toBe(220);
  });

  it('a call that fails adds nothing to the run (the provider spent nothing); a stream stopped midway counts what it generated', async () => {
    upstream = stubUpstream(() => json({ error: { message: 'bad request', type: 'invalid_request_error' } }, 400));
    const failed = createRunUsageSink();
    await runWithUsageSink(failed, async () => { await (await build('m')).invoke(USER).catch(() => undefined); });
    expect(failed.totalTokens).toBe(0);

    upstream = stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.text('a partial answer'));
      return live.response;
    });
    const stopped = createRunUsageSink();
    const controller = new AbortController();
    await runWithUsageSink(stopped, async () => {
      for await (const part of (await build('m')).stream!(USER, { signal: controller.signal })) {
        if (typeof part === 'string') controller.abort();
      }
    });
    expect(stopped.totalTokens).toBe(Math.ceil('a partial answer'.length / 4));
  });

  it('a failing call is an error row, and nothing is settled for it', async () => {
    upstream = stubUpstream(() => json({ error: { message: 'bad request', type: 'invalid_request_error' } }, 400));
    const onCost = vi.fn();
    const model = await build('m', { route: 'agent.chat', agentKey: 'a1', onCost });
    await expect(model.invoke(USER)).rejects.toBeDefined();
    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'error', route: 'agent.chat', providerRequest: { agentKey: 'a1' } });
    expect(onCost).not.toHaveBeenCalled();
  });
});

describe('abort', () => {
  it('a stop during a streamed answer ends the upstream request and logs the call as cancelled, with the partial usage estimated and settled', async () => {
    upstream = stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.text('a partial answer'));
      return live.response;
    });
    const onCost = vi.fn();
    const controller = new AbortController();
    const model = await build('m', { route: 'agent.chat', agentKey: 'a1', onCost });

    const seen: unknown[] = [];
    const run = (async () => {
      for await (const part of model.stream!(USER, { signal: controller.signal })) {
        seen.push(part);
        if (typeof part === 'string') controller.abort();
      }
    })();
    await run;
    await flush();

    expect(upstream.calls[0].signal?.aborted).toBe(true);
    expect(seen.filter((part) => typeof part === 'object')).toHaveLength(0);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'cancelled', route: 'agent.chat', providerRequest: { agentKey: 'a1' } });
    expect(rows()[0].usage.outputTokens).toBe(Math.ceil('a partial answer'.length / 4));
    expect(onCost).toHaveBeenCalledTimes(1);
  });

  it('a stop before the answer arrives (non-streamed) rejects as an abort and is logged cancelled, not as a fault', async () => {
    upstream = stubUpstream((call) => new Promise<Response>((_, reject) => {
      call.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }) as never);
    const controller = new AbortController();
    const model = await build('m', { route: 'agent.chat' });
    const pending = model.invoke(USER, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'cancelled', route: 'agent.chat' });
  });
});

describe('agent stream edge cases', () => {
  it('mints a tool-call id when the upstream sends none, and keeps it across fragments', async () => {
    upstream = stubUpstream(() => sse([
      chunk.tool(0, { name: 'lookup', arguments: '{"q":' }),
      chunk.tool(0, { arguments: '"x"}' }),
      chunk.finish('tool_calls'),
    ]));
    const parts: any[] = [];
    for await (const part of (await build('m')).stream!(USER)) parts.push(part);
    const final = parts.find((part) => typeof part === 'object' && part.role);
    expect(final.tool_calls).toHaveLength(1);
    expect(final.tool_calls[0].id).toMatch(/^call_0_/);
    expect(final.tool_calls[0].function).toMatchObject({ name: 'lookup', arguments: '{"q":"x"}' });
  });

  it('a consumer that stops reading without a signal still aborts the upstream, books a cancelled row and settles usage', async () => {
    let upstreamSignal: AbortSignal | undefined;
    upstream = stubUpstream((call) => {
      upstreamSignal = call.signal ?? undefined;
      const live = controlledStream(call.signal);
      live.send(chunk.text('a partial answer'));
      return live.response;
    });
    const sink = createRunUsageSink();
    await runWithUsageSink(sink, async () => {
      for await (const part of (await build('m')).stream!(USER)) {
        if (typeof part === 'string') break;
      }
    });
    await flush();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(rows().at(-1)).toMatchObject({ status: 'cancelled' });
    expect(sink.totalTokens).toBeGreaterThan(0);
  });

  it('a stream cut by an output guardrail still settles the partial usage', async () => {
    useModels(llm('m', { outputGuardrailKey: 'gr' }));
    (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      push: vi.fn(async () => ({ emit: [], blocked: true, verdict: { guardrailKey: 'gr', message: { body: 'no', reasonClass: 'secret' } } })),
      end: vi.fn(async () => ({ emit: [], blocked: false })),
    }));
    upstream = stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.text('a secret'));
      return live.response;
    });
    const sink = createRunUsageSink();
    await runWithUsageSink(sink, async () => {
      const drain = async () => { for await (const part of (await build('m')).stream!(USER)) void part; };
      await expect(drain()).rejects.toMatchObject({ name: 'AgentGuardrailBlockedError' });
    });
    await flush();
    expect(sink.totalTokens).toBeGreaterThan(0);
  });
});

describe('a model with a semantic cache, called by an agent', () => {
  it('is not served from the cache: the tool loop makes its upstream calls and runs its tool once', async () => {
    // A cache that would answer step 2 with step 1's stored tool call (same last user text).
    useModels(llm('m', { semanticCache: { indexKey: 'i', threshold: 0.9 } }));
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: true,
      response: completion({ content: null, toolCalls: [{ id: 'stale', name: 'lookup', arguments: '{"q":"apples"}' }] }),
    });
    const ran: string[] = [];
    const { createSmartAgent } = await import('@cognipeer/agent-sdk');
    const agent = createSmartAgent({
      model: await build('m', { route: 'agent.chat', agentKey: 'a1' }),
      tools: [await lookupTool((args) => { ran.push(args.q); return `found ${args.q}`; })],
      systemPrompt: 'Be brief.',
    } as never);
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'find apples' }] } as never) as { content?: string };

    expect(result.content).toBe('answered by prov-m');
    expect(upstream.calls).toHaveLength(2);
    expect(ran).toEqual(['apples']);
    expect(lookupCache).not.toHaveBeenCalled();
    expect(storeInCache).not.toHaveBeenCalled();
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
  });
});

describe('model-level guardrails on an agent turn', () => {
  const guarded = (extra: object = {}) => llm('m', { guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }], ...extra });

  it('an input guardrail bound to the MODEL blocks an agent turn before the provider is called, as the 400 guardrail_block the agent endpoints know', async () => {
    useModels(guarded());
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false, blocked: true, action: 'block', guardrailKey: 'gr-in', guardrailName: 'Strict', findings: [{ block: true, message: 'no' }],
    });
    const failure = await runAgent(await build('m', { route: 'agent.chat', agentKey: 'a1' })).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: 'AgentGuardrailBlockedError', guardrailKey: 'gr-in', status: 400 });
    expect(upstream.calls).toHaveLength(0);
  });

  it('the input guardrail judges the user\'s message ONCE per agent turn, not at every step of the tool loop; the next turn is judged again', async () => {
    useModels(guarded());
    const model = await build('m');
    await runAgent(model);
    expect(upstream.calls).toHaveLength(2);
    const inputEvaluations = () => (evaluateGuardrail as ReturnType<typeof vi.fn>).mock.calls.filter(([args]) => args.phase === 'input').length;
    expect(inputEvaluations()).toBe(1);

    upstream = stubUpstream(toolThenAnswer());
    await runAgent(await build('m'));
    expect(inputEvaluations()).toBe(2);
  });

  it('a redaction of the user\'s message reaches every step of the loop', async () => {
    useModels(guarded());
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({ ...GUARD_PASS, action: 'redact', redactedText: 'find [REDACTED]' });
    await runAgent(await build('m'));
    for (const call of upstream.calls) {
      const user = call.body.messages.find((m: any) => m.role === 'user');
      expect(user.content).toBe('find [REDACTED]');
    }
  });

  it('an output guardrail on the model redacts what the agent answers', async () => {
    useModels(llm('m', { guardrails: [{ key: 'gr-out', hooks: ['output.pre'] }] }));
    (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({ ...GUARD_PASS, action: 'redact', redactedText: 'answer without the secret', guardrailKey: 'gr-out' });
    upstream = stubUpstream(() => json(completion({ content: 'answer with the secret' })));
    const reply = await (await build('m')).invoke(USER);
    expect((reply as { content?: string }).content).toBe('answer without the secret');
  });

  it('a stream guardrail on the model stops a streamed agent answer mid-way: the loop gets the block, the row says error, not a hang-up', async () => {
    useModels(llm('m', { outputGuardrailKey: 'gr' }));
    (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      push: vi.fn(async () => ({ emit: [], blocked: true, verdict: { guardrailKey: 'gr', message: { body: 'not allowed', reasonClass: 'secret' } } })),
      end: vi.fn(async () => ({ emit: [], blocked: false })),
    }));
    upstream = stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.text('a secret'));
      return live.response;
    });
    const model = await build('m', { route: 'agent.chat' });
    const drain = async () => { for await (const part of model.stream!(USER)) void part; };
    await expect(drain()).rejects.toMatchObject({ name: 'AgentGuardrailBlockedError', guardrailKey: 'gr' });
    await flush();
    expect(rows().at(-1)).toMatchObject({ status: 'error', route: 'agent.chat' });
    expect(rows().some((row) => row.status === 'cancelled')).toBe(false);
  });
});

describe('Anthropic thinking in an agent loop', () => {
  const claude = (extra: object = {}) => llm('claude', {
    providerKey: 'prov-claude', providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5', settings: { maxTokens: 9000 }, ...extra,
  });
  const message = (content: unknown[], stop: string) => json({
    id: 'msg', model: 'claude', type: 'message', role: 'assistant', content, stop_reason: stop, usage: { input_tokens: 30, output_tokens: 12 },
  });
  const turns = [
    () => message([
      { type: 'thinking', thinking: 'let me look it up', signature: 'SIG-1' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'apples' } },
    ], 'tool_use'),
    () => message([{ type: 'text', text: 'Apples are found.' }], 'end_turn'),
  ];

  it('the loop replays the assistant turn with its SIGNED thinking block, and the agent pick turns thinking on', async () => {
    useModels(claude());
    let n = 0;
    upstream = stubUpstream(() => turns[n++]());
    const result = await runAgent(await build('claude', { reasoning: { effort: 'low' } }));

    expect(result.content).toBe('Apples are found.');
    expect(upstream.calls[0].body.thinking).toMatchObject({ type: 'enabled' });
    const assistant = upstream.calls[1].body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'thinking', thinking: 'let me look it up', signature: 'SIG-1' });
    expect(assistant.content.some((b: any) => b.type === 'tool_use' && b.id === 'toolu_1')).toBe(true);
  });

  it('streamed, the signed block is kept the same way', async () => {
    useModels(claude());
    let n = 0;
    upstream = stubUpstream(() => (n++ === 0
      ? sse([
        { type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 12 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me check' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-9' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"apples"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ])
      : sse([
        { type: 'message_start', message: { id: 'msg_2', model: 'claude', usage: { input_tokens: 20 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ])));
    const result = await runAgent(await build('claude', { reasoning: { effort: 'low' } }), { stream: true });

    expect(result.content).toBe('Done.');
    const assistant = upstream.calls[1].body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'thinking', thinking: 'let me check', signature: 'SIG-9' });
  });

  it('streamed, thinking deltas reach onReasoning while they arrive (and not when the call hides reasoning)', async () => {
    const answerAfterThinking = () => sse([
      { type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-3' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]);
    useModels(claude({ modelId: 'claude-opus-5-0' }));
    upstream = stubUpstream(answerAfterThinking);
    const seen: string[] = [];
    const visible = await runAgent(await build('claude', { reasoning: { effort: 'low' }, onReasoning: (text) => seen.push(text) }), { stream: true });
    expect(visible.content).toBe('Done.');
    expect(seen.join('')).toBe('let me check');
    // Visible reasoning is asked for as a summary on Claude 5.x (adaptive thinking).
    expect(upstream.calls[0].body.thinking).toMatchObject({ type: 'adaptive', display: 'summarized' });

    const hidden: string[] = [];
    upstream = stubUpstream(answerAfterThinking);
    await runAgent(await build('claude', { reasoning: { effort: 'low' }, showReasoning: false, onReasoning: (text) => hidden.push(text) }), { stream: true });
    expect(hidden).toEqual([]);
    expect(upstream.calls[0].body.thinking?.display).not.toBe('summarized');
  });

  it('Model Hub "return reasoning" off removes the thinking TEXT from what the agent outputs, not the signed block the loop replays', async () => {
    useModels(claude({ settings: { maxTokens: 9000, returnReasoning: false } }));
    let n = 0;
    upstream = stubUpstream(() => turns[n++]());
    const result = await runAgent(await build('claude', { reasoning: { effort: 'low' } }));

    const reasoningText = result.messages.map((m) => m.reasoning?.summary).filter(Boolean);
    expect(reasoningText).toEqual([]);
    const assistant = upstream.calls[1].body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'thinking', signature: 'SIG-1' });
  });
});

describe('a Dynamic LLM as the agent model', () => {
  const router = llm('router', {
    providerKey: 'dynamic', providerDriver: 'dynamic',
    settings: {
      dynamic: {
        strategy: 'rule-based',
        defaultModelKey: 'small',
        rules: [{ label: 'portal', targetModelKey: 'big', matchType: 'all', conditions: [{ signal: 'channel', operator: 'in', value: ['portal'] }] }],
      },
    },
  });

  beforeEach(() => {
    useModels(router, llm('big'), llm('small'));
    upstream = stubUpstream((call) => json(completion({
      content: `answered by ${servedBy(call)}`,
      toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    })));
  });

  it('the rules - caller channel included - pick the target per call; the answer, tool calls and usage come back to the loop', async () => {
    const model = await build('router', { route: 'agent.chat' });
    const portal = await runWithRoutingCaller({ channel: 'portal' }, () => model.invoke(USER)) as any;
    expect(portal.content).toBe('answered by prov-big');
    expect(portal.tool_calls?.[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } });
    expect(portal.usage).toMatchObject({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });

    const api = await runWithRoutingCaller({ channel: 'api' }, () => model.invoke(USER)) as any;
    expect(api.content).toBe('answered by prov-small');
  });

  it('prices the call at the CHILD, reports the routed model, and writes the child row on the agent route next to the router row', async () => {
    const onCost = vi.fn();
    const onRouted = vi.fn();
    const model = await build('router', { route: 'agent.chat', agentKey: 'a1', onCost, onRouted });
    await runWithRoutingCaller({ channel: 'portal' }, () => model.invoke(USER));
    await flush();

    expect(onRouted).toHaveBeenCalledWith('big');
    expect(onCost).toHaveBeenCalledTimes(1);
    expect(onCost.mock.calls[0][0].totalCost).toBeCloseTo((1000 * 10 + 500 * 30) / 1_000_000, 8);
    const byRoute = rows().map((row) => row.route).sort();
    expect(byRoute).toEqual(['agent.chat', 'chat.completions.router']);
    expect(rows().find((row) => row.route === 'agent.chat')).toMatchObject({ providerRequest: { agentKey: 'a1' }, routing: { role: 'child', chosenModelKey: 'big' } });
  });

  it('streams through a routed child: text deltas, then one assembled message with the tool call', async () => {
    upstream = stubUpstream(() => sse([
      chunk.text('Hel'), chunk.text('lo'),
      chunk.tool(0, { id: 'call_1', name: 'lookup', arguments: '{"q":' }),
      chunk.tool(0, { arguments: '"x"}' }),
      chunk.finish('tool_calls'),
      chunk.usage({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }),
    ]));
    const model = await build('router');
    const parts: any[] = [];
    await runWithRoutingCaller({ channel: 'portal' }, async () => {
      for await (const part of model.stream!(USER)) parts.push(part);
    });
    expect(parts.filter((part) => typeof part === 'string').join('')).toBe('Hello');
    const finals = parts.filter((part) => typeof part === 'object' && part.role);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      role: 'assistant', content: 'Hello',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });
  });

  it('carries the agent\'s sampling and tools to the routed model', async () => {
    const model = (await build('router', { overrides: { temperature: 0.3, max_tokens: 77 } })).bindTools!([await lookupTool()]);
    await runWithRoutingCaller({ channel: 'api' }, () => model.invoke(USER));
    expect(upstream.calls[0].body).toMatchObject({ temperature: 0.3, max_tokens: 77 });
    expect(upstream.calls[0].body.tools).toEqual([
      expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'lookup', description: 'Find a thing' }) }),
    ]);
  });

  it('a call made while another is in flight keeps its own routing', async () => {
    const seenByCall: string[] = [];
    const model = await build('router', { onRouted: (key) => seenByCall.push(key) });
    const [a, b] = await Promise.all([
      runWithRoutingCaller({ channel: 'portal' }, () => model.invoke(USER)),
      runWithRoutingCaller({ channel: 'api' }, () => model.invoke(USER)),
    ]) as any[];
    expect(a.content).toBe('answered by prov-big');
    expect(b.content).toBe('answered by prov-small');
    expect(seenByCall.sort()).toEqual(['big', 'small']);
  });

  it('a stream that fails midway rejects the call instead of ending quietly', async () => {
    upstream = stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.text('par'));
      setTimeout(() => live.fail(new Error('upstream exploded')), 5);
      return live.response;
    });
    const model = await build('router');
    const run = async () => { for await (const part of model.stream!(USER)) void part; };
    await expect(runWithRoutingCaller({ channel: 'api' }, run)).rejects.toThrow(/invalid|failed|exploded/i);
  });

  it('is guarded against a routing cycle (the depth limit), not left to loop', async () => {
    const dynamic = (key: string, to: string) => llm(key, {
      providerKey: 'dynamic', providerDriver: 'dynamic',
      settings: { dynamic: { strategy: 'rule-based', defaultModelKey: to, rules: [] } },
    });
    useModels(dynamic('ping', 'pong'), dynamic('pong', 'ping'));
    const model = await build('ping');
    await expect(model.invoke(USER)).rejects.toThrow(/depth exceeded/i);
    expect(upstream.calls).toHaveLength(0);
  });

  it('carries the agent\'s reasoning pick to the routed model, above its Model Hub default', async () => {
    useModels(router, llm('big'), llm('small', { settings: { reasoning: { effort: 'medium' } } }));
    await runWithRoutingCaller({ channel: 'api' }, async () => (await build('router', { reasoning: { effort: 'low' } })).invoke(USER));
    expect(upstream.calls[0].body.reasoning_effort).toBe('low');
    await runWithRoutingCaller({ channel: 'api' }, async () => (await build('router', { requestReasoning: { effort: 'low' } })).invoke(USER));
    expect(upstream.calls[1].body.reasoning_effort).toBe('medium');
  });
});
