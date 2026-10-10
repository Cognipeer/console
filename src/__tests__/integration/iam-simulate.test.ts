/**
 * The access check (src/lib/iam/simulate.ts) and the principal behind it
 * (principals.ts loadEvaluationPrincipal), on BOTH backends: the SAME engine and
 * the same principal construction the gates use - groups, project narrowing,
 * token scope, the default project of a token that has none - so the answer is
 * what a real request would meet. A check is not traffic: nothing is counted or
 * audited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
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

import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { decideEnforced, getEnforceStats, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { loadEvaluationPrincipal } from '@/lib/iam/principals';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { primeProjectLevelsForTests, resetProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { SimulateInputError, simulate } from '@/lib/iam/simulate';
import { createPolicy } from '@/lib/iam/store';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Access check', (getDb) => {
  let db: DatabaseProvider;
  let tenant: string;
  let tenantId: string;
  let seq = 0;
  const tenantRef = () => ({ tenantDbName: tenant, tenantId });

  const mkUser = async (role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
    seq++;
    return (await db.createUser({
      tenantId, email: `s${seq}-${Math.random().toString(36).slice(2, 7)}@x.io`, name: `Person ${seq}`, password: '$2b$10$x',
      role, licenseId: 'FREE', features: [], ...extra,
    })) as IUser;
  };
  const mkProject = async (key: string) => String((await db.createProject({ tenantId, key, name: key, createdBy: 'x' }))._id);
  const mkToken = async (user: IUser, extra: Record<string, unknown> = {}) =>
    String((await db.createApiToken({
      tenantId, userId: String(user._id), label: `token-${++seq}`, tokenHash: `h-${Math.random()}`, tokenPrefix: 'cp_sim', createdBy: String(user._id), ...extra,
    } as never))._id);

  const check = (principal: { type: 'user' | 'token'; id: string }, action: string, service: string, context?: Record<string, unknown>) =>
    simulate(tenantRef(), { principal, action, resource: { kind: 'service', service }, ...(context ? { context } : {}) });

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tenant = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'S', slug, dbName: tenant, licenseType: 'FREE', ownerId: 'pending' }))._id);
    await db.switchToTenant(tenant);
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    resetProjectNarrowingCachesForTests();
    resetProjectLevelsForTests();
    primeProjectLevelsForTests(tenant, 0);
    resetEnforceStatsForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the answer', () => {
    it('is allowed or denied, with the managed rules that decided it and no trace of the retired modes', async () => {
      const member = await mkUser('user');
      const allowed = await check({ type: 'user', id: String(member._id) }, 'agents.write', 'agents');
      expect(allowed).toMatchObject({ allowed: true, defaultDeny: false, enforcedAtGate: true, projectId: null });
      expect(allowed.reasons).toEqual([expect.objectContaining({ managed: true, effect: 'permit', policyId: null })]);

      const denied = await check({ type: 'user', id: String(member._id) }, 'members.write', 'members');
      expect(denied).toMatchObject({ allowed: false, defaultDeny: true, reasons: [] });

      for (const result of [allowed, denied]) {
        expect(Object.keys(result).sort()).toEqual(expect.arrayContaining(['allowed', 'defaultDeny', 'enforcedAtGate', 'principalSummary', 'projectId', 'reasons']));
        for (const gone of ['mode', 'legacy', 'monitor']) expect(result).not.toHaveProperty(gone);
      }
    });

    it('names the custom policy that forbade it', async () => {
      await createPolicy(tenant, { policyId: 'freeze-agents', name: 'Freeze agents', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "agents" };' }, 'u');
      const admin = await mkUser('admin');
      const result = await check({ type: 'user', id: String(admin._id) }, 'agents.write', 'agents');
      expect(result.allowed).toBe(false);
      expect(result.defaultDeny).toBe(false);
      expect(result.reasons).toEqual([{ cedarId: 'custom:freeze-agents', policyId: 'freeze-agents', managed: false, name: 'Freeze agents', effect: 'forbid' }]);
    });

    it('describes the person or token, and a disabled account', async () => {
      const user = await mkUser('user', { status: 'disabled' });
      const tokenId = await mkToken(user, { servicePermissions: { agents: 'read' } });
      const person = await check({ type: 'user', id: String(user._id) }, 'agents.read', 'agents');
      expect(person.principalSummary).toMatchObject({ type: 'user', id: String(user._id), role: 'user', status: 'disabled' });
      const token = await check({ type: 'token', id: tokenId }, 'agents.write', 'agents');
      expect(token.allowed).toBe(false);
      expect(token.principalSummary).toMatchObject({ type: 'token', id: tokenId, tokenScope: { agents: 'read' } });
    });

    it('an individual-resource action is answered by the policies but is not what a real request meets', async () => {
      const pid = await mkProject('sim-res');
      const member = await mkUser('user');
      const who = { type: 'user' as const, id: String(member._id) };
      // "a new agent in this project"
      const resource = await simulate(tenantRef(), { principal: who, action: 'agent.create', resource: { kind: 'project', projectId: pid } });
      expect(resource).toMatchObject({ allowed: true, enforcedAtGate: false, projectId: pid });
      // the service-level check of the same project is what the gates ask
      const service = await simulate(tenantRef(), { principal: who, action: 'agents.write', resource: { kind: 'project', projectId: pid } });
      expect(service).toMatchObject({ allowed: true, enforcedAtGate: true, projectId: pid });
      await expect(simulate(tenantRef(), { principal: who, action: 'agents.write', resource: { kind: 'project', projectId: 'no-such-project' } }))
        .rejects.toMatchObject({ code: 'resource_not_found', status: 404 });
    });

    it('refuses what it cannot answer: an unknown person, a malformed question', async () => {
      await expect(check({ type: 'user', id: 'nobody' }, 'agents.read', 'agents')).rejects.toMatchObject({ code: 'principal_not_found', status: 404 });
      await expect(simulate(tenantRef(), { principal: { type: 'user', id: 'x' }, action: 'nope.nope', resource: { kind: 'service', service: 'agents' } }))
        .rejects.toBeInstanceOf(SimulateInputError);
      await expect(simulate(tenantRef(), 'nonsense')).rejects.toMatchObject({ code: 'validation', status: 400 });
    });
  });

  describe('the project it runs in', () => {
    it('narrows by the project given, and by the project a request without one would run in', async () => {
      const pid = await mkProject('sim-p');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      const who = { type: 'user' as const, id: String(user._id) };

      const given = await check(who, 'agents.write', 'agents', { projectId: pid });
      expect(given).toMatchObject({ allowed: false, projectId: pid });
      expect(given.reasons.some((r) => r.cedarId.startsWith('managed:boundary:project'))).toBe(true);
      expect((await check(who, 'agents.read', 'agents', { projectId: pid })).allowed).toBe(true);

      // no project given: the person's own project is the one a request without a cookie runs in
      const implied = await check(who, 'agents.write', 'agents');
      expect(implied).toMatchObject({ allowed: false, projectId: pid });
    });

    it('a token without a project runs in the workspace\'s default project - the same answer as its gate', async () => {
      const defaultId = await mkProject('default');
      const owner = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(owner._id), projectId: defaultId, role: 'member', servicePermissions: { agents: 'read' } });
      const tokenId = await mkToken(owner); // no project of its own

      const result = await check({ type: 'token', id: tokenId }, 'agents.write', 'agents');
      expect(result).toMatchObject({ allowed: false, projectId: defaultId });

      // what the token gate decides for that request (apiTokenAuth hands it the default project)
      const gate = await decideEnforced({
        subject: 'token', tenantDbName: tenant, tenantId, requestId: 'r', method: 'POST', route: '/api/agents', userId: String(owner._id), user: owner,
        tokenId, tokenScope: null, requestedProjectId: defaultId, service: 'agents',
      });
      expect(gate.allowed).toBe(result.allowed);
      expect((await check({ type: 'token', id: tokenId }, 'agents.read', 'agents')).allowed).toBe(true);
    });

    it('a token with a project of its own is checked in that project, not the default one', async () => {
      const defaultId = await mkProject('default');
      const own = await mkProject('own');
      const owner = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(owner._id), projectId: defaultId, role: 'member', servicePermissions: { agents: 'read' } });
      await db.upsertUserProject({ tenantId, userId: String(owner._id), projectId: own, role: 'member', servicePermissions: { agents: 'write' } });
      const tokenId = await mkToken(owner, { projectId: own });
      expect(await check({ type: 'token', id: tokenId }, 'agents.write', 'agents')).toMatchObject({ allowed: true, projectId: own });
    });

    it('the workspace-level view (no project narrows, none is implied) is only for whoever asks for it', async () => {
      const pid = await mkProject('sim-wl');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      const ref = { type: 'user' as const, id: String(user._id) };
      const gateLike = await loadEvaluationPrincipal(tenantRef(), ref, null);
      expect(gateLike.narrowing?.projectId).toBe(pid);
      expect(gateLike.principal.sets.writeSvcs).not.toContain('agents');
      const workspace = await loadEvaluationPrincipal(tenantRef(), ref, null, { workspaceLevel: true });
      expect(workspace.narrowing).toBeNull();
      expect(workspace.principal.sets.writeSvcs).toContain('agents');
      // an explicit project always wins over the workspace-level switch
      const inProject = await loadEvaluationPrincipal(tenantRef(), ref, pid, { workspaceLevel: true });
      expect(inProject.narrowing?.projectId).toBe(pid);
    });
  });

  describe('the owner of the workspace', () => {
    it('always reaches the Authorization Engine with their own session, whatever a policy says - and says so', async () => {
      await createPolicy(tenant, { policyId: 'lock-iam', name: 'lock iam', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "iam" };' }, 'u');
      const owner = await mkUser('owner');
      const session = await check({ type: 'user', id: String(owner._id) }, 'iam.write', 'iam');
      expect(session).toMatchObject({ allowed: true, ownerSafety: true });
      // the engine alone would have said no
      expect(session.reasons.map((r) => r.policyId)).toContain('lock-iam');

      // other services are decided by the policies
      expect((await check({ type: 'user', id: String(owner._id) }, 'agents.write', 'agents')).ownerSafety).toBeUndefined();
      const admin = await mkUser('admin');
      expect(await check({ type: 'user', id: String(admin._id) }, 'iam.write', 'iam')).toMatchObject({ allowed: false });
    });

    it('their API token is an ordinary principal: a policy can restrict it', async () => {
      await createPolicy(tenant, { policyId: 'lock-iam', name: 'lock iam', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "iam" };' }, 'u');
      const owner = await mkUser('owner');
      const tokenId = await mkToken(owner);
      const result = await check({ type: 'token', id: tokenId }, 'iam.write', 'iam');
      expect(result.allowed).toBe(false);
      expect(result.ownerSafety).toBeUndefined();
    });
  });

  it('is not traffic: nothing is counted and no audit row is written', async () => {
    const member = await mkUser('user');
    const rows = async () => (await db.runWithTenant!(tenant, () => db.iamListAuditEvents({ tenantId, limit: 200 }))).items.length;
    const before = await rows();
    for (let i = 0; i < 5; i++) await check({ type: 'user', id: String(member._id) }, 'agents.write', 'agents');
    expect(getEnforceStats()).toMatchObject({ engineDecisions: 0, engineAllows: 0, engineDenies: 0, unavailable: 0, ownerSafety: 0 });
    expect(await rows()).toBe(before);
  });
});
