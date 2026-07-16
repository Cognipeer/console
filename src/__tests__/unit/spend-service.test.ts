import { describe, expect, it, vi, beforeEach } from 'vitest';

const db = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  aggregateModelUsage: vi.fn(),
  listUsageDaily: vi.fn(),
  findUserById: vi.fn(),
  listTenantApiTokens: vi.fn(),
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

const listModels = vi.fn();
vi.mock('@/lib/services/models/modelService', () => ({
  listModels: (...args: unknown[]) => listModels(...args),
}));

import { getSpendEntityBreakdown, getSpendReport } from '@/lib/services/spend/spendService';

const ctx = { tenantDbName: 'tenant_t1', tenantId: 't1', projectId: 'p1' };

function aggregate(overrides: Record<string, unknown>) {
  return {
    totalCalls: 0,
    successCalls: 0,
    errorCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    avgLatencyMs: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSpendReport', () => {
  it('sums per-model costs and merges timeseries periods', async () => {
    listModels.mockResolvedValue([
      { key: 'gpt', name: 'GPT', category: 'llm', providerKey: 'openai' },
      { key: 'embed', name: 'Embed', category: 'embedding', providerKey: 'openai' },
      { key: 'idle', name: 'Idle', category: 'llm', providerKey: 'openai' },
    ]);
    db.aggregateModelUsage
      .mockResolvedValueOnce(aggregate({
        modelKey: 'gpt',
        totalCalls: 10,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
        costSummary: { currency: 'USD', totalCost: 2.5 },
        timeseries: [
          { period: '2026-06-01', callCount: 4, inputTokens: 40, outputTokens: 20, cachedInputTokens: 0, totalTokens: 60, totalCost: 1 },
          { period: '2026-06-02', callCount: 6, inputTokens: 60, outputTokens: 30, cachedInputTokens: 0, totalTokens: 90, totalCost: 1.5 },
        ],
      }))
      .mockResolvedValueOnce(aggregate({
        modelKey: 'embed',
        totalCalls: 5,
        totalInputTokens: 500,
        totalTokens: 500,
        costSummary: { currency: 'USD', totalCost: 0.5 },
        timeseries: [
          { period: '2026-06-02', callCount: 5, inputTokens: 500, outputTokens: 0, cachedInputTokens: 0, totalTokens: 500, totalCost: 0.5 },
        ],
      }))
      .mockResolvedValueOnce(aggregate({ modelKey: 'idle' }));

    const report = await getSpendReport(ctx, { groupBy: 'day' });

    expect(report.totalCost).toBeCloseTo(3.0);
    expect(report.totalCalls).toBe(15);
    expect(report.totalTokens).toBe(650);
    // idle model (0 calls) is excluded; sorted by cost desc
    expect(report.byModel.map((m) => m.modelKey)).toEqual(['gpt', 'embed']);
    // periods merged across models
    expect(report.timeseries).toEqual([
      { period: '2026-06-01', calls: 4, totalTokens: 60, cost: 1 },
      { period: '2026-06-02', calls: 11, totalTokens: 590, cost: 2 },
    ]);
  });

  it('filters to a single model when modelKey is set', async () => {
    listModels.mockResolvedValue([
      { key: 'gpt', name: 'GPT', category: 'llm', providerKey: 'openai' },
      { key: 'other', name: 'Other', category: 'llm', providerKey: 'openai' },
    ]);
    db.aggregateModelUsage.mockResolvedValue(aggregate({
      modelKey: 'gpt',
      totalCalls: 1,
      totalTokens: 10,
      costSummary: { currency: 'USD', totalCost: 0.1 },
    }));

    const report = await getSpendReport(ctx, { modelKey: 'gpt' });
    expect(db.aggregateModelUsage).toHaveBeenCalledTimes(1);
    expect(report.byModel).toHaveLength(1);
    expect(report.byModel[0].modelKey).toBe('gpt');
  });
});

describe('getSpendEntityBreakdown', () => {
  it('reads usage_daily, groups per user and resolves names', async () => {
    db.listUsageDaily.mockResolvedValue([
      { userId: 'u1', apiTokenId: '', requests: 3, errors: 0, inputTokens: 30, outputTokens: 10, totalTokens: 40, costUsd: 0.4 },
      { userId: 'u1', apiTokenId: 't1', requests: 1, errors: 1, inputTokens: 5, outputTokens: 5, totalTokens: 10, costUsd: 0.1 },
      { userId: 'gone', apiTokenId: '', requests: 2, errors: 0, inputTokens: 2, outputTokens: 2, totalTokens: 4, costUsd: 5 },
    ]);
    db.findUserById.mockImplementation(async (id: string) =>
      id === 'u1' ? { _id: 'u1', name: 'Ada', email: 'ada@acme.io' } : null,
    );

    const breakdown = await getSpendEntityBreakdown(ctx, {
      entity: 'user',
      modelKey: 'gpt',
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-30T23:00:00.000Z'),
    });

    expect(db.listUsageDaily).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1',
      service: 'models',
      refKey: 'gpt',
      fromDay: '2026-06-01',
      toDay: '2026-06-30',
    }));

    expect(breakdown.entity).toBe('user');
    // sorted by cost desc; deleted user keeps its raw id without a name
    expect(breakdown.entries.map((entry) => entry.id)).toEqual(['gone', 'u1']);
    expect(breakdown.entries[0].name).toBeUndefined();
    expect(breakdown.entries[1]).toMatchObject({
      name: 'Ada',
      label: 'ada@acme.io',
      requests: 4,
      errors: 1,
      totalTokens: 50,
      costUsd: 0.5,
    });
    expect(breakdown.totals).toMatchObject({ requests: 6, costUsd: 5.5 });
  });

  it('groups per API token when entity is api_key', async () => {
    db.listUsageDaily.mockResolvedValue([
      { userId: 'u1', apiTokenId: 't1', requests: 2, errors: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.2 },
      { userId: 'u2', apiTokenId: '', requests: 1, errors: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.1 },
    ]);
    db.listTenantApiTokens.mockResolvedValue([{ _id: 't1', label: 'CI token' }]);

    const breakdown = await getSpendEntityBreakdown(ctx, { entity: 'api_key' });

    expect(db.listTenantApiTokens).toHaveBeenCalledWith('t1');
    expect(breakdown.entity).toBe('api_key');
    expect(breakdown.entries.map((entry) => entry.id)).toEqual(['t1', '']);
    expect(breakdown.entries[0].label).toBe('CI token');
    // dashboard/unattributed traffic collapses into the '' entry
    expect(breakdown.entries[1]).toMatchObject({ requests: 1, costUsd: 0.1 });
  });
});
