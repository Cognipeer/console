/**
 * Red-team records answer within the caller's active project: a campaign, run
 * or custom probe of another project reads as missing on every by-id route of
 * the dashboard API, and a client token reads the runs of its own project. Rows
 * stored before records carried a projectId stay reachable. The service is
 * stood in for, so these tests pin the routes' checks and that nothing is
 * changed for a record outside the project.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  deleteCampaign: vi.fn(),
  getRun: vi.fn(),
  compareRuns: vi.fn(),
  reviewAttempt: vi.fn(),
  cancelRun: vi.fn(),
  getCustomProbe: vi.fn(),
  updateCustomProbe: vi.fn(),
  deleteCustomProbe: vi.fn(),
}));

vi.mock('@/lib/services/redteam/service', () => ({
  createCampaign: vi.fn(),
  getCampaign: mocks.getCampaign,
  updateCampaign: mocks.updateCampaign,
  listCampaigns: vi.fn(async () => []),
  listCustomProbes: vi.fn(async () => []),
  compareRuns: mocks.compareRuns,
  createCustomProbe: vi.fn(),
  deleteCampaign: mocks.deleteCampaign,
  deleteCustomProbe: mocks.deleteCustomProbe,
  getCustomProbe: mocks.getCustomProbe,
  getOverview: vi.fn(),
  getRun: mocks.getRun,
  listRunsPage: vi.fn(async () => ({ runs: [], total: 0 })),
  cancelRun: mocks.cancelRun,
  reviewAttempt: mocks.reviewAttempt,
  updateCustomProbe: mocks.updateCustomProbe,
  validateCampaignInput: vi.fn(),
  CustomProbeError: class CustomProbeError extends Error {},
  RedTeamConflictError: class RedTeamConflictError extends Error {},
  RedTeamForbiddenError: class RedTeamForbiddenError extends Error {},
  RedTeamNotFoundError: class RedTeamNotFoundError extends Error {},
  RedTeamValidationError: class RedTeamValidationError extends Error {},
}));
vi.mock('@/lib/services/redteam/campaignJob', () => ({ enqueueCampaignRun: vi.fn() }));
vi.mock('@/server/api/restrictedKnowledgeRequest', () => ({
  restrictedKnowledgeReaderFor: vi.fn(() => ({ mayRead: async () => true })),
  withoutRestrictedAttempts: vi.fn(async (_request: unknown, _viewer: unknown, run: unknown) => run),
}));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  type Handler = (request: unknown, reply: unknown, ctx?: unknown) => unknown;
  const session = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', userId: 'user-1' };
  return {
    ...actual,
    authorizeServiceForRequest: vi.fn(async () => ({ allowed: true, service: 'agents', required: 'write' })),
    withApiRequestContext: (handler: Handler) => async (request: unknown, reply: unknown) => handler(request, reply),
    withClientApiRequestContext: (handler: Handler) => async (request: unknown, reply: unknown) => handler(request, reply),
    requireSessionContext: vi.fn(() => session),
    requireProjectContextForRequest: vi.fn(async () => ({ projectId: 'proj-1', session })),
    getApiTokenContextForRequest: vi.fn(async () => ({
      tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'proj-1', tokenRecord: { userId: 'user-1' },
    })),
  };
});

import { redTeamApiPlugin } from '@/server/api/plugins/redteam';
import { clientRedTeamApiPlugin } from '@/server/api/plugins/client-redteam';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

type App = Awaited<ReturnType<typeof createFastifyApiTestApp>>;

const campaign = (projectId?: string) => ({
  id: 'c1', key: 'model-scan', name: 'Model scan', targetKind: 'model', modelKey: 'm', probeKeys: [],
  ...(projectId !== undefined ? { projectId } : {}),
});
const run = (id: string, projectId?: string) => ({
  id, campaignKey: 'model-scan', status: 'completed', attempts: [],
  ...(projectId !== undefined ? { projectId } : {}),
});
const probe = (projectId?: string) => ({
  id: 'p1', key: 'custom:p', name: 'P', category: 'LLM01-prompt-injection', severity: 'high',
  attempts: [{ id: 'a1', turns: ['hi'] }], detectors: { refusal: true, pattern: true, judges: [] },
  ...(projectId !== undefined ? { projectId } : {}),
});

const PROBE_BODY = {
  name: 'P', category: 'LLM01-prompt-injection', severity: 'high', attempts: [{ id: 'a1', turns: ['hi'] }],
};

const call = (app: App, method: 'GET' | 'PATCH' | 'DELETE' | 'POST', url: string, payload?: unknown) =>
  app.inject({
    method, url,
    headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });

describe('dashboard red-team routes keep to the active project', () => {
  let app: App;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.updateCampaign.mockImplementation(async (_db, id, _user, data) => ({ id, ...data }));
    mocks.deleteCampaign.mockResolvedValue(true);
    mocks.compareRuns.mockResolvedValue({ regressed: [] });
    mocks.reviewAttempt.mockImplementation(async (_db, id) => run(id, 'proj-1'));
    mocks.cancelRun.mockImplementation(async (_db, id) => run(id, 'proj-1'));
    mocks.updateCustomProbe.mockImplementation(async (_db, id, _user, data) => ({ id, ...data }));
    mocks.deleteCustomProbe.mockResolvedValue({ deleted: true, usedBy: [] });
    app = await createFastifyApiTestApp(redTeamApiPlugin, { rawJsonBody: true });
  });

  describe('a campaign of another project', () => {
    beforeEach(() => mocks.getCampaign.mockResolvedValue(campaign('proj-2')));

    it('reads as missing', async () => {
      expect((await call(app, 'GET', '/api/redteam/campaigns/c1')).statusCode).toBe(404);
    });

    it('is not changed or deleted', async () => {
      expect((await call(app, 'PATCH', '/api/redteam/campaigns/c1', { name: 'Renamed' })).statusCode).toBe(404);
      expect((await call(app, 'DELETE', '/api/redteam/campaigns/c1')).statusCode).toBe(404);
      expect(mocks.updateCampaign).not.toHaveBeenCalled();
      expect(mocks.deleteCampaign).not.toHaveBeenCalled();
    });
  });

  it('serves a campaign of the active project, and one stored without a project', async () => {
    for (const projectId of ['proj-1', undefined]) {
      mocks.getCampaign.mockResolvedValue(campaign(projectId));
      expect((await call(app, 'GET', '/api/redteam/campaigns/c1')).statusCode).toBe(200);
      expect((await call(app, 'PATCH', '/api/redteam/campaigns/c1', { name: 'Renamed' })).statusCode).toBe(200);
      expect((await call(app, 'DELETE', '/api/redteam/campaigns/c1')).statusCode).toBe(200);
    }
    expect(mocks.updateCampaign).toHaveBeenCalledTimes(2);
    expect(mocks.deleteCampaign).toHaveBeenCalledTimes(2);
  });

  describe('runs', () => {
    it('reads a run of another project as missing', async () => {
      mocks.getRun.mockResolvedValue(run('r1', 'proj-2'));
      expect((await call(app, 'GET', '/api/redteam/runs/r1')).statusCode).toBe(404);
    });

    it('serves a run of the active project, and one stored without a project', async () => {
      mocks.getRun.mockResolvedValue(run('r1', 'proj-1'));
      expect((await call(app, 'GET', '/api/redteam/runs/r1')).statusCode).toBe(200);
      mocks.getRun.mockResolvedValue(run('r1'));
      expect((await call(app, 'GET', '/api/redteam/runs/r1')).statusCode).toBe(200);
    });

    it('compares only when both runs are in the active project', async () => {
      mocks.getRun.mockImplementation(async (_db, id: string) => run(id, id === 'base' ? 'proj-2' : 'proj-1'));
      expect((await call(app, 'GET', '/api/redteam/runs/r1/compare?baseline=base')).statusCode).toBe(404);
      mocks.getRun.mockImplementation(async (_db, id: string) => run(id, id === 'r1' ? 'proj-2' : 'proj-1'));
      expect((await call(app, 'GET', '/api/redteam/runs/r1/compare?baseline=base')).statusCode).toBe(404);
      expect(mocks.compareRuns).not.toHaveBeenCalled();

      mocks.getRun.mockImplementation(async (_db, id: string) => run(id, 'proj-1'));
      expect((await call(app, 'GET', '/api/redteam/runs/r1/compare?baseline=base')).statusCode).toBe(200);
      expect(mocks.compareRuns).toHaveBeenCalledTimes(1);
    });

    it('cancels only a run of the active project', async () => {
      mocks.getRun.mockResolvedValue(run('r1', 'proj-2'));
      expect((await call(app, 'POST', '/api/redteam/runs/r1/cancel')).statusCode).toBe(404);
      expect(mocks.cancelRun).not.toHaveBeenCalled();

      mocks.getRun.mockResolvedValue(run('r1', 'proj-1'));
      expect((await call(app, 'POST', '/api/redteam/runs/r1/cancel')).statusCode).toBe(200);
      expect(mocks.cancelRun).toHaveBeenCalledWith('tenant_db', 'r1', 'user-1');
    });

    it('records a review only on a run of the active project', async () => {
      mocks.getRun.mockResolvedValue(run('r1', 'proj-2'));
      const refused = await call(app, 'POST', '/api/redteam/runs/r1/attempts/a1/review', { outcome: 'safe' });
      expect(refused.statusCode).toBe(404);
      expect(mocks.reviewAttempt).not.toHaveBeenCalled();

      mocks.getRun.mockResolvedValue(run('r1', 'proj-1'));
      const accepted = await call(app, 'POST', '/api/redteam/runs/r1/attempts/a1/review', { outcome: 'safe' });
      expect(accepted.statusCode).toBe(200);
      expect(mocks.reviewAttempt).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom probes', () => {
    it('treat a probe of another project as missing and leave it unchanged', async () => {
      mocks.getCustomProbe.mockResolvedValue(probe('proj-2'));
      expect((await call(app, 'GET', '/api/redteam/custom-probes/p1')).statusCode).toBe(404);
      expect((await call(app, 'PATCH', '/api/redteam/custom-probes/p1', PROBE_BODY)).statusCode).toBe(404);
      expect((await call(app, 'DELETE', '/api/redteam/custom-probes/p1')).statusCode).toBe(404);
      expect(mocks.updateCustomProbe).not.toHaveBeenCalled();
      expect(mocks.deleteCustomProbe).not.toHaveBeenCalled();
    });

    it('serve and change a probe of the active project, and one stored without a project', async () => {
      for (const projectId of ['proj-1', undefined]) {
        mocks.getCustomProbe.mockResolvedValue(probe(projectId));
        expect((await call(app, 'GET', '/api/redteam/custom-probes/p1')).statusCode).toBe(200);
        expect((await call(app, 'PATCH', '/api/redteam/custom-probes/p1', PROBE_BODY)).statusCode).toBe(200);
        expect((await call(app, 'DELETE', '/api/redteam/custom-probes/p1')).statusCode).toBe(200);
      }
    });
  });
});

describe('client red-team runs keep to the token project', () => {
  let app: App;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createFastifyApiTestApp(clientRedTeamApiPlugin, { rawJsonBody: true });
  });

  it('reads a run of another project as missing', async () => {
    mocks.getRun.mockResolvedValue(run('r1', 'proj-2'));
    expect((await call(app, 'GET', '/api/client/v1/redteam/runs/r1')).statusCode).toBe(404);
  });

  it('serves a run of its project, and one stored without a project', async () => {
    mocks.getRun.mockResolvedValue(run('r1', 'proj-1'));
    expect((await call(app, 'GET', '/api/client/v1/redteam/runs/r1')).statusCode).toBe(200);
    mocks.getRun.mockResolvedValue(run('r1'));
    expect((await call(app, 'GET', '/api/client/v1/redteam/runs/r1')).statusCode).toBe(200);
  });
});
