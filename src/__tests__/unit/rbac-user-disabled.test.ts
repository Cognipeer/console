/**
 * Defense in depth behind the global session hook: the RBAC user loader (also
 * the entry point for realtime cookie auth via resolveSessionRbacContext)
 * rejects a disabled account on its own with a 401. The loader reads the user
 * and the groups inside a real tenant scope.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn(), scopes: [] as string[] }));
vi.mock('@/lib/database', () => ({
  getDatabase: hoisted.getDatabase,
  runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) => {
    hoisted.scopes.push(tenantDbName);
    return fn(await hoisted.getDatabase());
  },
}));

import { resolveSessionRbacContext, type ApiSessionContext } from '@/server/api/fastify-utils';

const session = {
  requestId: 'r1',
  tenantDbName: 'tenant_acme',
  tenantId: 't1',
  tenantSlug: 'acme',
  userId: 'u1',
  userRole: 'admin',
  licenseType: 'FREE',
} as ApiSessionContext;

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.scopes.length = 0;
  db = createMockDb();
  hoisted.getDatabase.mockResolvedValue(db);
});

describe('resolveSessionRbacContext: account state', () => {
  it('rejects a disabled user with a 401', async () => {
    db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'admin', status: 'disabled' } as never);
    await expect(resolveSessionRbacContext(session)).rejects.toMatchObject({
      message: 'Account is disabled',
      status: 401,
    });
  });

  it('loads an active user and a legacy status-less user', async () => {
    for (const status of ['active', undefined] as const) {
      db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'admin', status } as never);
      const { user } = await resolveSessionRbacContext(session);
      expect(String(user._id)).toBe('u1');
    }
  });

  it('rejects a user that is gone (401) and one that belongs to another workspace (403)', async () => {
    db.findUserById.mockResolvedValue(null as never);
    await expect(resolveSessionRbacContext(session)).rejects.toMatchObject({ message: 'Unauthorized', status: 401 });
    db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 'another-tenant', role: 'admin' } as never);
    await expect(resolveSessionRbacContext(session)).rejects.toMatchObject({ message: 'Tenant mismatch', status: 403 });
  });
});

describe('resolveSessionRbacContext: scope and groups', () => {
  it('reads inside the session\'s own tenant scope, never the process-global binding', async () => {
    db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user' } as never);
    await resolveSessionRbacContext(session);
    expect(hoisted.scopes).toEqual(['tenant_acme']);
  });

  it('answers the user, the groups behind the grants and the grants - the groups read in one query', async () => {
    db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user' } as never);
    db.listGroupMembersByUser.mockResolvedValue([
      { groupId: 'g1', userId: 'u1', role: 'member' },
      { groupId: 'g2', userId: 'u1', role: 'member' },
      { groupId: 'g3', userId: 'u1', role: 'member' },
    ] as never);
    db.iamListGroups.mockResolvedValue({
      items: [
        { _id: 'g1', name: 'Raisers', tenantRole: 'admin' },
        { _id: 'g2', name: 'Plain' },
        { _id: 'g3', name: 'Permissions', servicePermissions: { agents: 'admin' } },
      ],
      hasMore: false,
    } as never);

    const { user, groups, groupGrants } = await resolveSessionRbacContext(session);
    expect(String(user._id)).toBe('u1');
    expect(groups.map((g) => String(g._id))).toEqual(['g1', 'g2', 'g3']);
    expect(groupGrants).toEqual([
      { tenantRole: 'admin', servicePermissions: undefined },
      { tenantRole: undefined, servicePermissions: { agents: 'admin' } },
    ]);
    expect(db.iamListGroups).toHaveBeenCalledTimes(1);
    expect(db.iamListGroups).toHaveBeenCalledWith({ tenantId: 't1', ids: ['g1', 'g2', 'g3'], limit: 200 });
    expect(db.findGroupById).not.toHaveBeenCalled();
  });

  it('a user in no group costs no group query at all', async () => {
    db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user' } as never);
    db.listGroupMembersByUser.mockResolvedValue([] as never);
    const { groups, groupGrants } = await resolveSessionRbacContext(session);
    expect(groups).toEqual([]);
    expect(groupGrants).toEqual([]);
    expect(db.iamListGroups).not.toHaveBeenCalled();
  });

  it('falls back to point reads when the provider has no group query, skipping a group that is gone', async () => {
    db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user' } as never);
    db.listGroupMembersByUser.mockResolvedValue([
      { groupId: 'g1', userId: 'u1', role: 'member' },
      { groupId: 'gone', userId: 'u1', role: 'member' },
    ] as never);
    db.iamListGroups.mockResolvedValue(undefined as never); // an unusable answer
    db.findGroupById.mockImplementation((async (id: string) => (id === 'g1' ? { _id: 'g1', name: 'One', tenantRole: 'user' } : null)) as never);
    const { groups, groupGrants } = await resolveSessionRbacContext(session);
    expect(groups.map((g) => String(g._id))).toEqual(['g1']);
    expect(groupGrants).toEqual([{ tenantRole: 'user', servicePermissions: undefined }]);
  });
});
