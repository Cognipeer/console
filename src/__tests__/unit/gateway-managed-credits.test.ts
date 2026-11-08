/**
 * Managed-provider credits in the gateway core and the embeddings handler: one reservation per attempt,
 * the real usage booked once, the hold returned on every failure, the output cap applied, and an exact
 * no-op when no host is registered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeModelCall, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { normalizeInferenceError, OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import type { ModelStreamEvent } from '@/lib/services/models/gatewayTypes';
import { PlanLimitError } from '@/lib/limits/errors';
import {
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedCallInfo,
  type ManagedCreditLease,
  type ManagedRoute,
  type ManagedRouteQuery,
} from '@/enterprise/managed-credits';
import { flush } from '../helpers/nativeGateway';

vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', () => ({
  logModelUsage: vi.fn().mockResolvedValue(undefined),
  calculateCost: () => ({ currency: 'USD', inputCost: 0, outputCost: 0, cachedCost: 0, cacheWriteCost: 0, totalCost: 0 }),
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
const ASK = { messages: [{ role: 'user' as const, content: 'hello there' }] };
const stubModel = (m: object) => (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(m);
const nativeUsage = { inputTokens: 40, outputTokens: 12, totalTokens: 52, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 };

// ── host + client doubles ────────────────────────────────────────────────

type Lease = ManagedCreditLease & { settle: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
let leases: Lease[] = [];
let reserveCalls: ManagedCallInfo[] = [];

const ROUTE_A: ManagedRoute = { id: 'route-a', connectionId: 'conn-a', driver: 'openai' };
const ROUTE_B: ManagedRoute = { id: 'route-b', connectionId: 'conn-b', driver: 'anthropic', modelId: 'upstream-b' };

function installHost(options: {
  cap?: number;
  refuse?: Error;
  managed?: (ref: { driver?: string; key?: string }) => boolean;
  routes?: ManagedRoute[];
} = {}) {
  const reserve = vi.fn(async (call: ManagedCallInfo) => {
    reserveCalls.push(call);
    if (options.refuse) throw options.refuse;
    const lease: Lease = {
      id: `lease-${leases.length + 1}`,
      ...(options.cap !== undefined ? { maxOutputTokens: options.cap } : {}),
      settle: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    leases.push(lease);
    return lease;
  });
  const isManagedProvider = vi.fn(options.managed ?? (() => true));
  const listRoutes = vi.fn((_query: ManagedRouteQuery) => options.routes ?? [ROUTE_A]);
  registerManagedCreditsHost({ isManagedProvider, reserve, listRoutes });
  return { reserve, isManagedProvider, listRoutes };
}

type Chunk = Record<string, unknown>;
const completeResult = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', model: 'gpt-4o', content: 'hi', toolCalls: [], usage: nativeUsage, finishReason: 'stop', raw: null, ...extra,
});

/** A native client with scripted answers, wired in as the runtime of every replica (the `record` says which provider it is). */
function wire(script: {
  complete?: Array<Record<string, unknown> | Error>;
  stream?: (signal?: AbortSignal) => AsyncGenerator<Chunk, void, unknown>;
  record?: Record<string, unknown> | null;
} = {}) {
  const completes = [...(script.complete ?? [])];
  const client = {
    driver: 'openai',
    modelId: 'gpt-4o',
    provider: {},
    normalizeInlineReasoning: false,
    prepare: vi.fn(async (request: unknown) => request),
    complete: vi.fn(async () => {
      const next = completes.length > 1 ? completes.shift() : completes[0];
      if (next instanceof Error) throw next;
      return completeResult(next as Record<string, unknown> | undefined);
    }),
    stream: vi.fn((request: { signal?: AbortSignal }) => (script.stream ?? (async function* () {
      yield { id: 'c1', model: 'gpt-4o', delta: { content: 'hi' } };
      yield { id: 'c1', model: 'gpt-4o', delta: {}, finishReason: 'stop', rawFinishReason: 'stop', usage: nativeUsage };
    }))(request.signal)),
  };
  const createNativeChatClient = vi.fn().mockResolvedValue(client);
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
    runtime: { createNativeChatClient },
    ...(script.record === null ? {} : { record: script.record ?? { key: 'prov', driver: 'openai', type: 'model' } }),
  });
  return { client, createNativeChatClient };
}

async function collect(stream: AsyncGenerator<ModelStreamEvent, void, void>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const sentRequest = (client: { complete: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn> }, via: 'complete' | 'stream' = 'complete') =>
  client[via].mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  leases = [];
  reserveCalls = [];
  resetManagedCreditsHostForTests();
  stubModel(model());
});
afterEach(() => resetManagedCreditsHostForTests());

// ── no host: nothing changes ─────────────────────────────────────────────

describe('without a registered host', () => {
  it('sends the request exactly as before: no clamp, nothing reserved, passthrough limit keys untouched', async () => {
    stubModel(model({ settings: { maxTokens: 512, requestDefaults: { top_k: 5 } } }));
    const { client, createNativeChatClient } = wire();

    const outcome = await executeModelCall({ ...BASE, request: { ...ASK, maxTokens: 9999 } as never });
    await flush();

    expect(outcome.result?.response.content).toBe('hi');
    expect(sentRequest(client)).not.toHaveProperty('maxTokens');
    // The model settings the client is built from carry the caller's value, as always.
    expect(createNativeChatClient.mock.calls[0][0].modelSettings).toMatchObject({ requestMaxTokens: 9999 });
    expect(leases).toHaveLength(0);
  });

  it('a provider record that looks managed is not managed without a host', async () => {
    wire({ record: { key: 'prov', driver: 'managed-driver', type: 'model' } });
    await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect(reserveCalls).toHaveLength(0);
  });

  it('a host that says the provider is not managed changes nothing either', async () => {
    const host = installHost({ managed: () => false, cap: 10 });
    const { client } = wire();
    await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect(host.reserve).not.toHaveBeenCalled();
    expect(sentRequest(client)).not.toHaveProperty('maxTokens');
  });

  it('a record-less runtime (older mocks, dynamic routers) is never managed', async () => {
    const host = installHost();
    wire({ record: null });
    await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect(host.reserve).not.toHaveBeenCalled();
  });
});

// ── non-streamed ─────────────────────────────────────────────────────────

describe('managed chat call', () => {
  it('reserves once before the provider call and settles once with the real usage', async () => {
    const host = installHost();
    const order: string[] = [];
    host.reserve.mockImplementationOnce(async (call: ManagedCallInfo) => {
      order.push('reserve');
      reserveCalls.push(call);
      const lease: Lease = { id: 'l', settle: vi.fn(async () => {}), release: vi.fn(async () => {}) };
      leases.push(lease);
      return lease;
    });
    const { client } = wire();
    client.complete.mockImplementation(async () => { order.push('provider'); return completeResult(); });

    const outcome = await executeModelCall({
      ...BASE,
      request: ASK,
      context: { requestTags: { agentKey: 'helper' }, callerContext: { run: { runId: 'run-9' } }, route: 'agent.turn' } as never,
    });
    await flush();

    expect(outcome.result?.response.content).toBe('hi');
    expect(order).toEqual(['reserve', 'provider']);
    expect(host.reserve).toHaveBeenCalledTimes(1);
    expect(reserveCalls[0]).toMatchObject({
      kind: 'chat',
      tenantId: 'tenant-1',
      tenantDbName: 'tenant_acme',
      projectId: 'proj-1',
      providerKey: 'prov',
      driver: 'openai',
      modelKey: 'm',
      modelId: 'gpt-4o',
      attribution: { agentKey: 'helper', runId: 'run-9', route: 'agent.turn' },
    });
    expect(reserveCalls[0].estimate.inputTokens).toBeGreaterThan(0);
    expect(reserveCalls[0].estimate.maxOutputTokens).toBe(512);
    expect(typeof reserveCalls[0].requestId).toBe('string');
    expect(leases[0].settle).toHaveBeenCalledTimes(1);
    expect(leases[0].settle).toHaveBeenCalledWith({ inputTokens: 40, outputTokens: 12 });
    expect(leases[0].release).not.toHaveBeenCalled();
  });

  it('a refusal surfaces with its status and code, and no provider call is made', async () => {
    installHost({ refuse: new PlanLimitError({ code: 'insufficient_credits', message: 'Not enough credits.', kind: 'credits' as never }) });
    const { client } = wire();

    const failure = await executeModelCall({ ...BASE, request: ASK }).catch((error) => error);

    expect(failure).toBeInstanceOf(PlanLimitError);
    expect(failure).toMatchObject({ status: 402, code: 'insufficient_credits' });
    expect(client.complete).not.toHaveBeenCalled();
    expect(normalizeInferenceError(failure)).toMatchObject({ status: 402, error: { code: 'insufficient_credits', type: 'insufficient_quota' } });
  });

  it('a 413 refusal does not fail over to the next replica', async () => {
    installHost({ refuse: new PlanLimitError({ code: 'context_over_credit_cap', message: 'Too big.', kind: 'credits' as never }) });
    stubModel(model({ replicas: [{ providerKey: 'a', modelId: 'gpt-4o', weight: 1 }, { providerKey: 'b', modelId: 'gpt-4o', weight: 1 }] }));
    wire();

    await expect(executeModelCall({ ...BASE, request: ASK })).rejects.toMatchObject({ code: 'context_over_credit_cap', status: 413 });
    expect(reserveCalls).toHaveLength(1);
  });

  it('retries inside one attempt (withResilience) share a single reservation', async () => {
    installHost();
    const { client } = wire({ complete: [Object.assign(new Error('blip'), { status: 503 }), completeResult()] });

    const outcome = await executeModelCall({ ...BASE, request: ASK });
    await flush();

    expect(outcome.result?.response.content).toBe('hi');
    expect(client.complete.mock.calls.length).toBeGreaterThan(1);
    expect(reserveCalls).toHaveLength(1);
    expect(leases[0].settle).toHaveBeenCalledTimes(1);
    expect(leases[0].release).not.toHaveBeenCalled();
  });

  it('a failed route releases its hold before the next route reserves its own; only the serving one settles', async () => {
    installHost({ routes: [ROUTE_A, ROUTE_B] });
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const down = wire({ complete: [Object.assign(new Error('overloaded'), { status: 503 })] });
      const up = wire();
      (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(async (
        _db: string, _tenant: string, _providerKey: string, _project: unknown, options?: { managedConnectionId?: string },
      ) => ({
        runtime: { createNativeChatClient: vi.fn().mockResolvedValue(options?.managedConnectionId === 'conn-a' ? down.client : up.client) },
        record: { key: 'prov', driver: 'openai', type: 'model' },
      }));

      const outcome = await executeModelCall({ ...BASE, request: ASK });
      await flush();

      expect(outcome.result?.response.content).toBe('hi');
    } finally {
      Math.random = originalRandom;
    }
    // The hold is made under the PUBLIC identity; the route that serves it rides separately.
    expect(reserveCalls.map((call) => [call.providerKey, call.modelId, call.routeId])).toEqual([
      ['prov', 'gpt-4o', 'route-a'],
      ['prov', 'gpt-4o', 'route-b'],
    ]);
    expect(leases).toHaveLength(2);
    expect(leases[0].release).toHaveBeenCalledWith('error');
    expect(leases[0].settle).not.toHaveBeenCalled();
    expect(leases[1].settle).toHaveBeenCalledTimes(1);
    expect(leases[1].release).not.toHaveBeenCalled();
  });

  it('a provider failure releases the hold with "error"', async () => {
    installHost();
    wire({ complete: [Object.assign(new Error('bad request'), { status: 400 })] });
    await expect(executeModelCall({ ...BASE, request: ASK })).rejects.toBeTruthy();
    await flush();
    expect(leases).toHaveLength(1);
    expect(leases[0].release).toHaveBeenCalledWith('error');
    expect(leases[0].settle).not.toHaveBeenCalled();
  });

  it('a call that hit its output limit is billed (settled once) and flags the limit as a hard cap when it is the credit cap', async () => {
    installHost({ cap: 64 });
    wire({ complete: [{ content: null, finishReason: 'length', usage: { ...nativeUsage, outputTokens: 64 } }] });

    const failure = await executeModelCall({ ...BASE, request: ASK, context: { route: 'agent.turn' } }).catch((error) => error);
    await flush();

    expect(failure).toBeInstanceOf(OutputTokenLimitError);
    expect(failure).toMatchObject({ limit: 64, hardCap: true });
    expect(leases[0].settle).toHaveBeenCalledTimes(1);
    expect(leases[0].release).not.toHaveBeenCalled();
  });
});

// ── the output cap ───────────────────────────────────────────────────────

describe('managed output cap', () => {
  it('lowers a larger explicit max_tokens to the cap', async () => {
    installHost({ cap: 100 });
    const { client } = wire();
    await executeModelCall({ ...BASE, request: { ...ASK, maxTokens: 5000 } as never });
    await flush();
    expect(sentRequest(client).maxTokens).toBe(100);
  });

  it('applies the cap when the request names no limit and the model default is higher', async () => {
    installHost({ cap: 100 });
    const { client } = wire();
    await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect(sentRequest(client).maxTokens).toBe(100);
  });

  it('applies the cap when no limit would have been sent at all', async () => {
    installHost({ cap: 100 });
    stubModel(model({ settings: {} }));
    const { client } = wire();
    await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect(sentRequest(client).maxTokens).toBe(100);
  });

  it('leaves a lower limit alone, and sets no hard cap on it', async () => {
    installHost({ cap: 1000 });
    const { client } = wire({ complete: [{ content: null, finishReason: 'length' }] });
    const failure = await executeModelCall({ ...BASE, request: ASK, context: { route: 'agent.turn' } }).catch((error) => error);
    await flush();
    expect(sentRequest(client)).not.toHaveProperty('maxTokens');
    expect(failure).toBeInstanceOf(OutputTokenLimitError);
    expect(failure.limit).toBe(512);
    expect(failure.hardCap).toBeUndefined();
  });

  it('ignores the tenant passthrough limit and thinking-budget keys', async () => {
    installHost({ cap: 100 });
    stubModel(model({
      settings: {
        maxTokens: 512,
        allowUnknownPassthrough: true,
        requestDefaults: { top_k: 5, max_tokens: 99999, max_completion_tokens: 99999, thinking: { type: 'enabled', budget_tokens: 50000 }, budget_tokens: 5 },
      },
    }));
    const { createNativeChatClient } = wire();
    await executeModelCall({ ...BASE, request: ASK });
    await flush();
    const extraBody = createNativeChatClient.mock.calls[0][0].modelSettings.extraBody as Record<string, unknown> | undefined;
    expect(extraBody ?? {}).not.toHaveProperty('max_tokens');
    expect(extraBody ?? {}).not.toHaveProperty('max_completion_tokens');
    expect(extraBody ?? {}).not.toHaveProperty('thinking');
    expect(extraBody ?? {}).not.toHaveProperty('budget_tokens');
    expect(extraBody).toMatchObject({ top_k: 5 });
  });
});

// ── streamed ─────────────────────────────────────────────────────────────

describe('managed streamed call', () => {
  it('settles once on success with the provider usage', async () => {
    installHost();
    wire();
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    await collect(outcome.stream!);
    await flush();
    expect(reserveCalls).toHaveLength(1);
    expect(leases[0].settle).toHaveBeenCalledTimes(1);
    expect(leases[0].settle).toHaveBeenCalledWith({ inputTokens: 40, outputTokens: 12 });
    expect(leases[0].release).not.toHaveBeenCalled();
  });

  it('marks a settle estimated when the upstream sent no usage', async () => {
    installHost();
    wire({
      stream: async function* () {
        yield { id: 'c1', model: 'gpt-4o', delta: { content: 'hello' } };
        yield { id: 'c1', model: 'gpt-4o', delta: {}, finishReason: 'stop', rawFinishReason: 'stop' };
      },
    });
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    await collect(outcome.stream!);
    await flush();
    expect(leases[0].settle).toHaveBeenCalledTimes(1);
    expect(leases[0].settle.mock.calls[0][0]).toMatchObject({ estimated: true });
  });

  it('a stream cancelled before anything was generated releases the hold ("no_usage") and settles nothing', async () => {
    installHost();
    const controller = new AbortController();
    wire({
      stream: async function* () {
        yield { id: 'c1', model: 'gpt-4o', delta: {} };
        controller.abort();
        throw new Error('aborted');
      },
    });
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true, context: { signal: controller.signal } });
    const events = await collect(outcome.stream!);
    await flush();
    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(leases[0].release).toHaveBeenCalledTimes(1);
    expect(leases[0].release).toHaveBeenCalledWith('no_usage');
    expect(leases[0].settle).not.toHaveBeenCalled();
  });

  it('a stream cancelled after output settles on the estimate', async () => {
    installHost();
    const controller = new AbortController();
    wire({
      stream: async function* () {
        yield { id: 'c1', model: 'gpt-4o', delta: { content: 'some partial answer text' } };
        controller.abort();
        throw new Error('aborted');
      },
    });
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true, context: { signal: controller.signal } });
    await collect(outcome.stream!);
    await flush();
    expect(leases[0].settle).toHaveBeenCalledTimes(1);
    expect(leases[0].settle.mock.calls[0][0]).toMatchObject({ estimated: true });
    expect(leases[0].settle.mock.calls[0][0].outputTokens).toBeGreaterThan(0);
    expect(leases[0].release).not.toHaveBeenCalled();
  });

  it('a stream that fails before producing anything releases the hold with "error"', async () => {
    installHost();
    wire({
      stream: async function* () {
        yield { id: 'c1', model: 'gpt-4o', delta: {} };
        throw Object.assign(new Error('upstream died'), { status: 500 });
      },
    });
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);
    await flush();
    expect(events.some((event) => event.type === 'failed')).toBe(true);
    expect(leases[0].release).toHaveBeenCalledTimes(1);
    expect(leases[0].release).toHaveBeenCalledWith('error');
    expect(leases[0].settle).not.toHaveBeenCalled();
  });

  it('a stream that fails after output is billed on what it produced', async () => {
    installHost();
    wire({
      stream: async function* () {
        yield { id: 'c1', model: 'gpt-4o', delta: { content: 'partial text before the fault' } };
        throw Object.assign(new Error('upstream died'), { status: 500 });
      },
    });
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    await collect(outcome.stream!);
    await flush();
    expect(leases[0].settle).toHaveBeenCalledTimes(1);
    expect(leases[0].release).not.toHaveBeenCalled();
  });

  it('a failure while opening the stream releases the hold', async () => {
    installHost();
    const { client } = wire();
    client.stream.mockImplementation(() => (async function* () { throw Object.assign(new Error('refused'), { status: 400 }); })());
    await expect(executeModelCall({ ...BASE, request: ASK, stream: true })).rejects.toBeTruthy();
    await flush();
    expect(leases[0].release).toHaveBeenCalledWith('error');
    expect(leases[0].settle).not.toHaveBeenCalled();
  });

  it('clamps a streamed call too', async () => {
    installHost({ cap: 100 });
    const { client } = wire();
    const outcome = await executeModelCall({ ...BASE, request: { ...ASK, maxTokens: 5000 } as never, stream: true });
    await collect(outcome.stream!);
    expect(sentRequest(client, 'stream').maxTokens).toBe(100);
  });
});

// ── embeddings ───────────────────────────────────────────────────────────

describe('managed embeddings', () => {
  const embeddingModel = () => ({ ...model(), category: 'embedding' as const, modelId: 'text-embedding-3-small', key: 'emb', settings: {} });
  function wireEmbedder(embed: ReturnType<typeof vi.fn>, record: Record<string, unknown> | null = { key: 'prov', driver: 'openai', type: 'embedding' }) {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: { createNativeEmbedder: vi.fn().mockResolvedValue({ embed }) },
      ...(record ? { record } : {}),
    });
  }
  const call = (body: Record<string, unknown>) => handleEmbeddingRequest({
    tenantDbName: 'tenant_acme', modelKey: 'emb', projectId: 'proj-1', body: { input: 'abcdefgh', ...body },
  });

  beforeEach(() => stubModel(embeddingModel()));

  it('reserves with the text estimate (a caller-supplied count is ignored) and settles with the provider usage', async () => {
    const host = installHost();
    wireEmbedder(vi.fn().mockResolvedValue({ vectors: [[0.1]], usage: { inputTokens: 7 } }));

    const result = await call({ input_tokens: 1 });
    await flush();

    expect(host.reserve).toHaveBeenCalledTimes(1);
    expect(reserveCalls[0]).toMatchObject({ kind: 'embedding', providerKey: 'prov', modelId: 'text-embedding-3-small', estimate: { inputTokens: 2 } });
    expect(leases[0].settle).toHaveBeenCalledWith({ inputTokens: 7, outputTokens: 0 });
    expect(result.response.usage.prompt_tokens).toBe(7);
  });

  it('settles on the estimate (flagged) when the provider reports no usage, ignoring input_tokens', async () => {
    installHost();
    wireEmbedder(vi.fn().mockResolvedValue({ vectors: [[0.1]] }));
    await call({ input_tokens: 1 });
    await flush();
    expect(leases[0].settle).toHaveBeenCalledWith({ inputTokens: 2, outputTokens: 0, estimated: true });
  });

  it('a refusal makes no provider call', async () => {
    installHost({ refuse: new PlanLimitError({ code: 'credits_unavailable', message: 'Credits unavailable.', kind: 'credits' as never }) });
    const embed = vi.fn();
    wireEmbedder(embed);
    await expect(call({})).rejects.toMatchObject({ code: 'credits_unavailable', status: 503 });
    expect(embed).not.toHaveBeenCalled();
  });

  it('releases the hold when the provider fails, and as cancelled when the caller aborted', async () => {
    installHost();
    wireEmbedder(vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 400 })));
    await expect(call({})).rejects.toBeTruthy();
    await flush();
    expect(leases[0].release).toHaveBeenCalledWith('error');
    expect(leases[0].settle).not.toHaveBeenCalled();

    const controller = new AbortController();
    wireEmbedder(vi.fn().mockImplementation(async () => { controller.abort(); throw new Error('aborted'); }));
    await expect(handleEmbeddingRequest({
      tenantDbName: 'tenant_acme', modelKey: 'emb', projectId: 'proj-1', body: { input: 'abcdefgh' }, signal: controller.signal,
    })).rejects.toBeTruthy();
    await flush();
    expect(leases[1].release).toHaveBeenCalledWith('cancelled');
  });

  it('is unchanged without a host: the caller-supplied count still wins and nothing is reserved', async () => {
    wireEmbedder(vi.fn().mockResolvedValue({ vectors: [[0.1]], usage: { inputTokens: 7 } }));
    const result = await call({ input_tokens: 3 });
    expect(result.response.usage.prompt_tokens).toBe(3);
    expect(reserveCalls).toHaveLength(0);
  });
});

// ── follow-up hardening ──────────────────────────────────────────────────

describe('managed accounting hardening', () => {
  it('a non-streamed upstream that sends no usage is settled at an estimate, flagged estimated', async () => {
    installHost();
    wire({ complete: [{ usage: undefined, content: 'a reply of some length' }] });
    await executeModelCall({ ...BASE, request: ASK });
    await flush();
    expect(leases[0].settle).toHaveBeenCalledTimes(1);
    const booked = leases[0].settle.mock.calls[0][0];
    expect(booked.inputTokens).toBeGreaterThan(0);
    expect(booked.outputTokens).toBeGreaterThan(0);
    expect(booked.estimated).toBe(true);
  });

  it('caller passthrough (vendor limit keys included) never reaches a managed provider', async () => {
    installHost({ cap: 50 });
    stubModel(model({ settings: { maxTokens: 512, allowUnknownPassthrough: true, requestDefaults: { top_k: 5, max_new_tokens: 999 } } }));
    const { createNativeChatClient } = wire();
    await executeModelCall({
      ...BASE,
      request: ASK,
      invocationBody: { max_new_tokens: 100000, num_predict: 100000, generation_config: { maxOutputTokens: 9e5 }, custom_flag: true },
    } as never);
    await flush();
    const extra = createNativeChatClient.mock.calls[0][0].modelSettings.extraBody ?? {};
    expect(extra).not.toHaveProperty('max_new_tokens');
    expect(extra).not.toHaveProperty('num_predict');
    expect(extra).not.toHaveProperty('generation_config');
    expect(extra).not.toHaveProperty('custom_flag');
  });

  it('a streamed outcome dropped before its first read gives the hold back', async () => {
    installHost();
    wire();
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    await outcome.stream!.return();
    await flush();
    expect(leases[0].release).toHaveBeenCalledTimes(1);
    expect(leases[0].settle).not.toHaveBeenCalled();
  });
});

describe('managed upstream error text', () => {
  const leaky = Object.assign(new Error('Upstream error: deployment ops-secret-east at https://ops.example.test failed'), { status: 429 });

  it('is not shown to the tenant for a non-streamed call', async () => {
    installHost();
    wire({ complete: [leaky] });
    const failure = await executeModelCall({ ...BASE, request: ASK }).catch((error) => error);
    const body = normalizeInferenceError(failure);
    expect(body.status).toBe(429);
    expect(JSON.stringify(body)).not.toMatch(/ops-secret|example\.test/i);
  });

  it('is not shown for a streamed failure either', async () => {
    installHost();
    wire({ stream: async function* () { yield { id: 'c1', model: 'gpt-4o', delta: { content: 'x' } }; throw leaky; } });
    const outcome = await executeModelCall({ ...BASE, request: ASK, stream: true });
    const events = await collect(outcome.stream!);
    expect(JSON.stringify(events)).not.toMatch(/ops-secret|example\.test/i);
  });

  it('is unchanged for a call that is not managed', async () => {
    wire({ complete: [leaky] });
    const failure = await executeModelCall({ ...BASE, request: ASK }).catch((error) => error);
    expect(normalizeInferenceError(failure).error.message).toMatch(/ops-secret/);
  });
});

// ── managed routes ───────────────────────────────────────────────────────

describe('managed routes', () => {
  const usageRows = () => (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2] as Record<string, unknown>);

  /**
   * Route A answers with `first` (an error or a result), route B with `second`. Each runtime is told apart by the
   * connection id it was built for; `created` records what each client was created for.
   */
  function wireRoutes(first: Record<string, unknown> | Error, second: Record<string, unknown> = {}) {
    const down = wire({ complete: [first] });
    const up = wire({ complete: [second] });
    const created: Array<{ connectionId?: string; modelId: string }> = [];
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(async (
      _db: string, _tenant: string, _providerKey: string, _project: unknown, options?: { managedConnectionId?: string },
    ) => ({
      runtime: {
        createNativeChatClient: vi.fn(async (args: { modelId: string }) => {
          created.push({ connectionId: options?.managedConnectionId, modelId: args.modelId });
          return options?.managedConnectionId === 'conn-a' ? down.client : up.client;
        }),
      },
      record: { key: 'prov', driver: 'openai', type: 'model' },
    }));
    return { created };
  }

  /** Route order is the host's order when the draw is 0. */
  async function callInOrder(request: Record<string, unknown> = ASK) {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const outcome = await executeModelCall({ ...BASE, request: request as never });
      await flush();
      return outcome;
    } finally {
      Math.random = originalRandom;
    }
  }

  it('the first route fails with 429 and the second serves it, built from its own connection and upstream model id', async () => {
    installHost({ routes: [ROUTE_A, ROUTE_B] });
    const { created } = wireRoutes(Object.assign(new Error('rate limited'), { status: 429 }));

    const outcome = await callInOrder();

    expect(outcome.result?.response.content).toBe('hi');
    expect(created).toEqual([
      { connectionId: 'conn-a', modelId: 'gpt-4o' },
      { connectionId: 'conn-b', modelId: 'upstream-b' },
    ]);
    // Every build is the metered kind.
    for (const call of (buildModelRuntime as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[4]).toMatchObject({ allowManaged: true });
    }
    expect(reserveCalls.map((call) => [call.providerKey, call.modelId, call.routeId])).toEqual([
      ['prov', 'gpt-4o', 'route-a'],
      ['prov', 'gpt-4o', 'route-b'],
    ]);
  });

  it('an empty route list refuses with 503, makes no upstream call and reserves nothing', async () => {
    const host = installHost({ routes: [] });
    const { client } = wire();

    const failure = await executeModelCall({ ...BASE, request: ASK }).catch((error) => error);

    expect(failure).toMatchObject({ status: 503, message: 'This model is not available right now.' });
    expect(host.reserve).not.toHaveBeenCalled();
    expect(buildModelRuntime).not.toHaveBeenCalled();
    expect(client.complete).not.toHaveBeenCalled();

    const streamFailure = await executeModelCall({ ...BASE, request: ASK, stream: true }).catch((error) => error);
    expect(streamFailure).toMatchObject({ status: 503, message: 'This model is not available right now.' });
    expect(host.reserve).not.toHaveBeenCalled();
  });

  it('a runtime that cannot be built for a route never shows its cause', async () => {
    installHost();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('connection conn-a refused at https://ops.example.test'), { status: 502 }),
    );

    const failure = await executeModelCall({ ...BASE, request: ASK }).catch((error) => error);

    expect(normalizeInferenceError(failure).error.message).toBe('Managed model provider request failed.');
    expect(JSON.stringify(normalizeInferenceError(failure))).not.toMatch(/conn-a|example\.test/);
  });

  it('usage rows and the wire response carry the public identity and nothing about the route', async () => {
    installHost({ routes: [ROUTE_A, ROUTE_B] });
    wireRoutes(
      Object.assign(new Error('overloaded'), { status: 503 }),
      { providerFields: { system_fingerprint: 'fp_upstream', service_tier: 'tier-x' } },
    );

    const outcome = await callInOrder();

    expect(JSON.stringify(usageRows())).not.toMatch(/route-a|route-b|conn-a|conn-b|upstream-b|fp_upstream|failedOver/);
    const wireBody = outcome.wire as Record<string, unknown>;
    expect(wireBody.model).toBe('gpt-4o');
    expect(wireBody.system_fingerprint).not.toBe('fp_upstream');
    expect(wireBody).not.toHaveProperty('service_tier');
    expect(usageRows().every((row) => (row.providerRequest as { model?: string }).model === 'm')).toBe(true);
  });

  it('stored replicas of a managed model are ignored', async () => {
    installHost({ routes: [ROUTE_A] });
    stubModel(model({ replicas: [{ providerKey: 'other', modelId: 'x', weight: 1 }] }));
    wire();

    await executeModelCall({ ...BASE, request: ASK });
    await flush();

    expect(reserveCalls.map((call) => call.providerKey)).toEqual(['prov']);
    expect(JSON.stringify(usageRows())).not.toMatch(/other|"replica"/);
  });

  it('a provider error finish of a managed call names no upstream reason', async () => {
    installHost();
    wire({ complete: [{ finishReason: 'error', rawFinishReason: 'MALFORMED_FUNCTION_CALL', content: null }] });

    const failure = await executeModelCall({ ...BASE, request: ASK }).catch((error) => error);
    await flush();

    expect(failure.message).toBe('The model stopped before completing the response.');
    expect(failure.code).toBe('provider_error');
    expect(JSON.stringify(usageRows())).not.toMatch(/MALFORMED|malformed_function_call/i);
  });

  it('an unmanaged model with stored replicas fails over as before and passes no connection id', async () => {
    installHost({ managed: () => false });
    stubModel(model({
      replicas: [{ providerKey: 'a', modelId: 'gpt-4o', weight: 1000 }, { providerKey: 'b', modelId: 'gpt-4o', weight: 1 }],
    }));
    const down = wire({ complete: [Object.assign(new Error('overloaded'), { status: 503 })] });
    const up = wire();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(async (_db: string, _tenant: string, providerKey: string) => ({
      runtime: { createNativeChatClient: vi.fn().mockResolvedValue(providerKey === 'a' ? down.client : up.client) },
      record: { key: providerKey, driver: 'openai', type: 'model' },
    }));

    const outcome = await callInOrder();

    expect(outcome.result?.response.content).toBe('hi');
    const calls = (buildModelRuntime as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((call) => call[2])).toEqual(['a', 'b']);
    for (const call of calls) expect(call[4].managedConnectionId).toBeUndefined();
  });
});
