/**
 * Removing a user from a project clears every direct record of the membership:
 * the UserProject row and the legacy `projectIds` entry (the invite flows write
 * both), and reports 'not_found' only when neither existed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';

const h = vi.hoisted(() => ({ revokeUserApiTokensInProject: vi.fn() }));

vi.mock('@/lib/services/users/userLifecycle', () => ({
  revokeUserApiTokensInProject: h.revokeUserApiTokensInProject,
}));

import { applyBulkMembers, removeProjectMember } from '@/lib/services/projects/projectMembership';

const db = {
  deleteUserProject: vi.fn(),
  updateUser: vi.fn(),
};

const remove = (target: Parameters<typeof removeProjectMember>[0]['target'], projectId = 'p1') =>
  removeProjectMember({ db: db as unknown as DatabaseProvider, projectId, target, tenantDbName: 'tenant_acme' });

beforeEach(() => {
  vi.clearAllMocks();
  db.deleteUserProject.mockResolvedValue(false);
  db.updateUser.mockImplementation(async (id: string, patch: object) => ({ _id: id, ...patch }));
  h.revokeUserApiTokensInProject.mockResolvedValue({ revoked: 0, failed: 0 });
});

describe('removeProjectMember', () => {
  it('removes a membership row and leaves an empty legacy list alone', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    await expect(remove({ _id: 'u1', projectIds: [] })).resolves.toBe('removed');
    expect(db.deleteUserProject).toHaveBeenCalledWith('u1', 'p1');
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('removes a legacy-only entry and keeps the others', async () => {
    await expect(remove({ _id: 'u1', projectIds: ['p0', 'p1', 'p2'] })).resolves.toBe('removed');
    expect(db.updateUser).toHaveBeenCalledWith('u1', { projectIds: ['p0', 'p2'] });
  });

  it('clears both the row and the legacy entry in the same call', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    await expect(remove({ _id: 'u1', projectIds: ['p1'] })).resolves.toBe('removed');
    expect(db.deleteUserProject).toHaveBeenCalledWith('u1', 'p1');
    expect(db.updateUser).toHaveBeenCalledWith('u1', { projectIds: [] });
  });

  it('reports not_found, and writes nothing, when the user was never a member', async () => {
    await expect(remove({ _id: 'u1', projectIds: ['p9'] })).resolves.toBe('not_found');
    await expect(remove({ _id: 'u1' })).resolves.toBe('not_found');
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('reports failed when the legacy list cannot be updated, so the caller can retry', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    db.updateUser.mockResolvedValue(null);
    await expect(remove({ _id: 'u1', projectIds: ['p1'] })).resolves.toBe('failed');
  });

  it('lets a retry finish a removal that stopped after the row was deleted', async () => {
    db.deleteUserProject.mockResolvedValue(false); // the row is already gone
    await expect(remove({ _id: 'u1', projectIds: ['p1'] })).resolves.toBe('removed');
    expect(db.updateUser).toHaveBeenCalledWith('u1', { projectIds: [] });
  });

  it('matches ids as strings', async () => {
    await expect(remove({ _id: 'u1', projectIds: ['42'] }, 42 as unknown as string)).resolves.toBe('removed');
  });

  it('lets a failing row delete reach the caller', async () => {
    db.deleteUserProject.mockRejectedValue(new Error('db down'));
    await expect(remove({ _id: 'u1', projectIds: ['p1'] })).rejects.toThrow('db down');
    expect(db.updateUser).not.toHaveBeenCalled();
  });
});

describe('removeProjectMember: tokens of a login-disabled account', () => {
  it('revokes the account\'s tokens for that project', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    await expect(remove({ _id: 'u1', canLogin: false })).resolves.toBe('removed');
    expect(h.revokeUserApiTokensInProject).toHaveBeenCalledWith('tenant_acme', 'u1', 'p1');
  });

  it('leaves the tokens of an account that can log in', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    await remove({ _id: 'u1', canLogin: true });
    await remove({ _id: 'u1' });
    expect(h.revokeUserApiTokensInProject).not.toHaveBeenCalled();
  });

  it('revokes nothing when there was no membership to remove', async () => {
    await expect(remove({ _id: 'u1', canLogin: false })).resolves.toBe('not_found');
    expect(h.revokeUserApiTokensInProject).not.toHaveBeenCalled();
  });

  it('revokes nothing when the legacy list could not be updated', async () => {
    db.updateUser.mockResolvedValue(null);
    await expect(remove({ _id: 'u1', canLogin: false, projectIds: ['p1'] })).resolves.toBe('failed');
    expect(h.revokeUserApiTokensInProject).not.toHaveBeenCalled();
  });

  it('still reports the removal when revoking fails', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    h.revokeUserApiTokensInProject.mockRejectedValue(new Error('db down'));
    await expect(remove({ _id: 'u1', canLogin: false })).resolves.toBe('removed');
  });
});

describe('applyBulkMembers remove', () => {
  const bulkRemove = (users: object[], userId: string) =>
    applyBulkMembers(
      { ...db, listUsers: async () => users, listUserProjectsByProject: async () => [] } as unknown as DatabaseProvider,
      { tenantId: 't', tenantDbName: 'tenant_acme', actorUserId: 'actor', projectId: 'p1', add: [], setRole: [], remove: [userId] },
    );

  it('clears the legacy entry and the project tokens of a login-disabled account, like the single removal', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    const result = await bulkRemove(
      [{ _id: 'bot', tenantId: 't', role: 'user', canLogin: false, projectIds: ['p1'] }],
      'bot',
    );
    expect(result.removedIds).toEqual(['bot']);
    expect(db.updateUser).toHaveBeenCalledWith('bot', { projectIds: [] });
    expect(h.revokeUserApiTokensInProject).toHaveBeenCalledWith('tenant_acme', 'bot', 'p1');
  });

  it('warns when the user is not a direct member', async () => {
    const result = await bulkRemove([{ _id: 'u1', tenantId: 't', role: 'user', projectIds: [] }], 'u1');
    expect(result.removedIds).toEqual([]);
    expect(result.warnings[0]).toContain('not a direct member');
  });
});
