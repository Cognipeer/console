import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(async () => undefined),
  db: {
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    findBrowserById: vi.fn(),
    listBrowserSessions: vi.fn(async () => []),
    createBrowserSession: vi.fn(),
    findBrowserSessionById: vi.fn(),
    updateBrowserSession: vi.fn().mockResolvedValue(null),
    createBrowserSessionEvent: vi.fn().mockResolvedValue({}),
    countBrowserSessionEvents: vi.fn().mockResolvedValue(0),
  },
  manager: { setUploadResolver: vi.fn(), openSession: vi.fn(), closeSession: vi.fn() },
  guard: { checkConcurrency: vi.fn(), checkRateLimit: vi.fn() },
}));

vi.mock('@/lib/limits', async () => {
  const errors = await vi.importActual<typeof import('@/lib/limits/errors')>('@/lib/limits/errors');
  return { PlanLimitError: errors.PlanLimitError, acquirePlanLease: (...args: unknown[]) => h.acquire(...args) };
});
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn() }));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_db: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../lib/services/browser/browserManager', () => ({ browserManager: h.manager }));
vi.mock('@/lib/core/cluster', () => ({ getThisNodeName: () => 'node-1', routeInstanceCall: vi.fn() }));
vi.mock('@/lib/services/files', () => ({ downloadFile: vi.fn(), uploadFile: vi.fn() }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: vi.fn() }));
vi.mock('@/lib/core/requestContext', () => ({ getRequestContext: () => ({ userId: 'u1' }) }));
vi.mock('@/lib/quota/quotaGuard', () => h.guard);

import { closeBrowserSession, createBrowserSession } from '@/lib/services/browser/browserSessionService';
import { isPlanLimitError } from '@/lib/limits/errors';

const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'proj-1' };
const allowed = { allowed: true, outcome: 'allowed', kind: 'concurrency', dimension: 'browser', limit: 2, used: 1 };
const refused = { allowed: false, outcome: 'refused', kind: 'concurrency', dimension: 'browser', limit: 2, used: 2, retryAfterMs: 5000 };
const lease = () => ({ tenantId: 'tenant-1', pool: 'browser', holderId: 'x', release: h.release });

beforeEach(() => {
  vi.clearAllMocks();
  h.db.findBrowserById.mockResolvedValue({ _id: 'br-1', key: 'main', tenantId: 'tenant-1', projectId: 'proj-1', status: 'active' });
  h.db.createBrowserSession.mockResolvedValue({ _id: 'row-1', sessionKey: 'k', tenantId: 'tenant-1' });
  h.db.findBrowserSessionById.mockResolvedValue({ _id: 'row-1', sessionKey: 'k', tenantId: 'tenant-1' });
  h.guard.checkConcurrency.mockResolvedValue({ allowed: true });
  h.guard.checkRateLimit.mockResolvedValue({ allowed: true });
  h.manager.openSession.mockResolvedValue(undefined);
  h.manager.closeSession.mockResolvedValue(true);
});

describe('browser session leases', () => {
  it('refuses with tenant_concurrency_limited before anything is created when the pool is full', async () => {
    h.acquire.mockResolvedValue({ decision: refused, lease: null });
    const failure = await createBrowserSession(CTX, { browserId: 'br-1' } as never).catch((e) => e);
    expect(isPlanLimitError(failure)).toBe(true);
    expect(failure).toMatchObject({ code: 'tenant_concurrency_limited', message: 'All 2 browser sessions are in use. Try again shortly.' });
    expect(h.db.createBrowserSession).not.toHaveBeenCalled();
    expect(h.manager.openSession).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('holds the lease while the session is open and gives it back when the manager closes it', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: lease() });
    let onClose: ((reason: string) => Promise<void>) | undefined;
    h.manager.openSession.mockImplementation(async (input: { onClose: (reason: string) => Promise<void> }) => {
      onClose = input.onClose;
    });
    await createBrowserSession(CTX, { browserId: 'br-1' } as never);
    expect(h.acquire).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', pool: 'browser' }));
    expect(h.release).not.toHaveBeenCalled();
    await onClose!('idle-timeout');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease when the session fails to open', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: lease() });
    h.manager.openSession.mockRejectedValue(new Error('launch failed'));
    await expect(createBrowserSession(CTX, { browserId: 'br-1' } as never)).rejects.toThrow('launch failed');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease when the row cannot be created', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: lease() });
    h.db.createBrowserSession.mockRejectedValue(new Error('db down'));
    await expect(createBrowserSession(CTX, { browserId: 'br-1' } as never)).rejects.toThrow('db down');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('never refuses when no lease is handed back (limits off / shadow with room)', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: null });
    await expect(createBrowserSession(CTX, { browserId: 'br-1' } as never)).resolves.toBeDefined();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('releases once even when both onClose and an explicit close run', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: lease() });
    let onClose: ((reason: string) => Promise<void>) | undefined;
    let key = '';
    h.manager.openSession.mockImplementation(async (input: { sessionKey: string; onClose: (reason: string) => Promise<void> }) => {
      onClose = input.onClose;
      key = input.sessionKey;
    });
    await createBrowserSession(CTX, { browserId: 'br-1' } as never);
    await closeBrowserSession(CTX, key);
    await onClose!('manual');
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});
