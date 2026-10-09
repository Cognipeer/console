/**
 * requireApiTokenFromHeader resolves the token's owner on every request (never
 * cached) and fails closed: a disabled, deleted, or unreadable owner means the
 * token authenticates nothing, and no side effect (default-project creation,
 * last-used stamp) runs for a rejected owner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    findApiTokenByHash: vi.fn(),
    findTenantById: vi.fn(),
    switchToTenant: vi.fn(),
    findUserById: vi.fn(),
    updateTokenLastUsedByHash: vi.fn(),
  },
  ensureDefaultProject: vi.fn(),
  runWithTenantScope: vi.fn(),
  cache: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (dbName: string, fn: (db: unknown) => unknown) => h.runWithTenantScope(dbName, fn)),
}));
vi.mock('@/lib/core/cache', () => ({ getCache: vi.fn(async () => h.cache) }));
vi.mock('@/lib/core/asyncTask', () => ({
  fireAndForget: (_label: string, fn: () => Promise<void>) => { fn().catch(() => undefined); },
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: h.ensureDefaultProject,
}));

import { ApiTokenAuthError, requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';

const tenant = { _id: 't1', dbName: 'tenant_acme', slug: 'acme', licenseType: 'FREE' };
const tokenRecord = { _id: 'tok-1', tenantId: 't1', userId: 'u1', projectId: 'p1' };
const AUTH = 'Bearer cgate_secret';

async function rejection(): Promise<ApiTokenAuthError> {
  const error = await requireApiTokenFromHeader(AUTH).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ApiTokenAuthError);
  return error as ApiTokenAuthError;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cache.get.mockResolvedValue(undefined);
  h.runWithTenantScope.mockImplementation(async (_dbName: string, fn: (db: unknown) => unknown) => fn(h.db));
  h.db.findApiTokenByHash.mockResolvedValue(tokenRecord);
  h.db.findTenantById.mockResolvedValue(tenant);
  h.db.updateTokenLastUsedByHash.mockResolvedValue(undefined);
  h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', tenantId: 't1' });
  h.ensureDefaultProject.mockResolvedValue({ _id: 'p-default' });
});

describe('requireApiTokenFromHeader: owner state', () => {
  it('rejects a disabled owner with 401', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', status: 'disabled' });
    const error = await rejection();
    expect(error.status).toBe(401);
    expect(error.message).toBe('API token owner is disabled');
  });

  it('rejects a deleted (orphaned-token) owner with 401', async () => {
    h.db.findUserById.mockResolvedValue(null);
    const error = await rejection();
    expect(error.status).toBe(401);
    expect(error.message).toBe('API token owner no longer exists');
  });

  it('fails closed with 503 when the owner cannot be loaded', async () => {
    h.db.findUserById.mockRejectedValue(new Error('db down'));
    const error = await rejection();
    expect(error.status).toBe(503);
    expect(error.message).toBe('Unable to verify API token owner');
  });

  it('does not create the default project or stamp last-used for a rejected owner', async () => {
    for (const outcome of [{ resolve: { status: 'disabled' } }, { resolve: null }, { reject: new Error('x') }]) {
      h.db.findUserById.mockReset();
      if ('reject' in outcome) h.db.findUserById.mockRejectedValue(outcome.reject);
      else h.db.findUserById.mockResolvedValue(outcome.resolve);
      await rejection();
    }
    expect(h.ensureDefaultProject).not.toHaveBeenCalled();
    expect(h.db.updateTokenLastUsedByHash).not.toHaveBeenCalled();
  });

  it('still rejects a disabled owner when the token and tenant come from the auth cache', async () => {
    h.cache.get.mockResolvedValue({ tokenRecord, tenant });
    h.db.findUserById.mockResolvedValue({ _id: 'u1', status: 'disabled' });
    expect((await rejection()).status).toBe(401);
    expect(h.db.findApiTokenByHash).not.toHaveBeenCalled();
    // The user is read fresh every time, which is what makes disable immediate.
    expect(h.db.findUserById).toHaveBeenCalledWith('u1');
    // ...through the tenant-scoped helper, not the process-global binding.
    expect(h.runWithTenantScope).toHaveBeenCalledWith(tenant.dbName, expect.any(Function));
  });

  it('authenticates an active owner and a legacy owner without a status field', async () => {
    for (const owner of [{ _id: 'u1', status: 'active' }, { _id: 'u1' }]) {
      h.db.findUserById.mockResolvedValue(owner);
      const ctx = await requireApiTokenFromHeader(AUTH);
      expect(ctx.user).toEqual(owner);
      expect(ctx.projectId).toBe('p1');
    }
    expect(h.ensureDefaultProject).toHaveBeenCalledTimes(2);
  });

  it('loads the owner inside the token tenant', async () => {
    await requireApiTokenFromHeader(AUTH);
    expect(h.db.switchToTenant).toHaveBeenCalledWith('tenant_acme');
    expect(h.db.switchToTenant.mock.invocationCallOrder[0])
      .toBeLessThan(h.db.findUserById.mock.invocationCallOrder[0]);
  });
});
