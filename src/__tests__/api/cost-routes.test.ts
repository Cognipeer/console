import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/cost/costService', () => ({
  getObservedModelCosts: vi.fn(),
  getAgentCosts: vi.fn(),
  getPricingCatalog: vi.fn(),
  getCostReport: vi.fn(),
  listExternalPricing: vi.fn(),
  upsertExternalPricing: vi.fn(),
  deleteExternalPricing: vi.fn(),
  repriceExternalModelUsage: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return { resolveProjectContext: vi.fn(), ProjectContextError };
});

import {
  deleteExternalPricing,
  getAgentCosts,
  getCostReport,
  getObservedModelCosts,
  getPricingCatalog,
  listExternalPricing,
  repriceExternalModelUsage,
  upsertExternalPricing,
} from '@/lib/services/cost/costService';
import { resolveProjectContext } from '@/lib/services/projects/projectContext';
import { costApiPlugin } from '@/server/api/plugins/cost';
import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

const HEADERS = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

describe('Cost API routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectId: 'project-1',
      project: { _id: 'project-1' },
      user: { _id: 'user-1', role: 'owner', projectIds: ['project-1'] },
    });
    const rbacDb = createMockDb();
    rbacDb.findUserById.mockResolvedValue({ _id: 'user-1', role: 'owner', tenantId: 'tenant-1' } as never);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(rbacDb);
    app = await createFastifyApiTestApp(costApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/cost/models returns the observed model overview', async () => {
    (getObservedModelCosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      fromDay: '2026-07-15',
      toDay: '2026-08-14',
      totals: { requests: 12, totalTokens: 5000, costUsd: 1.5, unpricedTokens: 2000, unpricedModels: 1 },
      entries: [
        {
          modelKey: 'claude-sonnet-4-5',
          modelName: 'claude-sonnet-4-5',
          status: 'unpriced',
          requests: 4,
          inputTokens: 1500,
          outputTokens: 500,
          cachedInputTokens: 0,
          totalTokens: 2000,
          costUsd: 0,
          costBySource: { tracing: 0 },
          modelCalls: 4,
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/cost/models?from=2026-07-15T00:00:00.000Z', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ totals: { unpricedModels: number }; entries: unknown[] }>(res.body);
    expect(body.totals.unpricedModels).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(getObservedModelCosts).toHaveBeenCalledWith(
      expect.objectContaining({ tenantDbName: 'tenant_acme', projectId: 'project-1' }),
      expect.objectContaining({ from: new Date('2026-07-15T00:00:00.000Z') }),
    );
  });

  it('GET /api/cost/agents returns the per-agent breakdown', async () => {
    (getAgentCosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      fromDay: '2026-07-15',
      toDay: '2026-08-14',
      totals: { requests: 10, totalTokens: 8000, costUsd: 2.4 },
      entries: [
        {
          agentKey: 'support-agent',
          requests: 6,
          modelCalls: 12,
          inputTokens: 5000,
          outputTokens: 3000,
          totalTokens: 8000,
          costUsd: 2.4,
          models: [
            { modelKey: 'claude-sonnet-4-5', status: 'external', requests: 6, totalTokens: 8000, costUsd: 2.4 },
          ],
          hasUnpricedUsage: false,
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/cost/agents', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ entries: Array<{ agentKey: string; models: unknown[] }> }>(res.body);
    expect(body.entries[0].agentKey).toBe('support-agent');
    expect(body.entries[0].models).toHaveLength(1);
    expect(getAgentCosts).toHaveBeenCalledWith(
      expect.objectContaining({ tenantDbName: 'tenant_acme', projectId: 'project-1' }),
      expect.anything(),
    );
  });

  it('GET /api/cost/pricing lists catalog entries', async () => {
    (listExternalPricing as ReturnType<typeof vi.fn>).mockResolvedValue([
      { modelName: 'claude-sonnet-4-5', normalizedName: 'claude-sonnet-4-5', pricing: { inputTokenPer1M: 3, outputTokenPer1M: 15 } },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/cost/pricing', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ entries: unknown[] }>(res.body).entries).toHaveLength(1);
  });

  it('PUT /api/cost/pricing upserts an entry', async () => {
    (upsertExternalPricing as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelName: 'claude-sonnet-4-5',
      pricing: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15, cachedTokenPer1M: 0 },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cost/pricing',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { modelName: 'claude-sonnet-4-5', pricing: { inputTokenPer1M: 3, outputTokenPer1M: 15 } },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertExternalPricing).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
      expect.objectContaining({ modelName: 'claude-sonnet-4-5', updatedBy: 'user-1' }),
    );
  });

  it('PUT /api/cost/pricing rejects a missing model name', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cost/pricing',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { pricing: { inputTokenPer1M: 3 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/cost/pricing surfaces validation errors as 400', async () => {
    (upsertExternalPricing as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('"gpt-4o" is a Model Hub model — edit its pricing in the Model Hub'),
    );
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cost/pricing',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { modelName: 'gpt-4o', pricing: { inputTokenPer1M: 3 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/cost/pricing/:modelName removes an entry', async () => {
    (deleteExternalPricing as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/cost/pricing/${encodeURIComponent('claude-sonnet-4-5')}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(deleteExternalPricing).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
      'claude-sonnet-4-5',
    );
  });

  it('DELETE /api/cost/pricing/:modelName returns 404 when absent', async () => {
    (deleteExternalPricing as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/cost/pricing/unknown-model',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/cost/models with scope=all widens to every project', async () => {
    (getObservedModelCosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      totals: { requests: 0, totalTokens: 0, costUsd: 0, unpricedTokens: 0, unpricedModels: 0 },
      entries: [],
    });
    const res = await app.inject({ method: 'GET', url: '/api/cost/models?scope=all', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(getObservedModelCosts).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined }),
      expect.anything(),
    );
  });

  it('GET /api/cost/pricing/catalog returns the unified catalog', async () => {
    (getPricingCatalog as ReturnType<typeof vi.fn>).mockResolvedValue({
      totals: { models: 2, hub: 1, external: 1, unpriced: 0 },
      entries: [
        { modelKey: 'gpt-4o', modelName: 'GPT-4o', status: 'hub', observed: true, requests: 1, totalTokens: 10, costUsd: 0.1, modelCalls: 0 },
        { modelKey: 'claude-sonnet-4-5', modelName: 'claude-sonnet-4-5', status: 'external', observed: false, requests: 0, totalTokens: 0, costUsd: 0, modelCalls: 0 },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/cost/pricing/catalog?scope=all', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ totals: { models: number }; entries: unknown[] }>(res.body);
    expect(body.totals.models).toBe(2);
    expect(getPricingCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined }),
      expect.anything(),
    );
  });

  it('PUT /api/cost/pricing forwards effectiveFrom and scope', async () => {
    (upsertExternalPricing as ReturnType<typeof vi.fn>).mockResolvedValue({ modelName: 'm' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cost/pricing',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {
        modelName: 'm',
        pricing: { inputTokenPer1M: 3, outputTokenPer1M: 15 },
        effectiveFrom: '2026-08-01',
        scope: 'all',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertExternalPricing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ effectiveFrom: '2026-08-01', tenantWide: true }),
    );
  });

  it('POST /api/cost/pricing/reprice recalculates recorded spend', async () => {
    (repriceExternalModelUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelName: 'claude-sonnet-4-5',
      rowsScanned: 4,
      rowsUpdated: 3,
      costBefore: 1,
      costAfter: 3,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/cost/pricing/reprice',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { modelName: 'claude-sonnet-4-5', from: '2026-08-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ rowsUpdated: number }>(res.body).rowsUpdated).toBe(3);
    expect(repriceExternalModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
      expect.objectContaining({ modelName: 'claude-sonnet-4-5', from: new Date('2026-08-01T00:00:00.000Z') }),
    );
  });

  it('POST /api/cost/pricing/reprice rejects a missing model name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cost/pricing/reprice',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/cost/pricing/reprice surfaces validation errors as 400', async () => {
    (repriceExternalModelUsage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('No pricing entry found for "nope" — add pricing first'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/cost/pricing/reprice',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      payload: { modelName: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/cost/reports returns the bucketed series', async () => {
    (getCostReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      granularity: 'weekly',
      totals: { requests: 3, totalTokens: 450, costUsd: 6 },
      series: [
        { bucket: '2026-08-03', requests: 1, errors: 0, totalTokens: 150, costUsd: 1 },
        { bucket: '2026-08-10', requests: 2, errors: 0, totalTokens: 300, costUsd: 5 },
      ],
      topModels: [{ modelKey: 'gpt-4o', requests: 3, totalTokens: 450, costUsd: 6 }],
      topAgents: [],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/cost/reports?granularity=weekly&scope=all',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ series: unknown[] }>(res.body);
    expect(body.series).toHaveLength(2);
    expect(getCostReport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined }),
      expect.objectContaining({ granularity: 'weekly' }),
    );
  });

  it('GET /api/cost/reports falls back to daily for unknown granularity', async () => {
    (getCostReport as ReturnType<typeof vi.fn>).mockResolvedValue({
      granularity: 'daily',
      totals: { requests: 0, totalTokens: 0, costUsd: 0 },
      series: [],
      topModels: [],
      topAgents: [],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/cost/reports?granularity=hourly',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(getCostReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granularity: 'daily' }),
    );
  });
});
