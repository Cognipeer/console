/**
 * The identity a server-rendered page gates on: the role the database holds now
 * (not the one in the session header), and the coarse "may this person open the
 * Authorization center" answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  headerValues: {} as Record<string, string>,
  getUserIdentity: vi.fn(),
  db: { findUserById: vi.fn(), listGroupMembersByUser: vi.fn(), findGroupById: vi.fn(), iamListGroups: vi.fn() },
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => h.headerValues[name] ?? null }),
}));
vi.mock('@/lib/database', () => ({
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/services/users/userAuthState', () => ({ getUserIdentity: h.getUserIdentity }));

import { canOpenIamCenter, getCurrentIdentity, type CurrentIdentity } from '@/lib/auth/serverIdentity';

const identityOf = (over: Partial<CurrentIdentity> = {}): CurrentIdentity => ({
  tenantDbName: 'tenant_acme',
  tenantId: 't1',
  userId: 'u1',
  email: 'a@acme.test',
  state: 'active',
  role: 'user',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.headerValues = {
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 't1',
    'x-user-id': 'u1',
    'x-user-email': 'a@acme.test',
    'x-user-role': 'admin', // what the session was issued with
  };
  h.getUserIdentity.mockResolvedValue({ state: 'active', role: 'user' });
  h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user', servicePermissions: {} });
  h.db.listGroupMembersByUser.mockResolvedValue([]);
  h.db.iamListGroups.mockResolvedValue({ items: [], hasMore: false });
});

describe('getCurrentIdentity', () => {
  it('answers with the role the database holds now, not the session header\'s', async () => {
    const identity = await getCurrentIdentity();
    expect(h.getUserIdentity).toHaveBeenCalledWith('tenant_acme', 't1', 'u1');
    expect(identity).toEqual({
      tenantDbName: 'tenant_acme',
      tenantId: 't1',
      userId: 'u1',
      email: 'a@acme.test',
      state: 'active',
      role: 'user',
    });
  });

  it('carries the account state, so a disabled or deleted account is visible to the layout', async () => {
    h.getUserIdentity.mockResolvedValue({ state: 'disabled', role: 'admin' });
    expect(await getCurrentIdentity()).toMatchObject({ state: 'disabled', role: 'admin' });
    h.getUserIdentity.mockResolvedValue({ state: 'missing', role: null });
    expect(await getCurrentIdentity()).toMatchObject({ state: 'missing', role: null });
  });

  it('is null without a session', async () => {
    for (const missing of ['x-tenant-db-name', 'x-tenant-id', 'x-user-id']) {
      const saved = h.headerValues[missing];
      delete h.headerValues[missing];
      expect(await getCurrentIdentity(), missing).toBeNull();
      h.headerValues[missing] = saved;
    }
    expect(h.getUserIdentity).not.toHaveBeenCalled();
  });

  it('lets an unreadable account reach the caller (the layout must not render on a guess)', async () => {
    h.getUserIdentity.mockRejectedValue(new Error('db down'));
    await expect(getCurrentIdentity()).rejects.toThrow('db down');
  });
});

describe('canOpenIamCenter', () => {
  it('opens for owners and admins without reading anything else', async () => {
    expect(await canOpenIamCenter(identityOf({ role: 'owner' }))).toBe(true);
    expect(await canOpenIamCenter(identityOf({ role: 'admin' }))).toBe(true);
    expect(h.db.findUserById).not.toHaveBeenCalled();
  });

  it('stays closed for a plain member, a project_admin, a stranger and a closed account', async () => {
    expect(await canOpenIamCenter(identityOf({ role: 'user' }))).toBe(false);
    expect(await canOpenIamCenter(identityOf({ role: 'project_admin' }))).toBe(false);
    expect(await canOpenIamCenter(null)).toBe(false);
    expect(await canOpenIamCenter(identityOf({ role: 'admin', state: 'disabled' }))).toBe(false);
    expect(await canOpenIamCenter(identityOf({ role: 'admin', state: 'missing' }))).toBe(false);
    expect(await canOpenIamCenter(identityOf({ role: null }))).toBe(false);
  });

  it('opens for a member whose own override reaches iam read', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user', servicePermissions: { iam: 'read' } });
    expect(await canOpenIamCenter(identityOf())).toBe(true);
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user', servicePermissions: { iam: 'admin' } });
    expect(await canOpenIamCenter(identityOf())).toBe(true);
  });

  it('stays closed for an override that is below read', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user', servicePermissions: { iam: 'none' } });
    expect(await canOpenIamCenter(identityOf())).toBe(false);
  });

  it('opens for a member whose group grants iam read', async () => {
    h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1', userId: 'u1' }]);
    h.db.iamListGroups.mockResolvedValue({ items: [{ _id: 'g1', tenantId: 't1', name: 'Auditors', servicePermissions: { iam: 'read' } }], hasMore: false });
    expect(await canOpenIamCenter(identityOf())).toBe(true);
  });

  it('stays closed for a group that grants something else', async () => {
    h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1', userId: 'u1' }]);
    h.db.iamListGroups.mockResolvedValue({ items: [{ _id: 'g1', tenantId: 't1', name: 'Builders', servicePermissions: { agents: 'admin' } }], hasMore: false });
    expect(await canOpenIamCenter(identityOf())).toBe(false);
  });

  it('judges by the role the database holds: a user promoted by a group role is let in', async () => {
    h.db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1', userId: 'u1' }]);
    h.db.iamListGroups.mockResolvedValue({ items: [{ _id: 'g1', tenantId: 't1', name: 'Admins', tenantRole: 'admin' }], hasMore: false });
    expect(await canOpenIamCenter(identityOf())).toBe(true);
  });

  it('stays closed when the account row is gone', async () => {
    h.db.findUserById.mockResolvedValue(null);
    expect(await canOpenIamCenter(identityOf())).toBe(false);
  });
});
