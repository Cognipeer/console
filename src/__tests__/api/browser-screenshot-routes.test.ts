import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
  captureLiveScreenshot: vi.fn(),
  captureScreenshot: vi.fn(),
  captureScreenshotOutput: vi.fn(),
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
vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
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

describe('dashboard browser screenshot route', () => {
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

  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST', url: '/api/browser/sessions/session-1/screenshot', headers: HEADERS, payload,
    });

  it('keeps the persisted-artifact response by default', async () => {
    browserMocks.captureScreenshot.mockResolvedValue({ artifact: { url: '/a.png' }, eventId: 'ev-1' });
    const response = await post({ fullPage: true });
    expect(response.statusCode).toBe(201);
    expect(parseJsonBody(response.body)).toEqual({ artifact: { url: '/a.png' }, eventId: 'ev-1' });
    expect(browserMocks.captureScreenshot).toHaveBeenCalledWith(
      SCOPE, 'session-1', { fullPage: true, createdBy: 'user-1' },
    );
    expect(browserMocks.captureScreenshotOutput).not.toHaveBeenCalled();
  });

  it('inline + persist:false returns content without an artifact', async () => {
    browserMocks.captureScreenshotOutput.mockResolvedValue({
      kind: 'tool_output',
      content: [{ type: 'text', text: 'shot' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      structuredContent: { url: 'http://x/', width: 10, height: 20, fullPage: false },
    });
    const response = await post({ inline: true, persist: false });
    expect(response.statusCode).toBe(200);
    const body = parseJsonBody(response.body) as Record<string, unknown>;
    expect(body.artifact).toBeUndefined();
    expect((body.content as Array<{ type: string }>)[1].type).toBe('image');
    expect(body.structured).toMatchObject({ width: 10, height: 20 });
    expect(browserMocks.captureScreenshotOutput).toHaveBeenCalledWith(
      SCOPE, 'session-1', expect.objectContaining({ persist: false }),
    );
    expect(browserMocks.captureScreenshot).not.toHaveBeenCalled();
  });

  it('inline alone persists as well and returns the artifact with the content', async () => {
    browserMocks.captureScreenshotOutput.mockResolvedValue({
      kind: 'tool_output',
      content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      structuredContent: { url: 'http://x/', artifact: { url: '/a.png' } },
      eventId: 'ev-2',
    });
    const response = await post({ inline: true });
    expect(response.statusCode).toBe(201);
    expect(parseJsonBody(response.body)).toMatchObject({ artifact: { url: '/a.png' }, eventId: 'ev-2' });
    expect(browserMocks.captureScreenshotOutput).toHaveBeenCalledWith(
      SCOPE, 'session-1', expect.objectContaining({ persist: true }),
    );
  });

  it('rejects persist:false without inline', async () => {
    const response = await post({ persist: false });
    expect(response.statusCode).toBe(400);
    expect(browserMocks.captureScreenshot).not.toHaveBeenCalled();
    expect(browserMocks.captureScreenshotOutput).not.toHaveBeenCalled();
  });
});
