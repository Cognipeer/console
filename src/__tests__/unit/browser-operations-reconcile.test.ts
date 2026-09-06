/**
 * Regression tests for F-06 (finance-institution assessment, 2026-09-05):
 * boot reconciliation used to decide a session was orphaned purely on
 * whether THIS process's in-memory browserManager knew about it — so a
 * session genuinely alive on another replica got marked expired the moment
 * any other replica booted or rolled. It now cross-checks the session's
 * recorded ownerNode against the cluster node registry before touching it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const { mockGetDatabase } = vi.hoisted(() => ({ mockGetDatabase: vi.fn() }));
vi.mock('@/lib/database', () => ({
  getDatabase: mockGetDatabase,
  runWithTenantScope: vi.fn(async (_tenantDbName: string, fn: (db: unknown) => unknown) => {
    const db = await mockGetDatabase();
    return fn(db);
  }),
}));

vi.mock('@/lib/core/cluster', () => ({
  listClusterNodes: vi.fn(),
}));

vi.mock('@/lib/services/browser/browserManager', () => ({
  browserManager: { hasSession: vi.fn().mockReturnValue(false) },
}));

import { getDatabase } from '@/lib/database';
import { listClusterNodes } from '@/lib/core/cluster';
import { browserManager } from '@/lib/services/browser/browserManager';
import { reconcileOrphanedBrowserSessions } from '@/lib/services/browser/browserOperationsService';
import type { IBrowserSession, INodeRecord, ITenant } from '@/lib/database';

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function makeSession(overrides: Partial<IBrowserSession> = {}): IBrowserSession {
  return {
    _id: 'sess-1',
    tenantId: 'tenant-1',
    browserId: 'browser-1',
    sessionKey: 'bs_abc',
    status: 'running',
    config: {},
    createdBy: 'user-1',
    ...overrides,
  };
}

function makeNode(name: string): INodeRecord {
  return {
    name,
    role: 'all',
    status: 'online',
    startedAt: new Date(),
  } as INodeRecord;
}

describe('reconcileOrphanedBrowserSessions — owner-node aware', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    db.listTenants.mockResolvedValue([
      { _id: 'tenant-1', dbName: 'tenant_acme', slug: 'acme' } as unknown as ITenant,
    ]);
    mockFn(getDatabase).mockResolvedValue(db);
    mockFn(browserManager.hasSession).mockReturnValue(false);
  });

  it('does NOT expire a session whose owner node is still online (the F-06 scenario)', async () => {
    mockFn(listClusterNodes).mockResolvedValue([makeNode('node-a'), makeNode('node-b')]);
    db.listBrowserSessions.mockResolvedValue([
      makeSession({ ownerNode: 'node-a' }), // alive on a DIFFERENT replica than the one reconciling
    ]);

    const result = await reconcileOrphanedBrowserSessions();

    expect(result.sessionsReconciled).toBe(0);
    expect(db.updateBrowserSession).not.toHaveBeenCalled();
  });

  it('expires a session whose owner node is gone', async () => {
    mockFn(listClusterNodes).mockResolvedValue([makeNode('node-b')]); // node-a is not in the online set
    db.listBrowserSessions.mockResolvedValue([
      makeSession({ ownerNode: 'node-a' }),
    ]);

    const result = await reconcileOrphanedBrowserSessions();

    expect(result.sessionsReconciled).toBe(1);
    expect(db.updateBrowserSession).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'expired' }));
  });

  it('still expires a legacy session with no ownerNode recorded (pre-migration row), matching prior behavior', async () => {
    mockFn(listClusterNodes).mockResolvedValue([makeNode('node-a')]);
    db.listBrowserSessions.mockResolvedValue([
      makeSession({ ownerNode: undefined }),
    ]);

    const result = await reconcileOrphanedBrowserSessions();

    expect(result.sessionsReconciled).toBe(1);
  });

  it('never touches a session this process already knows about locally', async () => {
    mockFn(browserManager.hasSession).mockReturnValue(true);
    mockFn(listClusterNodes).mockResolvedValue([]);
    db.listBrowserSessions.mockResolvedValue([
      makeSession({ ownerNode: 'some-other-node' }),
    ]);

    const result = await reconcileOrphanedBrowserSessions();

    expect(result.sessionsReconciled).toBe(0);
  });
});
