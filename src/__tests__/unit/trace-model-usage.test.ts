/**
 * `recordTraceModelUsage` writes trace-derived model usage into `usage_daily`
 * through `recordUsageEvent`. The pricing step was extracted into a shared
 * helper (also used by the entity-health emitters); these tests pin the exact
 * usage rows so the refactor cannot change what spend reports see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  recordUsageEvent: vi.fn((_input: Record<string, unknown>) => ({})),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: hoisted.getDatabase,
  runWithTenantScope: vi.fn(async (_n: string, fn: (d: unknown) => unknown) => fn(await hoisted.getDatabase())),
}));
vi.mock('@/lib/services/usage/usageEvents', () => ({ recordUsageEvent: hoisted.recordUsageEvent }));

import { runWithTenantScope } from '@/lib/database';
import { recordTraceModelUsage } from '@/lib/services/agentTracing';
import {
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedCreditPricer,
} from '@/enterprise/managed-credits';

const TENANT_DB = 'tenant_acme';

function makeDb(options: { models?: unknown[]; external?: unknown[] } = {}) {
  return {
    listModels: vi.fn(async () => options.models ?? []),
    listExternalModelPricing: vi.fn(async () => options.external ?? []),
  };
}

const base = {
  tenantDbName: TENANT_DB,
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentName: 'Pulse Main',
  metadata: { env: 'prod' },
};

describe('recordTraceModelUsage', () => {
  beforeEach(() => {
    hoisted.recordUsageEvent.mockClear();
    hoisted.getDatabase.mockReset();
  });

  it('prices a Hub model by key and records one usage row per model with summed tokens, latency and call count', async () => {
    const db = makeDb({
      models: [{ key: 'gpt-main', modelId: 'gpt-4o', pricing: { inputTokenPer1M: 2, outputTokenPer1M: 10 } }],
    });
    hoisted.getDatabase.mockResolvedValue(db);

    await recordTraceModelUsage({
      ...base,
      events: [
        { model: 'GPT-4o', inputTokens: 1000, outputTokens: 500, durationMs: 200 },
        { model: 'GPT-4o', inputTokens: 3000, outputTokens: 1500, durationMs: 400, reasoningTokens: 100 },
      ],
    });

    expect(runWithTenantScope).toHaveBeenCalledWith(TENANT_DB, expect.any(Function));
    expect(hoisted.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(hoisted.recordUsageEvent.mock.calls[0][0]).toEqual({
      tenantDbName: TENANT_DB,
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      service: 'models',
      refKey: 'gpt-main',
      agentKey: 'Pulse Main',
      metadata: { env: 'prod' },
      source: 'tracing',
      status: 'success',
      inputTokens: 4000,
      outputTokens: 2000,
      cachedInputTokens: 0,
      cachedWriteTokens: 0,
      reasoningTokens: 100,
      totalTokens: 6000,
      costUsd: (4000 * 2 + 2000 * 10) / 1_000_000,
      latencyMs: 600,
      latencySamples: 2,
      units: { modelCalls: 2 },
    });
  });

  it('falls back to the external pricing catalog (project entry wins) and records cost 0 for an unpriced model', async () => {
    const db = makeDb({
      external: [
        { projectId: '', normalizedName: 'claude-x', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 } },
        { projectId: 'proj-1', normalizedName: 'claude-x', pricing: { inputTokenPer1M: 3, outputTokenPer1M: 15 } },
      ],
    });
    hoisted.getDatabase.mockResolvedValue(db);

    await recordTraceModelUsage({
      ...base,
      events: [
        { model: 'claude-x', inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { model: 'mystery-model', inputTokens: 10, outputTokens: 5 },
      ],
    });

    const rows = hoisted.recordUsageEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);
    const claude = rows.find((row) => row.refKey === 'claude-x');
    const mystery = rows.find((row) => row.refKey === 'mystery-model');
    expect(claude).toMatchObject({ costUsd: 18, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(claude).not.toHaveProperty('latencyMs');
    expect(mystery).toMatchObject({ costUsd: 0, units: { modelCalls: 1 }, totalTokens: 15 });
  });

  it('resolves a Hub model by provider modelId when the key does not match', async () => {
    const db = makeDb({
      models: [{ key: 'hub-key', modelId: 'provider/model-7', pricing: { inputTokenPer1M: 4, outputTokenPer1M: 8 } }],
    });
    hoisted.getDatabase.mockResolvedValue(db);

    await recordTraceModelUsage({ ...base, events: [{ model: 'Provider/Model-7', inputTokens: 500_000, outputTokens: 250_000 }] });

    expect(hoisted.recordUsageEvent.mock.calls[0][0]).toMatchObject({ refKey: 'hub-key', costUsd: 4 });
  });

  it('skips gateway-served events, zero-token events and events without a model, and takes the model from modelNames', async () => {
    const db = makeDb();
    hoisted.getDatabase.mockResolvedValue(db);

    await recordTraceModelUsage({
      ...base,
      events: [
        { model: 'm-a', inputTokens: 10, outputTokens: 10, metadata: { gateway: true } },
        { model: 'm-a', inputTokens: 10, outputTokens: 10, metadata: { gatewayRequestId: 'req-1' } },
        { model: 'm-a', inputTokens: 10, outputTokens: 10, metadata: { consoleRequestId: 'req-2' } },
        { model: 'm-a', inputTokens: 0, outputTokens: 0 },
        { inputTokens: 10, outputTokens: 10 },
        { modelNames: ['m-b'], inputTokens: 7, outputTokens: 3 },
      ],
    });

    expect(hoisted.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(hoisted.recordUsageEvent.mock.calls[0][0]).toMatchObject({ refKey: 'm-b', inputTokens: 7, outputTokens: 3, units: { modelCalls: 1 } });
  });

  it('records only the delta of a re-posted session and nothing when the delta is zero', async () => {
    const db = makeDb({ models: [{ key: 'k', modelId: 'k', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 } }] });
    hoisted.getDatabase.mockResolvedValue(db);
    const first = { model: 'k', inputTokens: 100, outputTokens: 50, durationMs: 10 };
    const second = { model: 'k', inputTokens: 40, outputTokens: 20, durationMs: 30 };

    await recordTraceModelUsage({ ...base, events: [first, second], previousEvents: [first] });
    expect(hoisted.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(hoisted.recordUsageEvent.mock.calls[0][0]).toMatchObject({
      inputTokens: 40, outputTokens: 20, totalTokens: 60, latencyMs: 30, latencySamples: 1, units: { modelCalls: 1 },
    });

    hoisted.recordUsageEvent.mockClear();
    await recordTraceModelUsage({ ...base, events: [first, second], previousEvents: [first, second] });
    expect(hoisted.recordUsageEvent).not.toHaveBeenCalled();
  });

  it('treats cached read/write as subsets of input: total = input + output, write priced at its own rate', async () => {
    const db = makeDb({
      models: [{
        key: 'claude-main',
        modelId: 'claude-x',
        pricing: { inputTokenPer1M: 2, outputTokenPer1M: 10, cachedTokenPer1M: 0.5, cacheWriteTokenPer1M: 2.5 },
      }],
    });
    hoisted.getDatabase.mockResolvedValue(db);

    await recordTraceModelUsage({
      ...base,
      events: [{
        model: 'claude-main',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        cachedWriteTokens: 100_000,
      }],
    });

    const row = hoisted.recordUsageEvent.mock.calls[0][0] as Record<string, number>;
    expect(row).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      cachedWriteTokens: 100_000,
      totalTokens: 2_000_000,
    });
    // 700k uncached @2 + 200k read @0.5 + 100k write @2.5 + 1M output @10
    expect(row.costUsd).toBeCloseTo(11.75, 6);
  });

  it('subtracts previous cache-write tokens on a re-post and still records a write-only delta', async () => {
    const db = makeDb({ models: [{ key: 'k', modelId: 'k', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 } }] });
    hoisted.getDatabase.mockResolvedValue(db);
    const first = { model: 'k', inputTokens: 100, outputTokens: 50, cachedWriteTokens: 10 };

    await recordTraceModelUsage({ ...base, events: [first], previousEvents: [first] });
    expect(hoisted.recordUsageEvent).not.toHaveBeenCalled();

    await recordTraceModelUsage({
      ...base,
      events: [{ ...first, cachedWriteTokens: 30 }],
      previousEvents: [first],
    });
    expect(hoisted.recordUsageEvent.mock.calls[0][0]).toMatchObject({ cachedWriteTokens: 20, inputTokens: 0, outputTokens: 0 });
  });

  it('never throws and does not touch the database when nothing is billable', async () => {
    hoisted.getDatabase.mockRejectedValue(new Error('db down'));
    await expect(recordTraceModelUsage({ ...base, events: [{ model: 'm', inputTokens: 1, outputTokens: 1 }] })).resolves.toBeUndefined();
    expect(hoisted.recordUsageEvent).not.toHaveBeenCalled();

    hoisted.getDatabase.mockClear();
    await recordTraceModelUsage({ ...base, events: [{ model: 'm', inputTokens: 0, outputTokens: 0 }] });
    expect(hoisted.getDatabase).not.toHaveBeenCalled();
  });
});

describe('recordTraceModelUsage: a model paid with credits', () => {
  const platform = { key: 'cognipeer.chat', modelId: 'chat-1', providerKey: 'cognipeer', category: 'llm', pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0 } };
  const pricer = vi.fn<ManagedCreditPricer>((_query, usage) => ({ credits: 2 * (usage.calls ?? 1), usdPerCredit: 0.01, usd: 0.02 * (usage.calls ?? 1) }));
  const install = (answer: ManagedCreditPricer | null) => registerManagedCreditsHost({
    isManagedProvider: (ref) => ref.key === 'cognipeer',
    reserve: async () => { throw new Error('not in these tests'); },
    pricer: async () => answer,
  });

  beforeEach(() => {
    hoisted.recordUsageEvent.mockClear();
    hoisted.getDatabase.mockReset();
    pricer.mockClear();
  });
  afterEach(() => resetManagedCreditsHostForTests());

  it('prices its calls in credits at the tenant rate, the call count included', async () => {
    install(pricer);
    hoisted.getDatabase.mockResolvedValue(makeDb({ models: [platform] }));
    await recordTraceModelUsage({
      ...base,
      events: [
        { model: 'cognipeer.chat', inputTokens: 1000, outputTokens: 100 },
        { model: 'cognipeer.chat', inputTokens: 3000, outputTokens: 300 },
      ],
    });
    expect(pricer).toHaveBeenCalledWith(
      { providerKey: 'cognipeer', modelKey: 'cognipeer.chat', modelId: 'chat-1', kind: 'chat' },
      { inputTokens: 4000, outputTokens: 400, cachedInputTokens: 0, calls: 2 },
    );
    expect(hoisted.recordUsageEvent.mock.calls[0][0]).toMatchObject({ refKey: 'cognipeer.chat', costUsd: 0.04 });
  });

  it('stays at its token price (0) when no rate is known, and an own model is never asked about', async () => {
    install(null);
    hoisted.getDatabase.mockResolvedValue(makeDb({
      models: [platform, { key: 'own', modelId: 'gpt-x', providerKey: 'openai', category: 'llm', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 0 } }],
    }));
    await recordTraceModelUsage({
      ...base,
      events: [
        { model: 'cognipeer.chat', inputTokens: 1000, outputTokens: 100 },
        { model: 'own', inputTokens: 1_000_000, outputTokens: 0 },
      ],
    });
    const rows = hoisted.recordUsageEvent.mock.calls.map((call) => call[0]);
    expect(rows.find((row) => row.refKey === 'cognipeer.chat')).toMatchObject({ costUsd: 0 });
    expect(rows.find((row) => row.refKey === 'own')).toMatchObject({ costUsd: 1 });
  });
});
