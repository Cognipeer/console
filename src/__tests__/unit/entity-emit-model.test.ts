/**
 * Entity health emission — models. `logModelUsage` is the one funnel every
 * gateway call (chat, embeddings, audio, image, router rows) writes through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IModel } from '@/lib/database';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/entityMetrics/entityMetricsRollup', () => ({
  recordEntityMetric: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';

const MODEL = {
  _id: 'model-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'gpt-4o',
  name: 'GPT-4o',
  modelId: 'gpt-4o',
  category: 'llm',
  providerKey: 'openai',
  status: 'active',
  pricing: { currency: 'USD', inputTokenPer1M: 5, outputTokenPer1M: 15 },
} as unknown as IModel;

function base(over: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    route: 'chat.completions',
    status: 'success' as const,
    providerRequest: {},
    providerResponse: {},
    latencyMs: 420,
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ...over,
  };
}

describe('logModelUsage -> recordEntityMetric', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb());
  });

  it('records a successful call with latency, tokens and priced cost', async () => {
    await logModelUsage('tenant_acme', MODEL, base());

    expect(recordEntityMetric).toHaveBeenCalledTimes(1);
    expect(recordEntityMetric).toHaveBeenCalledWith(expect.objectContaining({
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      entityType: 'model',
      entityKey: 'gpt-4o',
      source: 'gateway',
      outcome: 'ok',
      latencyMs: 420,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: 20,
    }));
  });

  it('counts a cache hit as a request without feeding the latency histogram', async () => {
    await logModelUsage('tenant_acme', MODEL, base({ cacheHit: true, latencyMs: 3 }));

    const call = (recordEntityMetric as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.outcome).toBe('ok');
    expect(call.latencyMs).toBeNull();
  });

  it('maps error and cancelled statuses to their own outcomes', async () => {
    await logModelUsage('tenant_acme', MODEL, base({ status: 'error', usage: {} }));
    await logModelUsage('tenant_acme', MODEL, base({ status: 'cancelled', usage: {} }));

    const outcomes = (recordEntityMetric as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].outcome);
    expect(outcomes).toEqual(['error', 'cancelled']);
  });
});
