import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelById: vi.fn(),
}));

vi.mock('@/lib/services/models/routingAnalytics', () => ({
  getRoutingAnalytics: vi.fn(),
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

import { getModelById } from '@/lib/services/models/modelService';
import { getRoutingAnalytics } from '@/lib/services/models/routingAnalytics';
import { resolveProjectContext } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const HEADERS = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

const router = {
  _id: 'router-1',
  key: 'smart-router',
  name: 'Smart router',
  projectId: 'project-1',
  settings: { dynamic: { strategy: 'rule-based', defaultModelKey: 'small', rules: [] } },
};

describe('GET /api/models/:id/routing-analytics', () => {
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
    (getRoutingAnalytics as ReturnType<typeof vi.fn>).mockResolvedValue({ totals: { requests: 3 } });
    app = await createFastifyApiTestApp(modelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns analytics for a Dynamic LLM over a clamped window', async () => {
    (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue(router);
    const res = await app.inject({ method: 'GET', url: '/api/models/router-1/routing-analytics?days=365', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ analytics: { totals: { requests: number } } }>(res.body).analytics.totals.requests).toBe(3);
    const [, model, projectId, window] = (getRoutingAnalytics as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(model.key).toBe('smart-router');
    expect(projectId).toBe('project-1');
    expect((window.to.getTime() - window.from.getTime()) / 86_400_000).toBe(90);
  });

  it('rejects a regular model', async () => {
    (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...router, settings: {} });
    const res = await app.inject({ method: 'GET', url: '/api/models/router-1/routing-analytics', headers: HEADERS });
    expect(res.statusCode).toBe(400);
    expect(getRoutingAnalytics).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown model', async () => {
    (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/models/missing/routing-analytics', headers: HEADERS });
    expect(res.statusCode).toBe(404);
  });
});
