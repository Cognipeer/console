/**
 * Unit tests — a browser session is checked against the quota (requests +
 * concurrent sessions of the caller) BEFORE the browser is launched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    findBrowserById: vi.fn(),
    listBrowserSessions: vi.fn(),
    createBrowserSession: vi.fn(),
    updateBrowserSession: vi.fn().mockResolvedValue(null),
    createBrowserSessionEvent: vi.fn().mockResolvedValue({}),
  },
  manager: { setUploadResolver: vi.fn(), openSession: vi.fn() },
  guard: { checkConcurrency: vi.fn(), checkRateLimit: vi.fn() },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => mocks.db),
  runWithTenantScope: vi.fn(),
}));
vi.mock('../../lib/services/browser/browserManager', () => ({ browserManager: mocks.manager }));
vi.mock('@/lib/core/cluster', () => ({ getThisNodeName: () => 'node-1', routeInstanceCall: vi.fn() }));
vi.mock('@/lib/services/files', () => ({ downloadFile: vi.fn(), uploadFile: vi.fn() }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: vi.fn() }));
vi.mock('@/lib/core/requestContext', () => ({ getRequestContext: () => ({ userId: 'u1' }) }));
vi.mock('@/lib/quota/quotaGuard', () => mocks.guard);

import { createBrowserSession } from '@/lib/services/browser/browserSessionService';

const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'proj-1' };

describe('createBrowserSession quota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.findBrowserById.mockResolvedValue({ _id: 'br-1', key: 'main', tenantId: 'tenant-1', projectId: 'proj-1', status: 'active' });
    const rows = [
      { userId: 'u1', status: 'idle' },
      { userId: 'u1', status: 'running' },
      { userId: 'u1', status: 'closed' },
      { userId: 'other', status: 'idle' },
    ];
    // The service asks for each open status; the stub answers like the database would.
    mocks.db.listBrowserSessions.mockImplementation(async (_tenantId: string, filters: { status?: string }) =>
      rows.filter((row) => !filters?.status || row.status === filters.status));
    mocks.guard.checkConcurrency.mockResolvedValue({ allowed: true });
    mocks.guard.checkRateLimit.mockResolvedValue({ allowed: true });
  });

  it("refuses on concurrency before launching, counting only the caller's open sessions", async () => {
    mocks.guard.checkConcurrency.mockResolvedValue({ allowed: false, reason: 'Too many open browser sessions' });

    await expect(createBrowserSession(CTX, { browserId: 'br-1' } as never)).rejects.toMatchObject({
      name: 'QuotaExceededError', status: 429,
    });

    expect(mocks.guard.checkConcurrency).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'browser', resourceKey: 'main', userId: 'u1' }),
      2,
    );
    expect(mocks.db.createBrowserSession).not.toHaveBeenCalled();
    expect(mocks.manager.openSession).not.toHaveBeenCalled();
    // Only open sessions are read, never the project's whole history.
    const statuses = mocks.db.listBrowserSessions.mock.calls.map((call: unknown[]) => (call[1] as { status?: string }).status);
    expect(statuses.sort()).toEqual(['idle', 'pending', 'running']);
  });

  it('counts one request on the browser key when concurrency allows', async () => {
    mocks.db.createBrowserSession.mockRejectedValue(new Error('stop here'));
    await expect(createBrowserSession(CTX, { browserId: 'br-1' } as never)).rejects.toThrow('stop here');
    expect(mocks.guard.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'browser', resourceKey: 'main' }),
      { requests: 1 },
      { headroom: undefined },
    );
  });
});
