import { describe, expect, it, vi, beforeEach } from 'vitest';

const db = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  aggregateModelUsage: vi.fn(),
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

const listModels = vi.fn();
vi.mock('@/lib/services/models/modelService', () => ({
  listModels: (...args: unknown[]) => listModels(...args),
}));

import { getSpendReport } from '@/lib/services/spend/spendService';

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
