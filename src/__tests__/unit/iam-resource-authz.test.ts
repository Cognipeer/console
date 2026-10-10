/**
 * authorizeResourceAccess (resourceAuthz.ts): the decision the portal runtime asks
 * for on every request - the REAL helper, engine and audit trail over a real
 * database, on BOTH SQLite and MongoDB.
 *
 *   who gets in           the access list: people, groups, "everyone"; never a role, never a token
 *   a refusal             a decision id on every one, ONE audit row per kind per minute, the same id
 *                         for a repeat, a new one when the reason changes, and it resolves to a replay
 *   custom deny rules     block, are named, and are reported with the name they had
 *   when it cannot decide a refusal with its own id that says so (503), never an allow
 *   workspaces            nothing crosses them
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { registerIamPortalResolver, type IamPortalFacts } from '@/enterprise/iam-portal';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { listAuditFeed } from '@/lib/iam/auditFeed';
import { getDecision } from '@/lib/iam/decisions';
import { configureIamEngine, getIamEngineStats, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests, getPrincipalCacheStats } from '@/lib/iam/principalCache';
import { portalAgentResource, portalResource } from '@/lib/iam/portalEntities';
import { authorizeResourceAccess, resetResourceAuthzThrottleForTests, type ResourceAuthzInput } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { simulate } from '@/lib/iam/simulate';
import { createPolicy, deletePolicy, updatePolicy } from '@/lib/iam/store';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Tenant {
  dbName: string;
  id: string;
  users: Record<string, IUser>;
  groupId: string;
}

describeForEachProvider('authorizeResourceAccess', (getDb) => {
  let db: DatabaseProvider;
  let A: Tenant;
  let B: Tenant;
  let facts: IamPortalFacts;

  async function build(label: string): Promise<Tenant> {
    const slug = `res-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const tenantRow = await db.createTenant({ companyName: `Resource ${label}`, slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const t: Tenant = { dbName, id: String(tenantRow._id), users: {}, groupId: '' };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user') => {
        t.users[key] = await db.createUser({ tenantId: t.id, email: `${key}@${label}.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [] });
      };
      await mk('owner', 'owner');
      await mk('listed', 'user');
      await mk('grouped', 'user');
      await mk('stranger', 'user');
      const group = await db.createGroup({ tenantId: t.id, name: 'Retail', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      t.groupId = String(group._id);
      await db.addGroupMember({ groupId: t.groupId, userId: String(t.users.grouped._id), tenantId: t.id, role: 'member' });
    });
    return t;
  }

  const idOf = (t: Tenant, key: string) => String(t.users[key]._id);

  const portalFacts = (t: Tenant, over: Partial<IamPortalFacts['access']> = {}): IamPortalFacts => ({
    id: 'portal-1',
    key: 'branch',
    name: 'Branch assistant',
    status: 'enabled',
    access: { mode: 'selected', userIds: [idOf(t, 'listed')], groupIds: [t.groupId], ...over },
    agentIds: ['agent-1'],
  });

  /** The input the enterprise portal runtime sends for "may this person open the portal". */
  const openPortal = (t: Tenant, who: string, f: IamPortalFacts = facts, extra: Partial<ResourceAuthzInput> = {}): ResourceAuthzInput => ({
    tenantDbName: t.dbName,
    tenantId: t.id,
    userId: idOf(t, who),
    channel: 'portal',
    action: 'portal.use',
    resource: (who$) => portalResource({ id: f.id, key: f.key, access: f.access }, who$),
    subject: { portalId: f.id, portalKey: f.key, resourceName: f.name },
    client: { ip: '203.0.113.7', requestId: 'req-1', userAgent: 'vitest', method: 'GET', path: '/api/portal/branch/info' },
    ...extra,
  });

  const runAgent = (t: Tenant, who: string, f: IamPortalFacts = facts): ResourceAuthzInput => ({
    ...openPortal(t, who, f),
    action: 'agent.invoke',
    resource: (who$) => portalAgentResource({ id: 'agent-1', key: 'support', projectId: 'proj-1' }, { id: f.id, access: f.access }, who$),
    subject: { portalId: f.id, portalKey: f.key, resourceName: 'Support bot' },
  });

  async function denialRows(t: Tenant, extra: Record<string, unknown> = {}) {
    await drainPendingTasks();
    return db.runWithTenant!(t.dbName, () => db.iamListAuditEvents({ tenantId: t.id, service: 'portals', outcome: 'denied', limit: 50, ...extra }));
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    A = await build('a');
    B = await build('b');
    facts = portalFacts(A);
  });
  afterAll(async () => {
    registerIamPortalResolver(null);
    configureIamEngine({ validateRequests: false });
    await drainPendingTasks();
  });
  beforeEach(() => {
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    resetEnforceStatsForTests();
    resetResourceAuthzThrottleForTests();
    resetResourceAuthzStatsForTests();
    // the enterprise overlay's resolver: the portal as it is stored now
    registerIamPortalResolver(async (tenant, id) => (tenant.tenantDbName === A.dbName && id === facts.id ? facts : null));
  });
  afterEach(async () => {
    await drainPendingTasks();
  });

  describe('who gets in', () => {
    it('admits the person the list names, a member of a group it names, and everyone when the portal is open to all', async () => {
      expect(await authorizeResourceAccess(openPortal(A, 'listed'))).toEqual({ allowed: true, source: 'engine', reasons: [], policyIds: [] });
      expect((await authorizeResourceAccess(openPortal(A, 'grouped'))).allowed).toBe(true);
      expect((await authorizeResourceAccess(openPortal(A, 'stranger', portalFacts(A, { mode: 'all' })))).allowed).toBe(true);
      expect((await authorizeResourceAccess(runAgent(A, 'listed'))).allowed).toBe(true);
      expect((await authorizeResourceAccess(runAgent(A, 'grouped'))).allowed).toBe(true);
      // an allow writes nothing
      expect((await denialRows(A)).items).toHaveLength(0);
      expect(getIamEngineStats().resourceAuthz).toMatchObject({ decisions: 5, allows: 5, denies: 0 });
    });

    it('refuses a stranger - and the workspace owner who is not on the list - and says the access list is why', async () => {
      for (const who of ['stranger', 'owner']) {
        const result = await authorizeResourceAccess(openPortal(A, who));
        expect(result).toMatchObject({ allowed: false, source: 'engine', reasons: ['managed:portal:use-boundary'], policyIds: [] });
        expect(result.unavailable).toBeUndefined();
        expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
      }
      const agent = await authorizeResourceAccess(runAgent(A, 'stranger'));
      expect(agent).toMatchObject({ allowed: false, reasons: ['managed:portal:agent-boundary'] });
    });

    it('sees an access-list edit on the very next request, and a group membership change at once', async () => {
      expect((await authorizeResourceAccess(openPortal(A, 'stranger'))).allowed).toBe(false);
      const widened = portalFacts(A, { userIds: [idOf(A, 'listed'), idOf(A, 'stranger')] });
      expect((await authorizeResourceAccess(openPortal(A, 'stranger', widened))).allowed).toBe(true);

      expect((await authorizeResourceAccess(openPortal(A, 'grouped'))).allowed).toBe(true);
      const loads = getPrincipalCacheStats().loads;
      expect((await authorizeResourceAccess(openPortal(A, 'grouped'))).allowed).toBe(true);
      expect(getPrincipalCacheStats().loads).toBe(loads); // the second look reads nothing again
      await db.runWithTenant!(A.dbName, () => db.removeGroupMember(A.groupId, idOf(A, 'grouped')));
      expect((await authorizeResourceAccess(openPortal(A, 'grouped'))).allowed).toBe(false);
      await db.runWithTenant!(A.dbName, () => db.addGroupMember({ groupId: A.groupId, userId: idOf(A, 'grouped'), tenantId: A.id, role: 'member' }));
      expect((await authorizeResourceAccess(openPortal(A, 'grouped'))).allowed).toBe(true);
    });
  });

  describe('a refusal', () => {
    it('is audited once: service portals, the action, the portal, the reasons - and the audit row is what the decision id finds', async () => {
      const result = await authorizeResourceAccess(openPortal(A, 'stranger'));
      const rows = (await denialRows(A, { metadata: { key: 'decisionId', value: result.decisionId! } })).items;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        service: 'portals', action: 'read', event: 'portal.use', outcome: 'denied', statusCode: 403,
        actorType: 'user', actorUserId: idOf(A, 'stranger'), actorRole: 'user',
        method: 'GET', path: '/api/portal/branch/info', ipAddress: '203.0.113.7', requestId: 'req-1',
        resourceType: 'portal', resourceId: 'portal-1',
      });
      expect(rows[0].metadata).toMatchObject({
        iamEnforce: true, code: 'forbidden', decisionId: result.decisionId, action: 'portal.use', channel: 'portal',
        resourceType: 'portal', resourceId: 'portal-1', resourceName: 'Branch assistant', portalId: 'portal-1', portalKey: 'branch',
        source: 'engine', reasons: ['managed:portal:use-boundary'], contextIp: '203.0.113.7',
      });
      expect(rows[0].metadata).not.toHaveProperty('policyIds');
    });

    it('gives a repeat inside the minute the same id and no second row; a new reason is a new id; a new person is too', async () => {
      const rowsBefore = (await denialRows(A)).items.length;
      const first = await authorizeResourceAccess(openPortal(A, 'stranger'));
      for (let i = 0; i < 4; i++) expect((await authorizeResourceAccess(openPortal(A, 'stranger'))).decisionId).toBe(first.decisionId);
      expect((await authorizeResourceAccess(runAgent(A, 'stranger'))).decisionId).not.toBe(first.decisionId);
      expect((await authorizeResourceAccess(openPortal(A, 'owner'))).decisionId).not.toBe(first.decisionId);
      expect(await denialRows(A, { metadata: { key: 'decisionId', value: first.decisionId! } })).toMatchObject({ items: [expect.anything()] });
      expect((await denialRows(A)).items).toHaveLength(rowsBefore + 3);
      expect(getIamEngineStats().resourceAuthz).toMatchObject({ denies: 7, auditSuppressed: 0 });
    });

    it('replays: the decision id leads to the check on the portal, which says the same', async () => {
      const result = await authorizeResourceAccess(openPortal(A, 'stranger'));
      await drainPendingTasks();
      const decision = (await getDecision({ tenantDbName: A.dbName, tenantId: A.id }, result.decisionId!))!;
      expect(decision).toMatchObject({
        channel: 'portal', code: 'forbidden', service: 'portals', policyIds: [], policies: [],
        resource: { type: 'portal', id: 'portal-1', label: 'Branch assistant' },
        principal: { type: 'user', id: idOf(A, 'stranger') },
        simulateInput: {
          principal: { type: 'user', id: idOf(A, 'stranger') },
          action: 'portal.use',
          resource: { kind: 'resource', type: 'portal', id: 'portal-1' },
          context: { channel: 'portal', ip: '203.0.113.7' },
        },
      });
      const replay = await simulate({ tenantDbName: A.dbName, tenantId: A.id }, decision.simulateInput);
      expect(replay).toMatchObject({
        allowed: false, defaultDeny: false, enforcedAtGate: true,
        reasons: [expect.objectContaining({ cedarId: 'managed:portal:use-boundary', managed: true })],
        portal: { id: 'portal-1', name: 'Branch assistant', mode: 'selected', userCount: 1, groupCount: 1 },
      });
    });

    it('replays the run of an agent through the portal, and shows up in the denials feed in words', async () => {
      const result = await authorizeResourceAccess(runAgent(A, 'stranger'));
      await drainPendingTasks();
      const decision = (await getDecision({ tenantDbName: A.dbName, tenantId: A.id }, result.decisionId!))!;
      expect(decision.simulateInput).toMatchObject({ action: 'agent.invoke', context: { channel: 'portal', portalId: 'portal-1' } });
      expect(decision.resource).toEqual({ type: 'agent', id: 'agent-1', label: 'Support bot' });

      const feed = await listAuditFeed({ tenantDbName: A.dbName, tenantId: A.id }, { kind: 'denials', limit: 20, offset: 0 });
      const item = feed.items.find((i) => i.decisionId === result.decisionId)!;
      expect(item).toMatchObject({
        service: 'portals', action: 'agent.invoke', principal: { type: 'user', id: idOf(A, 'stranger') },
        summary: 'Denied stranger running agent "Support bot" in a portal because they are not on its access list',
        text: { key: 'denied.portalInvoke', params: { who: 'stranger', resource: 'Support bot', policies: '' } },
      });
    });
  });

  describe('custom deny rules', () => {
    const FORBID = (userId: string) => `forbid (principal == User::"${userId}", action == Action::"portal.use", resource == Portal::"portal-1");`;

    it('block a person who is on the list, are named in the refusal, and the audit row keeps the name', async () => {
      const policy = await createPolicy(A.dbName, { policyId: 'no-listed', name: 'Block the listed one', cedar: FORBID(idOf(A, 'listed')) }, 'tester');
      try {
        const result = await authorizeResourceAccess(openPortal(A, 'listed'));
        expect(result).toMatchObject({ allowed: false, reasons: ['custom:no-listed'], policyIds: ['no-listed'] });
        const row = (await denialRows(A, { metadata: { key: 'decisionId', value: result.decisionId! } })).items[0];
        expect(row.metadata).toMatchObject({ policyIds: ['no-listed'], policyNames: { 'no-listed': 'Block the listed one' }, reasons: ['custom:no-listed'] });

        // the feed names the policy; the lookup says it is in force
        const feed = await listAuditFeed({ tenantDbName: A.dbName, tenantId: A.id }, { kind: 'denials', limit: 20, offset: 0 });
        expect(feed.items.find((i) => i.decisionId === result.decisionId)).toMatchObject({
          summary: 'Denied listed opening portal "Branch assistant" by policy "Block the listed one"',
          text: { key: 'denied.portalUsePolicy', params: { policies: 'Block the listed one' } },
          policyId: 'no-listed',
        });
        const active = (await getDecision({ tenantDbName: A.dbName, tenantId: A.id }, result.decisionId!))!;
        expect(active.policies).toEqual([{ policyId: 'no-listed', name: 'Block the listed one', status: 'active' }]);

        // switched off: it takes no part any more, and the record says so
        await updatePolicy(A.dbName, 'no-listed', { enabled: false }, 'tester');
        expect((await authorizeResourceAccess(openPortal(A, 'listed'))).allowed).toBe(true);
        expect((await getDecision({ tenantDbName: A.dbName, tenantId: A.id }, result.decisionId!))!.policies)
          .toEqual([{ policyId: 'no-listed', name: 'Block the listed one', status: 'disabled' }]);

        // deleted: the name the denial kept is all that is left
        await deletePolicy(A.dbName, 'no-listed');
        expect((await getDecision({ tenantDbName: A.dbName, tenantId: A.id }, result.decisionId!))!.policies)
          .toEqual([{ policyId: 'no-listed', name: 'Block the listed one', status: 'deleted' }]);
        expect(policy.policyId).toBe('no-listed');
      } finally {
        await deletePolicy(A.dbName, 'no-listed').catch(() => undefined);
      }
    });

    it('reads the name of a deleted policy back from the trail of policy changes when the denial did not keep it', async () => {
      // a refusal written the way the request gates write theirs: ids only
      const decisionId = '11111111-2222-4333-8444-555555555555';
      await db.runWithTenant!(A.dbName, async () => {
        await db.createAuditLog({
          tenantId: A.id, actorType: 'user', actorUserId: idOf(A, 'listed'), service: 'portals', action: 'read', event: 'portal.use',
          outcome: 'denied', statusCode: 403,
          metadata: { iamEnforce: true, code: 'forbidden', decisionId, action: 'portal.use', channel: 'portal', resourceType: 'portal', resourceId: 'portal-1', portalId: 'portal-1', policyIds: ['long-gone'] },
        });
        // ...and the policy's own deletion, as the center records it
        await db.createAuditLog({
          tenantId: A.id, actorType: 'user', actorUserId: idOf(A, 'owner'), service: 'iam', action: 'admin', event: 'iam.policy.delete',
          outcome: 'success', resourceType: 'iam-policy', resourceId: 'long-gone', metadata: { iamChange: true, policyId: 'long-gone', name: 'Weekend freeze' },
        });
      });
      const decision = (await getDecision({ tenantDbName: A.dbName, tenantId: A.id }, decisionId))!;
      expect(decision.policies).toEqual([{ policyId: 'long-gone', name: 'Weekend freeze', status: 'deleted' }]);

      // nothing anywhere remembers a policy that never left a trace: the id is all there is
      await db.runWithTenant!(A.dbName, () => db.createAuditLog({
        tenantId: A.id, actorType: 'user', actorUserId: idOf(A, 'listed'), service: 'portals', action: 'read', event: 'portal.use', outcome: 'denied', statusCode: 403,
        metadata: { iamEnforce: true, code: 'forbidden', decisionId: '22222222-2222-4333-8444-555555555555', action: 'portal.use', channel: 'portal', resourceType: 'portal', resourceId: 'portal-1', portalId: 'portal-1', policyIds: ['no-trace'] },
      }));
      const bare = (await getDecision({ tenantDbName: A.dbName, tenantId: A.id }, '22222222-2222-4333-8444-555555555555'))!;
      expect(bare.policies).toEqual([{ policyId: 'no-trace', name: null, status: 'deleted' }]);
    });
  });

  describe('when it cannot decide', () => {
    it('refuses a person the workspace does not know, says so (unavailable), and writes the refusal down as that', async () => {
      const result = await authorizeResourceAccess({ ...openPortal(A, 'listed'), userId: 'ghost-user' });
      expect(result).toMatchObject({ allowed: false, unavailable: true, source: 'unavailable', reasons: [], policyIds: [] });
      expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
      const row = (await denialRows(A, { metadata: { key: 'decisionId', value: result.decisionId! } })).items[0];
      expect(row).toMatchObject({ outcome: 'denied', statusCode: 503, event: 'portal.use' });
      expect(row.metadata).toMatchObject({ code: 'authorization_unavailable', source: 'unavailable', iamEnforce: true });
      expect(getIamEngineStats().resourceAuthz).toMatchObject({ unavailable: 1, allows: 0 });
      // and the lookup does not pretend it was a policy answer
      const decision = (await getDecision({ tenantDbName: A.dbName, tenantId: A.id }, result.decisionId!))!;
      expect(decision).toMatchObject({ code: 'authorization_unavailable', simulateInput: null });
      // the feed words it as the outage it was
      const feed = await listAuditFeed({ tenantDbName: A.dbName, tenantId: A.id }, { kind: 'denials', limit: 20, offset: 0 });
      expect(feed.items.find((i) => i.decisionId === result.decisionId)?.text?.key).toBe('unavailable');
    });

    it('never throws, whatever it is given - and never allows', async () => {
      for (const garbage of [undefined, null, 42, {}, { tenantDbName: A.dbName }, { ...openPortal(A, 'listed'), action: 'agents.write' }, { ...openPortal(A, 'listed'), channel: 'api' }]) {
        const result = await authorizeResourceAccess(garbage as never);
        expect(result.allowed).toBe(false);
        expect(result.unavailable).toBe(true);
        expect(result.decisionId).toBeTruthy();
      }
      const throwing = await authorizeResourceAccess({ ...openPortal(A, 'listed'), resource: () => { throw new Error('builder bug'); } });
      expect(throwing).toMatchObject({ allowed: false, unavailable: true });
    });

    it('refuses an access list the engine cannot read, instead of letting a skipped limit through', async () => {
      const bad = await authorizeResourceAccess({
        ...openPortal(A, 'owner'),
        resource: { kind: 'resource', type: 'portal', id: 'portal-1', service: 'portals', attrs: { mode: 'selected', allowedUsers: ['not-an-entity'], allowedGroups: [] } },
      });
      expect(bad).toMatchObject({ allowed: false, unavailable: true });
    });
  });

  describe('workspaces', () => {
    it('reads the person from the workspace it is told, and writes the refusal there only', async () => {
      // A's listed person means nothing in B: B has no such user
      const crossing = await authorizeResourceAccess({ ...openPortal(A, 'listed'), tenantDbName: B.dbName, tenantId: B.id });
      expect(crossing).toMatchObject({ allowed: false, unavailable: true });
      // B's own people are decided against B's data
      const own = await authorizeResourceAccess(openPortal(B, 'stranger', portalFacts(B)));
      expect(own).toMatchObject({ allowed: false, reasons: ['managed:portal:use-boundary'] });
      expect((await denialRows(B, { metadata: { key: 'decisionId', value: own.decisionId! } })).items).toHaveLength(1);
      expect((await denialRows(A, { metadata: { key: 'decisionId', value: own.decisionId! } })).items).toHaveLength(0);
      // the same refusal in two workspaces is two ids (the throttle is per workspace)
      const ofA = await authorizeResourceAccess(openPortal(A, 'stranger'));
      expect(ofA.decisionId).not.toBe(own.decisionId);
    });
  });
});
