import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelById: vi.fn(),
  listUsageLogs: vi.fn(),
  getUsageAggregate: vi.fn(),
  getModelUsageBreakdown: vi.fn(),
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

vi.mock('@/lib/utils/dashboardDateFilter', () => ({
  parseDashboardDateFilterFromSearchParams: vi.fn().mockReturnValue({ from: null, to: null }),
}));

import {
  getModelById,
  listUsageLogs,
  getUsageAggregate,
  getModelUsageBreakdown,
} from '@/lib/services/models/modelService';
import { resolveProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
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

describe('GET /api/models/:id/logs and /usage', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  const mockModel = { _id: 'model-1', key: 'gpt-4o', name: 'GPT-4o', projectId: 'project-1' };

  beforeEach(async () => {
    vi.clearAllMocks();
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectId: 'project-1',
      project: { _id: 'project-1' },
      user: { _id: 'user-1', role: 'owner', projectIds: ['project-1'] },
    });
    (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue(mockModel);
    // Models routes are wrapped in withApiRequestContext, which loads the
    // RBAC user from the DB and binds the tenant per request. Provide a mock
    // DB so the owner passes RBAC and runWithTenant passes through.
    const rbacDb = createMockDb();
    rbacDb.findUserById.mockResolvedValue({ _id: 'user-1', role: 'owner', tenantId: 'tenant-1' } as never);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(rbacDb);
    app = await createFastifyApiTestApp(modelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns logs on success', async () => {
    (listUsageLogs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { _id: 'log-1', modelKey: 'gpt-4o', requestTokens: 100, responseTokens: 200 },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/models/model-1/logs', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ logs: unknown[] }>(res.body);
    expect(body.logs).toHaveLength(1);
  });

  it('caps logs limit at 200', async () => {
    (listUsageLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await app.inject({ method: 'GET', url: '/api/models/model-1/logs?limit=999', headers: HEADERS });
    expect(listUsageLogs).toHaveBeenCalledWith(
      'tenant_acme',
      'gpt-4o',
      'project-1',
      expect.objectContaining({ limit: 200 }),
    );
  });

  it('returns usage aggregate on success', async () => {
    (getUsageAggregate as ReturnType<typeof vi.fn>).mockResolvedValue([
      { date: '2025-01-01', totalCalls: 50, totalTokens: 10000 },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/models/model-1/usage', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ usage: Array<{ totalCalls: number }> }>(res.body);
    expect(body.usage[0].totalCalls).toBe(50);
  });

  it('passes groupBy param to getUsageAggregate', async () => {
    (getUsageAggregate as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await app.inject({ method: 'GET', url: '/api/models/model-1/usage?groupBy=hour', headers: HEADERS });
    expect(getUsageAggregate).toHaveBeenCalledWith(
      'tenant_acme',
      'gpt-4o',
      'project-1',
      expect.objectContaining({ groupBy: 'hour' }),
    );
  });

  it('returns the usage breakdown with defaults (groupBy=user, last 30 days)', async () => {
    (getModelUsageBreakdown as ReturnType<typeof vi.fn>).mockResolvedValue({
      groupBy: 'user',
      totals: { requests: 5, errors: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.5 },
      entries: [{ id: 'user-9', name: 'Ada', label: 'ada@acme.io', requests: 5, errors: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.5 }],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/models/model-1/usage/breakdown',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ breakdown: { entries: Array<{ id: string }> } }>(res.body);
    expect(body.breakdown.entries[0].id).toBe('user-9');
    expect(getModelUsageBreakdown).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'gpt-4o',
      'project-1',
      expect.objectContaining({ groupBy: 'user', from: expect.any(Date), to: expect.any(Date) }),
    );
    const [, , , , options] = (getModelUsageBreakdown as ReturnType<typeof vi.fn>).mock.calls[0];
    const rangeMs = options.to.getTime() - options.from.getTime();
    expect(rangeMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('passes groupBy=token to the breakdown and rejects invalid values', async () => {
    (getModelUsageBreakdown as ReturnType<typeof vi.fn>).mockResolvedValue({
      groupBy: 'token', totals: {}, entries: [],
    });
    const ok = await app.inject({
      method: 'GET',
      url: '/api/models/model-1/usage/breakdown?groupBy=token',
      headers: HEADERS,
    });
    expect(ok.statusCode).toBe(200);
    expect(getModelUsageBreakdown).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'gpt-4o',
      'project-1',
      expect.objectContaining({ groupBy: 'token' }),
    );

    const bad = await app.inject({
      method: 'GET',
      url: '/api/models/model-1/usage/breakdown?groupBy=nope',
      headers: HEADERS,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('returns 404 when model not found', async () => {
    (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/models/model-1/logs', headers: HEADERS });
    expect(res.statusCode).toBe(404);
  });

  it('returns ProjectContextError status', async () => {
    const ProjectError = ProjectContextError as unknown as new (message: string, status: number) => Error;
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ProjectError('No project', 400),
    );
    const res = await app.inject({ method: 'GET', url: '/api/models/model-1/usage', headers: HEADERS });
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    (getUsageAggregate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const res = await app.inject({ method: 'GET', url: '/api/models/model-1/usage', headers: HEADERS });
    expect(res.statusCode).toBe(500);
  });
});
