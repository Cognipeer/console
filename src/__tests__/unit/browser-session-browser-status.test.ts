/**
 * Unit tests — browser sessions re-check the parent browser's status per action.
 * A session opened before its browser was disabled is closed and refused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    findBrowserSessionByKey: vi.fn(),
    findBrowserById: vi.fn(),
    updateBrowserSession: vi.fn().mockResolvedValue(null),
    countBrowserSessionEvents: vi.fn().mockResolvedValue(0),
    createBrowserSessionEvent: vi.fn().mockResolvedValue({ id: 'e1', createdAt: new Date() }),
  },
  manager: {
    setUploadResolver: vi.fn(),
    runAction: vi.fn(),
    extract: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => mocks.db),
  runWithTenantScope: vi.fn(),
}));
vi.mock('../../lib/services/browser/browserManager', () => ({ browserManager: mocks.manager }));
vi.mock('@/lib/core/cluster', () => ({
  getThisNodeName: () => 'node-1',
  // Run the call locally, as a single-node deployment does.
  routeInstanceCall: async (_target: unknown, _payload: unknown, local: () => Promise<unknown>) => local(),
}));
vi.mock('@/lib/services/files', () => ({ downloadFile: vi.fn(), uploadFile: vi.fn() }));

import { extractFromBrowser, runBrowserAction } from '@/lib/services/browser/browserSessionService';

const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'proj-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.switchToTenant.mockResolvedValue(undefined);
  mocks.db.updateBrowserSession.mockResolvedValue(null);
  mocks.db.countBrowserSessionEvents.mockResolvedValue(0);
  mocks.db.createBrowserSessionEvent.mockResolvedValue({ id: 'e1', createdAt: new Date() });
  mocks.manager.closeSession.mockResolvedValue(true);
  mocks.db.findBrowserSessionByKey.mockResolvedValue({
    _id: 'sess-1', tenantId: 'tenant-1', projectId: 'proj-1', browserId: 'br-1', sessionKey: 'bs_1',
  });
});

describe('browser session actions', () => {
  it('refuses an action and closes the session when the browser was disabled', async () => {
    mocks.db.findBrowserById.mockResolvedValue({ _id: 'br-1', key: 'main', status: 'disabled' });

    await expect(runBrowserAction(CTX, 'bs_1', { type: 'snapshot' } as never)).rejects.toThrow('Browser main is not active');

    expect(mocks.manager.runAction).not.toHaveBeenCalled();
    expect(mocks.manager.closeSession).toHaveBeenCalledWith('bs_1', 'manual');
    expect(mocks.db.updateBrowserSession).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'closed' }));
  });

  it('refuses extraction when the browser was disabled', async () => {
    mocks.db.findBrowserById.mockResolvedValue({ _id: 'br-1', key: 'main', status: 'disabled' });

    await expect(extractFromBrowser(CTX, 'bs_1', { selector: 'h1' } as never)).rejects.toThrow(/is not active/);
    expect(mocks.manager.extract).not.toHaveBeenCalled();
  });

  it('runs the action while the browser is active', async () => {
    mocks.db.findBrowserById.mockResolvedValue({ _id: 'br-1', key: 'main', status: 'active' });
    mocks.manager.runAction.mockResolvedValue({ ok: true });

    const result = await runBrowserAction(CTX, 'bs_1', { type: 'snapshot' } as never);

    expect(result).toMatchObject({ ok: true });
    expect(mocks.manager.closeSession).not.toHaveBeenCalled();
  });
});
