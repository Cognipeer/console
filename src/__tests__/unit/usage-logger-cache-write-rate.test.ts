/**
 * The persisted usage row prices a cache write like the budget path does: a Claude model with no cache-write price
 * entered is billed at 1.25 x the input price (flagged assumed), any other model at the input rate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createModelUsageLog = vi.fn();

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => ({ switchToTenant: vi.fn(), createModelUsageLog })),
}));
vi.mock('@/lib/services/usage/usageEvents', () => ({ recordUsageEvent: vi.fn(() => ({})) }));
vi.mock('@/lib/services/entityMetrics/entityMetricsRollup', () => ({ recordEntityMetric: vi.fn() }));
vi.mock('@/lib/services/logRedaction', () => ({ redactLogPayload: (v: unknown) => v, redactLogString: (v: unknown) => v }));
vi.mock('@/lib/services/logPiiRedaction', () => ({
  redactPiiFromLogPayload: async (v: unknown) => v,
  redactPiiFromLogString: async (v: unknown) => v,
}));
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({ recordRoutedUsage: vi.fn() }));

import { calculateCost, logModelUsage } from '@/lib/services/models/usageLogger';
import { buildCostEstimator } from '@/lib/services/agents/agentTurnState';

const pricing = { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15 };
const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedWriteTokens: 1_000_000 };

function modelOf(providerDriver: string, modelId: string) {
  return { key: 'm', tenantId: 't', projectId: 'p', providerDriver, modelId, pricing } as never;
}

async function logged(providerDriver: string, modelId: string, extra: Record<string, unknown> = {}) {
  createModelUsageLog.mockClear();
  await logModelUsage('db', modelOf(providerDriver, modelId), {
    requestId: 'r', route: 'chat', status: 'success', providerRequest: {}, providerResponse: {}, usage, ...extra,
  });
  return createModelUsageLog.mock.calls[0][0].pricingSnapshot as Record<string, unknown>;
}

describe('logModelUsage cache-write pricing', () => {
  beforeEach(() => createModelUsageLog.mockReset());

  it('a Claude model with no write price stores 1.25 x the input rate and flags it assumed', async () => {
    const snap = await logged('anthropic', 'claude-sonnet-4-5');
    expect(snap.cacheWriteCost).toBeCloseTo(3.75);
    expect(snap.totalCost).toBeCloseTo(3.75);
    expect(snap.assumedRates).toEqual(['cacheWrite']);
  });

  it('a Claude model on Bedrock is priced the same', async () => {
    const snap = await logged('bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(snap.cacheWriteCost).toBeCloseTo(3.75);
    expect(snap.assumedRates).toEqual(['cacheWrite']);
  });

  it('a GPT model stores the input rate (still flagged assumed)', async () => {
    const snap = await logged('openai', 'gpt-5');
    expect(snap.cacheWriteCost).toBeCloseTo(3);
    expect(snap.assumedRates).toEqual(['cacheWrite']);
  });

  it('an entered write price is used as is and not flagged', async () => {
    createModelUsageLog.mockClear();
    const model = { ...(modelOf('anthropic', 'claude-sonnet-4-5') as object), pricing: { ...pricing, cacheWriteTokenPer1M: 6 } } as never;
    await logModelUsage('db', model, { requestId: 'r', route: 'chat', status: 'success', providerRequest: {}, providerResponse: {}, usage });
    const snap = createModelUsageLog.mock.calls[0][0].pricingSnapshot as Record<string, unknown>;
    expect(snap.cacheWriteCost).toBeCloseTo(6);
    expect(snap.assumedRates).toBeUndefined();
  });

  it('the routing baseline is priced with its own model context', async () => {
    const snap = await logged('openai', 'gpt-5', {
      routing: { role: 'child' },
      routingBaselinePricing: pricing,
      routingBaselineModel: { providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' },
    });
    expect(snap.cacheWriteCost).toBeCloseTo(3);
    const row = createModelUsageLog.mock.calls[0][0];
    expect(row.routing.baselineCostUsd).toBeCloseTo(3.75);
    expect(calculateCost(pricing as never, usage).totalCost).toBeCloseTo(3);
  });
});

describe('buildCostEstimator model context', () => {
  it('prices a Claude cache write at 1.25 x for the matched model and for the fallback model', () => {
    const args = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 };
    const claude = { providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' };
    const gpt = { providerDriver: 'openai', modelId: 'gpt-5' };
    const estimate = buildCostEstimator(
      [{ names: ['claude-sonnet-4-5'], pricing: pricing as never, model: claude }, { names: ['gpt-5'], pricing: pricing as never, model: gpt }],
      pricing as never,
      calculateCost,
      claude,
    )!;
    expect(estimate({ ...args, modelName: 'claude-sonnet-4-5' } as never)).toBeCloseTo(3.75);
    expect(estimate({ ...args, modelName: 'gpt-5' } as never)).toBeCloseTo(3);
    expect(estimate({ ...args, modelName: 'unknown' } as never)).toBeCloseTo(3.75);
  });
});
