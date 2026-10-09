/**
 * Enforce mode (C4) building blocks, on BOTH backends (SQLite and MongoDB via
 * mongodb-memory-server): mode resolution, project narrowing, the enforce
 * decision, and project access through groups.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn(), gate: null as null | ((...args: unknown[]) => unknown) }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    authorizeGate: (...args: Parameters<typeof actual.authorizeGate>) =>
      hoisted.gate ? hoisted.gate(...args) : actual.authorizeGate(...args),
  };
});

import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { decideEnforced, getEnforceStats, resetEnforceStatsForTests, type EnforceGateInput } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import {
  narrowLevel,
  narrowedLevelSets,
  pickActiveProjectId,
  resetProjectNarrowingCachesForTests,
  resolveNarrowingMembership,
} from '@/lib/iam/projectNarrowing';
import {
  ENFORCEMENT_LOOKUP_TIMEOUT_MS,
  getModeLookupStats,
  peekAuthzMode,
  primeAuthzModeForTests,
  resolveEnforcement,
  resetAuthzModeCacheForTests,
  setAuthzMode,
} from '@/lib/iam/shadow';
import { resetProjectMembershipCacheForTests } from '@/lib/iam/shadow/projectMembership';
import { findGroupProjectMembership } from '@/lib/services/projects/accessibleProjects';
import { ProjectContextError, resolveProjectContext } from '@/lib/services/projects/projectContext';
import { describeForEachProvider } from './db-parity.helper';

let savedKillSwitch: string | undefined;
beforeAll(() => {
  savedKillSwitch = process.env.IAM_ENFORCE_DISABLED;
  delete process.env.IAM_ENFORCE_DISABLED; // __tests__/setup.ts turns enforcement off globally
});
afterAll(() => {
  if (savedKillSwitch === undefined) delete process.env.IAM_ENFORCE_DISABLED;
  else process.env.IAM_ENFORCE_DISABLED = savedKillSwitch;
});

describe('pure helpers', () => {
  it('narrowLevel: only an EXPLICIT project setting narrows, and only downwards', () => {
    const member = { role: 'member' as const, servicePermissions: { agents: 'read' as const } };
    expect(narrowLevel('write', member, 'agents')).toBe('read');
    expect(narrowLevel('admin', member, 'agents')).toBe('read');
    expect(narrowLevel('none', member, 'agents')).toBe('none');
    expect(narrowLevel('read', { role: 'member', servicePermissions: { agents: 'admin' } }, 'agents')).toBe('read'); // never raises
    expect(narrowLevel('write', member, 'prompts')).toBe('write'); // not mentioned: tenant level stands
    expect(narrowLevel('admin', { role: 'member' }, 'members')).toBe('admin'); // role defaults never narrow
    expect(narrowLevel('write', null, 'agents')).toBe('write');
  });

  it('narrowedLevelSets applies the narrowing to the whole service list', () => {
    const sets = narrowedLevelSets({ role: 'user' }, [], { role: 'member', servicePermissions: { agents: 'read', prompts: 'none' } });
    expect(sets.readSvcs).toContain('agents');
    expect(sets.writeSvcs).not.toContain('agents');
    expect(sets.readSvcs).not.toContain('prompts');
    expect(sets.writeSvcs).toContain('models');
  });

  it('pickActiveProjectId mirrors resolveProjectContext', () => {
    const members = ['a', 'b'];
    expect(pickActiveProjectId({ requestedProjectId: 'b', memberProjectIds: members })).toBe('b');
    expect(pickActiveProjectId({ requestedProjectId: 'zzz', memberProjectIds: members })).toBe('a');
    expect(pickActiveProjectId({ requestedProjectId: undefined, defaultProjectId: 'b', memberProjectIds: members })).toBe('b');
    expect(pickActiveProjectId({ requestedProjectId: undefined, defaultProjectId: 'not-mine', memberProjectIds: members })).toBe('a');
    expect(pickActiveProjectId({ requestedProjectId: 'a', memberProjectIds: [] })).toBeUndefined();
  });
});

describeForEachProvider('Enforce mode', (getDb) => {
  let db: DatabaseProvider;
  let tenant: string;
  let tenantId: string;
  let seq = 0;

  const mkUser = async (role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
    seq++;
    return (await db.createUser({
      tenantId, email: `u${seq}-${Math.random().toString(36).slice(2, 7)}@x.io`, name: `u${seq}`, password: '$2b$10$x',
      role, licenseId: 'FREE', features: [], ...extra,
    })) as IUser;
  };
  const mkProject = async (key: string) => String((await db.createProject({ tenantId, key, name: key, createdBy: 'x' }))._id);
  const mkGroup = async (name: string, extra: Record<string, unknown> = {}) =>
    String((await db.createGroup({ tenantId, name, createdBy: 't', source: 'local', ...extra } as never))._id);

  const gateInput = (over: Partial<EnforceGateInput> & { user: IUser }): EnforceGateInput => ({
    subject: 'session',
    tenantDbName: tenant,
    tenantId,
    requestId: 'r-1',
    method: 'POST',
    route: '/api/agents/x',
    userId: String(over.user._id),
    groupGrants: [],
    service: 'agents',
    legacyAllowed: true,
    ...over,
  });

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    hoisted.gate = null;
    db = getDb();
    const slug = `enf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tenant = `tenant_${slug}`;
    const t = await db.createTenant({ companyName: 'E', slug, dbName: tenant, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(t._id);
    await db.switchToTenant(tenant);
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    resetAuthzModeCacheForTests();
    resetProjectMembershipCacheForTests();
    resetProjectNarrowingCachesForTests();
    resetEnforceStatsForTests();
  });

  afterEach(() => {
    delete process.env.IAM_ENFORCE_DISABLED;
    vi.restoreAllMocks();
  });

  // ── mode resolution ─────────────────────────────────────────────────────

  describe('resolveEnforcement', () => {
    it('reads the stored mode on the very first call (no placeholder gap) and follows changes', async () => {
      expect(await resolveEnforcement(tenant)).toBe(false); // default legacy
      await setAuthzMode(tenant, 'shadow', 'a');
      expect(await resolveEnforcement(tenant)).toBe(false); // shadow does not decide
      await setAuthzMode(tenant, 'enforce', 'a');
      resetAuthzModeCacheForTests(); // as after a restart / on another node
      expect(await resolveEnforcement(tenant)).toBe(true);
      await setAuthzMode(tenant, 'legacy', 'a');
      expect(await resolveEnforcement(tenant)).toBe(false);
    });

    it('is per tenant', async () => {
      await setAuthzMode(tenant, 'enforce', 'a');
      resetAuthzModeCacheForTests();
      expect(await resolveEnforcement(tenant)).toBe(true);
      expect(await resolveEnforcement(`${tenant}_other`)).toBe(false);
    });

    it('IAM_ENFORCE_DISABLED forces legacy decisions', async () => {
      await setAuthzMode(tenant, 'enforce', 'a');
      process.env.IAM_ENFORCE_DISABLED = '1';
      expect(await resolveEnforcement(tenant)).toBe(false);
      delete process.env.IAM_ENFORCE_DISABLED;
      expect(await resolveEnforcement(tenant)).toBe(true);
    });

    it('keeps the last known mode when the refresh fails, and is legacy for a tenant never read', async () => {
      await setAuthzMode(tenant, 'enforce', 'a');
      primeAuthzModeForTests(tenant, 'enforce', -1); // known, but stale
      vi.spyOn(db, 'iamDocGet').mockRejectedValue(new Error('db down'));
      expect(await resolveEnforcement(tenant)).toBe(true);

      resetAuthzModeCacheForTests();
      expect(await resolveEnforcement(tenant)).toBe(false); // never read: legacy
    });

    it('a known mode never blocks the request path again: an expired entry answers at once and refreshes in the background', async () => {
      await setAuthzMode(tenant, 'legacy', 'a');
      primeAuthzModeForTests(tenant, 'legacy', -1); // known, expired
      const original = db.iamDocGet.bind(db);
      const spy = vi.spyOn(db, 'iamDocGet').mockImplementation(async (...args: Parameters<typeof original>) => {
        await new Promise((r) => setTimeout(r, 300));
        return original(...args);
      });
      const started = Date.now();
      expect(await resolveEnforcement(tenant)).toBe(false);
      expect(Date.now() - started).toBeLessThan(150); // did not wait for the 300 ms read
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    });

    it('a failing background refresh does not flip an enforce tenant to legacy (peek path)', async () => {
      await setAuthzMode(tenant, 'enforce', 'a');
      primeAuthzModeForTests(tenant, 'enforce', -1);
      vi.spyOn(db, 'iamDocGet').mockRejectedValue(new Error('db down'));
      expect(peekAuthzMode(tenant)).toBe('enforce'); // starts the failing refresh
      await new Promise((r) => setTimeout(r, 50));
      expect(await resolveEnforcement(tenant)).toBe(true); // before the fix the failure cached `legacy` for 30 s
      expect(peekAuthzMode(tenant)).toBe('enforce');
    });

    it('a first read that fails or times out is counted (coarse reason only) and treated as legacy', async () => {
      vi.spyOn(db, 'iamDocGet').mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:27017'));
      expect(await resolveEnforcement(tenant)).toBe(false);
      expect(getModeLookupStats()).toMatchObject({ fallbacks: 1, lastFallbackReason: 'mode_lookup_failed' });
      expect(JSON.stringify(getModeLookupStats())).not.toContain('10.1.2.3');
    });

    it('does not wait for a slow database longer than the lookup timeout, and corrects itself when the read lands', async () => {
      await setAuthzMode(tenant, 'enforce', 'a');
      resetAuthzModeCacheForTests();
      const original = db.iamDocGet.bind(db);
      vi.spyOn(db, 'iamDocGet').mockImplementation(async (...args: Parameters<typeof original>) => {
        await new Promise((r) => setTimeout(r, ENFORCEMENT_LOOKUP_TIMEOUT_MS + 250));
        return original(...args);
      });
      const started = Date.now();
      expect(await resolveEnforcement(tenant)).toBe(false); // legacy while the mode is unknown
      expect(Date.now() - started).toBeLessThan(ENFORCEMENT_LOOKUP_TIMEOUT_MS + 200);
      expect(getModeLookupStats()).toMatchObject({ fallbacks: 1, lastFallbackReason: 'mode_lookup_timeout' });
      await vi.waitFor(async () => expect(await resolveEnforcement(tenant)).toBe(true), { timeout: 3000, interval: 50 });
    });
  });

  // ── narrowing ───────────────────────────────────────────────────────────

  describe('resolveNarrowingMembership', () => {
    const resolve = (user: IUser, requestedProjectId?: string | null, groupGrants: any[] = []) =>
      resolveNarrowingMembership({
        tenantDbName: tenant, tenantId, userId: String(user._id), role: String(user.role), user, groupGrants, requestedProjectId,
      });

    it('direct membership, legacy projectIds and group assignments all count; the explicit settings are merged', async () => {
      const pid = await mkProject('p1');
      const direct = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(direct._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      expect(await resolve(direct, pid)).toMatchObject({ projectId: pid, membership: { servicePermissions: { agents: 'read' } } });

      const legacy = await mkUser('user', { projectIds: [pid] });
      expect(await resolve(legacy, pid)).toMatchObject({ projectId: pid, membership: { role: 'member' } });

      const viaGroup = await mkUser('user');
      const g1 = await mkGroup('g1');
      const g2 = await mkGroup('g2');
      for (const g of [g1, g2]) await db.addGroupMember({ groupId: g, userId: String(viaGroup._id), tenantId, role: 'member' });
      await db.upsertGroupProject({ tenantId, groupId: g1, projectId: pid, role: 'member', servicePermissions: { agents: 'read', prompts: 'none' } });
      await db.upsertGroupProject({ tenantId, groupId: g2, projectId: pid, role: 'project_admin', servicePermissions: { agents: 'write' } });
      const found = await resolve(viaGroup, pid);
      expect(found?.membership.role).toBe('project_admin');
      expect(found?.membership.servicePermissions).toMatchObject({ agents: 'write', prompts: 'none' }); // highest per service
    });

    it('owners, admins and group-admins are never narrowed; no membership means nothing to narrow with', async () => {
      const pid = await mkProject('p2');
      const owner = await mkUser('owner');
      const admin = await mkUser('admin');
      expect(await resolve(owner, pid)).toBeNull();
      expect(await resolve(admin, pid)).toBeNull();
      const stranger = await mkUser('user');
      expect(await resolve(stranger, pid)).toBeNull();
      const gAdmin = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(gAdmin._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      expect(await resolve(gAdmin, pid, [{ tenantRole: 'admin' }])).toBeNull();
    });

    it('the project is the one the handler would run in (fallback to the first accessible one)', async () => {
      const pa = await mkProject('pa');
      const pb = await mkProject('pb');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pa, role: 'member', servicePermissions: { agents: 'read' } });
      for (const requested of [null, undefined, 'unknown', pb, 'x;DROP TABLE']) {
        expect((await resolve(user, requested))?.projectId).toBe(pa);
      }
    });

    it('exactProject (tokens): the token\'s own project or nothing, never another project\'s settings', async () => {
      const mine = await mkProject('pm');
      const foreign = await mkProject('pf');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: mine, role: 'member', servicePermissions: { agents: 'read' } });
      const exact = (requested?: string | null) => resolveNarrowingMembership({
        tenantDbName: tenant, tenantId, userId: String(user._id), role: 'user', user, groupGrants: [], requestedProjectId: requested, exactProject: true,
      });
      expect((await exact(mine))?.projectId).toBe(mine);
      expect(await exact(foreign)).toBeNull(); // not a member there: nothing narrows (no borrowing of `mine`)
      expect(await exact(null)).toBeNull();
      // the session rule is unchanged
      expect((await resolve(user, foreign))?.projectId).toBe(mine);
    });

    it('findGroupProjectMembership: null without a group assignment', async () => {
      const pid = await mkProject('p3');
      const user = await mkUser('user');
      expect(await findGroupProjectMembership(db, String(user._id), pid)).toBeNull();
      const g = await mkGroup('g3');
      await db.addGroupMember({ groupId: g, userId: String(user._id), tenantId, role: 'member' });
      expect(await findGroupProjectMembership(db, String(user._id), pid)).toBeNull();
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      expect(await findGroupProjectMembership(db, String(user._id), pid)).toEqual({ role: 'member', servicePermissions: { agents: 'read' } });
    });
  });

  // ── the decision ────────────────────────────────────────────────────────

  describe('decideEnforced', () => {
    it('token + owner groups: the group raises the token, the scope still caps it', async () => {
      const user = await mkUser('user', { servicePermissions: { agents: 'none' } });
      const g = await mkGroup('raisers', { tenantRole: 'user' });
      await db.addGroupMember({ groupId: g, userId: String(user._id), tenantId, role: 'member' });

      const unscoped = await decideEnforced(gateInput({ user, subject: 'token', tokenId: 't1', tokenScope: null, legacyAllowed: false }));
      expect(unscoped).toMatchObject({ allowed: true, source: 'engine' });
      const readCap = await decideEnforced(gateInput({ user, subject: 'token', tokenId: 't2', tokenScope: { agents: 'read' }, legacyAllowed: false }));
      expect(readCap).toMatchObject({ allowed: false, service: 'agents', required: 'write' });
      const emptyCap = await decideEnforced(gateInput({ user, subject: 'token', tokenId: 't3', tokenScope: {}, method: 'GET', legacyAllowed: false }));
      expect(emptyCap.allowed).toBe(false);
    });

    it('session: narrowing by the requested project; a service the project does not mention is unaffected', async () => {
      const pid = await mkProject('p4');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      const denied = await decideEnforced(gateInput({ user, requestedProjectId: pid }));
      expect(denied).toMatchObject({ allowed: false, source: 'engine', service: 'agents', required: 'write' });
      expect(typeof (denied as { decisionId: string }).decisionId).toBe('string');
      expect((await decideEnforced(gateInput({ user, requestedProjectId: pid, method: 'GET' }))).allowed).toBe(true);
      expect((await decideEnforced(gateInput({ user, requestedProjectId: pid, service: 'prompts' }))).allowed).toBe(true);
    });

    it('falls back to the legacy decision when the engine fails, never to "allow"', async () => {
      const user = await mkUser('user');
      hoisted.gate = async () => ({ allowed: false, reasons: [], errors: ['down'], obligations: {}, durationUs: 1, failed: true });
      expect(await decideEnforced(gateInput({ user, legacyAllowed: true }))).toMatchObject({ allowed: true, source: 'legacy-fallback' });
      expect(await decideEnforced(gateInput({ user, legacyAllowed: false }))).toMatchObject({ allowed: false, source: 'legacy-fallback' });
      hoisted.gate = async () => { throw new Error('boom'); };
      expect(await decideEnforced(gateInput({ user, legacyAllowed: false }))).toMatchObject({ allowed: false, source: 'legacy-fallback' });
      expect(getEnforceStats().fallbacks).toBe(3);
    });

    it('the tenant owner always reaches the iam service, even with no engine at all', async () => {
      const owner = await mkUser('owner');
      hoisted.gate = async () => { throw new Error('boom'); };
      expect(await decideEnforced(gateInput({ user: owner, service: 'iam', legacyAllowed: true }))).toMatchObject({ allowed: true, source: 'owner-safety' });
      // not for other roles, and not for other services
      const admin = await mkUser('admin');
      expect(await decideEnforced(gateInput({ user: admin, service: 'iam', legacyAllowed: true }))).toMatchObject({ source: 'legacy-fallback' });
    });
  });

  // ── project access through groups ───────────────────────────────────────

  describe('resolveProjectContext', () => {
    it('a user who reaches a project only through a group: legacy refuses, enforce resolves it with the group\'s role and settings', async () => {
      const pid = await mkProject('p5');
      const user = await mkUser('user');
      const g = await mkGroup('team');
      await db.addGroupMember({ groupId: g, userId: String(user._id), tenantId, role: 'member' });
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: pid, role: 'project_admin', servicePermissions: { agents: 'read' } });
      const ctx = { tenantDbName: tenant, tenantId, userId: String(user._id), activeProjectId: pid };

      await expect(resolveProjectContext(ctx)).rejects.toMatchObject({ name: 'ProjectContextError', status: 403, message: 'No project assigned' });

      await setAuthzMode(tenant, 'enforce', 'a');
      const resolved = await resolveProjectContext(ctx);
      expect(resolved.projectId).toBe(pid);
      expect(resolved.userProject).toMatchObject({ role: 'project_admin', servicePermissions: { agents: 'read' } });
      // no cookie: still lands in the group project
      expect((await resolveProjectContext({ ...ctx, activeProjectId: undefined })).projectId).toBe(pid);

      // back to legacy: the behaviour is the old one again
      await setAuthzMode(tenant, 'legacy', 'a');
      await expect(resolveProjectContext(ctx)).rejects.toBeInstanceOf(ProjectContextError);
    });

    it('direct memberships resolve identically in both modes', async () => {
      const pid = await mkProject('p6');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member' });
      const ctx = { tenantDbName: tenant, tenantId, userId: String(user._id), activeProjectId: pid };
      const legacy = await resolveProjectContext(ctx);
      await setAuthzMode(tenant, 'enforce', 'a');
      const enforced = await resolveProjectContext(ctx);
      expect(enforced.projectId).toBe(legacy.projectId);
      expect(enforced.userProject?.role).toBe(legacy.userProject?.role);
    });
  });
});
