/**
 * The project-access rule shared by the dashboard and API-token authentication.
 *
 * A user reaches a project through a tenant role with implicit access
 * (owner/admin), a UserProject row, the legacy `projectIds` list, or a group
 * assigned to the project. `canAccessProject` is the cheap yes/no form of
 * `resolveProjectMembership`, and the two have to agree on every combination.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import {
  canAccessProject,
  canTokenOwnerAccessProject,
  collectAccessibleProjectIds,
  getLegacyProjectIds,
  hasImplicitProjectAccess,
  isProgrammaticUser,
  resolveProjectMembership,
} from '@/lib/services/projects/projectAccess';

interface World {
  rows?: Array<{ userId: string; projectId: string; role: 'member' | 'project_admin' }>;
  groupMembers?: Array<{ groupId: string; userId: string }>;
  groupProjects?: Array<{ groupId: string; projectId: string; role: 'member' | 'project_admin' }>;
}

function fakeDb(world: World = {}) {
  const rows = world.rows ?? [];
  const groupMembers = world.groupMembers ?? [];
  const groupProjects = world.groupProjects ?? [];
  const db = {
    findUserProject: vi.fn(async (userId: string, projectId: string) => (
      rows.find((r) => r.userId === userId && r.projectId === projectId) ?? null
    )),
    listUserProjectsByUser: vi.fn(async (userId: string) => rows.filter((r) => r.userId === userId)),
    listGroupMembersByUser: vi.fn(async (userId: string) => groupMembers.filter((m) => m.userId === userId)),
    listGroupProjectsByProject: vi.fn(async (projectId: string) => groupProjects.filter((g) => g.projectId === projectId)),
    listGroupProjectsByGroup: vi.fn(async (groupId: string) => groupProjects.filter((g) => g.groupId === groupId)),
  };
  return db as typeof db & DatabaseProvider;
}

const lookups = (db: ReturnType<typeof fakeDb>) => (
  db.findUserProject.mock.calls.length
  + db.listGroupMembersByUser.mock.calls.length
  + db.listGroupProjectsByProject.mock.calls.length
);

describe('hasImplicitProjectAccess', () => {
  it('is true for owner and admin only', () => {
    expect(hasImplicitProjectAccess('owner')).toBe(true);
    expect(hasImplicitProjectAccess('admin')).toBe(true);
    expect(hasImplicitProjectAccess('project_admin')).toBe(false);
    expect(hasImplicitProjectAccess('user')).toBe(false);
    expect(hasImplicitProjectAccess(undefined)).toBe(false);
  });
});

describe('getLegacyProjectIds', () => {
  it('normalises the list to non-empty strings', () => {
    expect(getLegacyProjectIds(undefined)).toEqual([]);
    expect(getLegacyProjectIds(['a', '', 'b'])).toEqual(['a', 'b']);
    expect(getLegacyProjectIds([1 as unknown as string])).toEqual(['1']);
  });
});

describe('canAccessProject', () => {
  it('lets owners and admins in without any lookup', async () => {
    for (const userRole of ['owner', 'admin']) {
      const db = fakeDb();
      await expect(canAccessProject(db, { userId: 'u1', userRole, projectId: 'p1' })).resolves.toBe(true);
      expect(lookups(db)).toBe(0);
    }
  });

  it('accepts a legacy list entry without any lookup', async () => {
    const db = fakeDb();
    await expect(canAccessProject(db, { userId: 'u1', userRole: 'user', projectId: 'p1', legacyProjectIds: ['p1'] }))
      .resolves.toBe(true);
    expect(lookups(db)).toBe(0);
  });

  it('accepts a membership row with a single lookup', async () => {
    const db = fakeDb({ rows: [{ userId: 'u1', projectId: 'p1', role: 'member' }] });
    await expect(canAccessProject(db, { userId: 'u1', userRole: 'user', projectId: 'p1' })).resolves.toBe(true);
    expect(db.findUserProject).toHaveBeenCalledWith('u1', 'p1');
    expect(db.listGroupMembersByUser).not.toHaveBeenCalled();
  });

  it('accepts a group assignment', async () => {
    const db = fakeDb({
      groupMembers: [{ groupId: 'g1', userId: 'u1' }],
      groupProjects: [{ groupId: 'g1', projectId: 'p1', role: 'member' }],
    });
    await expect(canAccessProject(db, { userId: 'u1', userRole: 'user', projectId: 'p1' })).resolves.toBe(true);
  });

  it('skips the group assignment lookup for a user who is in no group', async () => {
    const db = fakeDb({ groupProjects: [{ groupId: 'g1', projectId: 'p1', role: 'member' }] });
    await expect(canAccessProject(db, { userId: 'u1', userRole: 'user', projectId: 'p1' })).resolves.toBe(false);
    expect(db.listGroupProjectsByProject).not.toHaveBeenCalled();
  });

  it('refuses a user whose only access is to other projects or other groups', async () => {
    const db = fakeDb({
      rows: [{ userId: 'u1', projectId: 'p2', role: 'member' }, { userId: 'u2', projectId: 'p1', role: 'member' }],
      groupMembers: [{ groupId: 'g-other', userId: 'u1' }],
      groupProjects: [{ groupId: 'g1', projectId: 'p1', role: 'member' }],
    });
    await expect(canAccessProject(db, {
      userId: 'u1', userRole: 'user', projectId: 'p1', legacyProjectIds: ['p3'],
    })).resolves.toBe(false);
  });

  it('treats an unknown role like a plain member', async () => {
    const db = fakeDb();
    await expect(canAccessProject(db, { userId: 'u1', userRole: undefined, projectId: 'p1' })).resolves.toBe(false);
  });

  it('compares ids as strings', async () => {
    const db = fakeDb({ rows: [{ userId: 'u1', projectId: '42', role: 'member' }] });
    await expect(canAccessProject(db, { userId: 'u1', userRole: 'user', projectId: 42 as unknown as string }))
      .resolves.toBe(true);
  });

  it('propagates a lookup failure instead of answering', async () => {
    const db = fakeDb();
    db.findUserProject.mockRejectedValueOnce(new Error('db down'));
    await expect(canAccessProject(db, { userId: 'u1', userRole: 'user', projectId: 'p1' })).rejects.toThrow('db down');
  });
});

describe('canAccessProject agrees with resolveProjectMembership', () => {
  // Every combination of the four sources for a non-privileged user.
  const direct = [false, true];
  const legacy = [false, true];
  const groupMembership = ['none', 'assigned-group', 'other-group'] as const;
  const groupAssignment = [false, true];

  for (const hasRow of direct) {
    for (const hasLegacy of legacy) {
      for (const membership of groupMembership) {
        for (const assigned of groupAssignment) {
          const label = `row=${hasRow} legacy=${hasLegacy} groups=${membership} assigned=${assigned}`;
          it(label, async () => {
            const world: World = {
              rows: hasRow ? [{ userId: 'u1', projectId: 'p1', role: 'member' }] : [],
              groupMembers: membership === 'none'
                ? []
                : [{ groupId: membership === 'assigned-group' ? 'g1' : 'g2', userId: 'u1' }],
              groupProjects: assigned ? [{ groupId: 'g1', projectId: 'p1', role: 'project_admin' }] : [],
            };
            const params = {
              userId: 'u1',
              userRole: 'user',
              projectId: 'p1',
              legacyProjectIds: hasLegacy ? ['p1'] : [],
            };
            const resolved = await resolveProjectMembership(fakeDb(world), params);
            await expect(canAccessProject(fakeDb(world), params)).resolves.toBe(resolved !== null);
          });
        }
      }
    }
  }
});

describe('resolveProjectMembership', () => {
  it('returns the strongest role across sources', async () => {
    const db = fakeDb({
      rows: [{ userId: 'u1', projectId: 'p1', role: 'member' }],
      groupMembers: [{ groupId: 'g1', userId: 'u1' }],
      groupProjects: [{ groupId: 'g1', projectId: 'p1', role: 'project_admin' }],
    });
    await expect(resolveProjectMembership(db, { userId: 'u1', userRole: 'user', projectId: 'p1' }))
      .resolves.toMatchObject({ role: 'project_admin' });
  });

  it('maps a legacy entry to project_admin for a project_admin user and to member otherwise', async () => {
    const db = fakeDb();
    const params = { userId: 'u1', projectId: 'p1', legacyProjectIds: ['p1'] };
    await expect(resolveProjectMembership(db, { ...params, userRole: 'project_admin' }))
      .resolves.toMatchObject({ role: 'project_admin' });
    await expect(resolveProjectMembership(db, { ...params, userRole: 'user' }))
      .resolves.toMatchObject({ role: 'member' });
  });

  it('returns null when nothing grants access', async () => {
    await expect(resolveProjectMembership(fakeDb(), { userId: 'u1', userRole: 'user', projectId: 'p1' }))
      .resolves.toBeNull();
  });
});

describe('collectAccessibleProjectIds', () => {
  it('unions the legacy list, membership rows and group assignments', async () => {
    const db = fakeDb({
      rows: [{ userId: 'u1', projectId: 'p2', role: 'member' }],
      groupMembers: [{ groupId: 'g1', userId: 'u1' }],
      groupProjects: [{ groupId: 'g1', projectId: 'p3', role: 'member' }],
    });
    const ids = await collectAccessibleProjectIds(db, 'u1', ['p1', 'p2']);
    expect([...ids].sort()).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('isProgrammaticUser', () => {
  it('is true only for an explicit canLogin=false', () => {
    expect(isProgrammaticUser({ canLogin: false })).toBe(true);
    expect(isProgrammaticUser({ canLogin: true })).toBe(false);
    expect(isProgrammaticUser({})).toBe(false);
  });
});

describe('canTokenOwnerAccessProject', () => {
  const member = { _id: 'u1', role: 'user' as const };

  it('follows the dashboard rule for an owner that can log in', async () => {
    const withRow = fakeDb({ rows: [{ userId: 'u1', projectId: 'p1', role: 'member' }] });
    await expect(canTokenOwnerAccessProject(withRow, member, 'p1')).resolves.toBe(true);
    await expect(canTokenOwnerAccessProject(withRow, { ...member, canLogin: true }, 'p1')).resolves.toBe(true);
    await expect(canTokenOwnerAccessProject(fakeDb(), member, 'p1')).resolves.toBe(false);
    await expect(canTokenOwnerAccessProject(fakeDb(), { ...member, projectIds: ['p1'] }, 'p1')).resolves.toBe(true);
  });

  it('lets owners and admins in everywhere', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const db = fakeDb();
      await expect(canTokenOwnerAccessProject(db, { _id: 'u1', role }, 'p9')).resolves.toBe(true);
      expect(lookups(db)).toBe(0);
    }
  });

  it('does not tie a login-disabled (programmatic) owner to a membership', async () => {
    const db = fakeDb();
    await expect(canTokenOwnerAccessProject(db, { ...member, canLogin: false }, 'p1')).resolves.toBe(true);
    expect(lookups(db)).toBe(0);
  });

  it('refuses an owner record that has no id and no other grant', async () => {
    await expect(canTokenOwnerAccessProject(fakeDb(), { role: 'user' }, 'p1')).resolves.toBe(false);
  });
});
