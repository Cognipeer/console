/**
 * requireApiTokenFromHeader resolves the token's owner on every request (never
 * cached) and fails closed: a disabled, deleted, or unreadable owner means the
 * token authenticates nothing, and no side effect (default-project creation,
 * last-used stamp) runs for a rejected owner.
 *
 * It also checks, on every request and against live data, that the owner can
 * work in the project the token is bound to (same rule as the dashboard).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    findApiTokenByHash: vi.fn(),
    findTenantById: vi.fn(),
    switchToTenant: vi.fn(),
    findUserById: vi.fn(),
    findUserProject: vi.fn(),
    listGroupMembersByUser: vi.fn(),
    listGroupProjectsByProject: vi.fn(),
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
  h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'owner', tenantId: 't1' });
  h.db.findUserProject.mockResolvedValue(null);
  h.db.listGroupMembersByUser.mockResolvedValue([]);
  h.db.listGroupProjectsByProject.mockResolvedValue([]);
  h.ensureDefaultProject.mockResolvedValue({ _id: 'p-default' });
});

describe('requireApiTokenFromHeader: owner state', () => {
  it('rejects a disabled owner with 401', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', status: 'disabled' });
    const error = await rejection();
    expect(error.status).toBe(401);
    expect(error.message).toBe('API token owner is disabled');
  });

  it('rejects an external owner (a host application person) with 401', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', kind: 'external', canLogin: false });
    const error = await rejection();
    expect(error.status).toBe(401);
    expect(error.message).toBe('API token owner cannot hold API tokens');
    expect(h.ensureDefaultProject).not.toHaveBeenCalled();
    expect(h.db.updateTokenLastUsedByHash).not.toHaveBeenCalled();
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
    for (const owner of [{ _id: 'u1', role: 'owner', status: 'active' }, { _id: 'u1', role: 'owner' }]) {
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

describe('requireApiTokenFromHeader: project access', () => {
  const member = { _id: 'u1', role: 'user', tenantId: 't1' };
  const membershipRow = { userId: 'u1', projectId: 'p1', role: 'member' };

  beforeEach(() => {
    h.db.findUserById.mockResolvedValue(member);
  });

  it('accepts an owner that holds a project membership row', async () => {
    h.db.findUserProject.mockResolvedValue(membershipRow);
    const ctx = await requireApiTokenFromHeader(AUTH);
    expect(ctx.projectId).toBe('p1');
    expect(h.db.findUserProject).toHaveBeenCalledWith('u1', 'p1');
  });

  it('accepts an owner whose access is on the legacy project list, without a membership query', async () => {
    h.db.findUserById.mockResolvedValue({ ...member, projectIds: ['p1'] });
    await requireApiTokenFromHeader(AUTH);
    expect(h.db.findUserProject).not.toHaveBeenCalled();
  });

  it('accepts an owner that reaches the project through a group assignment', async () => {
    h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1', userId: 'u1' }]);
    h.db.listGroupProjectsByProject.mockResolvedValue([{ groupId: 'g1', projectId: 'p1', role: 'member' }]);
    await expect(requireApiTokenFromHeader(AUTH)).resolves.toMatchObject({ projectId: 'p1' });
    expect(h.db.listGroupProjectsByProject).toHaveBeenCalledWith('p1');
  });

  it('ignores a group assignment the owner is not part of', async () => {
    h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g-other', userId: 'u1' }]);
    h.db.listGroupProjectsByProject.mockResolvedValue([{ groupId: 'g1', projectId: 'p1', role: 'member' }]);
    expect((await rejection()).status).toBe(403);
  });

  it('rejects an owner with no access to the token project with 403', async () => {
    const error = await rejection();
    expect(error.status).toBe(403);
    expect(error.message).toBe('API token owner has no access to the token project');
  });

  it('checks access in the tenant the token belongs to, through the scoped helper', async () => {
    h.db.findUserProject.mockResolvedValue(membershipRow);
    await requireApiTokenFromHeader(AUTH);
    expect(h.runWithTenantScope).toHaveBeenCalledWith(tenant.dbName, expect.any(Function));
    expect(h.runWithTenantScope).toHaveBeenCalledTimes(2); // owner lookup + access check
  });

  it('applies the same rule to the default project when the token has no project', async () => {
    const unbound = { _id: 'tok-2', tenantId: 't1', userId: 'u1' };
    h.db.findApiTokenByHash.mockResolvedValue(unbound);

    expect((await rejection()).status).toBe(403);
    expect(h.db.findUserProject).toHaveBeenCalledWith('u1', 'p-default');

    h.db.findUserProject.mockResolvedValue({ ...membershipRow, projectId: 'p-default' });
    await expect(requireApiTokenFromHeader(AUTH)).resolves.toMatchObject({ projectId: 'p-default' });
  });

  it('re-checks on every request, so a change applies on the next call even when the token comes from the auth cache', async () => {
    h.cache.get.mockResolvedValue({ tokenRecord, tenant });

    h.db.findUserProject.mockResolvedValue(membershipRow);
    await expect(requireApiTokenFromHeader(AUTH)).resolves.toMatchObject({ projectId: 'p1' });

    h.db.findUserProject.mockResolvedValue(null); // removed from the project
    expect((await rejection()).status).toBe(403);

    h.db.findUserProject.mockResolvedValue(membershipRow); // added back
    await expect(requireApiTokenFromHeader(AUTH)).resolves.toMatchObject({ projectId: 'p1' });

    expect(h.db.findApiTokenByHash).not.toHaveBeenCalled(); // every call was served from the cache
  });

  it('does not stamp last-used for a refused token', async () => {
    await rejection();
    expect(h.db.updateTokenLastUsedByHash).not.toHaveBeenCalled();
  });

  it('stamps last-used for an accepted token', async () => {
    h.db.findUserProject.mockResolvedValue(membershipRow);
    await requireApiTokenFromHeader(AUTH);
    expect(h.db.updateTokenLastUsedByHash).toHaveBeenCalledTimes(1);
  });

  it('does not look up membership for owners and admins', async () => {
    for (const role of ['owner', 'admin']) {
      h.db.findUserById.mockResolvedValue({ _id: 'u1', role, tenantId: 't1' });
      await expect(requireApiTokenFromHeader(AUTH)).resolves.toMatchObject({ projectId: 'p1' });
    }
    expect(h.db.findUserProject).not.toHaveBeenCalled();
    expect(h.db.listGroupMembersByUser).not.toHaveBeenCalled();
  });

  it('does not tie the token of a login-disabled (programmatic) owner to a membership', async () => {
    h.db.findUserById.mockResolvedValue({ ...member, canLogin: false });
    await expect(requireApiTokenFromHeader(AUTH)).resolves.toMatchObject({ projectId: 'p1' });
    expect(h.db.findUserProject).not.toHaveBeenCalled();
  });

  it('still applies the rule to an owner that can log in', async () => {
    h.db.findUserById.mockResolvedValue({ ...member, canLogin: true });
    expect((await rejection()).status).toBe(403);
  });

  it('fails closed with 503 when project access cannot be read', async () => {
    h.db.findUserProject.mockRejectedValue(new Error('db down'));
    const error = await rejection();
    expect(error.status).toBe(503);
    expect(error.message).toBe('Unable to verify API token project access');
    expect(h.db.updateTokenLastUsedByHash).not.toHaveBeenCalled();
  });
});
