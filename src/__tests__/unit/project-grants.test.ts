/**
 * The pure parts of giving a person several project memberships: reading the body of a request, the legacy single
 * `projectId`, who administers which project, and what a write does to existing memberships.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyProjectGrants,
  inviteGrantsOf,
  parseProjectGrants,
  projectsAdministeredBy,
  unknownProjectIds,
} from '@/lib/services/users/projectGrants';

describe('parseProjectGrants', () => {
  it('reads a list of projects with roles, the last entry of a project winning', () => {
    expect(parseProjectGrants([
      { projectId: 'p1', role: 'member' },
      { projectId: ' p2 ', role: 'project_admin' },
      { projectId: 'p1', role: 'project_admin' },
    ])).toEqual({
      ok: true,
      grants: [{ projectId: 'p1', role: 'project_admin' }, { projectId: 'p2', role: 'project_admin' }],
    });
  });

  it('refuses everything else, naming the problem', () => {
    for (const bad of [undefined, 'p1', {}, [null], [[]], [{ role: 'member' }], [{ projectId: '', role: 'member' }], [{ projectId: 'p1' }], [{ projectId: 'p1', role: 'owner' }], [{ projectId: 'p1', role: 'user' }]]) {
      const parsed = parseProjectGrants(bad);
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
      if (!parsed.ok) expect(parsed.error).toBeTruthy();
    }
    expect(parseProjectGrants(Array.from({ length: 101 }, (_, i) => ({ projectId: `p${i}`, role: 'member' }))).ok).toBe(false);
  });
});

describe('inviteGrantsOf', () => {
  it('maps the legacy projectId through the role of the person', () => {
    expect(inviteGrantsOf({ projectId: 'p1', role: 'user' })).toEqual({ ok: true, grants: [{ projectId: 'p1', role: 'member' }] });
    expect(inviteGrantsOf({ projectId: 'p1', role: 'project_admin' })).toEqual({ ok: true, grants: [{ projectId: 'p1', role: 'project_admin' }] });
  });

  it('gives an admin no memberships (access everywhere), but still refuses a malformed list', () => {
    expect(inviteGrantsOf({ projectId: 'p1', role: 'admin', projects: [{ projectId: 'p2', role: 'member' }] })).toEqual({ ok: true, grants: [] });
    expect(inviteGrantsOf({ role: 'admin', projects: 'x' }).ok).toBe(false);
  });

  it('puts the list first and adds the legacy projectId only when the list does not name it', () => {
    expect(inviteGrantsOf({ role: 'user', projectId: 'p1', projects: [{ projectId: 'p2', role: 'project_admin' }] })).toEqual({
      ok: true,
      grants: [{ projectId: 'p2', role: 'project_admin' }, { projectId: 'p1', role: 'member' }],
    });
    expect(inviteGrantsOf({ role: 'user', projectId: 'p2', projects: [{ projectId: 'p2', role: 'project_admin' }] })).toEqual({
      ok: true,
      grants: [{ projectId: 'p2', role: 'project_admin' }],
    });
  });

  it('has nothing to grant without either', () => {
    expect(inviteGrantsOf({ role: 'user' })).toEqual({ ok: true, grants: [] });
  });
});

describe('unknownProjectIds', () => {
  it('names the projects the workspace does not have', () => {
    const projects = new Map([['p1', { _id: 'p1' }]]) as never;
    expect(unknownProjectIds([{ projectId: 'p1', role: 'member' }, { projectId: 'p9', role: 'member' }], projects)).toEqual(['p9']);
  });
});

describe('projectsAdministeredBy', () => {
  const db = (over: Record<string, unknown> = {}) => ({
    listUserProjectsByUser: vi.fn().mockResolvedValue([]),
    listGroupMembersByUser: vi.fn().mockResolvedValue([]),
    listGroupProjectsByGroup: vi.fn().mockResolvedValue([]),
    findUserById: vi.fn().mockResolvedValue(null),
    ...over,
  });

  it('is every project for an owner or admin, with no reads', async () => {
    const d = db();
    expect([...await projectsAdministeredBy(d as never, { userId: 'u', role: 'admin' }, ['a', 'b'])]).toEqual(['a', 'b']);
    expect(d.listUserProjectsByUser).not.toHaveBeenCalled();
  });

  it('is the projects where the person is a project admin: a direct row, the legacy list of a project_admin, or a group grant', async () => {
    const d = db({
      listUserProjectsByUser: vi.fn().mockResolvedValue([{ projectId: 'a', role: 'project_admin' }, { projectId: 'b', role: 'member' }]),
      findUserById: vi.fn().mockResolvedValue({ projectIds: ['c'] }),
      listGroupMembersByUser: vi.fn().mockResolvedValue([{ groupId: 'g' }]),
      listGroupProjectsByGroup: vi.fn().mockResolvedValue([{ projectId: 'd', role: 'project_admin' }, { projectId: 'e', role: 'member' }]),
    });
    const got = await projectsAdministeredBy(d as never, { userId: 'u', role: 'project_admin' }, ['a', 'b', 'c', 'd', 'e', 'f']);
    expect([...got].sort()).toEqual(['a', 'c', 'd']);
  });

  it('lets a direct row decide over the legacy list, as the single add does', async () => {
    const d = db({
      listUserProjectsByUser: vi.fn().mockResolvedValue([{ projectId: 'c', role: 'member' }]),
      findUserById: vi.fn().mockResolvedValue({ projectIds: ['c'] }),
    });
    expect((await projectsAdministeredBy(d as never, { userId: 'u', role: 'project_admin' }, ['c'])).size).toBe(0);
  });

  it('does not count the legacy list of a member who is not a project admin', async () => {
    const d = db({ findUserById: vi.fn().mockResolvedValue({ projectIds: ['c'] }) });
    expect((await projectsAdministeredBy(d as never, { userId: 'u', role: 'user' }, ['c'])).size).toBe(0);
  });
});

describe('applyProjectGrants', () => {
  const run = (existing: Array<Record<string, unknown>>, input: Record<string, unknown>) => {
    const upsertUserProject = vi.fn().mockResolvedValue({});
    const db = { listUserProjectsByUser: vi.fn().mockResolvedValue(existing), upsertUserProject };
    return applyProjectGrants(db as never, { tenantId: 't', userId: 'u', actorId: 'a', grants: [], ...input } as never).then((result) => ({ result, upsertUserProject }));
  };

  it('reads the person\'s memberships once, not once per project', async () => {
    const upsertUserProject = vi.fn();
    const listUserProjectsByUser = vi.fn().mockResolvedValue([]);
    await applyProjectGrants({ listUserProjectsByUser, upsertUserProject } as never, {
      tenantId: 't', userId: 'u', actorId: 'a', grants: [{ projectId: 'p1', role: 'member' }, { projectId: 'p2', role: 'member' }, { projectId: 'p3', role: 'member' }],
    });
    expect(listUserProjectsByUser).toHaveBeenCalledTimes(1);
    expect(upsertUserProject).toHaveBeenCalledTimes(3);
  });

  it('adds new memberships as manual rows recorded to the actor', async () => {
    const { result, upsertUserProject } = await run([], { grants: [{ projectId: 'p1', role: 'member' }] });
    expect(result).toEqual({ added: ['p1'], updated: [], skipped: [] });
    expect(upsertUserProject).toHaveBeenCalledWith({
      tenantId: 't', userId: 'u', projectId: 'p1', role: 'member', servicePermissions: {}, invitedBy: 'a', source: 'manual',
    });
  });

  it('skips an existing row with the same role, updates one with another role, keeping who invited them', async () => {
    const { result, upsertUserProject } = await run(
      [
        { projectId: 'p1', role: 'member', servicePermissions: {}, invitedBy: 'old' },
        { projectId: 'p2', role: 'member', servicePermissions: { models: 'read' }, invitedBy: 'old' },
      ],
      { grants: [{ projectId: 'p1', role: 'member' }, { projectId: 'p2', role: 'project_admin' }] },
    );
    expect(result).toEqual({ added: [], updated: ['p2'], skipped: [{ projectId: 'p1', reason: 'already_member' }] });
    expect(upsertUserProject).toHaveBeenCalledTimes(1);
    expect(upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p2', role: 'project_admin', invitedBy: 'old', servicePermissions: { models: 'read' }, source: 'manual',
    }));
  });

  it('takes over a row the directory made: it is recorded to the actor from then on', async () => {
    const { result, upsertUserProject } = await run(
      [{ projectId: 'p1', role: 'member', servicePermissions: {}, invitedBy: 'directory:oidc', source: 'directory' }],
      { grants: [{ projectId: 'p1', role: 'project_admin' }] },
    );
    expect(result.updated).toEqual(['p1']);
    expect(upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({ invitedBy: 'a', source: 'manual' }));
  });

  it('updates the service access of a row with the same role when a different one is asked for', async () => {
    const existing = [{ projectId: 'p1', role: 'member', servicePermissions: { models: 'read' } }];
    const same = await run(existing, { grants: [{ projectId: 'p1', role: 'member' }], servicePermissions: { models: 'read' } });
    expect(same.result.skipped).toHaveLength(1);
    const changed = await run(existing, { grants: [{ projectId: 'p1', role: 'member' }], servicePermissions: { models: 'write' } });
    expect(changed.result.updated).toEqual(['p1']);
    const reset = await run(existing, { grants: [{ projectId: 'p1', role: 'member' }], servicePermissions: null });
    expect(reset.result.updated).toEqual(['p1']);
    expect(reset.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({ servicePermissions: {} }));
  });
});
