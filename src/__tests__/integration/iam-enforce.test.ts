/**
 * The decision point of the request gates (src/lib/iam/enforce.ts), on BOTH
 * backends (SQLite and MongoDB via mongodb-memory-server): the policy engine
 * decides every request of every workspace. Covers project narrowing, the
 * decision for sessions and tokens, failure semantics (a refusal, never a guess),
 * the owner's own-session promise, the project-levels rule, project access
 * through groups, and the managed rules against plain role arithmetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
import {
  buildEnforcePrincipal,
  decideEnforced,
  getEnforceStats,
  getTenantEnforceStats,
  resetEnforceStatsForTests,
  type EnforceGateInput,
} from '@/lib/iam/enforce';
import { getPrincipalCacheStats, resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { PROJECT_LEVELS_DOC_ID, primeProjectLevelsForTests, resetProjectLevelsForTests } from '@/lib/iam/projectLevels';
import {
  narrowLevel,
  narrowedLevelSets,
  pickActiveProjectId,
  resetProjectNarrowingCachesForTests,
  resolveNarrowingMembership,
} from '@/lib/iam/projectNarrowing';
import { authorizeServiceAccess, type ServiceAuthzPrincipal } from '@/lib/iam/requestAuthz';
import { createPolicy } from '@/lib/iam/store';
import {
  authorizeService,
  getRequiredPermissionLevel,
  minPermission,
  resolveCurrentServicePermission,
  type GroupTenantGrant,
  type PermissionService,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { collectAccessibleProjectIds, findGroupProjectMembership } from '@/lib/services/projects/accessibleProjects';
import { ProjectContextError, resolveProjectContext } from '@/lib/services/projects/projectContext';
import { mulberry32 } from '../helpers/iamTestDb';
import { describeForEachProvider } from './db-parity.helper';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

describeForEachProvider('Engine decisions', (getDb) => {
  let db: DatabaseProvider;
  let tenant: string;
  let tenantId: string;
  let seq = 0;

  const mkUser = async (role: 'owner' | 'admin' | 'user' | 'project_admin', extra: Record<string, unknown> = {}) => {
    seq++;
    return (await db.createUser({
      tenantId, email: `u${seq}-${Math.random().toString(36).slice(2, 7)}@x.io`, name: `u${seq}`, password: '$2b$10$x',
      role, licenseId: 'FREE', features: [], ...extra,
    })) as IUser;
  };
  const mkProject = async (key: string) => String((await db.createProject({ tenantId, key, name: key, createdBy: 'x' }))._id);
  const mkGroup = async (name: string, extra: Record<string, unknown> = {}) =>
    String((await db.createGroup({ tenantId, name, createdBy: 't', source: 'local', ...extra } as never))._id);
  const join = (groupId: string, user: IUser) => db.addGroupMember({ groupId, userId: String(user._id), tenantId, role: 'member' });

  type GateOver = Partial<EnforceGateInput> & { user: IUser };
  /** A session POST to an agents route unless said otherwise. */
  const gateInput = (over: GateOver): EnforceGateInput => ({
    subject: 'session',
    tenantDbName: tenant,
    tenantId,
    requestId: 'r-1',
    method: 'POST',
    route: '/api/agents/x',
    userId: String(over.user._id),
    service: 'agents',
    ...over,
  });
  const decide = (over: GateOver) => decideEnforced(gateInput(over));
  /** The same request made with an API token of the user (unscoped unless said otherwise). */
  const tokenOf = (over: GateOver): GateOver => ({ subject: 'token', tokenId: `tok-${++seq}`, tokenScope: null, ...over });

  const failedEngine = async () => ({ allowed: false, reasons: [], errors: ['down'], obligations: {}, durationUs: 1, failed: true });

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
    resetProjectLevelsForTests();
    resetProjectNarrowingCachesForTests();
    resetEnforceStatsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every project row counts in full (as if the workspace had been evaluated before any row was saved). */
  const everyRowCounts = () => primeProjectLevelsForTests(tenant, 0);

  // ── narrowing ───────────────────────────────────────────────────────────

  describe('resolveNarrowingMembership', () => {
    const resolve = (user: IUser, requestedProjectId?: string | null, groupGrants: any[] = []) =>
      resolveNarrowingMembership({
        tenantDbName: tenant, tenantId, userId: String(user._id), role: String(user.role), user, groupGrants, requestedProjectId,
      });

    it('direct membership, legacy projectIds and group assignments all count; the explicit settings are merged', async () => {
      everyRowCounts();
      const pid = await mkProject('p1');
      const direct = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(direct._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      expect(await resolve(direct, pid)).toMatchObject({ projectId: pid, membership: { servicePermissions: { agents: 'read' } } });

      const legacy = await mkUser('user', { projectIds: [pid] });
      expect(await resolve(legacy, pid)).toMatchObject({ projectId: pid, membership: { role: 'member' } });

      const viaGroup = await mkUser('user');
      const g1 = await mkGroup('g1');
      const g2 = await mkGroup('g2');
      for (const g of [g1, g2]) await join(g, viaGroup);
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
      // admin through a group's tenantRole: decided from the grants alone, before anything is loaded
      resetPrincipalCacheForTests();
      expect(await resolve(gAdmin, pid, [{ tenantRole: 'admin' }])).toBeNull();
      expect(getPrincipalCacheStats().loads).toBe(0);
      expect(await resolve(gAdmin, pid, [{ tenantRole: 'user' }])).not.toBeNull();
    });

    it('the project is the one the handler would run in (fallback to the first accessible one)', async () => {
      const pa = await mkProject('pa');
      const pb = await mkProject('pb');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pa, role: 'member', servicePermissions: { agents: 'read' } });
      for (const requested of [null, undefined, 'unknown', pb, 'x;y', 'x'.repeat(300), '../other']) {
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

    it('once the principal is warm, resolving a membership reads nothing, whatever the cookie says', async () => {
      const pid = await mkProject('pw');
      const user = await mkUser('user');
      const g = await mkGroup('warm');
      await join(g, user);
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: pid, role: 'member', servicePermissions: { prompts: 'read' } });
      await resolve(user, pid); // loads the principal context (and the default project lookup)
      const reads = [
        vi.spyOn(db, 'findUserProject'), vi.spyOn(db, 'listUserProjectsByUser'), vi.spyOn(db, 'listGroupProjectsByGroup'),
        vi.spyOn(db, 'listGroupMembersByUser'), vi.spyOn(db, 'findUserById'), vi.spyOn(db, 'listProjects'),
      ];
      for (const cookie of [pid, 'unknown', null, undefined, 'a b; c', 'x'.repeat(300)]) {
        expect((await resolve(user, cookie))?.projectId).toBe(pid);
      }
      for (const spy of reads) expect(spy).not.toHaveBeenCalled();
    });

    it('findGroupProjectMembership: null without a group assignment', async () => {
      const pid = await mkProject('p3');
      const user = await mkUser('user');
      expect(await findGroupProjectMembership(db, String(user._id), pid)).toBeNull();
      const g = await mkGroup('g3');
      await join(g, user);
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
      await join(g, user);

      expect(await decide(tokenOf({ user }))).toMatchObject({ allowed: true, source: 'engine' });
      expect(await decide(tokenOf({ user, tokenScope: { agents: 'read' } }))).toMatchObject({ allowed: false, service: 'agents', required: 'write' });
      expect((await decide(tokenOf({ user, tokenScope: {}, method: 'GET' }))).allowed).toBe(false);
    });

    it('session: the group grants of the request raise the level; without them the user\'s own level decides', async () => {
      const user = await mkUser('user', { servicePermissions: { agents: 'none' } });
      expect((await decide({ user, groupGrants: [] })).allowed).toBe(false);
      expect((await decide({ user, groupGrants: [{ tenantRole: 'user' }] })).allowed).toBe(true);
      // omitted: the cached principal context's grants
      const g = await mkGroup('ctx', { tenantRole: 'user' });
      await join(g, user);
      expect((await decide({ user })).allowed).toBe(true);
    });

    it('session: narrowing by the requested project; a service the project does not mention is unaffected', async () => {
      const pid = await mkProject('p4');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      const denied = await decide({ user, requestedProjectId: pid });
      expect(denied).toMatchObject({ allowed: false, source: 'engine', service: 'agents', required: 'write', action: 'agents.write', projectId: pid });
      expect(typeof (denied as { decisionId: string }).decisionId).toBe('string');
      expect((await decide({ user, requestedProjectId: pid, method: 'GET' })).allowed).toBe(true);
      expect((await decide({ user, requestedProjectId: pid, service: 'prompts' })).allowed).toBe(true);
    });

    it('session: no cookie, or a project the user cannot access, narrows by their first accessible project (a cookie value cannot pick the project that narrows)', async () => {
      const pid = await mkProject('p4b');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      for (const cookie of [null, undefined, 'some-other-project']) {
        expect(await decide({ user, requestedProjectId: cookie }), String(cookie)).toMatchObject({ allowed: false, projectId: pid });
      }
    });

    it('a route that names its project (projectFromPath): that project\'s settings decide, never the cookie\'s or a fallback\'s', async () => {
      const readOnly = await mkProject('p-ro');
      const writable = await mkProject('p-rw');
      const foreign = await mkProject('p-foreign');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: readOnly, role: 'member', servicePermissions: { agents: 'read' } });
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: writable, role: 'member', servicePermissions: { agents: 'write' } });
      expect((await decide({ user, requestedProjectId: writable, projectFromPath: true })).allowed).toBe(true);
      expect((await decide({ user, requestedProjectId: readOnly, projectFromPath: true })).allowed).toBe(false);
      // a project the member does not belong to: nothing narrows, and no other project's settings are borrowed
      expect((await decide({ user, requestedProjectId: foreign, projectFromPath: true })).allowed).toBe(true);
    });

    it('owners and admins are never narrowed, whatever their project rows say', async () => {
      const pid = await mkProject('p-priv');
      for (const role of ['owner', 'admin'] as const) {
        const user = await mkUser(role);
        await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
        expect((await decide({ user, requestedProjectId: pid })).allowed, role).toBe(true);
      }
    });

    it('a custom permit cannot lift what the project narrowed', async () => {
      const pid = await mkProject('p-cap');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      await createPolicy(tenant, { policyId: 'grant-agents', name: 'grant', cedar: 'permit(principal is User, action == Action::"agents.write", resource is Service);' }, 'u');
      expect((await decide({ user, requestedProjectId: pid })).allowed).toBe(false);
      expect((await decide({ user })).allowed).toBe(false); // the cookie-less request lands in the same project
    });

    it('owners and admins without a project run in the default one, which is what a policy sees as the project', async () => {
      const defaultId = await mkProject('default');
      const admin = await mkUser('admin');
      expect((await buildEnforcePrincipal(gateInput({ user: admin }))).contextProjectId).toBe(defaultId);
      const other = await mkProject('other');
      expect((await buildEnforcePrincipal(gateInput({ user: admin, requestedProjectId: other }))).contextProjectId).toBe(other);
    });

    it('a custom policy that denies is named in the denial (for the audit row, not for the caller)', async () => {
      await createPolicy(tenant, { policyId: 'freeze-agents', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "agents" };' }, 'u');
      const admin = await mkUser('admin');
      const denied = await decide({ user: admin });
      expect(denied).toMatchObject({ allowed: false, source: 'engine', action: 'agents.write', policyIds: ['freeze-agents'] });
      expect((denied as { reasons: string[] }).reasons).toContain('custom:freeze-agents');
      expect((await decide({ user: admin, method: 'GET' })).allowed).toBe(true);
    });

    it('the retired kill switches change nothing: no environment variable turns the engine off', async () => {
      const user = await mkUser('user', { servicePermissions: { agents: 'read' } });
      vi.stubEnv('IAM_ENFORCE_DISABLED', '1');
      vi.stubEnv('IAM_SHADOW_DISABLED', '1');
      vi.stubEnv('IAM_SHADOW_SAMPLE_RATE', '0');
      try {
        expect(await decide({ user })).toMatchObject({ allowed: false, source: 'engine', service: 'agents', required: 'write' });
        expect(await decide({ user, method: 'GET' })).toMatchObject({ allowed: true, source: 'engine' });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('counts what it decides: per process and per workspace', async () => {
      const user = await mkUser('user');
      await decide({ user, method: 'GET' });
      await decide({ user, service: 'members' });
      await decide({ user, service: 'members', method: 'GET' });
      expect(getEnforceStats()).toMatchObject({ engineDecisions: 3, engineAllows: 1, engineDenies: 2, unavailable: 0, ownerSafety: 0 });
      expect(getTenantEnforceStats(tenant)).toMatchObject({ engineDecisions: 3, engineAllows: 1, engineDenies: 2 });
      expect(getTenantEnforceStats(`${tenant}_other`)).toMatchObject({ engineDecisions: 0 });
    });
  });

  // ── failure semantics ───────────────────────────────────────────────────

  describe('when the engine cannot decide', () => {
    it('it is a refusal with its own decision id - never an allow, never another rule set\'s answer', async () => {
      const admin = await mkUser('admin'); // would be allowed by every other rule set
      hoisted.gate = failedEngine;
      const refused = await decide({ user: admin });
      expect(refused).toMatchObject({
        allowed: false, source: 'unavailable', unavailable: true, service: 'agents', required: 'write', reason: 'engine_unavailable',
      });
      expect(typeof (refused as { decisionId: string }).decisionId).toBe('string');

      // a throwing engine is the same refusal, with its own coarse reason
      hoisted.gate = async () => { throw new Error('boom'); };
      const thrown = await decide({ user: admin, method: 'GET' });
      expect(thrown).toMatchObject({ allowed: false, unavailable: true, reason: 'evaluation_error' });
      expect((thrown as { decisionId: string }).decisionId).not.toBe((refused as { decisionId: string }).decisionId);
    });

    // decideEnforced never throws, also for a request it cannot even build (no method): the gate answers it with a
    // refusal that has a decision id, not a 500.
    it('does not throw for a request with no method: it refuses with a decision id like any other failure', async () => {
      const admin = await mkUser('admin');
      const refused = await decide({ user: admin, method: undefined as unknown as string });
      expect(refused).toMatchObject({ allowed: false, source: 'unavailable', unavailable: true, service: 'agents', reason: 'engine_unavailable' });
      expect(typeof (refused as { decisionId: string }).decisionId).toBe('string');
      // a route that declares its level needs no method to be classified: it is decided like any other request
      expect(await decide({ user: admin, method: undefined as unknown as string, level: 'read' })).toMatchObject({ allowed: true, source: 'engine' });
    });

    it('counts the refusals (not as decisions) and keeps only a coarse reason', async () => {
      const user = await mkUser('user');
      hoisted.gate = async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:27017'); };
      await decide({ user });
      await decide({ user });
      const stats = getEnforceStats();
      expect(stats).toMatchObject({ unavailable: 2, engineDecisions: 0, engineAllows: 0, engineDenies: 0, lastUnavailableReason: 'evaluation_error' });
      expect(typeof stats.lastUnavailableAt).toBe('string');
      expect(JSON.stringify(stats)).not.toContain('10.1.2.3');
      expect(getTenantEnforceStats(tenant)).toMatchObject({ unavailable: 2, lastUnavailableReason: 'evaluation_error' });
    });

    it('a caller that cannot be loaded is refused the same way', async () => {
      const user = await mkUser('user');
      vi.spyOn(db, 'listUserProjectsByUser').mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:27017'));
      const refused = await decide({ user });
      expect(refused).toMatchObject({ allowed: false, source: 'unavailable', unavailable: true, reason: 'principal_unavailable' });
      expect(getEnforceStats()).toMatchObject({ unavailable: 1, lastUnavailableReason: 'principal_unavailable' });
      expect(JSON.stringify(getEnforceStats())).not.toContain('10.1.2.3');
      // ... and recovers once the store does: a failed load is never cached
      vi.restoreAllMocks();
      expect((await decide({ user })).allowed).toBe(true);
    });

    it('a workspace whose project-levels record cannot be read is refused, not guessed at', async () => {
      const user = await mkUser('user');
      vi.spyOn(db, 'iamDocGet').mockRejectedValue(new Error('store down'));
      expect(await decide({ user })).toMatchObject({ allowed: false, unavailable: true, reason: 'principal_unavailable' });
      vi.restoreAllMocks();
      expect((await decide({ user })).allowed).toBe(true);
    });

    it('the owner\'s own session still reaches iam, decided before anything can fail', async () => {
      const owner = await mkUser('owner');
      hoisted.gate = async () => { throw new Error('boom'); };
      hoisted.getDatabase.mockRejectedValue(new Error('db down'));
      expect(await decide({ user: owner, service: 'iam' })).toEqual({ allowed: true, source: 'owner-safety' });
      expect(await decide({ user: owner, service: 'iam', method: 'GET' })).toEqual({ allowed: true, source: 'owner-safety' });
      expect(getEnforceStats()).toMatchObject({ ownerSafety: 2, unavailable: 0 });

      hoisted.getDatabase.mockImplementation(async () => getDb());
      // ... for iam only, and only for the owner's session
      const admin = await mkUser('admin');
      expect(await decide({ user: admin, service: 'iam' })).toMatchObject({ unavailable: true });
      expect(await decide({ user: owner, service: 'agents' })).toMatchObject({ unavailable: true });
      expect(await decide(tokenOf({ user: owner, service: 'iam' }))).toMatchObject({ unavailable: true });
    });

    it('an API token owned by the owner is an ordinary principal: a policy can restrict it while the owner\'s session passes', async () => {
      await createPolicy(tenant, { policyId: 'lock-iam', name: 'lock', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "iam" };' }, 'u');
      const owner = await mkUser('owner');
      expect(await decide({ user: owner, service: 'iam' })).toEqual({ allowed: true, source: 'owner-safety' });
      expect(await decide(tokenOf({ user: owner, service: 'iam' }))).toMatchObject({ allowed: false, source: 'engine', policyIds: ['lock-iam'] });
      expect((await decide(tokenOf({ user: owner, service: 'iam', method: 'GET' }))).allowed).toBe(true);
    });
  });

  // ── handler-level checks ────────────────────────────────────────────────

  describe('authorizeServiceAccess (the second, finer check a handler makes)', () => {
    const principalOf = (user: IUser, over: Partial<ServiceAuthzPrincipal> = {}): ServiceAuthzPrincipal => ({
      subject: 'session', tenantDbName: tenant, tenantId, userId: String(user._id), user, ...over,
    });

    it('answers allowed with the level it asked for: the one the method implies, or the one given', async () => {
      const user = await mkUser('user');
      expect(await authorizeServiceAccess(principalOf(user), 'agents')).toEqual({ allowed: true, service: 'agents', required: 'read' });
      expect(await authorizeServiceAccess(principalOf(user), 'agents', { method: 'DELETE' })).toEqual({ allowed: true, service: 'agents', required: 'write' });
      expect(await authorizeServiceAccess(principalOf(user), 'members', { method: 'GET' })).toMatchObject({ allowed: false, required: 'read' });
    });

    it('a refusal carries the decision id, never the unavailable flag', async () => {
      const user = await mkUser('user', { servicePermissions: { agents: 'read' } });
      const refused = await authorizeServiceAccess(principalOf(user), 'agents', { method: 'POST' });
      expect(refused).toMatchObject({ allowed: false, service: 'agents', required: 'write' });
      expect(typeof refused.decisionId).toBe('string');
      expect(refused).not.toHaveProperty('unavailable');
    });

    it('an explicit level overrides the method: admin on a service the user only writes', async () => {
      const user = await mkUser('user');
      expect((await authorizeServiceAccess(principalOf(user), 'agents', { method: 'POST' })).allowed).toBe(true);
      expect(await authorizeServiceAccess(principalOf(user), 'agents', { method: 'POST', level: 'admin' })).toMatchObject({ allowed: false, required: 'admin' });
      const admin = await mkUser('admin');
      expect(await authorizeServiceAccess(principalOf(admin), 'agents', { level: 'admin' })).toEqual({ allowed: true, service: 'agents', required: 'admin' });
    });

    it('decides like the gate: the owner\'s groups apply to a token, the scope caps it, the project narrows', async () => {
      const pid = await mkProject('p-handler');
      const user = await mkUser('user', { servicePermissions: { agents: 'none' } });
      const g = await mkGroup('raisers-h', { tenantRole: 'user' });
      await join(g, user);
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { prompts: 'read' } });

      const token = (over: Partial<ServiceAuthzPrincipal> = {}) => principalOf(user, { subject: 'token', tokenId: 'tk', tokenScope: null, ...over });
      expect((await authorizeServiceAccess(token(), 'agents', { method: 'POST' })).allowed).toBe(true);
      expect((await authorizeServiceAccess(token({ tokenScope: { agents: 'read' } }), 'agents', { method: 'POST' })).allowed).toBe(false);
      expect((await authorizeServiceAccess(token({ projectId: pid }), 'prompts', { method: 'POST' })).allowed).toBe(false);
      expect((await authorizeServiceAccess(token({ projectId: pid }), 'prompts', { method: 'GET' })).allowed).toBe(true);
    });

    it('a session may bring the groups it already loaded; those decide', async () => {
      const user = await mkUser('user', { servicePermissions: { agents: 'none' } });
      expect((await authorizeServiceAccess(principalOf(user, { groupGrants: [] }), 'agents', { method: 'POST' })).allowed).toBe(false);
      expect((await authorizeServiceAccess(principalOf(user, { groupGrants: [{ tenantRole: 'user' }] }), 'agents', { method: 'POST' })).allowed).toBe(true);
    });

    it('when the engine cannot decide it answers unavailable (with a decision id) - it does not throw and it does not allow', async () => {
      const user = await mkUser('admin');
      hoisted.gate = failedEngine;
      const out = await authorizeServiceAccess(principalOf(user), 'agents', { method: 'POST' });
      expect(out).toMatchObject({ allowed: false, unavailable: true, service: 'agents', required: 'write' });
      expect(typeof out.decisionId).toBe('string');
      hoisted.gate = async () => { throw new Error('boom'); };
      expect(await authorizeServiceAccess(principalOf(user), 'agents')).toMatchObject({ allowed: false, unavailable: true });
      expect(getEnforceStats().unavailable).toBe(2);
    });

    it('the owner\'s own session reaches iam even then', async () => {
      const owner = await mkUser('owner');
      hoisted.gate = failedEngine;
      expect(await authorizeServiceAccess(principalOf(owner), 'iam', { method: 'POST' })).toEqual({ allowed: true, service: 'iam', required: 'admin' });
    });
  });

  // ── project levels (grandfathering) ─────────────────────────────────────

  describe('project levels recorded before the engine existed', () => {
    const levelsDoc = () => db.runWithTenant!(tenant, () => db.iamDocGet('iam_meta', PROJECT_LEVELS_DOC_ID));

    it('an explicit "none" of a row saved before the workspace was first evaluated reads as not set; read, write and admin are honoured', async () => {
      const pid = await mkProject('gf');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'none', prompts: 'read' } });
      await sleep(15);

      expect(await levelsDoc()).toBeNull(); // nothing is recorded until the engine first decides
      expect((await decide({ user, requestedProjectId: pid, method: 'GET' })).allowed).toBe(true); // old `none`: ignored
      expect((await decide({ user, requestedProjectId: pid })).allowed).toBe(true);
      expect((await decide({ user, requestedProjectId: pid, service: 'prompts' })).allowed).toBe(false); // old `read`: honoured
      expect((await decide({ user, requestedProjectId: pid, service: 'prompts', method: 'GET' })).allowed).toBe(true);
      expect(typeof (await levelsDoc())?.data.since).toBe('string');
    });

    it('a row saved after that moment is honoured in full, including "none"', async () => {
      const pid = await mkProject('gf2');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'none' } });
      await sleep(15);
      expect((await decide({ user, requestedProjectId: pid, method: 'GET' })).allowed).toBe(true);

      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'none' } });
      expect(await decide({ user, requestedProjectId: pid, method: 'GET' })).toMatchObject({ allowed: false, projectId: pid });
      // a project assigned after the moment, with the same setting
      const later = await mkProject('gf2b');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: later, role: 'member', servicePermissions: { prompts: 'none' } });
      expect((await decide({ user, requestedProjectId: later, service: 'prompts', method: 'GET' })).allowed).toBe(false);
    });

    it('the rule reads the row\'s own save date: an unrelated later save of an old row makes its old "none" count', async () => {
      const pid = await mkProject('gf3');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'none' } });
      await sleep(15);
      expect((await decide({ user, requestedProjectId: pid, method: 'GET' })).allowed).toBe(true);
      // e.g. the member's project role changes; the permissions are saved along with it
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'project_admin', servicePermissions: { agents: 'none' } });
      expect((await decide({ user, requestedProjectId: pid, method: 'GET' })).allowed).toBe(false);
    });

    it('group assignments follow the same rule', async () => {
      const pid = await mkProject('gf4');
      const user = await mkUser('user');
      const g = await mkGroup('gf-team');
      await join(g, user);
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: pid, role: 'member', servicePermissions: { agents: 'none' } });
      await sleep(15);
      expect((await decide({ user, requestedProjectId: pid, method: 'GET' })).allowed).toBe(true);
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: pid, role: 'member', servicePermissions: { agents: 'none' } });
      expect((await decide({ user, requestedProjectId: pid, method: 'GET' })).allowed).toBe(false);
    });

    it('the moment is recorded once per workspace and survives a restart (another node reads the same one)', async () => {
      const user = await mkUser('user');
      await decide({ user, method: 'GET' });
      const first = String((await levelsDoc())?.data.since);
      resetProjectLevelsForTests(); // as after a restart / on another node
      await sleep(5);
      await decide({ user, method: 'GET' });
      expect(String((await levelsDoc())?.data.since)).toBe(first);
      // a different workspace has its own moment
      const slug = `enf-other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const other = `tenant_${slug}`;
      await db.createTenant({ companyName: 'O', slug, dbName: other, licenseType: 'FREE', ownerId: 'pending' });
      expect(await db.runWithTenant!(other, () => db.iamDocGet('iam_meta', PROJECT_LEVELS_DOC_ID))).toBeNull();
    });
  });

  // ── the managed rules against plain role arithmetic ─────────────────────

  describe('the engine and the role arithmetic', () => {
    it('decideEnforced == authorizeService for random users, group grants and token scopes (no project, no custom policy)', async () => {
      const seed = process.env.IAM_FUZZ_SEED ? Number(process.env.IAM_FUZZ_SEED) : (Date.now() & 0x7fffffff);
      const rnd = mulberry32(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
      const levels: ServicePermissionLevel[] = ['none', 'read', 'write', 'admin'];
      const services: PermissionService[] = ['agents', 'models', 'members', 'providers', 'rag', 'tools', 'guardrails', 'config', 'iam', 'tokens', 'prompts', 'mcp'];
      const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
      const randomPerms = (): UserServicePermissions =>
        Object.fromEntries(services.filter(() => rnd() < 0.3).map((s) => [s, pick(levels)])) as UserServicePermissions;

      const groups: Array<{ id: string; grant: GroupTenantGrant }> = [];
      for (let i = 0; i < 4; i++) {
        const grant: GroupTenantGrant = {
          ...(rnd() < 0.6 ? { tenantRole: pick(['user', 'admin', 'project_admin'] as const) } : {}),
          ...(rnd() < 0.6 ? { servicePermissions: randomPerms() } : {}),
        };
        groups.push({ id: await mkGroup(`fz-${i}`, grant as Record<string, unknown>), grant });
      }
      const people: Array<{ user: IUser; grants: GroupTenantGrant[] }> = [];
      for (let i = 0; i < 8; i++) {
        const user = await mkUser(pick(['owner', 'admin', 'user', 'user', 'project_admin'] as const), rnd() < 0.7 ? { servicePermissions: randomPerms() } : {});
        const mine = groups.filter(() => rnd() < 0.4);
        for (const g of mine) await join(g.id, user);
        // (a group counts as a grant only when it carries a role or a non-empty permission map)
        const grants = mine.map((g) => g.grant).filter((g) => g.tenantRole || (g.servicePermissions && Object.keys(g.servicePermissions).length > 0));
        people.push({ user, grants });
      }

      const mismatches: string[] = [];
      let allows = 0;
      const total = Number(process.env.IAM_FUZZ_DECISIONS) || 160; // IAM_FUZZ_DECISIONS scales the run
      for (let i = 0; i < total; i++) {
        const { user, grants } = pick(people);
        const service = pick(services);
        const method = pick(methods);
        const isToken = rnd() < 0.5;
        const scope = !isToken ? undefined : rnd() < 0.3 ? null : rnd() < 0.15 ? {} : randomPerms();
        const expected = authorizeService(user, method, service, grants, scope).allowed;
        const got = await decide(isToken
          ? tokenOf({ user, service, method, tokenScope: scope })
          : { user, service, method });
        if (expected) allows++;
        if (got.allowed !== expected) {
          mismatches.push(JSON.stringify({ role: user.role, perms: user.servicePermissions, grants, isToken, scope, service, method, expected, got }));
        }
      }
      expect(mismatches.slice(0, 3), `seed ${seed}`).toEqual([]);
      expect(allows).toBeGreaterThan(0);
      expect(allows).toBeLessThan(total);
    });
  });

  describe('the engine and the project narrowing', () => {
    it('decideEnforced == min(workspace level, project level) for random members, groups, token scopes and project settings', async () => {
      const seed = process.env.IAM_FUZZ_SEED ? Number(process.env.IAM_FUZZ_SEED) : (Date.now() & 0x7fffffff);
      const rnd = mulberry32(seed ^ 0x51ed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
      const RANK: Record<ServicePermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };
      const grades: ServicePermissionLevel[] = ['none', 'read', 'write', 'admin'];
      const services: PermissionService[] = ['agents', 'models', 'members', 'providers', 'rag', 'tools', 'prompts', 'mcp'];
      const perms = (chance: number): UserServicePermissions =>
        Object.fromEntries(services.filter(() => rnd() < chance).map((s) => [s, pick(grades)])) as UserServicePermissions;
      everyRowCounts(); // an explicit `none` counts: the rows below are all "saved after"

      const group = await mkGroup('fz-tier', { tenantRole: 'user', servicePermissions: perms(0.3) });
      const groupGrant: GroupTenantGrant = { tenantRole: 'user', servicePermissions: (await db.findGroupById(group))?.servicePermissions };
      const people: Array<{ user: IUser; projectId: string; settings: UserServicePermissions; inGroup: boolean }> = [];
      for (let i = 0; i < 8; i++) {
        const user = await mkUser(pick(['user', 'user', 'project_admin'] as const), rnd() < 0.6 ? { servicePermissions: perms(0.3) } : {});
        const projectId = await mkProject(`fz-p${i}`);
        const settings = perms(0.5);
        await db.upsertUserProject({ tenantId, userId: String(user._id), projectId, role: 'member', servicePermissions: settings });
        const inGroup = rnd() < 0.4;
        if (inGroup) await join(group, user);
        people.push({ user, projectId, settings, inGroup });
      }

      const mismatches: string[] = [];
      let allows = 0;
      let narrowed = 0;
      const total = Number(process.env.IAM_FUZZ_DECISIONS) || 200; // IAM_FUZZ_DECISIONS scales the run
      for (let i = 0; i < total; i++) {
        const { user, projectId, settings, inGroup } = pick(people);
        const service = pick(services);
        const method = pick(['GET', 'POST', 'DELETE']);
        const isToken = rnd() < 0.4;
        const scope = !isToken ? undefined : rnd() < 0.4 ? null : perms(0.6);
        const grants = inGroup ? [groupGrant] : [];

        const workspace = resolveCurrentServicePermission(user, service, grants, scope);
        const explicit = settings[service];
        const level = explicit ? minPermission(workspace, explicit) : workspace;
        if (explicit && level !== workspace) narrowed++;
        const expected = RANK[level] >= RANK[getRequiredPermissionLevel(method, service)];

        // the request names the project, or no project at all (then the person's only project is the one it runs in)
        const requested = rnd() < 0.5 ? projectId : null;
        const got = await decide(isToken
          ? tokenOf({ user, service, method, tokenScope: scope, requestedProjectId: projectId })
          : { user, service, method, requestedProjectId: requested });
        if (expected) allows++;
        if (got.allowed !== expected) {
          mismatches.push(JSON.stringify({ role: user.role, own: user.servicePermissions, grants, settings: explicit, isToken, scope, service, method, expected, got: got.allowed }));
        }
      }
      expect(mismatches.slice(0, 3), `seed ${seed}`).toEqual([]);
      expect(narrowed).toBeGreaterThan(0); // the run did exercise the narrowing
      expect(allows).toBeGreaterThan(0);
      expect(allows).toBeLessThan(total);
    });
  });

  // ── project access through groups ───────────────────────────────────────

  describe('resolveProjectContext', () => {
    it('a user who reaches a project only through a group gets it with the group\'s role and settings', async () => {
      const pid = await mkProject('p5');
      const user = await mkUser('user');
      const g = await mkGroup('team');
      await join(g, user);
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: pid, role: 'project_admin', servicePermissions: { agents: 'read' } });
      const ctx = { tenantDbName: tenant, tenantId, userId: String(user._id), activeProjectId: pid };

      const resolved = await resolveProjectContext(ctx);
      expect(resolved.projectId).toBe(pid);
      expect(resolved.userProject).toMatchObject({ role: 'project_admin', servicePermissions: { agents: 'read' } });
      // no cookie: still lands in the group project
      expect((await resolveProjectContext({ ...ctx, activeProjectId: undefined })).projectId).toBe(pid);
      // a cookie for a project the user cannot open falls back to the first one they can
      const foreign = await mkProject('p5-foreign');
      expect((await resolveProjectContext({ ...ctx, activeProjectId: foreign })).projectId).toBe(pid);
    });

    it('several groups assigned to the same project merge: the strongest role, the highest level per service', async () => {
      const pid = await mkProject('p5b');
      const user = await mkUser('user');
      const g1 = await mkGroup('t1');
      const g2 = await mkGroup('t2');
      await join(g1, user);
      await join(g2, user);
      await db.upsertGroupProject({ tenantId, groupId: g1, projectId: pid, role: 'member', servicePermissions: { agents: 'read', prompts: 'write' } });
      await db.upsertGroupProject({ tenantId, groupId: g2, projectId: pid, role: 'project_admin', servicePermissions: { agents: 'write' } });
      const resolved = await resolveProjectContext({ tenantDbName: tenant, tenantId, userId: String(user._id), activeProjectId: pid });
      expect(resolved.userProject).toMatchObject({ role: 'project_admin', servicePermissions: { agents: 'write', prompts: 'write' } });
    });

    it('a user with no project at all is refused; an owner or admin lands in the default project without a membership', async () => {
      const nobody = await mkUser('user');
      await expect(resolveProjectContext({ tenantDbName: tenant, tenantId, userId: String(nobody._id) })).rejects.toMatchObject({
        name: 'ProjectContextError', status: 403, message: 'No project assigned',
      });
      const admin = await mkUser('admin');
      const resolved = await resolveProjectContext({ tenantDbName: tenant, tenantId, userId: String(admin._id) });
      expect(resolved.userProject).toBeNull();
      expect(resolved.project.key).toBe('default');
    });

    it('direct memberships (and the legacy project list) resolve as they always did', async () => {
      const pid = await mkProject('p6');
      const legacyPid = await mkProject('p6-legacy');
      const user = await mkUser('user', { projectIds: [legacyPid] });
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member' });
      const ctx = { tenantDbName: tenant, tenantId, userId: String(user._id) };
      const direct = await resolveProjectContext({ ...ctx, activeProjectId: pid });
      expect(direct.projectId).toBe(pid);
      expect(direct.userProject?.role).toBe('member');
      const legacy = await resolveProjectContext({ ...ctx, activeProjectId: legacyPid });
      expect(legacy.projectId).toBe(legacyPid);
      expect(legacy.userProject).toMatchObject({ role: 'member' });
    });

    it('a project just assigned directly is usable at once (the member\'s own rows are read fresh); the group part comes from the cached principal', async () => {
      const pid = await mkProject('p7');
      const user = await mkUser('user');
      const g = await mkGroup('cached-team');
      await join(g, user);
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: pid, role: 'member', servicePermissions: {} });
      const ctx = { tenantDbName: tenant, tenantId, userId: String(user._id), activeProjectId: pid };
      await resolveProjectContext(ctx);

      const direct = vi.spyOn(db, 'listUserProjectsByUser');
      const viaGroup = vi.spyOn(db, 'listGroupProjectsByGroup');
      await resolveProjectContext(ctx);
      expect(direct).toHaveBeenCalledTimes(1);
      expect(viaGroup).not.toHaveBeenCalled();
    });

    it('the projects a person can open - at login, in the session and in the project list - include the ones their groups reach, each once', async () => {
      const [a, b, c, d] = [await mkProject('ac-a'), await mkProject('ac-b'), await mkProject('ac-c'), await mkProject('ac-d')];
      const user = await mkUser('user', { projectIds: [a] });
      const g1 = await mkGroup('ac-1');
      const g2 = await mkGroup('ac-2');
      const empty = await mkGroup('ac-empty');
      for (const g of [g1, g2, empty]) await join(g, user);
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: b, role: 'member', servicePermissions: {} });
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: a, role: 'member', servicePermissions: {} }); // also in the legacy list
      await db.upsertGroupProject({ tenantId, groupId: g1, projectId: c, role: 'member', servicePermissions: {} });
      await db.upsertGroupProject({ tenantId, groupId: g2, projectId: c, role: 'project_admin', servicePermissions: {} }); // the same project through two groups
      await db.upsertGroupProject({ tenantId, groupId: g2, projectId: d, role: 'member', servicePermissions: {} });
      const ids = await collectAccessibleProjectIds(db, String(user._id), user.projectIds);
      expect(ids.sort()).toEqual([a, b, c, d].sort());
      // a person nobody assigned to anything has none
      expect(await collectAccessibleProjectIds(db, String((await mkUser('user'))._id))).toEqual([]);
    });

    it('a deleted project is not found', async () => {
      const pid = await mkProject('p8');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member' });
      await db.deleteProject(pid);
      const error = await resolveProjectContext({ tenantDbName: tenant, tenantId, userId: String(user._id), activeProjectId: pid }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProjectContextError);
    });
  });
});
