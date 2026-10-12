/**
 * What the portal runtime can ask beyond the access list - on BOTH SQLite and MongoDB, through the REAL helper,
 * engine and audit trail:
 *
 *  - the network boundary: a refusal from outside the listed networks is audited with the address that was
 *    evaluated, and its decision id replays to the same refusal;
 *  - the test session: an allowed one is recorded once a minute per person and portal (and is not a denial);
 *    a member who sets the flag is refused, and the refusal replays with the flag;
 *  - embedded people: `client.embedded` admits them to a portal that takes every verified person, and the
 *    replay of a refusal carries it;
 *  - "view as": the Access check accepts a group as the audience, and `simulatePortalView` answers what a
 *    person or a group would meet (open? which agents?), from a given network, as an embedded person.
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
import { getDecision } from '@/lib/iam/decisions';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { portalAgentResource, portalResource } from '@/lib/iam/portalEntities';
import { authorizeResourceAccess, resetResourceAuthzThrottleForTests, type ResourceAuthzInput } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { SimulateInputError, simulate } from '@/lib/iam/simulate';
import { parsePortalViewInput, simulatePortalView } from '@/lib/iam/viewAs';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Tenant {
  dbName: string;
  id: string;
  users: Record<string, IUser>;
  groupId: string;
  otherGroupId: string;
  projectId: string;
  agentIds: string[];
}

describeForEachProvider('the portal runtime flags and "view as"', (getDb) => {
  let db: DatabaseProvider;
  let T: Tenant;
  let facts: IamPortalFacts;
  const idOf = (key: string) => String(T.users[key]._id);
  const tenant = () => ({ tenantDbName: T.dbName, tenantId: T.id });

  const baseFacts = (): IamPortalFacts => ({
    id: 'portal-1',
    key: 'branch',
    name: 'Branch assistant',
    status: 'enabled',
    access: { mode: 'selected', userIds: [idOf('listed')], groupIds: [T.groupId] },
    agentIds: T.agentIds,
  });

  const open = (who: string, client: ResourceAuthzInput['client'] = {}): ResourceAuthzInput => ({
    tenantDbName: T.dbName,
    tenantId: T.id,
    userId: idOf(who),
    channel: 'portal',
    action: 'portal.use',
    resource: (requester) => portalResource({ id: facts.id, key: facts.key, access: facts.access }, requester),
    subject: { portalId: facts.id, portalKey: facts.key, portalName: facts.name, resourceName: facts.name },
    client: { ip: '203.0.113.7', requestId: 'req-1', userAgent: 'vitest', method: 'GET', path: '/api/portal/branch/info', ...client },
  });
  const run = (who: string, client: ResourceAuthzInput['client'] = {}): ResourceAuthzInput => ({
    ...open(who, client),
    action: 'agent.invoke',
    resource: (requester) => portalAgentResource({ id: T.agentIds[0], key: 'support-bot', projectId: T.projectId }, { id: facts.id, access: facts.access }, requester),
    subject: { portalId: facts.id, portalKey: facts.key, portalName: facts.name, resourceName: 'Support bot' },
  });

  async function rows(extra: Record<string, unknown>) {
    await drainPendingTasks();
    return db.runWithTenant!(T.dbName, () => db.iamListAuditEvents({ tenantId: T.id, service: 'portals', limit: 50, ...extra }));
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `flags-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Flags', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    T = { dbName, id: String(row._id), users: {}, groupId: '', otherGroupId: '', projectId: '', agentIds: [] };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user') => {
        T.users[key] = await db.createUser({ tenantId: T.id, email: `${key}@flags.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [] });
      };
      await mk('owner', 'owner');
      await mk('admin', 'admin');
      await mk('listed', 'user');
      await mk('grouped', 'user');
      await mk('stranger', 'user');
      const group = await db.createGroup({ tenantId: T.id, name: 'Retail', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      T.groupId = String(group._id);
      const other = await db.createGroup({ tenantId: T.id, name: 'Elsewhere', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      T.otherGroupId = String(other._id);
      await db.addGroupMember({ groupId: T.groupId, userId: idOf('grouped'), tenantId: T.id, role: 'member' });
      const project = await db.createProject({ tenantId: T.id, key: 'pj1', name: 'Project One', createdBy: 'x' });
      T.projectId = String(project._id);
      for (const key of ['support-bot', 'sales-bot']) {
        const agent = await db.createAgent({ tenantId: T.id, projectId: T.projectId, key, name: key, config: { modelKey: 'm1' }, status: 'draft', createdBy: 'x' } as never);
        T.agentIds.push(String(agent._id));
      }
    });
  });
  afterAll(async () => {
    registerIamPortalResolver(null);
    configureIamEngine({ validateRequests: false });
    await drainPendingTasks();
  });
  beforeEach(() => {
    facts = baseFacts();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    resetEnforceStatsForTests();
    resetResourceAuthzThrottleForTests();
    resetResourceAuthzStatsForTests();
    registerIamPortalResolver(async (t, id) => (t.tenantDbName === T.dbName && id === facts.id ? facts : null));
  });
  afterEach(async () => {
    await drainPendingTasks();
  });

  describe('the network boundary', () => {
    beforeEach(() => {
      facts = { ...facts, access: { ...facts.access, networks: { mode: 'allow_list', cidrs: ['203.0.113.0/24', '2001:db8::/32'] } } };
    });

    it('lets a listed person in from a listed network and refuses from another one, with a decision id that replays', async () => {
      expect((await authorizeResourceAccess(open('listed', { ip: '203.0.113.50' }))).allowed).toBe(true);
      expect((await authorizeResourceAccess(run('listed', { ip: '2001:db8::9' }))).allowed).toBe(true);

      const refused = await authorizeResourceAccess(open('listed', { ip: '198.51.100.4' }));
      expect(refused.allowed).toBe(false);
      expect(refused.decisionId).toBeTruthy();
      expect(refused.reasons).toContain('managed:portal:network-boundary');

      await drainPendingTasks();
      const record = await getDecision(tenant(), refused.decisionId!);
      expect(record).toMatchObject({ channel: 'portal', resource: { type: 'portal', id: 'portal-1' } });
      expect(record!.simulateInput).toMatchObject({ action: 'portal.use', context: { channel: 'portal', ip: '198.51.100.4' } });
      const replay = await simulate(tenant(), record!.simulateInput);
      expect(replay.allowed).toBe(false);
      expect(replay.reasons.map((r) => r.cedarId)).toContain('managed:portal:network-boundary');
    });

    it('refuses a request whose address could not be read', async () => {
      const refused = await authorizeResourceAccess(open('listed', { ip: null }));
      expect(refused.allowed).toBe(false);
      expect(refused.reasons).toContain('managed:portal:network-boundary');
    });

    it('the Access check says how many networks the portal lists, never which', async () => {
      const result = await simulate(tenant(), {
        principal: { type: 'user', id: idOf('listed') },
        action: 'portal.use',
        resource: { kind: 'resource', type: 'portal', id: 'portal-1' },
        context: { ip: '198.51.100.4' },
      });
      expect(result.allowed).toBe(false);
      expect(result.portal).toMatchObject({ networks: { mode: 'allow_list', count: 2 } });
      expect(JSON.stringify(result)).not.toContain('203.0.113');
      const inside = await simulate(tenant(), {
        principal: { type: 'user', id: idOf('listed') },
        action: 'portal.use',
        resource: { kind: 'resource', type: 'portal', id: 'portal-1' },
        context: { ip: '203.0.113.9' },
      });
      expect(inside.allowed).toBe(true);
    });
  });

  describe('the test session', () => {
    it('admits an admin who is not on the list and records it - once a minute, as a plain audit event', async () => {
      const first = await authorizeResourceAccess(open('admin', { test: true }));
      expect(first.allowed).toBe(true);
      expect((await authorizeResourceAccess(run('admin', { test: true }))).allowed).toBe(true);
      expect((await authorizeResourceAccess(open('admin', { test: true }))).allowed).toBe(true);

      const recorded = await rows({ outcome: 'success', actorUserId: idOf('admin') });
      const sessions = recorded.items.filter((r) => r.event === 'portal.test_session');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        service: 'portals', actorUserId: idOf('admin'), resourceType: 'portal', resourceId: 'portal-1',
        metadata: { testSession: true, action: 'portal.use', portalKey: 'branch' },
      });
      // it is not a denial: the denials feed never sees it
      expect(sessions[0].metadata?.iamEnforce).toBeUndefined();
      expect((await rows({ outcome: 'denied', actorUserId: idOf('admin') })).items).toHaveLength(0);
    });

    it('records nothing for an ordinary request, and refuses a member who claims a test session', async () => {
      expect((await authorizeResourceAccess(open('listed'))).allowed).toBe(true);
      expect((await rows({ outcome: 'success', actorUserId: idOf('listed') })).items).toHaveLength(0);

      const refused = await authorizeResourceAccess(open('stranger', { test: true }));
      expect(refused.allowed).toBe(false);
      expect((await rows({ outcome: 'success', actorUserId: idOf('stranger') })).items).toHaveLength(0);
      await drainPendingTasks();
      const record = await getDecision(tenant(), refused.decisionId!);
      expect(record!.simulateInput!.context).toMatchObject({ channel: 'portal', test: true });
      expect((await simulate(tenant(), record!.simulateInput)).allowed).toBe(false);
    });

    it('does not apply to the owner or admin without the flag', async () => {
      expect((await authorizeResourceAccess(open('admin'))).allowed).toBe(false);
      expect((await authorizeResourceAccess(open('owner'))).allowed).toBe(false);
      expect((await authorizeResourceAccess(open('owner', { test: true }))).allowed).toBe(true);
    });
  });

  describe('embedded people', () => {
    it('are admitted only by a portal that takes every verified person, and only when the runtime says so', async () => {
      expect((await authorizeResourceAccess(open('stranger', { embedded: true }))).allowed).toBe(false);
      facts = { ...facts, access: { ...facts.access, embedded: 'any_verified' } };
      expect((await authorizeResourceAccess(open('stranger'))).allowed).toBe(false);
      expect((await authorizeResourceAccess(open('stranger', { embedded: true }))).allowed).toBe(true);
      expect((await authorizeResourceAccess(run('stranger', { embedded: true }))).allowed).toBe(true);
    });

    it('a refusal of an embedded person replays with the flag', async () => {
      facts = { ...facts, access: { ...facts.access, embedded: 'any_verified', networks: { mode: 'allow_list', cidrs: ['203.0.113.0/24'] } } };
      const refused = await authorizeResourceAccess(open('stranger', { embedded: true, ip: '198.51.100.4' }));
      expect(refused.allowed).toBe(false);
      await drainPendingTasks();
      const record = await getDecision(tenant(), refused.decisionId!);
      expect(record!.simulateInput!.context).toMatchObject({ channel: 'portal', embedded: true, ip: '198.51.100.4' });
      // the same question from inside the network: the embed setting lets the person in
      const fixed = await simulate(tenant(), { ...record!.simulateInput!, context: { ...record!.simulateInput!.context, ip: '203.0.113.9' } });
      expect(fixed.allowed).toBe(true);
    });
  });

  describe('the Access check for an audience', () => {
    const ask = (principal: unknown, context: Record<string, unknown> = {}, action = 'portal.use') => simulate(tenant(), {
      principal,
      action,
      resource: action === 'portal.use' ? { kind: 'resource', type: 'portal', id: 'portal-1' } : { kind: 'resource', type: 'agent', id: T.agentIds[0] },
      context: action === 'portal.use' ? context : { channel: 'portal', portalId: 'portal-1', ...context },
    });

    it('takes a group: a plain member of it, admitted when the list names the group', async () => {
      const listed = await ask({ type: 'group', id: T.groupId });
      expect(listed).toMatchObject({ allowed: true, principalSummary: { type: 'group', id: T.groupId, label: 'Retail', role: 'user' } });
      expect(listed.reasons.map((r) => r.cedarId)).toContain('managed:portal:use');
      const unlisted = await ask({ type: 'group', id: T.otherGroupId });
      expect(unlisted).toMatchObject({ allowed: false, principalSummary: { type: 'group', label: 'Elsewhere' } });
      const runs = await ask({ type: 'group', id: T.groupId }, {}, 'agent.invoke');
      expect(runs.allowed).toBe(true);
    });

    it('does not take a group for anything but the portal actions, nor a group of another workspace', async () => {
      const error = await simulate(tenant(), {
        principal: { type: 'group', id: T.groupId }, action: 'agents.read', resource: { kind: 'service', service: 'agents' },
      }).then(() => null, (e: unknown) => e as SimulateInputError);
      expect(error).toBeInstanceOf(SimulateInputError);
      expect(error!.status).toBe(400);
      const missing = await ask({ type: 'group', id: 'no-such-group' }).then(() => null, (e: unknown) => e as SimulateInputError);
      expect(missing).toBeInstanceOf(SimulateInputError);
      expect(missing!.status).toBe(404);
    });

    it('passes the embedded and test flags through, in the portal channel only', async () => {
      const stranger = { type: 'user', id: idOf('stranger') };
      expect((await ask(stranger, { embedded: true })).allowed).toBe(false);
      facts = { ...facts, access: { ...facts.access, embedded: 'any_verified' } };
      const embedded = await ask(stranger, { embedded: true });
      expect(embedded.allowed).toBe(true);
      expect(embedded.portal).toMatchObject({ embedded: 'any_verified' });
      expect((await ask({ type: 'user', id: idOf('admin') }, { test: true })).allowed).toBe(true);
      expect((await ask({ type: 'user', id: idOf('admin') }, {})).allowed).toBe(false);
      const wrongChannel = await simulate(tenant(), {
        principal: stranger, action: 'agents.read', resource: { kind: 'service', service: 'agents' }, context: { embedded: true },
      }).then(() => null, (e: unknown) => e as SimulateInputError);
      expect(wrongChannel).toBeInstanceOf(SimulateInputError);
    });
  });

  describe('simulatePortalView', () => {
    it('says whether a person can open the portal and which agents they could run', async () => {
      const view = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'user', id: idOf('listed') } });
      expect(view.portal).toMatchObject({ id: 'portal-1', key: 'branch', status: 'enabled', networks: { mode: 'any', count: 0 }, embedded: 'access_list' });
      expect(view.audience).toMatchObject({ type: 'user', id: idOf('listed'), disabled: false });
      expect(view.canOpen.allowed).toBe(true);
      expect(view.agents.map((a) => [a.key, a.allowed])).toEqual([['support-bot', true], ['sales-bot', true]]);
      expect(view.runnableAgentIds).toEqual(T.agentIds);
      expect(view.truncated).toBe(false);

      const stranger = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'user', id: idOf('stranger') } });
      expect(stranger.canOpen).toMatchObject({ allowed: false, reasons: [expect.objectContaining({ cedarId: 'managed:portal:use-boundary' })] });
      expect(stranger.runnableAgentIds).toEqual([]);
    });

    it('answers for a group as a plain member of it', async () => {
      const view = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'group', id: T.groupId } });
      expect(view.audience).toMatchObject({ type: 'group', label: 'Retail' });
      expect(view.canOpen.allowed).toBe(true);
      expect(view.runnableAgentIds).toHaveLength(2);
      const other = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'group', id: T.otherGroupId } });
      expect(other.canOpen.allowed).toBe(false);
    });

    it('asks from a network and as an embedded person', async () => {
      facts = { ...facts, access: { ...facts.access, networks: { mode: 'allow_list', cidrs: ['203.0.113.0/24'] }, embedded: 'any_verified' } };
      const outside = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'user', id: idOf('listed') }, ip: '198.51.100.4' });
      expect(outside.portal.networks).toEqual({ mode: 'allow_list', count: 1 });
      expect(outside.canOpen.allowed).toBe(false);
      expect(outside.canOpen.reasons.map((r) => r.cedarId)).toContain('managed:portal:network-boundary');
      expect(outside.runnableAgentIds).toEqual([]);

      const inside = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'user', id: idOf('listed') }, ip: '203.0.113.20' });
      expect(inside.canOpen.allowed).toBe(true);

      const plain = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'user', id: idOf('stranger') }, ip: '203.0.113.20' });
      expect(plain.canOpen.allowed).toBe(false);
      const embedded = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'user', id: idOf('stranger') }, ip: '203.0.113.20', embedded: true });
      expect(embedded.canOpen.allowed).toBe(true);
      expect(embedded.runnableAgentIds).toHaveLength(2);
    });

    it('records nothing and refuses what does not exist', async () => {
      const before = (await rows({ outcome: 'denied' })).items.length;
      await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'user', id: idOf('stranger') } });
      expect((await rows({ outcome: 'denied' })).items).toHaveLength(before);
      const gone = await simulatePortalView(tenant(), { portalId: 'nope', audience: { type: 'user', id: idOf('listed') } }).then(() => null, (e: unknown) => e as SimulateInputError);
      expect(gone!.status).toBe(404);
      const nobody = await simulatePortalView(tenant(), { portalId: 'portal-1', audience: { type: 'user', id: 'nobody' } }).then(() => null, (e: unknown) => e as SimulateInputError);
      expect(nobody!.status).toBe(404);
    });

    it('validates its input', () => {
      for (const bad of [null, [], {}, { portalId: 'p' }, { portalId: 'p', audience: { type: 'token', id: 'x' } }, { portalId: 'p', audience: { type: 'user', id: 'x' }, ip: 'nope' }, { portalId: 'p', audience: { type: 'user', id: 'x' }, embedded: 'yes' }]) {
        expect(() => parsePortalViewInput(bad), JSON.stringify(bad)).toThrow(SimulateInputError);
      }
      expect(parsePortalViewInput({ portalId: 'p', audience: { type: 'group', id: 'g' }, ip: '::ffff:10.0.0.1', embedded: true }))
        .toEqual({ portalId: 'p', audience: { type: 'group', id: 'g' }, ip: '10.0.0.1', embedded: true });
    });
  });
});
