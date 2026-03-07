import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/models/modelService', () => ({
  getModelById: vi.fn(),
  listUsageLogs: vi.fn(),
  getUsageAggregate: vi.fn(),
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
} from '@/lib/services/models/modelService';
import { resolveProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
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
