/**
 * Unit tests — cost service (observed-model grouping + external pricing).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { getDatabase } from '@/lib/database';
import {
  getAgentCosts,
  getCostReport,
  getObservedModelCosts,
  getPricingCatalog,
  repriceExternalModelUsage,
  resolveExternalPricingForDay,
  upsertExternalPricing,
} from '@/lib/services/cost/costService';
import { createMockDb, type MockDb } from '../helpers/db.mock';

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'project-1' };

function usageRow(overrides: Record<string, unknown>) {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: '',
    apiTokenId: '',
    actorType: '',
    source: 'api',
    service: 'models',
    refKey: 'gpt-4o',
    agentKey: '',
    day: '2026-08-10',
    requests: 1,
    errors: 0,
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    totalTokens: 150,
    costUsd: 0.01,
    latencyMsSum: 0,
    latencyCount: 0,
    ...overrides,
  };
}

describe('getObservedModelCosts', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('groups rows per model and resolves hub / external / unpriced status', async () => {
    db.listUsageDaily.mockResolvedValue([
      usageRow({ refKey: 'gpt-4o', costUsd: 0.02, source: 'api' }),
      usageRow({ refKey: 'gpt-4o', costUsd: 0.03, source: 'tracing', units: { modelCalls: 2 } }),
      usageRow({ refKey: 'claude-sonnet-4-5', costUsd: 0.5, source: 'tracing' }),
      usageRow({ refKey: 'mystery-model', costUsd: 0, totalTokens: 4000, source: 'tracing' }),
    ] as never);
    db.listModels.mockResolvedValue([
      { key: 'gpt-4o', name: 'GPT-4o', modelId: 'gpt-4o', providerKey: 'openai', pricing: { inputTokenPer1M: 2.5, outputTokenPer1M: 10 } },
    ] as never);
    db.listExternalModelPricing.mockResolvedValue([
      { modelName: 'claude-sonnet-4-5', normalizedName: 'claude-sonnet-4-5', projectId: 'project-1', pricing: { inputTokenPer1M: 3, outputTokenPer1M: 15 } },
    ] as never);

    const result = await getObservedModelCosts(CTX, {});

    const byKey = Object.fromEntries(result.entries.map((entry) => [entry.modelKey, entry]));
    expect(byKey['gpt-4o'].status).toBe('hub');
    expect(byKey['gpt-4o'].costUsd).toBeCloseTo(0.05);
    expect(byKey['gpt-4o'].costBySource).toEqual({ api: 0.02, tracing: 0.03 });
    expect(byKey['gpt-4o'].modelCalls).toBe(2);
    expect(byKey['claude-sonnet-4-5'].status).toBe('external');
    expect(byKey['mystery-model'].status).toBe('unpriced');
    expect(result.totals.unpricedModels).toBe(1);
    expect(result.totals.unpricedTokens).toBe(4000);
  });

  it('project-scoped catalog entries override tenant-wide ones', async () => {
    db.listUsageDaily.mockResolvedValue([
      usageRow({ refKey: 'llama-3-70b', costUsd: 0, source: 'tracing' }),
    ] as never);
    db.listModels.mockResolvedValue([] as never);
    db.listExternalModelPricing.mockResolvedValue([
      { modelName: 'llama-3-70b', normalizedName: 'llama-3-70b', projectId: 'project-1', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 } },
      { modelName: 'llama-3-70b', normalizedName: 'llama-3-70b', projectId: '', pricing: { inputTokenPer1M: 9, outputTokenPer1M: 9 } },
    ] as never);

    const result = await getObservedModelCosts(CTX, {});
    expect(result.entries[0].pricing?.inputTokenPer1M).toBe(1);
  });
});

describe('getAgentCosts', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('groups per agent with per-model splits and flags unpriced usage', async () => {
    db.listUsageDaily.mockResolvedValue([
      usageRow({ agentKey: 'support-agent', refKey: 'gpt-4o', costUsd: 0.2, source: 'tracing', units: { modelCalls: 3 } }),
      usageRow({ agentKey: 'support-agent', refKey: 'mystery-model', costUsd: 0, totalTokens: 900, source: 'tracing' }),
      usageRow({ agentKey: 'sales-agent', refKey: 'gpt-4o', costUsd: 0.9, source: 'tracing' }),
      usageRow({ agentKey: '', refKey: 'gpt-4o', costUsd: 0.1, source: 'api' }),
    ] as never);
    db.listModels.mockResolvedValue([
      { key: 'gpt-4o', name: 'GPT-4o', modelId: 'gpt-4o', pricing: { inputTokenPer1M: 2.5, outputTokenPer1M: 10 } },
    ] as never);
    db.listExternalModelPricing.mockResolvedValue([] as never);

    const result = await getAgentCosts(CTX, {});

    expect(result.entries.map((entry) => entry.agentKey)).toEqual(['sales-agent', 'support-agent', '']);
    const support = result.entries.find((entry) => entry.agentKey === 'support-agent')!;
    expect(support.models).toHaveLength(2);
    expect(support.hasUnpricedUsage).toBe(true);
    expect(support.modelCalls).toBe(3);
    const sales = result.entries.find((entry) => entry.agentKey === 'sales-agent')!;
    expect(sales.hasUnpricedUsage).toBe(false);
    expect(result.totals.costUsd).toBeCloseTo(1.2);
  });
});

describe('upsertExternalPricing', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('rejects names colliding with a Model Hub key', async () => {
    db.listModels.mockResolvedValue([
      { key: 'gpt-4o', name: 'GPT-4o', modelId: 'gpt-4o', pricing: { inputTokenPer1M: 2.5, outputTokenPer1M: 10 } },
    ] as never);
    await expect(
      upsertExternalPricing(CTX, { modelName: 'GPT-4O', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 } }),
    ).rejects.toThrow(/Model Hub/);
  });

  it('rejects negative rates and requires a name', async () => {
    db.listModels.mockResolvedValue([] as never);
    await expect(
      upsertExternalPricing(CTX, { modelName: ' ', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 } }),
    ).rejects.toThrow(/modelName/);
    await expect(
      upsertExternalPricing(CTX, { modelName: 'm', pricing: { inputTokenPer1M: -1, outputTokenPer1M: 1 } }),
    ).rejects.toThrow(/non-negative/);
  });

  it('normalizes and persists a valid entry', async () => {
    db.listModels.mockResolvedValue([] as never);
    db.upsertExternalModelPricing.mockResolvedValue({
      modelName: 'claude-sonnet-4-5',
      normalizedName: 'claude-sonnet-4-5',
      pricing: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15, cachedTokenPer1M: 0 },
    } as never);

    await upsertExternalPricing(CTX, {
      modelName: '  claude-sonnet-4-5  ',
      pricing: { inputTokenPer1M: 3, outputTokenPer1M: 15 },
      updatedBy: 'user-1',
    });

    expect(db.upsertExternalModelPricing).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'claude-sonnet-4-5',
        projectId: 'project-1',
        pricing: expect.objectContaining({ currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15 }),
      }),
    );
  });

  it('rejects a malformed effectiveFrom', async () => {
    db.listModels.mockResolvedValue([] as never);
    await expect(
      upsertExternalPricing(CTX, {
        modelName: 'm',
        pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 },
        effectiveFrom: '08/01/2026',
      }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('appends an effective-dated version and keeps prior history', async () => {
    db.listModels.mockResolvedValue([] as never);
    db.listExternalModelPricing.mockResolvedValue([
      {
        modelName: 'claude-sonnet-4-5',
        normalizedName: 'claude-sonnet-4-5',
        projectId: 'project-1',
        pricing: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15 },
      },
    ] as never);
    db.upsertExternalModelPricing.mockImplementation(async (entry) => entry as never);

    await upsertExternalPricing(CTX, {
      modelName: 'claude-sonnet-4-5',
      pricing: { inputTokenPer1M: 4, outputTokenPer1M: 20 },
      effectiveFrom: '2026-08-01',
      updatedBy: 'user-1',
    });

    const stored = db.upsertExternalModelPricing.mock.calls[0][0];
    // Legacy single price seeded as the epoch version, dated version appended.
    expect(stored.versions).toHaveLength(2);
    expect(stored.versions?.[0].effectiveFrom).toBe('');
    expect(stored.versions?.[0].pricing.inputTokenPer1M).toBe(3);
    expect(stored.versions?.[1].effectiveFrom).toBe('2026-08-01');
    expect(stored.versions?.[1].pricing.inputTokenPer1M).toBe(4);
    // Current price = version effective today (2026-08-01 is in the past).
    expect(stored.pricing.inputTokenPer1M).toBe(4);
  });

  it('stores tenant-wide entries with an empty projectId', async () => {
    db.listModels.mockResolvedValue([] as never);
    db.upsertExternalModelPricing.mockImplementation(async (entry) => entry as never);

    await upsertExternalPricing(CTX, {
      modelName: 'llama-3-70b',
      pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
      tenantWide: true,
    });

    expect(db.listModels).toHaveBeenCalledWith({ projectId: undefined });
    expect(db.upsertExternalModelPricing).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: '' }),
    );
  });
});

describe('resolveExternalPricingForDay', () => {
  const versions = [
    { effectiveFrom: '', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 } },
    { effectiveFrom: '2026-08-01', pricing: { inputTokenPer1M: 3, outputTokenPer1M: 6 } },
    { effectiveFrom: '2026-08-10', pricing: { inputTokenPer1M: 5, outputTokenPer1M: 10 } },
  ];

  it('picks the version effective on the day', () => {
    const entry = { pricing: versions[2].pricing, versions };
    expect(resolveExternalPricingForDay(entry, '2026-07-01')?.inputTokenPer1M).toBe(1);
    expect(resolveExternalPricingForDay(entry, '2026-08-05')?.inputTokenPer1M).toBe(3);
    expect(resolveExternalPricingForDay(entry, '2026-08-10')?.inputTokenPer1M).toBe(5);
    expect(resolveExternalPricingForDay(entry, '2026-09-01')?.inputTokenPer1M).toBe(5);
  });

  it('falls back to the single price for legacy entries', () => {
    const entry = { pricing: { inputTokenPer1M: 7, outputTokenPer1M: 7 } };
    expect(resolveExternalPricingForDay(entry, '2020-01-01')?.inputTokenPer1M).toBe(7);
  });

  it('returns undefined when every version starts after the day', () => {
    const entry = {
      pricing: { inputTokenPer1M: 9, outputTokenPer1M: 9 },
      versions: [{ effectiveFrom: '2026-08-10', pricing: { inputTokenPer1M: 9, outputTokenPer1M: 9 } }],
    };
    expect(resolveExternalPricingForDay(entry, '2026-08-01')).toBeUndefined();
  });
});

describe('repriceExternalModelUsage', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('recomputes row costs with the price effective on each day', async () => {
    db.listUsageDaily.mockResolvedValue([
      // 1M input tokens on each day; old price $1/1M → recorded $1.
      usageRow({ _id: 'row-1', refKey: 'Claude-Sonnet-4-5', day: '2026-07-01', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, costUsd: 1 }),
      usageRow({ _id: 'row-2', refKey: 'claude-sonnet-4-5', day: '2026-08-05', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, costUsd: 1 }),
      usageRow({ _id: 'row-3', refKey: 'other-model', day: '2026-08-05', costUsd: 1 }),
    ] as never);
    db.listModels.mockResolvedValue([] as never);
    db.listExternalModelPricing.mockResolvedValue([
      {
        modelName: 'claude-sonnet-4-5',
        normalizedName: 'claude-sonnet-4-5',
        projectId: 'project-1',
        pricing: { inputTokenPer1M: 3, outputTokenPer1M: 6 },
        versions: [
          { effectiveFrom: '', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 } },
          { effectiveFrom: '2026-08-01', pricing: { inputTokenPer1M: 3, outputTokenPer1M: 6 } },
        ],
      },
    ] as never);
    db.setUsageDailyCost.mockResolvedValue(1 as never);

    const result = await repriceExternalModelUsage(CTX, { modelName: 'claude-sonnet-4-5' });

    // row-1 keeps $1 (epoch price unchanged), row-2 goes to $3, row-3 ignored.
    expect(db.setUsageDailyCost).toHaveBeenCalledWith([{ id: 'row-2', costUsd: 3 }]);
    expect(result.rowsScanned).toBe(2);
    expect(result.costBefore).toBeCloseTo(2);
    expect(result.costAfter).toBeCloseTo(4);
  });

  it('keeps a row untouched when no version covers its day', async () => {
    db.listUsageDaily.mockResolvedValue([
      usageRow({ _id: 'row-1', refKey: 'm', day: '2026-07-01', costUsd: 0.5 }),
    ] as never);
    db.listModels.mockResolvedValue([] as never);
    db.listExternalModelPricing.mockResolvedValue([
      {
        modelName: 'm',
        normalizedName: 'm',
        projectId: 'project-1',
        pricing: { inputTokenPer1M: 3, outputTokenPer1M: 6 },
        versions: [{ effectiveFrom: '2026-08-01', pricing: { inputTokenPer1M: 3, outputTokenPer1M: 6 } }],
      },
    ] as never);

    const result = await repriceExternalModelUsage(CTX, { modelName: 'm' });
    expect(db.setUsageDailyCost).not.toHaveBeenCalled();
    expect(result.rowsUpdated).toBe(0);
    expect(result.costAfter).toBeCloseTo(0.5);
  });

  it('rejects hub models and unknown entries', async () => {
    db.listUsageDaily.mockResolvedValue([] as never);
    db.listModels.mockResolvedValue([
      { key: 'gpt-4o', name: 'GPT-4o', modelId: 'gpt-4o', pricing: { inputTokenPer1M: 2.5, outputTokenPer1M: 10 } },
    ] as never);
    db.listExternalModelPricing.mockResolvedValue([] as never);

    await expect(repriceExternalModelUsage(CTX, { modelName: 'gpt-4o' })).rejects.toThrow(/Model Hub/);
    await expect(repriceExternalModelUsage(CTX, { modelName: 'nope' })).rejects.toThrow(/No pricing entry/);
  });
});

describe('getPricingCatalog', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('merges hub models, external entries, and observed usage', async () => {
    db.listModels.mockResolvedValue([
      { key: 'gpt-4o', name: 'GPT-4o', modelId: 'gpt-4o', providerKey: 'openai', pricing: { inputTokenPer1M: 2.5, outputTokenPer1M: 10 } },
      { key: 'unused-hub-model', name: 'Unused', modelId: 'unused', providerKey: 'openai', pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1 } },
    ] as never);
    db.listExternalModelPricing.mockResolvedValue([
      {
        modelName: 'claude-sonnet-4-5',
        normalizedName: 'claude-sonnet-4-5',
        projectId: '',
        pricing: { inputTokenPer1M: 3, outputTokenPer1M: 15 },
      },
    ] as never);
    db.listUsageDaily.mockResolvedValue([
      usageRow({ refKey: 'gpt-4o', costUsd: 0.5, day: '2026-08-12' }),
      usageRow({ refKey: 'claude-sonnet-4-5', costUsd: 0.4, day: '2026-08-13', units: { modelCalls: 2 } }),
      usageRow({ refKey: 'mystery-model', costUsd: 0, totalTokens: 900, day: '2026-08-10' }),
    ] as never);

    const catalog = await getPricingCatalog(CTX, {});

    const byKey = Object.fromEntries(catalog.entries.map((entry) => [entry.modelKey.toLowerCase(), entry]));
    expect(byKey['gpt-4o'].status).toBe('hub');
    expect(byKey['gpt-4o'].observed).toBe(true);
    expect(byKey['unused-hub-model'].observed).toBe(false);
    expect(byKey['claude-sonnet-4-5'].status).toBe('external');
    expect(byKey['claude-sonnet-4-5'].entryScope).toBe('tenant');
    expect(byKey['claude-sonnet-4-5'].versions).toHaveLength(1);
    expect(byKey['mystery-model'].status).toBe('unpriced');
    expect(catalog.totals).toEqual({ models: 4, hub: 2, external: 1, unpriced: 1 });
  });
});

describe('getCostReport', () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('buckets spend by week (Monday) and ranks models and agents', async () => {
    db.listUsageDaily.mockResolvedValue([
      // 2026-08-10 is a Monday; 2026-08-05 falls in the week of 2026-08-03.
      usageRow({ day: '2026-08-05', costUsd: 1, refKey: 'gpt-4o', agentKey: 'support-agent' }),
      usageRow({ day: '2026-08-10', costUsd: 2, refKey: 'gpt-4o', agentKey: '' }),
      usageRow({ day: '2026-08-12', costUsd: 4, refKey: 'claude-sonnet-4-5', agentKey: 'sales-agent' }),
    ] as never);

    const report = await getCostReport(CTX, { granularity: 'weekly' });

    expect(report.series.map((bucket) => bucket.bucket)).toEqual(['2026-08-03', '2026-08-10']);
    expect(report.series[0].costUsd).toBeCloseTo(1);
    expect(report.series[1].costUsd).toBeCloseTo(6);
    expect(report.totals.costUsd).toBeCloseTo(7);
    expect(report.topModels[0].modelKey).toBe('claude-sonnet-4-5');
    expect(report.topAgents.map((agent) => agent.agentKey)).toEqual(['sales-agent', 'support-agent']);
  });

  it('buckets by month', async () => {
    db.listUsageDaily.mockResolvedValue([
      usageRow({ day: '2026-07-31', costUsd: 1 }),
      usageRow({ day: '2026-08-01', costUsd: 2 }),
    ] as never);

    const report = await getCostReport(CTX, { granularity: 'monthly' });
    expect(report.series.map((bucket) => bucket.bucket)).toEqual(['2026-07', '2026-08']);
  });
});
