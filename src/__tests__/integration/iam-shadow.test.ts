/**
 * Shadow mode (C2): mode setting, evaluation categories and the bounded diff
 * store — run on BOTH backends (SQLite and MongoDB via mongodb-memory-server).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { createPolicy } from '@/lib/iam/store';
import {
  MAX_KEYS_PER_TENANT,
  MAX_SAMPLES,
  flushShadowEvents,
  getAuthzMode,
  getPendingShadowEventCount,
  listShadowEntries,
  peekAuthzMode,
  primeAuthzModeForTests,
  recordShadowEvent,
  resetAuthzModeCacheForTests,
  resetShadowBufferForTests,
  resetShadowEntries,
  setAuthzMode,
  summarizeShadowEntries,
} from '@/lib/iam/shadow';
import { evaluateGateObservation } from '@/lib/iam/shadow/evaluate';
import { shadowMetrics, resetShadowMetricsForTests } from '@/lib/iam/shadow/metrics';
import { observeGateDecision, observeUnmappedPath } from '@/lib/iam/shadow/observer';
import { resetProjectMembershipCacheForTests } from '@/lib/iam/shadow/projectMembership';
import { MAX_QUEUE, drainShadowQueue, getShadowQueueDepth, resetShadowQueueForTests, submitShadowJob } from '@/lib/iam/shadow/queue';
import { canonicalRoute } from '@/lib/iam/shadow/routePattern';
import type { GateObservation } from '@/lib/iam/shadow/types';
import { authorizeServiceRequest, type GroupTenantGrant, type UserServicePermissions } from '@/lib/security/rbac';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Shadow mode', (getDb) => {
  let db: DatabaseProvider;
  let tenant: string;
  let tenantId: string;
  let seq = 0;

  const mkUser = async (role: 'owner' | 'admin' | 'project_admin' | 'user', extra: Record<string, unknown> = {}) => {
    seq++;
    return (await db.createUser({
      tenantId, email: `u${seq}@x.io`, name: `u${seq}`, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
    })) as IUser;
  };

  /** Mirrors what enforceSessionRbac / enforceApiTokenRbac hand to the observer. */
  const observation = (args: {
    subject?: 'session' | 'token';
    user: IUser;
    method: string;
    path: string;
    groupGrants?: GroupTenantGrant[];
    tokenScope?: UserServicePermissions | null;
    projectId?: string | null;
    tokenId?: string;
  }): GateObservation => {
    const subject = args.subject ?? 'session';
    const groupGrants = subject === 'token' ? [] : (args.groupGrants ?? []);
    const decision = authorizeServiceRequest(args.user, args.method, args.path, groupGrants, subject === 'token' ? args.tokenScope : undefined);
    if (!decision.service) throw new Error(`test path ${args.path} is unmapped`);
    return {
      subject,
      tenantDbName: tenant,
      tenantId,
      requestId: `req-${++seq}`,
      method: args.method,
      pathname: args.path,
      route: canonicalRoute(undefined, args.path),
      userId: String(args.user._id),
      role: String(args.user.role),
      tokenId: args.tokenId,
      user: { role: args.user.role, servicePermissions: args.user.servicePermissions, projectIds: args.user.projectIds },
      groupGrants,
      tokenScope: subject === 'token' ? args.tokenScope : undefined,
      activeProjectId: args.projectId ?? null,
      legacy: { allowed: decision.allowed, service: decision.service, required: decision.required },
    };
  };

  const entries = async () => listShadowEntries(tenant);
  const byCategory = async (category: string) => (await entries()).filter((e) => e.category === category);

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `shd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tenant = `tenant_${slug}`;
    const t = await db.createTenant({ companyName: 'S', slug, dbName: tenant, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(t._id);
    await db.switchToTenant(tenant);
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    resetShadowBufferForTests();
    resetShadowMetricsForTests();
    resetShadowQueueForTests();
    resetAuthzModeCacheForTests();
    resetProjectMembershipCacheForTests();
  });

  afterEach(() => {
    resetShadowBufferForTests();
  });

  // ── mode ────────────────────────────────────────────────────────────────

  describe('authorization mode', () => {
    it('defaults to legacy, persists shadow, and is per tenant', async () => {
      expect(await getAuthzMode(tenant)).toEqual({ mode: 'legacy', updatedAt: null, updatedBy: null });
      const set = await setAuthzMode(tenant, 'shadow', 'admin-1');
      expect(set.mode).toBe('shadow');
      expect(set.updatedBy).toBe('admin-1');
      resetAuthzModeCacheForTests();
      expect((await getAuthzMode(tenant)).mode).toBe('shadow');
      expect((await getAuthzMode(`${tenant}_other`)).mode).toBe('legacy');
      await setAuthzMode(tenant, 'legacy', 'admin-1');
      expect((await getAuthzMode(tenant)).mode).toBe('legacy');
    });

    it('rejects modes that are not selectable (enforce arrives in C4)', async () => {
      await expect(setAuthzMode(tenant, 'enforce' as never, 'a')).rejects.toThrow(/Unsupported/);
      await expect(setAuthzMode(tenant, 'nonsense' as never, 'a')).rejects.toThrow(/Unsupported/);
    });

    it('peek is synchronous: legacy first, then the stored value after the background read', async () => {
      await setAuthzMode(tenant, 'shadow', 'a');
      resetAuthzModeCacheForTests();
      expect(peekAuthzMode(tenant)).toBe('legacy'); // nothing cached yet, read started
      await vi.waitFor(() => expect(peekAuthzMode(tenant)).toBe('shadow'));
    });

    it('a failing database leaves the mode where it was and never throws', async () => {
      primeAuthzModeForTests(tenant, 'shadow', 1);
      await new Promise((r) => setTimeout(r, 5));
      hoisted.getDatabase.mockRejectedValue(new Error('db down'));
      expect(() => peekAuthzMode(tenant)).not.toThrow();
      expect(peekAuthzMode(tenant)).toBe('shadow');
    });
  });

  // ── categories ──────────────────────────────────────────────────────────

  describe('categories', () => {
    it('token-groups: the token path ignores the owner\'s group grants, the target includes them', async () => {
      const user = await mkUser('user', { servicePermissions: { agents: 'none' } });
      const group = await db.createGroup({ tenantId, name: 'raisers', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      await db.addGroupMember({ groupId: String(group._id), userId: String(user._id), tenantId, role: 'member' });

      // token: legacy denies (groups not loaded), target would allow
      const tokenObs = observation({ subject: 'token', user, method: 'POST', path: '/api/agents/abc', tokenScope: null, tokenId: 'tok-1' });
      expect(tokenObs.legacy.allowed).toBe(false);
      await evaluateGateObservation(tokenObs);
      const found = await byCategory('token-groups');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ service: 'agents', method: 'POST', legacyAllowed: false, targetAllowed: true, count: 1 });
      expect(found[0].samples[0]).toMatchObject({ userId: String(user._id), tokenId: 'tok-1', role: 'user' });
      expect(await byCategory('parity-mismatch')).toHaveLength(0);

      // a scoped token stays capped even with groups -> no diff
      await resetShadowEntries(tenant);
      await evaluateGateObservation(observation({ subject: 'token', user, method: 'POST', path: '/api/agents/abc', tokenScope: { agents: 'read' }, tokenId: 'tok-2' }));
      expect(await byCategory('token-groups')).toHaveLength(0);

      // the SESSION path already includes groups -> legacy allows, no diff
      await evaluateGateObservation(observation({ user, method: 'POST', path: '/api/agents/abc', groupGrants: [{ tenantRole: 'user' }] }));
      expect(await byCategory('token-groups')).toHaveLength(0);

      // an owner without groups: nothing to compare
      const noGroups = await mkUser('user');
      await evaluateGateObservation(observation({ subject: 'token', user: noGroups, method: 'GET', path: '/api/agents', tokenScope: null, tokenId: 'tok-3' }));
      expect(await entries()).toHaveLength(0);
    });

    it('project-narrowing: a member whose project permission is read, doing a write', async () => {
      const user = await mkUser('user');
      const project = await db.createProject({ tenantId, key: 'p1', name: 'P1', createdBy: 'x' });
      const pid = String(project._id);
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });

      const write = observation({ user, method: 'POST', path: '/api/agents/abc', projectId: pid });
      expect(write.legacy.allowed).toBe(true);
      await evaluateGateObservation(write);
      const found = await byCategory('project-narrowing');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ service: 'agents', method: 'POST', legacyAllowed: true, targetAllowed: false });

      // a read is still allowed under min(write, read) -> no new diff for GET
      await evaluateGateObservation(observation({ user, method: 'GET', path: '/api/agents/abc', projectId: pid }));
      expect((await byCategory('project-narrowing')).map((e) => e.method)).toEqual(['POST']);

      // no active project, a different project, or no membership -> nothing to narrow with
      await resetShadowEntries(tenant);
      await evaluateGateObservation(observation({ user, method: 'POST', path: '/api/agents/abc', projectId: null }));
      await evaluateGateObservation(observation({ user, method: 'POST', path: '/api/agents/abc', projectId: 'some-other-project' }));
      const stranger = await mkUser('user');
      await evaluateGateObservation(observation({ user: stranger, method: 'POST', path: '/api/agents/abc', projectId: pid }));
      expect(await entries()).toHaveLength(0);
    });

    it('project-narrowing: owners and admins bypass; plain members with default permissions are not narrowed', async () => {
      const project = await db.createProject({ tenantId, key: 'p2', name: 'P2', createdBy: 'x' });
      const pid = String(project._id);
      const admin = await mkUser('admin');
      await db.upsertUserProject({ tenantId, userId: String(admin._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
      await evaluateGateObservation(observation({ user: admin, method: 'POST', path: '/api/agents/abc', projectId: pid }));

      const member = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(member._id), projectId: pid, role: 'member', servicePermissions: {} });
      await evaluateGateObservation(observation({ user: member, method: 'POST', path: '/api/agents/abc', projectId: pid }));
      expect(await entries()).toHaveLength(0);
    });

    it('project-narrowing: group-assigned projects and API tokens with a projectId count too', async () => {
      const user = await mkUser('user');
      const project = await db.createProject({ tenantId, key: 'p3', name: 'P3', createdBy: 'x' });
      const pid = String(project._id);
      const group = await db.createGroup({ tenantId, name: 'team', createdBy: 't', source: 'local' } as never);
      await db.addGroupMember({ groupId: String(group._id), userId: String(user._id), tenantId, role: 'member' });
      await db.upsertGroupProject({ tenantId, groupId: String(group._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });

      await evaluateGateObservation(observation({ subject: 'token', user, method: 'POST', path: '/api/client/v1/agents/abc', tokenScope: null, projectId: pid, tokenId: 'tok-p' }));
      const found = await byCategory('project-narrowing');
      expect(found).toHaveLength(1);
      expect(found[0].samples[0].tokenId).toBe('tok-p');
    });

    it('unmapped-path: recorded only in shadow mode, with ids masked and no query string', async () => {
      const build = () => ({
        subject: 'session' as const, tenantDbName: tenant, tenantId, requestId: 'r-1', method: 'GET',
        pathname: '/api/things/507f1f77bcf86cd799439011', route: canonicalRoute(undefined, '/api/things/507f1f77bcf86cd799439011?secret=1'),
        userId: 'u-1', role: 'user',
      });
      primeAuthzModeForTests(tenant, 'legacy');
      observeUnmappedPath(tenant, build);
      expect(getPendingShadowEventCount()).toBe(0);

      primeAuthzModeForTests(tenant, 'shadow');
      observeUnmappedPath(tenant, build);
      observeUnmappedPath(tenant, build);
      const found = await byCategory('unmapped-path');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ route: '/api/things/:id', method: 'GET', legacyAllowed: true, targetAllowed: false, count: 2 });
      expect(JSON.stringify(found)).not.toContain('secret');
    });

    it('parity: 400 random decisions produce zero mismatches', async () => {
      const levels = ['none', 'read', 'write', 'admin'] as const;
      const services = ['agents', 'models', 'members', 'providers', 'rag', 'tools', 'guardrails', 'config', 'iam', 'tokens'];
      const paths = ['/api/agents/x', '/api/models', '/api/users', '/api/providers/1', '/api/rag/m', '/api/tools', '/api/guardrails', '/api/config', '/api/iam/mode', '/api/tokens'];
      const methods = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND'];
      const roles = ['owner', 'admin', 'project_admin', 'user'] as const;
      let s = 12345;
      const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];

      const users: IUser[] = [];
      for (let i = 0; i < 8; i++) {
        const perms: Record<string, string> = {};
        for (const svc of services) if (rnd() < 0.3) perms[svc] = pick(levels);
        users.push(await mkUser(pick(roles), { servicePermissions: perms }));
      }
      for (let i = 0; i < 400; i++) {
        const user = pick(users);
        const grants: GroupTenantGrant[] = rnd() < 0.3 ? [{ tenantRole: pick(['user', 'admin', 'project_admin'] as const) }] : [];
        const isToken = rnd() < 0.4;
        const scope = !isToken ? undefined : rnd() < 0.3 ? null : rnd() < 0.2 ? {} : Object.fromEntries(services.filter(() => rnd() < 0.5).map((svc) => [svc, pick(levels)]));
        const idx = Math.floor(rnd() * paths.length);
        await evaluateGateObservation(observation({
          subject: isToken ? 'token' : 'session', user, method: pick(methods), path: paths[idx],
          groupGrants: grants, tokenScope: scope as never, tokenId: isToken ? 'tok' : undefined,
        }));
      }
      expect(shadowMetrics.parityMismatches).toBe(0);
      expect(await byCategory('parity-mismatch')).toHaveLength(0);
      expect(shadowMetrics.evaluated).toBe(400);
    });

    it('parity: a disagreement is recorded loudly (legacy claims allow for a denied user)', async () => {
      const user = await mkUser('user');
      const obs = observation({ user, method: 'POST', path: '/api/providers/x' });
      expect(obs.legacy.allowed).toBe(false);
      await evaluateGateObservation({ ...obs, legacy: { ...obs.legacy, allowed: true } });
      expect(shadowMetrics.parityMismatches).toBe(1);
      const found = await byCategory('parity-mismatch');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ service: 'providers', legacyAllowed: true, targetAllowed: false });
      expect(found[0].samples[0].detail).toMatch(/legacy=allow engine=deny/);
    });

    it('a tenant custom policy that changes a decision is counted, not reported as a parity bug', async () => {
      await createPolicy(tenant, { policyId: 'freeze-agents', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "agents" };' }, 'tester');
      const user = await mkUser('admin');
      const obs = observation({ user, method: 'POST', path: '/api/agents/abc' });
      expect(obs.legacy.allowed).toBe(true);
      await evaluateGateObservation(obs);
      expect(shadowMetrics.parityMismatches).toBe(0);
      expect(shadowMetrics.customPolicyDiffs).toBe(1);
      expect(await entries()).toHaveLength(0);
    });
  });

  // ── gate hook ───────────────────────────────────────────────────────────

  describe('observeGateDecision', () => {
    it('does nothing in legacy mode (the observation is not even built)', async () => {
      primeAuthzModeForTests(tenant, 'legacy');
      const build = vi.fn();
      observeGateDecision(tenant, build as never);
      expect(build).not.toHaveBeenCalled();
      expect(getShadowQueueDepth().queued).toBe(0);
    });

    it('queues in shadow mode and evaluates off the call path', async () => {
      primeAuthzModeForTests(tenant, 'shadow');
      const user = await mkUser('user', { servicePermissions: { agents: 'none' } });
      const group = await db.createGroup({ tenantId, name: 'g', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      await db.addGroupMember({ groupId: String(group._id), userId: String(user._id), tenantId, role: 'member' });
      const obs = observation({ subject: 'token', user, method: 'POST', path: '/api/agents/abc', tokenScope: null, tokenId: 'tok' });
      observeGateDecision(tenant, () => obs);
      expect(shadowMetrics.evaluated).toBe(0); // not run inline
      await drainShadowQueue();
      expect(shadowMetrics.evaluated).toBe(1);
      expect(await byCategory('token-groups')).toHaveLength(1);
    });

    it('never throws: a throwing builder, a dead database, a malformed observation', async () => {
      primeAuthzModeForTests(tenant, 'shadow');
      expect(() => observeGateDecision(tenant, () => { throw new Error('boom'); })).not.toThrow();
      expect(() => observeUnmappedPath(tenant, () => { throw new Error('boom'); })).not.toThrow();
      observeGateDecision(tenant, () => ({ nonsense: true }) as never);
      hoisted.getDatabase.mockRejectedValue(new Error('db down'));
      const user = await mkUser('user').catch(() => ({ _id: 'x', role: 'user' }) as IUser);
      observeGateDecision(tenant, () => observation({ user, method: 'GET', path: '/api/agents' }));
      await drainShadowQueue();
      expect(shadowMetrics.evaluationFailures).toBeGreaterThanOrEqual(1);
    });
  });

  // ── bounded memory ──────────────────────────────────────────────────────

  describe('bounds', () => {
    const ev = (i: number, extra: Partial<Parameters<typeof recordShadowEvent>[1]> = {}) => ({
      category: 'unmapped-path' as const, service: '(none)', method: 'GET', route: `/api/r${i}`,
      legacyAllowed: true, targetAllowed: false,
      sample: { requestId: `r${i}`, userId: 'u', role: 'user', at: new Date().toISOString() },
      ...extra,
    });

    it('keeps at most 20 samples per key, newest last, with count and first/last seen', async () => {
      for (let i = 0; i < 45; i++) {
        recordShadowEvent(tenant, ev(1, { sample: { requestId: `req-${i}`, userId: 'u', role: 'user', at: new Date(1_700_000_000_000 + i * 1000).toISOString() } }));
      }
      const [entry] = await entries();
      expect(entry.count).toBe(45);
      expect(entry.samples).toHaveLength(MAX_SAMPLES);
      expect(entry.samples[0].requestId).toBe('req-25');
      expect(entry.samples.at(-1)?.requestId).toBe('req-44');
      expect(entry.firstSeen < entry.lastSeen).toBe(true);

      // a second flush merges into the stored aggregate
      for (let i = 45; i < 50; i++) recordShadowEvent(tenant, ev(1, { sample: { requestId: `req-${i}`, userId: 'u', role: 'user', at: new Date(1_700_000_100_000 + i).toISOString() } }));
      const [merged] = await entries();
      expect(merged.count).toBe(50);
      expect(merged.samples).toHaveLength(MAX_SAMPLES);
      expect(merged.firstSeen).toBe(entry.firstSeen);
      expect(merged.samples.at(-1)?.requestId).toBe('req-49');
    });

    it('caps the number of stored keys per tenant and counts what it drops', async () => {
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 400; i++) recordShadowEvent(tenant, ev(batch * 400 + i));
        await flushShadowEvents();
      }
      const stored = await entries();
      expect(stored.length).toBe(MAX_KEYS_PER_TENANT);
      expect(shadowMetrics.droppedKeys).toBe(200);
      expect(shadowMetrics.droppedEvents).toBeGreaterThanOrEqual(200);
      // an existing key still aggregates after the cap is reached
      recordShadowEvent(tenant, ev(0));
      expect((await entries()).find((e) => e.route === '/api/r0')?.count).toBe(2);
    }, 60_000);

    it('bounds the in-memory buffer between flushes', async () => {
      // 1,500 distinct keys recorded synchronously: only the per-tenant pending cap is kept
      for (let i = 0; i < 1500; i++) recordShadowEvent(tenant, ev(i));
      expect(shadowMetrics.droppedEvents).toBeGreaterThan(0);
      expect(getPendingShadowEventCount()).toBeLessThanOrEqual(500 + 200);
      await flushShadowEvents();
      expect(getPendingShadowEventCount()).toBe(0);
    });

    it('sheds evaluations when the queue is full instead of buffering', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const blocker = () => gate;
      let accepted = 0;
      for (let i = 0; i < MAX_QUEUE + 50; i++) if (submitShadowJob(blocker)) accepted++;
      const depth = getShadowQueueDepth();
      expect(depth.queued).toBeLessThanOrEqual(MAX_QUEUE);
      expect(accepted).toBeLessThanOrEqual(MAX_QUEUE + depth.concurrency);
      expect(shadowMetrics.queueDrops).toBeGreaterThanOrEqual(40);
      release();
      await drainShadowQueue();
      expect(getShadowQueueDepth().queued).toBe(0);
    });

    it('reset clears the stored aggregates and anything buffered, for that tenant only', async () => {
      recordShadowEvent(tenant, ev(1));
      recordShadowEvent(`${tenant}_b`, ev(2));
      await flushShadowEvents();
      expect(await entries()).toHaveLength(1);
      recordShadowEvent(tenant, ev(3));
      expect(await resetShadowEntries(tenant)).toBe(1);
      expect(await entries()).toHaveLength(0);
      expect(await listShadowEntries(`${tenant}_b`)).toHaveLength(1);
    });
  });

  // ── report math ─────────────────────────────────────────────────────────

  it('summarizes per category, per service and top routes', async () => {
    const base = { sample: { requestId: 'r', userId: 'u', role: 'user', at: new Date().toISOString() } };
    for (let i = 0; i < 3; i++) recordShadowEvent(tenant, { ...base, category: 'token-groups', service: 'agents', method: 'POST', route: '/api/agents', legacyAllowed: false, targetAllowed: true });
    for (let i = 0; i < 2; i++) recordShadowEvent(tenant, { ...base, category: 'project-narrowing', service: 'agents', method: 'POST', route: '/api/agents/:id', legacyAllowed: true, targetAllowed: false });
    recordShadowEvent(tenant, { ...base, category: 'unmapped-path', service: '(none)', method: 'GET', route: '/api/x', legacyAllowed: true, targetAllowed: false });
    const summary = summarizeShadowEntries(await entries());
    const cat = Object.fromEntries(summary.categories.map((c) => [c.category, c]));
    expect(cat['token-groups']).toMatchObject({ events: 3, keys: 1, wouldAllow: 3, wouldDeny: 0 });
    expect(cat['project-narrowing']).toMatchObject({ events: 2, wouldDeny: 2 });
    expect(cat['unmapped-path']).toMatchObject({ events: 1, wouldDeny: 1 });
    expect(cat['parity-mismatch']).toMatchObject({ events: 0, keys: 0, firstSeen: null });
    expect(summary.totals).toEqual({ events: 6, keys: 3 });
    expect(summary.services[0]).toMatchObject({ service: 'agents', total: 5 });
    expect(summary.topRoutes[0]).toMatchObject({ category: 'token-groups', count: 3 });
    expect(summarizeShadowEntries(await entries(), { category: 'unmapped-path' }).topRoutes).toHaveLength(1);
  });
});

describe('canonicalRoute', () => {
  it('prefers the route pattern, masks ids otherwise and never keeps a query string', () => {
    expect(canonicalRoute('/api/groups/:id', '/api/groups/5')).toBe('/api/groups/:id');
    expect(canonicalRoute(undefined, '/api/groups/507f1f77bcf86cd799439011/members/42')).toBe('/api/groups/:id/members/:id');
    expect(canonicalRoute(undefined, '/api/x/123e4567-e89b-12d3-a456-426614174000?token=abc')).toBe('/api/x/:id');
    expect(canonicalRoute(undefined, '/api/agents/my-agent')).toBe('/api/agents/my-agent');
    expect(canonicalRoute('', '/api/a')).toBe('/api/a');
    expect(canonicalRoute(undefined, `/api/${'a'.repeat(500)}`).length).toBeLessThanOrEqual(200);
  });
});
