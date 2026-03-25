/**
 * Unit tests — Usage Logger
 * calculateCost is a pure function; logModelUsage is tested with mocked DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IModel, IModelPricing } from '@/lib/database';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { calculateCost, logModelUsage } from '@/lib/services/models/usageLogger';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PRICING: IModelPricing = {
  currency: 'USD',
  inputTokenPer1M: 5.0,
  outputTokenPer1M: 15.0,
  cachedTokenPer1M: 0.5,
};

const PRICING_NO_CACHE: IModelPricing = {
  currency: 'USD',
  inputTokenPer1M: 3.0,
  outputTokenPer1M: 12.0,
};

const MOCK_MODEL: IModel = {
  _id: 'model-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'gpt-4o',
  name: 'GPT-4o',
  modelId: 'gpt-4o',
  category: 'llm',
  providerKey: 'openai',
  status: 'active',
  pricing: PRICING,
  createdBy: 'user-1',
} as unknown as IModel;

// ── calculateCost (pure function) ─────────────────────────────────────────────

describe('calculateCost', () => {
  it('computes costs correctly for basic usage', () => {
    const result = calculateCost(PRICING, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    });
    expect(result.inputCost).toBeCloseTo(5.0);
    expect(result.outputCost).toBeCloseTo(15.0);
    expect(result.cachedCost).toBeCloseTo(0);
    expect(result.totalCost).toBeCloseTo(20.0);
    expect(result.currency).toBe('USD');
  });

  it('computes cached token cost', () => {
    const result = calculateCost(PRICING, {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 2_000_000,
    });
    expect(result.cachedCost).toBeCloseTo(1.0);
  });

  it('handles zero usage gracefully', () => {
    const result = calculateCost(PRICING, {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    expect(result.totalCost).toBe(0);
  });

  it('handles missing optional token fields', () => {
    const result = calculateCost(PRICING, {});
    expect(result.inputCost).toBe(0);
    expect(result.outputCost).toBe(0);
    expect(result.cachedCost).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  it('handles pricing with no cachedTokenPer1M field', () => {
    const result = calculateCost(PRICING_NO_CACHE, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(result.inputCost).toBeCloseTo(3.0);
    expect(result.outputCost).toBeCloseTo(6.0);
    expect(result.cachedCost).toBe(0); // defaults to 0
  });

  it('uses correct currency from pricing', () => {
    const eurPricing: IModelPricing = { ...PRICING, currency: 'EUR' };
    const result = calculateCost(eurPricing, { inputTokens: 1000 });
    expect(result.currency).toBe('EUR');
  });

  it('calculates partial million tokens proportionally', () => {
    const result = calculateCost(PRICING, {
      inputTokens: 500_000,  // half a million
      outputTokens: 250_000, // quarter million
    });
    expect(result.inputCost).toBeCloseTo(2.5);
    expect(result.outputCost).toBeCloseTo(3.75);
  });

  it('returns totalCost as sum of all costs', () => {
    const result = calculateCost(PRICING, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    });
    expect(result.totalCost).toBeCloseTo(result.inputCost + result.outputCost + result.cachedCost);
  });
});

// ── logModelUsage ─────────────────────────────────────────────────────────────

describe('logModelUsage', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('creates a model usage log with correct fields', async () => {
    await logModelUsage('tenant_acme', MOCK_MODEL, {
      requestId: 'req-001',
      route: '/api/chat',
      status: 'success',
      providerRequest: { messages: [] },
      providerResponse: { id: 'res-001' },
      latencyMs: 450,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 10,
        totalTokens: 160,
        toolCalls: 1,
      },
    });

    expect(db.createModelUsageLog).toHaveBeenCalledTimes(1);
    const payload = db.createModelUsageLog.mock.calls[0][0];

    expect(payload.requestId).toBe('req-001');
    expect(payload.route).toBe('/api/chat');
    expect(payload.status).toBe('success');
    expect(payload.inputTokens).toBe(100);
    expect(payload.outputTokens).toBe(50);
    expect(payload.cachedInputTokens).toBe(10);
    expect(payload.totalTokens).toBe(160);
    expect(payload.toolCalls).toBe(1);
    expect(payload.latencyMs).toBe(450);
    expect(payload.modelKey).toBe('gpt-4o');
    expect(payload.tenantId).toBe('tenant-1');
    expect(payload.projectId).toBe('proj-1');
  });

  it('switches to the correct tenant database', async () => {
    await logModelUsage('tenant_acme', MOCK_MODEL, {
      requestId: 'req-002',
      route: '/api/embed',
      status: 'success',
      providerRequest: {},
      providerResponse: {},
      usage: { inputTokens: 10, outputTokens: 0 },
    });

    expect(db.switchToTenant).toHaveBeenCalledWith('tenant_acme');
  });

  it('includes pricing snapshot in the log', async () => {
    await logModelUsage('tenant_acme', MOCK_MODEL, {
      requestId: 'req-003',
      route: '/api/chat',
      status: 'success',
      providerRequest: {},
      providerResponse: {},
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });

    const payload = db.createModelUsageLog.mock.calls[0][0];
    expect(payload.pricingSnapshot).toBeDefined();
    const snap = payload.pricingSnapshot as unknown as Record<string, unknown>;
    expect(snap['inputCost']).toBeCloseTo(5.0);
    expect(snap['currency']).toBe('USD');
  });

  it('defaults missing usage fields to 0', async () => {
    await logModelUsage('tenant_acme', MOCK_MODEL, {
      requestId: 'req-004',
      route: '/api/chat',
      status: 'error',
      providerRequest: {},
      providerResponse: {},
      errorMessage: 'timeout',
      usage: {},
    });

    const payload = db.createModelUsageLog.mock.calls[0][0];
    expect(payload.inputTokens).toBe(0);
    expect(payload.outputTokens).toBe(0);
    expect(payload.totalTokens).toBe(0);
    expect(payload.toolCalls).toBe(0);
    expect(payload.errorMessage).toBe('timeout');
    expect(payload.status).toBe('error');
  });

  it('records cacheHit flag when provided', async () => {
    await logModelUsage('tenant_acme', MOCK_MODEL, {
      requestId: 'req-005',
      route: '/api/chat',
      status: 'success',
      providerRequest: {},
      providerResponse: {},
      usage: {},
      cacheHit: true,
    });

    const payload = db.createModelUsageLog.mock.calls[0][0];
    expect(payload.cacheHit).toBe(true);
  });

  it('auto-calculates totalTokens when not provided', async () => {
    await logModelUsage('tenant_acme', MOCK_MODEL, {
      requestId: 'req-006',
      route: '/api/chat',
      status: 'success',
      providerRequest: {},
      providerResponse: {},
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const payload = db.createModelUsageLog.mock.calls[0][0];
    expect(payload.totalTokens).toBe(150);
  });
});
