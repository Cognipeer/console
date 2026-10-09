/**
 * Principal context: batched group loading (behaviour-identical to the old
 * N+1 loop), the per-(tenant,user) cache with TTL, explicit invalidation hooks
 * and the provider-level invalidation wiring — on BOTH backends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // The real helper closes over the module-local getDatabase, which this mock
    // cannot rebind — so re-implement it on top of the stubbed one.
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import type { DatabaseProvider, IGroup } from '@/lib/database';
import { authorizeGate, configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { onIamInvalidation, invalidatePrincipal, invalidateTenantPrincipals, type IamInvalidation } from '@/lib/iam/events';
import { GROUP_READ_CONCURRENCY, loadGroupGrants, loadUserGroups } from '@/lib/iam/groupGrants';
import {
  PRINCIPAL_CACHE_TTL_MS,
  getPrincipalCacheStats,
  getPrincipalContext,
  resetPrincipalCacheForTests,
  resolveTokenPrincipal,
  resolveUserPrincipal,
} from '@/lib/iam/principalCache';
import { describeForEachProvider } from './db-parity.helper';

// ── pure: batched loader == the old sequential loop ─────────────────────────

/** The loop fastify-utils used before this change, verbatim. */
async function legacyLoadGroupTenantGrants(db: any, userId: string) {
  const memberships = typeof db.listGroupMembersByUser === 'function' ? await db.listGroupMembersByUser(userId) : [];
  if (!Array.isArray(memberships) || memberships.length === 0) return [];
  const grants: any[] = [];
  for (const membership of memberships) {
    const group = await db.findGroupById(String(membership.groupId));
    if (!group) continue;
    const hasServiceGrant = group.servicePermissions && Object.keys(group.servicePermissions).length > 0;
    if (group.tenantRole || hasServiceGrant) grants.push({ tenantRole: group.tenantRole, servicePermissions: group.servicePermissions });
  }
  return grants;
}

function fakeGroupDb(groups: Record<string, Partial<IGroup> | null>, memberships: string[] | 'no-fn' | 'not-array') {
  const calls = { find: 0, list: 0 };
  const db: any = {
    findGroupById: vi.fn(async (id: string) => { calls.find++; return (groups[id] as IGroup) ?? null; }),
    listGroups: vi.fn(async () => { calls.list++; return Object.entries(groups).filter(([, g]) => g).map(([id, g]) => ({ _id: id, ...g })); }),
  };
  if (memberships !== 'no-fn') {
    db.listGroupMembersByUser = vi.fn(async () => (memberships === 'not-array' ? undefined : memberships.map((groupId) => ({ groupId, userId: 'u', role: 'member' }))));
  }
  return { db, calls };
}

describe('loadGroupGrants == legacy loop', () => {
  const groups = {
    g1: { tenantRole: 'user' as const },
    g2: { servicePermissions: { agents: 'admin' as const } },
    g3: { servicePermissions: {} },          // no grant
    g4: { description: 'plain' },            // no grant
    g5: null,                                // dangling membership
    g6: { tenantRole: 'admin' as const, servicePermissions: { members: 'read' as const } },
  };

  it.each([
    ['normal', ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']],
    ['empty', []],
    ['no listGroupMembersByUser', 'no-fn'],
    ['non-array memberships', 'not-array'],
  ] as const)('%s', async (_label, memberships) => {
    const a = fakeGroupDb(groups, memberships as never);
    const b = fakeGroupDb(groups, memberships as never);
    expect(await loadGroupGrants(a.db, 'u')).toEqual(await legacyLoadGroupTenantGrants(b.db, 'u'));
  });

  it('only ever uses per-membership point reads (never lists the tenant groups) with bounded concurrency', async () => {
    const small = fakeGroupDb(groups, ['g1', 'g2']);
    await loadGroupGrants(small.db, 'u');
    expect(small.calls).toEqual({ find: 2, list: 0 });

    const many: Record<string, Partial<IGroup>> = {};
    const ids = Array.from({ length: GROUP_READ_CONCURRENCY * 2 + 5 }, (_, i) => { many[`m${i}`] = { tenantRole: 'user' }; return `m${i}`; });
    const big = fakeGroupDb(many, ids);
    let inflight = 0;
    let maxInflight = 0;
    const original = big.db.findGroupById;
    big.db.findGroupById = vi.fn(async (id: string) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 1));
      const out = await original(id);
      inflight--;
      return out;
    });
    const result = await loadGroupGrants(big.db, 'u');
    expect(big.calls.list).toBe(0);
    expect(big.db.findGroupById).toHaveBeenCalledTimes(ids.length);
    expect(maxInflight).toBeLessThanOrEqual(GROUP_READ_CONCURRENCY);
    expect(result).toHaveLength(ids.length);
    expect(result).toEqual(await legacyLoadGroupTenantGrants(fakeGroupDb(many, ids).db, 'u'));
  });

  it('keeps membership order and returns whole groups from loadUserGroups', async () => {
    const f = fakeGroupDb(groups, ['g6', 'g1']);
    expect((await loadUserGroups(f.db, 'u')).map((g) => g.tenantRole)).toEqual(['admin', 'user']);
  });
});

// ── real providers ──────────────────────────────────────────────────────────

describeForEachProvider('Principal context + invalidation', (getDb) => {
  let dbName: string;
  let tenantId: string;
  let db: DatabaseProvider;
  let events: IamInvalidation[];
  let off: () => void;

  const mkUser = async (email: string, role: 'owner' | 'admin' | 'project_admin' | 'user' = 'user', extra: Record<string, unknown> = {}) =>
    db.createUser({ tenantId, email, name: email, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra });

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `iamp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'P', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    events = [];
    off?.();
    off = onIamInvalidation((e) => events.push(e));
  });
  afterEach(() => off?.());

  const makeGroup = (name: string, extra: Partial<IGroup> = {}) =>
    db.createGroup({ tenantId, name, createdBy: 'test', source: 'local', ...extra } as never);

  it('loads group ids and grants, builds levels with the real rbac functions', async () => {
    const user = await mkUser('a@x.io', 'user', { servicePermissions: { agents: 'none' } });
    const raising = await makeGroup('raisers', { tenantRole: 'user' });
    const plain = await makeGroup('plain');
    await db.addGroupMember({ groupId: String(raising._id), userId: String(user._id), tenantId, role: 'member' });
    await db.addGroupMember({ groupId: String(plain._id), userId: String(user._id), tenantId, role: 'member' });

    const principal = await resolveUserPrincipal({ tenantDbName: dbName, tenantId, userId: String(user._id) });
    expect(principal.kind).toBe('user');
    expect(principal.groupIds.sort()).toEqual([String(raising._id), String(plain._id)].sort());
    expect(principal.sets.writeSvcs).toContain('agents');       // group tenantRole raised the explicit 'none'
    expect(principal.sets.adminSvcs).not.toContain('members');  // adminService stays off

    const gate = await authorizeGate({ tenant: dbName, principal, service: 'agents', method: 'POST' });
    expect(gate.allowed).toBe(true);
  });

  it('token principals: legacy = owner WITHOUT groups, target = owner WITH groups', async () => {
    const user = await mkUser('t@x.io', 'user', { servicePermissions: { agents: 'none' } });
    const g = await makeGroup('raisers', { tenantRole: 'user' });
    await db.addGroupMember({ groupId: String(g._id), userId: String(user._id), tenantId, role: 'member' });
    const base = { tenantDbName: dbName, tenantId, tokenId: 'tok1', ownerUserId: String(user._id), scope: null };

    const legacy = await resolveTokenPrincipal(base);
    const target = await resolveTokenPrincipal({ ...base, includeOwnerGroups: true });
    expect(legacy.kind).toBe('token');
    expect(legacy.groupIds).toEqual([]);
    expect(target.groupIds).toEqual([String(g._id)]);
    expect((await authorizeGate({ tenant: dbName, principal: legacy, service: 'agents', method: 'POST' })).allowed).toBe(false);
    expect((await authorizeGate({ tenant: dbName, principal: target, service: 'agents', method: 'POST' })).allowed).toBe(true);
    // scope still narrows after groups are included
    const narrowed = await resolveTokenPrincipal({ ...base, includeOwnerGroups: true, scope: { agents: 'read' } });
    expect((await authorizeGate({ tenant: dbName, principal: narrowed, service: 'agents', method: 'POST' })).allowed).toBe(false);
    expect((await authorizeGate({ tenant: dbName, principal: narrowed, service: 'agents', method: 'GET' })).allowed).toBe(true);
  });

  it('uses caller-supplied user + grants for the levels (exact legacy inputs)', async () => {
    const user = await mkUser('l@x.io', 'user');
    const principal = await resolveUserPrincipal({
      tenantDbName: dbName, tenantId, userId: String(user._id),
      user: { role: 'admin', servicePermissions: { agents: 'read' } },
      groupGrants: [],
    });
    expect(principal.role).toBe('admin');
    expect(principal.sets.readSvcs).toContain('agents');
    expect(principal.sets.writeSvcs).not.toContain('agents');
    expect(principal.sets.writeSvcs).toContain('models');
  });

  it('projects: owner/admin see all, members get direct + group + legacy, with project-admin roles', async () => {
    const p1 = await db.createProject({ tenantId, key: 'p1', name: 'P1', createdBy: 'x' });
    const p2 = await db.createProject({ tenantId, key: 'p2', name: 'P2', createdBy: 'x' });
    const p3 = await db.createProject({ tenantId, key: 'p3', name: 'P3', createdBy: 'x' });
    const p4 = await db.createProject({ tenantId, key: 'p4', name: 'P4', createdBy: 'x' });
    const ids = [p1, p2, p3, p4].map((p) => String(p._id));

    const admin = await mkUser('adm@x.io', 'admin');
    const adm = await resolveUserPrincipal({ tenantDbName: dbName, tenantId, userId: String(admin._id), withProjects: true });
    expect([...adm.projects].sort()).toEqual([...ids].sort());
    expect([...adm.adminProjects].sort()).toEqual([...ids].sort());

    const user = await mkUser('m@x.io', 'user', { projectIds: [ids[3]] });
    await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: ids[0], role: 'project_admin', servicePermissions: {} });
    const g = await makeGroup('team');
    await db.addGroupMember({ groupId: String(g._id), userId: String(user._id), tenantId, role: 'member' });
    await db.upsertGroupProject({ tenantId, groupId: String(g._id), projectId: ids[1], role: 'member', servicePermissions: {} });
    await db.upsertGroupProject({ tenantId, groupId: String(g._id), projectId: ids[2], role: 'project_admin', servicePermissions: {} });

    const member = await resolveUserPrincipal({ tenantDbName: dbName, tenantId, userId: String(user._id), withProjects: true, fresh: true });
    expect([...member.projects].sort()).toEqual([...ids].sort());
    expect([...member.adminProjects].sort()).toEqual([ids[0], ids[2]].sort());

    // projects are opt-in: a context loaded without them has none until asked
    const lean = await mkUser('lean@x.io', 'user');
    const leanCtx = await getPrincipalContext({ tenantDbName: dbName, tenantId, userId: String(lean._id) });
    expect(leanCtx.projects).toBeUndefined();
    const upgraded = await getPrincipalContext({ tenantDbName: dbName, tenantId, userId: String(lean._id), withProjects: true });
    expect(upgraded.projects).toEqual([]);
  });

  it('caches per (tenant,user): hit, TTL expiry, fresh bypass, and no cached failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const user = await mkUser('c@x.io');
      const input = { tenantDbName: dbName, tenantId, userId: String(user._id) };
      const first = await getPrincipalContext(input);
      const second = await getPrincipalContext(input);
      expect(second).toBe(first);
      let stats = getPrincipalCacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.entries).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.5);

      expect(await getPrincipalContext({ ...input, fresh: true })).not.toBe(first);

      vi.setSystemTime(Date.now() + PRINCIPAL_CACHE_TTL_MS + 1);
      const afterTtl = await getPrincipalContext(input);
      expect(afterTtl).not.toBe(first);

      await expect(getPrincipalContext({ ...input, userId: 'ghost' })).rejects.toThrow();
      stats = getPrincipalCacheStats();
      expect(stats.entries).toBe(1); // the failed load left no entry behind
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates concurrent loads', async () => {
    const user = await mkUser('d@x.io');
    const input = { tenantDbName: dbName, tenantId, userId: String(user._id) };
    const [a, b, c] = await Promise.all([getPrincipalContext(input), getPrincipalContext(input), getPrincipalContext(input)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(getPrincipalCacheStats().loads).toBe(1);
  });

  it('explicit hooks drop one user / a whole tenant', async () => {
    const u1 = await mkUser('h1@x.io');
    const u2 = await mkUser('h2@x.io');
    const i1 = { tenantDbName: dbName, tenantId, userId: String(u1._id) };
    const i2 = { tenantDbName: dbName, tenantId, userId: String(u2._id) };
    const c1 = await getPrincipalContext(i1);
    const c2 = await getPrincipalContext(i2);
    invalidatePrincipal(dbName, String(u1._id));
    expect(await getPrincipalContext(i2)).toBe(c2);
    expect(await getPrincipalContext(i1)).not.toBe(c1);
    const c1b = await getPrincipalContext(i1);
    invalidateTenantPrincipals(dbName);
    expect(await getPrincipalContext(i1)).not.toBe(c1b);
    expect(await getPrincipalContext(i2)).not.toBe(c2);
    // null tenant = everywhere
    const c1c = await getPrincipalContext(i1);
    invalidatePrincipal(null, String(u1._id));
    expect(await getPrincipalContext(i1)).not.toBe(c1c);
  });

  describe('provider-level invalidation wiring (writes made anywhere refresh the cache)', () => {
    const warm = async (userId: string) => getPrincipalContext({ tenantDbName: dbName, tenantId, userId });

    it('updateUser / deleteUser drop that user', async () => {
      const u = await mkUser('w1@x.io');
      const before = await warm(String(u._id));
      await db.updateUser(String(u._id), { servicePermissions: { agents: 'none' } });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'user', userId: String(u._id) }));
      const after = await warm(String(u._id));
      expect(after).not.toBe(before);
      expect(after.user.servicePermissions).toEqual({ agents: 'none' });
      events.length = 0;
      await db.deleteUser(String(u._id));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'user', userId: String(u._id) }));
    });

    it('group edits and membership changes are visible immediately', async () => {
      const u = await mkUser('w2@x.io', 'user', { servicePermissions: { agents: 'none' } });
      const g = await makeGroup('flip', { tenantRole: 'user' });
      const uid = String(u._id);
      const gid = String(g._id);
      await warm(uid);

      await db.addGroupMember({ groupId: gid, userId: uid, tenantId, role: 'member' });
      let ctx = await warm(uid);
      expect(ctx.groupIds).toEqual([gid]);
      expect(ctx.groupGrants).toEqual([expect.objectContaining({ tenantRole: 'user' })]);

      await db.updateGroup(gid, { tenantRole: 'admin' });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tenant-principals' }));
      ctx = await warm(uid);
      expect(ctx.groupGrants).toEqual([expect.objectContaining({ tenantRole: 'admin' })]);

      await db.removeGroupMember(gid, uid);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'user', userId: uid }));
      ctx = await warm(uid);
      expect(ctx.groupIds).toEqual([]);
      expect(ctx.groupGrants).toEqual([]);

      await db.addGroupMember({ groupId: gid, userId: uid, tenantId, role: 'member' });
      await warm(uid);
      await db.deleteGroupMembersByGroup(gid);
      await db.deleteGroup(gid);
      ctx = await warm(uid);
      expect(ctx.groupIds).toEqual([]);
    });

    it('project assignments and token changes invalidate too', async () => {
      const u = await mkUser('w3@x.io');
      const uid = String(u._id);
      const project = await db.createProject({ tenantId, key: 'wp', name: 'WP', createdBy: 'x' });
      const g = await makeGroup('pg');
      await db.addGroupMember({ groupId: String(g._id), userId: uid, tenantId, role: 'member' });
      await getPrincipalContext({ tenantDbName: dbName, tenantId, userId: uid, withProjects: true });

      await db.upsertUserProject({ tenantId, userId: uid, projectId: String(project._id), role: 'member', servicePermissions: {} });
      let ctx = await getPrincipalContext({ tenantDbName: dbName, tenantId, userId: uid, withProjects: true });
      expect(ctx.projects).toEqual([String(project._id)]);

      await db.deleteUserProject(uid, String(project._id));
      ctx = await getPrincipalContext({ tenantDbName: dbName, tenantId, userId: uid, withProjects: true });
      expect(ctx.projects).toEqual([]);

      await db.upsertGroupProject({ tenantId, groupId: String(g._id), projectId: String(project._id), role: 'member', servicePermissions: {} });
      ctx = await getPrincipalContext({ tenantDbName: dbName, tenantId, userId: uid, withProjects: true });
      expect(ctx.projects).toEqual([String(project._id)]);

      events.length = 0;
      const token = await db.createApiToken({ tenantId, userId: uid, label: 'x', tokenHash: `h-${Math.random()}`, tokenPrefix: 'cp_test', createdBy: uid } as never);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'user', userId: uid }));
      events.length = 0;
      await db.deleteApiToken(String(token._id), uid);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'user', userId: uid }));

      // deleting a project drops every principal slice that lists it
      events.length = 0;
      await db.deleteProject(String(project._id));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tenant-principals' }));
    });

    it('inside a tenant scope the event carries the tenant label (and only that tenant is dropped)', async () => {
      const u = await mkUser('w0@x.io');
      await getPrincipalContext({ tenantDbName: dbName, tenantId, userId: String(u._id) });
      events.length = 0;
      await db.runWithTenant!(dbName, () => db.updateUser(String(u._id), { name: 'Scoped' }));
      expect(events).toContainEqual({ kind: 'user', tenantDbName: dbName, userId: String(u._id) });
      await db.runWithTenant!(dbName, () => db.updateGroup('no-such-group', { name: 'x' }).catch(() => null));
      expect(events).toContainEqual({ kind: 'tenant-principals', tenantDbName: dbName });
    });

    it('the wrapper passes results and errors through untouched and survives a throwing listener', async () => {
      const bad = onIamInvalidation(() => { throw new Error('listener boom'); });
      try {
        const u = await mkUser('w4@x.io');
        const updated = await db.updateUser(String(u._id), { name: 'Renamed' });
        expect(updated?.name).toBe('Renamed');
        expect(await db.deleteGroup('does-not-exist-000000000000000000000000').catch(() => false)).toBeFalsy();
      } finally {
        bad();
      }
    });
  });
});
