/**
 * `recordTraceModelUsage` writes trace-derived model usage into `usage_daily`
 * through `recordUsageEvent`. The pricing step was extracted into a shared
 * helper (also used by the entity-health emitters); these tests pin the exact
 * usage rows so the refactor cannot change what spend reports see.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  recordUsageEvent: vi.fn((_input: Record<string, unknown>) => ({})),
}));

vi.mock('@/lib/database', () => ({ getDatabase: hoisted.getDatabase }));
vi.mock('@/lib/services/usage/usageEvents', () => ({ recordUsageEvent: hoisted.recordUsageEvent }));

import { recordTraceModelUsage } from '@/lib/services/agentTracing';

const TENANT_DB = 'tenant_acme';

function makeDb(options: { models?: unknown[]; external?: unknown[] } = {}) {
  return {
    switchToTenant: vi.fn(async () => undefined),
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

    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
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

  it('never throws and does not touch the database when nothing is billable', async () => {
    hoisted.getDatabase.mockRejectedValue(new Error('db down'));
    await expect(recordTraceModelUsage({ ...base, events: [{ model: 'm', inputTokens: 1, outputTokens: 1 }] })).resolves.toBeUndefined();
    expect(hoisted.recordUsageEvent).not.toHaveBeenCalled();

    hoisted.getDatabase.mockClear();
    await recordTraceModelUsage({ ...base, events: [{ model: 'm', inputTokens: 0, outputTokens: 0 }] });
    expect(hoisted.getDatabase).not.toHaveBeenCalled();
  });
});
