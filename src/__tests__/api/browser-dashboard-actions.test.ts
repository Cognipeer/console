import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
  captureLiveScreenshot: vi.fn(),
  captureScreenshot: vi.fn(),
  captureSnapshot: vi.fn(),
  clearBrowserStorageState: vi.fn(),
  closeBrowserSession: vi.fn(),
  createBrowser: vi.fn(),
  createBrowserFlow: vi.fn(),
  createBrowserSession: vi.fn(),
  deleteBrowser: vi.fn(),
  deleteBrowserFlow: vi.fn(),
  deleteBrowserSession: vi.fn(),
  describeSessionElement: vi.fn(),
  exportSessionPdf: vi.fn(),
  exportSessionStorageState: vi.fn(),
  extractFromBrowser: vi.fn(),
  getBrowser: vi.fn(),
  getBrowserFlow: vi.fn(),
  getBrowserFlowRun: vi.fn(),
  getBrowserSession: vi.fn(),
  listBrowserFlowRuns: vi.fn(),
  listBrowserFlows: vi.fn(),
  listBrowserSessionEvents: vi.fn(),
  listBrowserSessions: vi.fn(),
  listBrowsers: vi.fn(),
  readSessionObservations: vi.fn(),
  recordBrowserFlow: vi.fn(),
  runBrowserAction: vi.fn(),
  runBrowserFlow: vi.fn(),
  runBrowserFlowSteps: vi.fn(),
  searchPageText: vi.fn(),
  setBrowserStorageState: vi.fn(),
  startBrowserFlowRun: vi.fn(),
  updateBrowser: vi.fn(),
  updateBrowserFlow: vi.fn(),
}));

vi.mock('@/lib/services/browser', () => browserMocks);
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/projects/projectContext', () => ({
  resolveProjectContext: vi.fn(),
  ProjectContextError: class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

import { getDatabase } from '@/lib/database';
import { resolveProjectContext } from '@/lib/services/projects/projectContext';
import { browserApiPlugin } from '@/server/api/plugins/browser';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const HEADERS = {
  'content-type': 'application/json',
  'x-license-type': 'ENTERPRISE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};
const SCOPE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'project-1' };

describe('dashboard browser action routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectId: 'project-1',
      project: { _id: 'project-1' },
      user: { _id: 'user-1', role: 'owner', projectIds: ['project-1'] },
    });
    const db = createMockDb();
    db.findUserById.mockResolvedValue({
      _id: 'user-1', email: 'owner@example.com', role: 'owner', tenantId: 'tenant-1',
    } as never);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    app = await createFastifyApiTestApp(browserApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /api/browser/sessions/:sessionKey/describe resolves a durable target', async () => {
    browserMocks.describeSessionElement.mockResolvedValue({ role: 'button', name: 'Submit' });
    const response = await app.inject({
      method: 'POST', url: '/api/browser/sessions/session-1/describe', headers: HEADERS,
      payload: { ref: 'e7' },
    });
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response.body)).toEqual({ role: 'button', name: 'Submit' });
    expect(browserMocks.describeSessionElement).toHaveBeenCalledWith(SCOPE, 'session-1', 'e7');
  });

  it('POST /api/browser/flows/:idOrKey/run/start returns the background run', async () => {
    browserMocks.startBrowserFlowRun.mockResolvedValue({ id: 'run-1', status: 'running' });
    const response = await app.inject({
      method: 'POST', url: '/api/browser/flows/flow-1/run/start', headers: HEADERS,
      payload: { inputs: { account: 'ACME' } },
    });
    expect(response.statusCode).toBe(202);
    expect(parseJsonBody(response.body)).toEqual({ run: { id: 'run-1', status: 'running' } });
    expect(browserMocks.startBrowserFlowRun).toHaveBeenCalledWith(SCOPE, 'flow-1', {
      inputs: { account: 'ACME' }, trigger: 'manual', createdBy: 'user-1',
    });
  });

  it('POST /api/browser/flows/:idOrKey/steps/run replays only the requested slice', async () => {
    browserMocks.runBrowserFlowSteps.mockResolvedValue({ stepResults: [{ status: 'succeeded' }] });
    const response = await app.inject({
      method: 'POST', url: '/api/browser/flows/flow-1/steps/run', headers: HEADERS,
      payload: { sessionKey: 'session-1', from: 1, to: 2, inputs: { account: 'ACME' } },
    });
    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response.body)).toEqual({ stepResults: [{ status: 'succeeded' }] });
    expect(browserMocks.runBrowserFlowSteps).toHaveBeenCalledWith(SCOPE, 'flow-1', {
      sessionKey: 'session-1', from: 1, to: 2, inputs: { account: 'ACME' }, createdBy: 'user-1',
    });
  });
});