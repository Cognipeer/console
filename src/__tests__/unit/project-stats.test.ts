import { describe, expect, it } from 'vitest';
import {
  buildProjectStats,
  computeReadiness,
  directoryDefaultsFor,
  providerProjectIds,
} from '@/lib/services/projects/projectStats';
import {
  applyBulkMembers,
  parseIdList,
  parseRoleEntries,
} from '@/lib/services/projects/projectMembership';
import { describeProjectGroups, loadProjectActivity } from '@/lib/services/projects/projectOverview';

describe('buildProjectStats', () => {
  const data = {
    userProjects: [
      { userId: 'u1', projectId: 'p1' },
      { userId: 'u2', projectId: 'p1' },
      { userId: 'u1', projectId: 'p2' },
      { userId: 'u9', projectId: 'other-tenant-project' },
    ],
    groupProjects: [
      { groupId: 'g1', projectId: 'p1' },
      { groupId: 'g2', projectId: 'p2' },
    ],
    groupMembers: [
      { groupId: 'g1', userId: 'u2' }, // already a direct member of p1
      { groupId: 'g1', userId: 'u3' },
      { groupId: 'g1', userId: 'u4' },
      { groupId: 'g2', userId: 'u5' },
    ],
    providers: [
      { type: 'model' as const, projectIds: ['p1', 'p2'] },
      { type: 'model' as const, projectIds: ['p1'] },
      { type: 'vector' as const, projectIds: ['p1'] },
      { type: 'file' as const, projectId: 'p2' },
      { type: 'embedding' as const }, // unassigned
    ],
    agents: [{ projectId: 'p1' }, { projectId: 'p1' }, { projectId: 'p2' }],
    tokens: [{ projectId: 'p1' }, { projectId: undefined }, { projectId: 'p2' }],
  };

  it('counts direct rows, group grants and distinct people per project', () => {
    const stats = buildProjectStats(['p1', 'p2', 'p3'], data);
    expect(stats.get('p1')).toMatchObject({ members: 2, groups: 1, people: 4 });
    expect(stats.get('p2')).toMatchObject({ members: 1, groups: 1, people: 2 });
    expect(stats.get('p3')).toEqual({
      members: 0, groups: 0, people: 0, providers: 0, providersByDomain: {}, agents: 0, tokens: 0,
    });
  });

  it('counts legacy projectIds memberships like the members list: not owners/admins, not twice, joined with groups', () => {
    const stats = buildProjectStats(['p1', 'p2'], {
      ...data,
      users: [
        { _id: 'u1', role: 'user', projectIds: ['p1', 'p2'] }, // has a row on both: not counted again
        { _id: 'u6', role: 'user', projectIds: ['p1', 'p1', 'gone'] }, // legacy only; duplicate id counted once
        { _id: 'u3', role: 'project_admin', projectIds: ['p1'] }, // legacy, also reaches p1 through g1: one person
        { _id: 'u7', role: 'admin', projectIds: ['p1'] }, // implicit access: never a counted member
        { _id: 'u8', role: 'user' },
      ],
    });
    expect(stats.get('p1')).toMatchObject({ members: 4, groups: 1, people: 5 });
    expect(stats.get('p2')).toMatchObject({ members: 1, people: 2 });
  });

  it('groups providers by domain, honouring legacy projectId and ignoring unassigned ones', () => {
    const stats = buildProjectStats(['p1', 'p2'], data);
    expect(stats.get('p1')).toMatchObject({ providers: 3, providersByDomain: { model: 2, vector: 1 } });
    expect(stats.get('p2')).toMatchObject({ providers: 2, providersByDomain: { model: 1, file: 1 } });
  });

  it('counts agents and tokens by project and skips rows of unknown projects', () => {
    const stats = buildProjectStats(['p1', 'p2'], data);
    expect(stats.get('p1')).toMatchObject({ agents: 2, tokens: 1 });
    expect(stats.get('p2')).toMatchObject({ agents: 1, tokens: 1 });
    expect(stats.has('other-tenant-project')).toBe(false);
  });

  it('providerProjectIds merges the legacy single id and the list without duplicates', () => {
    expect(providerProjectIds({ projectId: 'a', projectIds: ['a', 'b'] }).sort()).toEqual(['a', 'b']);
    expect(providerProjectIds({})).toEqual([]);
  });
});

describe('computeReadiness', () => {
  const stats = (providersByDomain: Record<string, number>) => ({
    members: 0, groups: 0, people: 0, providers: 0, providersByDomain, agents: 0, tokens: 0,
  });

  it('always asks for a model provider and names the tenant domains the project lacks', () => {
    const readiness = computeReadiness({
      stats: stats({ vector: 1 }),
      tenantDomains: ['vector', 'file'],
      hasProjectAdmin: false,
      hasLimits: false,
    });
    expect(readiness).toEqual({
      hasModelProvider: false,
      missingDomains: ['model', 'file'],
      hasProjectAdmin: false,
      hasLimits: false,
    });
  });

  it('is complete when a model provider exists and nothing else is missing', () => {
    const readiness = computeReadiness({
      stats: stats({ model: 1, vector: 1 }),
      tenantDomains: ['model', 'vector'],
      hasProjectAdmin: true,
      hasLimits: true,
    });
    expect(readiness).toMatchObject({ hasModelProvider: true, missingDomains: [] });
  });
});

describe('directoryDefaultsFor', () => {
  it('lists one entry per rule that hands the project out, with that project\'s role', () => {
    const out = directoryDefaultsFor([
      { source: 'oidc', label: 'Okta', mode: 'fallback', applyOn: 'first_sign_in', projects: [{ projectId: 'p1', role: 'member' }, { projectId: 'p2', role: 'project_admin' }] },
      { source: 'ldap', mode: 'always', applyOn: 'every_sign_in', projects: [{ projectId: 'p2', role: 'member' }] },
    ], 'p2');
    expect(out).toEqual([
      { source: 'oidc', label: 'Okta', role: 'project_admin', mode: 'fallback' },
      { source: 'ldap', role: 'member', mode: 'always' },
    ]);
  });
});

describe('request parsing', () => {
  it('keeps valid role entries, dedupes, and warns about the rest', () => {
    const warnings: string[] = [];
    const out = parseRoleEntries([
      { userId: 'a', role: 'member' },
      { userId: 'a', role: 'project_admin' },
      { userId: 'b', role: 'owner' },
      { role: 'member' },
      null,
    ], 'userId', 'Members', warnings);
    expect(out).toEqual([{ id: 'a', role: 'member' }]);
    expect(warnings).toHaveLength(3);
  });

  it('rejects a non-list and trims id lists', () => {
    const warnings: string[] = [];
    expect(parseRoleEntries('x', 'userId', 'Members', warnings)).toEqual([]);
    expect(parseIdList([' a ', 'a', '', 3], 'Remove', warnings)).toEqual(['a']);
    expect(warnings).toHaveLength(1);
  });
});

describe('describeProjectGroups', () => {
  it('names groups, counts members and flags directory-synced groups; drops grants of unknown groups', () => {
    const out = describeProjectGroups({
      grants: [
        { tenantId: 't', groupId: 'g1', projectId: 'p', role: 'member' },
        { tenantId: 't', groupId: 'g2', projectId: 'p', role: 'project_admin' },
        { tenantId: 't', groupId: 'gone', projectId: 'p', role: 'member' },
      ],
      groups: [
        { _id: 'g1', tenantId: 't', name: 'Eng', createdBy: 'x' },
        { _id: 'g2', tenantId: 't', name: 'Okta eng', source: 'oidc', createdBy: 'x' },
      ],
      groupMembers: [{ groupId: 'g1' }, { groupId: 'g1' }, { groupId: 'g2' }],
    });
    expect(out).toEqual([
      { groupId: 'g1', name: 'Eng', role: 'member', memberCount: 2, directorySynced: false, source: 'local' },
      { groupId: 'g2', name: 'Okta eng', role: 'project_admin', memberCount: 1, directorySynced: true, source: 'oidc' },
    ]);
  });
});

describe('applyBulkMembers (fake db)', () => {
  const users = [
    { _id: 'u1', tenantId: 't', email: 'u1@x', name: 'U1', role: 'user' },
    { _id: 'u2', tenantId: 't', email: 'u2@x', name: 'U2', role: 'user' },
    { _id: 'adm', tenantId: 't', email: 'adm@x', name: 'Adm', role: 'admin' },
    { _id: 'ext', tenantId: 't', email: 'ext@x', name: 'Ext', role: 'user', kind: 'external' },
    { _id: 'foreign', tenantId: 'other', email: 'f@x', name: 'F', role: 'user' },
  ];
  const makeDb = () => {
    const rows = new Map<string, Record<string, unknown>>([
      ['u2', { userId: 'u2', projectId: 'p', role: 'member', source: 'directory', invitedBy: 'directory:oidc' }],
    ]);
    const upserts: Array<Record<string, unknown>> = [];
    const db = {
      listUsers: async () => users,
      listUserProjectsByProject: async () => [...rows.values()],
      upsertUserProject: async (data: Record<string, unknown>) => { upserts.push(data); rows.set(String(data.userId), data); return data; },
      deleteUserProject: async (userId: string) => rows.delete(userId),
      updateUser: async () => ({}),
    };
    return { db: db as never, upserts, rows };
  };

  it('adds, changes roles (taking ownership of directory rows) and removes in one call', async () => {
    const { db, upserts, rows } = makeDb();
    const result = await applyBulkMembers(db, {
      tenantId: 't', actorUserId: 'actor', projectId: 'p',
      add: [{ id: 'u1', role: 'member' }],
      setRole: [{ id: 'u2', role: 'project_admin' }],
      remove: [],
    });
    expect(result).toMatchObject({ added: 1, updated: 1, removed: 0, addedIds: ['u1'], updatedIds: ['u2'], warnings: [] });
    expect(upserts.find((u) => u.userId === 'u1')).toMatchObject({ source: 'manual', invitedBy: 'actor' });
    expect(upserts.find((u) => u.userId === 'u2')).toMatchObject({ source: 'manual', role: 'project_admin', invitedBy: 'directory:oidc' });
    expect(rows.has('u2')).toBe(true);

    const removed = await applyBulkMembers(db, {
      tenantId: 't', actorUserId: 'actor', projectId: 'p', add: [], setRole: [], remove: ['u2'],
    });
    expect(removed).toMatchObject({ removed: 1, removedIds: ['u2'] });
  });

  it('warns instead of failing for admins, external, foreign, unknown and already-member users', async () => {
    const { db, upserts } = makeDb();
    const result = await applyBulkMembers(db, {
      tenantId: 't', actorUserId: 'actor', projectId: 'p',
      add: [
        { id: 'adm', role: 'member' },
        { id: 'ext', role: 'member' },
        { id: 'foreign', role: 'member' },
        { id: 'nobody', role: 'member' },
        { id: 'u2', role: 'member' },
      ],
      setRole: [{ id: 'adm', role: 'project_admin' }, { id: 'u1', role: 'member' }],
      remove: ['adm', 'u1'],
    });
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(result.warnings).toHaveLength(9);
    expect(upserts).toHaveLength(0);
  });
  it('one failing entry becomes a warning and the rest of the batch still applies', async () => {
    const { db } = makeDb();
    const flaky = {
      ...(db as unknown as Record<string, unknown>),
      upsertUserProject: async (data: Record<string, unknown>) => {
        if (data.userId === 'u1') throw new Error('boom');
        return data;
      },
    } as never;
    const result = await applyBulkMembers(flaky, {
      tenantId: 't', actorUserId: 'actor', projectId: 'p',
      add: [{ id: 'u1', role: 'member' }],
      setRole: [{ id: 'u2', role: 'project_admin' }],
      remove: [],
    });
    expect(result).toMatchObject({ added: 0, updated: 1, updatedIds: ['u2'] });
    expect(result.warnings).toEqual(['u1@x could not be added.']);
  });
});

describe('loadProjectActivity audit wording', () => {
  const row = (method: string, path: string, at: string) => ({
    method, path, outcome: 'success', createdAt: new Date(at), actorUserId: 'a', actorEmail: 'a@x',
  });
  it('reads a group grant revoke as group access, not as a project deletion', async () => {
    const db = {
      listAuditLogs: async () => [
        row('DELETE', '/api/groups/g1/projects/p1', '2026-10-02T00:00:00Z'),
        row('DELETE', '/api/projects/p1', '2026-10-01T00:00:00Z'),
        row('POST', '/api/projects/p10/members', '2026-10-03T00:00:00Z'),
      ],
    } as never;
    const out = await loadProjectActivity({
      db, projectId: 'p1', userProjects: [], groupGrants: [], groups: [], users: new Map(),
    });
    expect(out.map((e) => e.action)).toEqual(['groups.removed', 'project.deleted']);
  });
});
