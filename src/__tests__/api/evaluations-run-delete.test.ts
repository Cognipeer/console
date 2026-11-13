/**
 * DELETE /api/evaluation/runs/:id on the dashboard Evaluation API: tenant and
 * project scoped, 404 outside the scope, 409 while the run is in flight. The
 * service is mocked in the route block; the scoping rules are covered against
 * a fake database in the service block.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  deleteRun: vi.fn(),
  requireProjectContextForRequest: vi.fn(),
  db: {
    switchToTenant: vi.fn(),
    findEvaluationRunById: vi.fn(),
    deleteEvaluationRun: vi.fn(),
  },
}));

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return { ...actual, requireProjectContextForRequest: h.requireProjectContextForRequest };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));

describe('DELETE /evaluation/runs/:id (route)', () => {
  const headers = {
    'x-license-type': 'ENTERPRISE',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 'tenant-1',
    'x-user-id': 'user-1',
  };
  let app: Awaited<ReturnType<typeof import('../helpers/fastify-api').createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/lib/services/evaluation/service', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/services/evaluation/service')>()),
      deleteRun: h.deleteRun,
    }));
    h.deleteRun.mockReset();
    h.requireProjectContextForRequest.mockResolvedValue({
      projectId: 'proj-1',
      session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
    });
    const { evaluationsApiPlugin } = await import('@/server/api/plugins/evaluations');
    const { createFastifyApiTestApp } = await import('../helpers/fastify-api');
    app = await createFastifyApiTestApp(evaluationsApiPlugin, { rawJsonBody: true });
  });

  it('deletes a run of the caller project', async () => {
    h.deleteRun.mockResolvedValue('deleted');
    const res = await app.inject({ method: 'DELETE', url: '/api/evaluation/runs/run-1', headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(h.deleteRun).toHaveBeenCalledWith('tenant_acme', 'run-1', 'proj-1');
  });

  it('answers 404 for a run outside the scope', async () => {
    h.deleteRun.mockResolvedValue('not_found');
    const res = await app.inject({ method: 'DELETE', url: '/api/evaluation/runs/other', headers });
    expect(res.statusCode).toBe(404);
  });

  it('answers 409 for a run still in progress', async () => {
    h.deleteRun.mockResolvedValue('in_progress');
    const res = await app.inject({ method: 'DELETE', url: '/api/evaluation/runs/run-2', headers });
    expect(res.statusCode).toBe(409);
  });
});

describe('deleteRun (service)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('@/lib/services/evaluation/service');
    h.db.findEvaluationRunById.mockReset();
    h.db.deleteEvaluationRun.mockReset().mockResolvedValue(true);
  });

  async function load() {
    return (await import('@/lib/services/evaluation/service')).deleteRun;
  }

  it('does not touch a run of another project', async () => {
    h.db.findEvaluationRunById.mockResolvedValue({ _id: 'r1', projectId: 'proj-2', status: 'completed' });
    expect(await (await load())('tenant_acme', 'r1', 'proj-1')).toBe('not_found');
    expect(h.db.deleteEvaluationRun).not.toHaveBeenCalled();
  });

  it('deletes a finished run of the project', async () => {
    h.db.findEvaluationRunById.mockResolvedValue({ _id: 'r1', projectId: 'proj-1', status: 'completed' });
    expect(await (await load())('tenant_acme', 'r1', 'proj-1')).toBe('deleted');
    expect(h.db.deleteEvaluationRun).toHaveBeenCalledWith('r1');
  });

  it('refuses a recent running run but removes a stale one', async () => {
    const del = await load();
    h.db.findEvaluationRunById.mockResolvedValue({ projectId: 'proj-1', status: 'running', startedAt: new Date() });
    expect(await del('tenant_acme', 'r1', 'proj-1')).toBe('in_progress');
    h.db.findEvaluationRunById.mockResolvedValue({
      projectId: 'proj-1', status: 'running', startedAt: new Date(Date.now() - 2 * 3600_000),
    });
    expect(await del('tenant_acme', 'r1', 'proj-1')).toBe('deleted');
  });
});
