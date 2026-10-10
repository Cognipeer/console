/**
 * The decisions the agent ROUTES ask the engine - `agent.approve`, `agent.session_view_others`,
 * `agent.session_manage_others` - with the REAL helper, engine and audit trail over a real
 * database, on BOTH SQLite and MongoDB:
 *
 *   the principal   built the way the request gate builds it (project narrowing, a token's scope)
 *   a refusal       a decision id, ONE audit row per kind per minute under service `agents`
 *                   (with the token, the session's owner and the agent's setting), the denials
 *                   feed in words, and a replay in the Access check that says the same
 *   a quiet answer  shapes a list: no decision id, no row
 *   fail closed     an action asked where it is not decided, or an engine that cannot answer, is a
 *                   refusal that says so (503), never an allow
 *   the Access check takes the session's owner and the agent's setting as inputs
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
import { agentSessionResource, portalAgentSessionResource } from '@/lib/iam/agentEntities';
import { ApprovalUnavailableError, portalApprovalAuthorizer } from '@/lib/services/agents/approvalAuthorizers';
import { listAuditFeed } from '@/lib/iam/auditFeed';
import { buildCatalog } from '@/lib/iam/catalog';
import { getDecision } from '@/lib/iam/decisions';
import { configureIamEngine, getIamEngineStats, resetIamEngineForTests } from '@/lib/iam/engine';
import { buildEnforcePrincipal, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { previewPolicy } from '@/lib/iam/preview';
import {
  authorizeResourceAccess,
  authorizeResourceForPrincipal,
  resetResourceAuthzThrottleForTests,
  type ResourcePrincipalAuthzInput,
} from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { SimulateInputError, simulate } from '@/lib/iam/simulate';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import type { IamPrincipal } from '@/lib/iam/entities';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Tenant {
  dbName: string;
  id: string;
  users: Record<string, IUser>;
  p1: string;
  p2: string;
  agentId: string;
  groupId: string;
}

describeForEachProvider('agent session decisions', (getDb) => {
  let db: DatabaseProvider;
  let T: Tenant;
  const tenant = () => ({ tenantDbName: T.dbName, tenantId: T.id });
  const idOf = (key: string) => String(T.users[key]._id);

  async function build(): Promise<Tenant> {
    const slug = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Sessions', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const t: Tenant = { dbName, id: String(row._id), users: {}, p1: '', p2: '', agentId: '', groupId: '' };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user') => {
        t.users[key] = await db.createUser({ tenantId: t.id, email: `${key}@sessions.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [] });
      };
      await mk('owner', 'owner');
      await mk('admin', 'admin');
      await mk('starter', 'user');
      await mk('other', 'user');
      await mk('padmin', 'user');
      await mk('capped', 'user');
      t.p1 = String((await db.createProject({ tenantId: t.id, key: 'pj1', name: 'Project One', createdBy: 'x' }))._id);
      t.p2 = String((await db.createProject({ tenantId: t.id, key: 'pj2', name: 'Project Two', createdBy: 'x' }))._id);
      for (const key of ['starter', 'other', 'padmin', 'capped']) {
        await db.upsertUserProject({
          tenantId: t.id, userId: String(t.users[key]._id), projectId: t.p1, role: key === 'padmin' ? 'project_admin' : 'member',
          // a project that limits one member's agents to read: Write-level actions are out of their reach there
          ...(key === 'capped' ? { servicePermissions: { agents: 'read' } } : {}),
        } as never);
      }
      const agent = await db.createAgent({ tenantId: t.id, projectId: t.p1, key: 'support', name: 'Support', config: { modelKey: 'm1' }, status: 'draft', createdBy: 'x' } as never);
      t.agentId = String(agent._id);
      const group = await db.createGroup({ tenantId: t.id, name: 'Contractors', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      t.groupId = String(group._id);
      await db.addGroupMember({ groupId: t.groupId, userId: String(t.users.other._id), tenantId: t.id, role: 'member' });
    });
    return t;
  }

  /** The principal of a request, built by the very function the gate decides with. */
  async function principalOf(who: string, over: { token?: { id: string; scope?: Record<string, string> | null }; project?: string } = {}): Promise<IamPrincipal> {
    return db.runWithTenant!(T.dbName, () => buildEnforcePrincipal({
      subject: over.token ? 'token' : 'session',
      tenantDbName: T.dbName,
      tenantId: T.id,
      requestId: 'req-1',
      method: 'POST',
      route: '/agents/sessions',
      userId: idOf(who),
      user: T.users[who],
      requestedProjectId: over.project ?? T.p1,
      projectFromPath: !over.token,
      service: 'agents',
      ...(over.token ? { tokenId: over.token.id, tokenScope: over.token.scope ?? null } : {}),
    }));
  }

  const resource = (approvers: 'owner' | 'owner_or_admin' | 'project_members' = 'owner_or_admin', owners = ['starter']) => agentSessionResource({
    id: T.agentId, key: 'support', projectId: T.p1, ownerIds: owners.map(idOf), approvers,
  });

  async function ask(who: string, over: Partial<ResourcePrincipalAuthzInput> & { token?: { id: string; scope?: Record<string, string> | null } } = {}) {
    const { token, ...rest } = over;
    const principal = await principalOf(who, { token });
    return authorizeResourceForPrincipal({
      tenantDbName: T.dbName,
      tenantId: T.id,
      userId: idOf(who),
      principal,
      channel: token ? 'api' : 'dashboard',
      action: 'agent.approve',
      resource: resource(),
      subject: { resourceName: 'support' },
      client: { ip: '203.0.113.9', requestId: 'req-1', userAgent: 'vitest', method: 'POST', path: '/api/agents/support/sessions/s1/actions/a1/resolve' },
      ...rest,
    });
  }

  async function rows(extra: Record<string, unknown> = {}) {
    await drainPendingTasks();
    return db.runWithTenant!(T.dbName, () => db.iamListAuditEvents({ tenantId: T.id, service: 'agents', outcome: 'denied', limit: 200, ...extra }));
  }
  /** Refusals written since the test began (the tenant is shared by the tests of a provider). */
  let rowsAtStart = 0;
  const added = async () => (await rows()).items.length - rowsAtStart;

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    T = await build();
  });
  afterAll(async () => {
    registerIamPortalResolver(null);
    configureIamEngine({ validateRequests: false });
    await drainPendingTasks();
  });
  beforeEach(async () => {
    rowsAtStart = (await rows()).items.length;
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    resetEnforceStatsForTests();
    resetResourceAuthzThrottleForTests();
    resetResourceAuthzStatsForTests();
    registerIamPortalResolver(null);
  });
  afterEach(async () => {
    await drainPendingTasks();
    for (const p of await listPolicies(T.dbName)) await deletePolicy(T.dbName, p.policyId);
  });

  describe('the request\'s own principal', () => {
    it('lets the person who started the session answer, and an admin of the project when the agent accepts admins - and writes nothing', async () => {
      expect(await ask('starter')).toEqual({ allowed: true, source: 'engine', reasons: [], policyIds: [] });
      expect((await ask('padmin')).allowed).toBe(true);
      expect((await ask('admin')).allowed).toBe(true);
      expect(await added()).toBe(0);
      expect(getIamEngineStats().resourceAuthz).toMatchObject({ decisions: 3, allows: 3, denies: 0, byAction: { 'agent.approve': { allows: 3 } } });
    });

    it('refuses another member, with the approval rule as the reason, and a decision id', async () => {
      const result = await ask('other');
      expect(result).toMatchObject({ allowed: false, source: 'engine', reasons: ['managed:agent:approve-boundary'], policyIds: [] });
      expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.unavailable).toBeUndefined();
      // the agent's setting is the input: with "every member", the same person is let in
      expect((await ask('other', { resource: resource('project_members') })).allowed).toBe(true);
    });

    it('applies the project\'s own limit: a member whose project limits agents to read cannot answer, even their own session', async () => {
      const own = await ask('capped', { resource: resource('owner_or_admin', ['capped']) });
      expect(own.allowed).toBe(false);
      expect(own.reasons).toContain('managed:boundary:project-write');
    });

    it('is audited once under service agents: the action, the session\'s owner and setting, the project, the reasons', async () => {
      const result = await ask('other');
      const [row] = (await rows({ metadata: { key: 'decisionId', value: result.decisionId! } })).items;
      expect(row).toMatchObject({
        service: 'agents', action: 'write', event: 'agent.approve', outcome: 'denied', statusCode: 403,
        actorType: 'user', actorUserId: idOf('other'), actorRole: 'user', projectId: T.p1,
        method: 'POST', path: '/api/agents/support/sessions/s1/actions/a1/resolve', ipAddress: '203.0.113.9', requestId: 'req-1',
        resourceType: 'agent', resourceId: T.agentId,
      });
      expect(row.apiTokenId ?? null).toBeNull();
      expect(row.metadata).toMatchObject({
        iamEnforce: true, code: 'forbidden', decisionId: result.decisionId, action: 'agent.approve', channel: 'dashboard',
        resourceType: 'agent', resourceId: T.agentId, resourceName: 'support', contextProjectId: T.p1,
        ownerId: idOf('starter'), approvers: 'owner_or_admin', source: 'engine', reasons: ['managed:agent:approve-boundary'], contextIp: '203.0.113.9',
      });
      expect(row.metadata).not.toHaveProperty('portalId');
    });

    it('gives a repeat inside the minute the same id and no second row; another session is another refusal', async () => {
      const first = await ask('other');
      for (let i = 0; i < 3; i++) expect((await ask('other')).decisionId).toBe(first.decisionId);
      const elsewhere = await ask('other', { resource: resource('owner_or_admin', ['admin']) });
      expect(elsewhere.decisionId).not.toBe(first.decisionId);
      expect(await added()).toBe(2);
    });

    it('names the token as well as its owner, and applies its scope as a cap', async () => {
      const token = { id: 'tok-ci' };
      const result = await ask('other', { token });
      expect(result).toMatchObject({ allowed: false, reasons: ['managed:agent:approve-boundary'] });
      const [row] = (await rows({ metadata: { key: 'decisionId', value: result.decisionId! } })).items;
      expect(row).toMatchObject({ actorType: 'api_token', actorUserId: idOf('other'), apiTokenId: 'tok-ci' });
      expect(row.metadata).toMatchObject({ channel: 'api' });
      // the starter's token answers; the same token scoped to read does not
      expect((await ask('starter', { token: { id: 'tok-open' } })).allowed).toBe(true);
      const scoped = await ask('starter', { token: { id: 'tok-read', scope: { agents: 'read' } } });
      expect(scoped.allowed).toBe(false);
      expect(scoped.reasons).toContain('managed:boundary:token-cap-write');
    });

    it('a quiet question shapes a response: counted, but no decision id and no row', async () => {
      const principal = await principalOf('other');
      const result = await authorizeResourceForPrincipal({
        tenantDbName: T.dbName, tenantId: T.id, userId: idOf('other'), principal, channel: 'dashboard',
        action: 'agent.session_view_others', resource: agentSessionResource({ id: T.agentId, projectId: T.p1, ownerIds: [] }), quiet: true,
      });
      expect(result.allowed).toBe(true);
      const compiledForbid = await createPolicy(T.dbName, {
        policyId: 'own-only', name: 'Contractors see their own sessions',
        cedar: `forbid (principal in Group::"${T.groupId}", action == Action::"agent.session_view_others", resource);`,
      }, 'tester');
      expect(compiledForbid.policyId).toBe('own-only');
      resetIamEngineForTests();
      configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
      const denied = await authorizeResourceForPrincipal({
        tenantDbName: T.dbName, tenantId: T.id, userId: idOf('other'), principal, channel: 'dashboard',
        action: 'agent.session_view_others', resource: agentSessionResource({ id: T.agentId, projectId: T.p1, ownerIds: [] }), quiet: true,
      });
      expect(denied).toMatchObject({ allowed: false, policyIds: ['own-only'] });
      expect(denied.decisionId).toBeUndefined();
      expect(await added()).toBe(0);
    });
  });

  describe('custom deny rules', () => {
    it('block a group from answering, are named in the refusal, and the audit row keeps the name', async () => {
      await createPolicy(T.dbName, {
        policyId: 'no-contractors', name: 'Contractors do not approve',
        cedar: `forbid (principal in Group::"${T.groupId}", action == Action::"agent.approve", resource);`,
      }, 'tester');
      resetIamEngineForTests();
      configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
      // 'other' is in the group; with the agent accepting every member they would be let in, the rule stops them
      const result = await ask('other', { resource: resource('project_members') });
      expect(result).toMatchObject({ allowed: false, reasons: ['custom:no-contractors'], policyIds: ['no-contractors'] });
      const [row] = (await rows({ metadata: { key: 'decisionId', value: result.decisionId! } })).items;
      expect(row.metadata).toMatchObject({ policyIds: ['no-contractors'], policyNames: { 'no-contractors': 'Contractors do not approve' } });

      const feed = await listAuditFeed(tenant(), { kind: 'denials', limit: 20, offset: 0 });
      expect(feed.items.find((i) => i.decisionId === result.decisionId)).toMatchObject({
        service: 'agents', action: 'agent.approve', principal: { type: 'user', id: idOf('other') },
        summary: 'Denied other answering a pending request of agent "support" by policy "Contractors do not approve"',
        text: { key: 'denied.approvePolicy', params: { who: 'other', resource: 'support', policies: 'Contractors do not approve' } },
      });
    });
  });

  describe('replay in the Access check', () => {
    it('the decision id leads to the same question - the session\'s owner and the agent\'s setting included - and says the same', async () => {
      const result = await ask('other', { resource: resource('owner') });
      await drainPendingTasks();
      const decision = (await getDecision(tenant(), result.decisionId!))!;
      expect(decision).toMatchObject({
        channel: 'dashboard', code: 'forbidden', service: 'agents',
        resource: { type: 'agent', id: T.agentId, label: 'support' },
        principal: { type: 'user', id: idOf('other') },
        simulateInput: {
          principal: { type: 'user', id: idOf('other') },
          action: 'agent.approve',
          resource: { kind: 'resource', type: 'agent', id: T.agentId },
          context: { channel: 'dashboard', projectId: T.p1, ownerId: idOf('starter'), approvers: 'owner', ip: '203.0.113.9' },
        },
      });
      const replay = await simulate(tenant(), decision.simulateInput);
      expect(replay).toMatchObject({
        allowed: false, enforcedAtGate: true, defaultDeny: false,
        reasons: [expect.objectContaining({ cedarId: 'managed:agent:approve-boundary', managed: true, effect: 'forbid' })],
        session: { ownerId: idOf('starter'), approvers: 'owner' },
      });
    });

    it('replays a token\'s refusal for the token', async () => {
      const token = await db.runWithTenant!(T.dbName, () => db.createApiToken({
        tenantId: T.id, userId: idOf('other'), label: 'other-ci', tokenHash: `h-${T.dbName}`, tokenPrefix: 'cp_other', createdBy: idOf('other'),
      } as never));
      const result = await ask('other', { token: { id: String(token._id) } });
      await drainPendingTasks();
      const decision = (await getDecision(tenant(), result.decisionId!))!;
      expect(decision.principal).toMatchObject({ type: 'token', id: String(token._id) });
      expect(decision.simulateInput).toMatchObject({ principal: { type: 'token', id: String(token._id) }, action: 'agent.approve', context: { channel: 'api' } });
      expect((await simulate(tenant(), decision.simulateInput)).allowed).toBe(false);
    });
  });

  describe('fail closed', () => {
    it('an action is only asked in the channels it is decided in: anything else is a refusal that says nobody decided', async () => {
      const principal = await principalOf('admin');
      for (const [channel, action] of [['dashboard', 'portal.use'], ['api', 'agent.invoke'], ['dashboard', 'agent.get']] as const) {
        const result = await authorizeResourceForPrincipal({
          tenantDbName: T.dbName, tenantId: T.id, userId: idOf('admin'), principal, channel, action: action as never, resource: resource(),
        });
        expect(result, `${channel} ${action}`).toMatchObject({ allowed: false, unavailable: true, source: 'unavailable' });
        expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
      }
      // ...and the portal channel needs a portal to name
      expect(await authorizeResourceAccess({
        tenantDbName: T.dbName, tenantId: T.id, userId: idOf('admin'), channel: 'portal', action: 'agent.approve', resource: resource(), subject: {} as never,
      })).toMatchObject({ allowed: false, unavailable: true });
    });

    it('an engine that cannot answer is a refusal with its own id (503), audited only when the caller asks for the row', async () => {
      const principal = await principalOf('admin');
      const broken = () => { throw new Error('the entity could not be built'); };
      const quietly = await authorizeResourceForPrincipal({
        tenantDbName: T.dbName, tenantId: T.id, userId: idOf('admin'), principal, channel: 'dashboard', action: 'agent.approve', resource: broken as never,
        auditUnavailable: false,
      });
      expect(quietly).toMatchObject({ allowed: false, unavailable: true, source: 'unavailable' });
      expect(await added()).toBe(0);
      resetResourceAuthzThrottleForTests();
      const audited = await authorizeResourceForPrincipal({
        tenantDbName: T.dbName, tenantId: T.id, userId: idOf('admin'), principal, channel: 'dashboard', action: 'agent.approve', resource: broken as never,
      });
      const [row] = (await rows({ metadata: { key: 'decisionId', value: audited.decisionId! } })).items;
      expect(row).toMatchObject({ statusCode: 503, metadata: expect.objectContaining({ code: 'authorization_unavailable', source: 'unavailable' }) });
    });
  });

  describe('in a portal', () => {
    it('the approval is judged on the portal\'s access list on top of the rule, as the portal runtime asks it', async () => {
      const portal: IamPortalFacts = {
        id: 'portal-1', key: 'branch', name: 'Branch', status: 'enabled',
        access: { mode: 'selected', userIds: [idOf('starter')], groupIds: [] }, agentIds: [T.agentId],
      };
      registerIamPortalResolver(async (t, id) => (t.tenantDbName === T.dbName && id === portal.id ? portal : null));
      const input = (who: string) => ({
        tenantDbName: T.dbName, tenantId: T.id, userId: idOf(who), channel: 'portal' as const, action: 'agent.approve' as const,
        resource: portalAgentSessionResource({ id: T.agentId, projectId: T.p1, ownerIds: [idOf('starter')], approvers: 'owner_or_admin' as const }, portal),
        subject: { portalId: portal.id, portalKey: portal.key, resourceName: 'Branch agent' },
      });
      expect((await authorizeResourceAccess(input('starter'))).allowed).toBe(true);
      const admin = await authorizeResourceAccess(input('admin'));
      expect(admin).toMatchObject({ allowed: false, reasons: ['managed:portal:agent-boundary'] });
      // filed under the portals, like the rest of the portal runtime's refusals
      await drainPendingTasks();
      const feedRows = await db.runWithTenant!(T.dbName, () => db.iamListAuditEvents({ tenantId: T.id, service: 'portals', outcome: 'denied', limit: 20 }));
      expect(feedRows.items.find((r) => r.metadata?.decisionId === admin.decisionId)).toMatchObject({ event: 'agent.approve' });
    });
  });

  describe('portalApprovalAuthorizer (what the portal hands to the resolution service)', () => {
  const portal: IamPortalFacts = {
    id: 'portal-1', key: 'branch', name: 'Branch', status: 'enabled',
    access: { mode: 'selected', userIds: [] as string[], groupIds: [] }, agentIds: [],
  };
  const request = (createdBy: string, approvers: 'owner' | 'owner_or_admin' | 'project_members' = 'owner_or_admin') => ({
    conversation: { _id: 'c1', agentKey: 'support', projectId: T.p1, createdBy },
    action: { _id: 'act_1', agentKey: 'support', projectId: T.p1, createdBy },
    approvers,
  });
  const authorizer = (who: string) => portalApprovalAuthorizer({
    tenantDbName: T.dbName, tenantId: T.id, userId: idOf(who),
    portal: { id: portal.id, key: portal.key, name: portal.name, access: { ...portal.access, userIds: [idOf('starter')] } },
    agent: { id: T.agentId, key: 'support' },
  });

  it('allows the listed person who started the session and refuses the rest, as the portal runtime would ask', async () => {
    registerIamPortalResolver(async () => portal);
    expect(await authorizer('starter')(request(idOf('starter')))).toEqual({ allowed: true });
    const refused = await authorizer('admin')(request(idOf('starter')));
    expect(refused).toMatchObject({ allowed: false, decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('throws when the engine cannot decide - the portal answers "try again", never an allow', async () => {
    // a request the runtime cannot even state (no person) is a refusal that says nobody decided
    const broken = portalApprovalAuthorizer({
      tenantDbName: T.dbName, tenantId: T.id, userId: '',
      portal: { id: 'portal-1', access: { mode: 'selected', userIds: [], groupIds: [] } },
      agent: { id: T.agentId },
    });
    const error = await broken(request(idOf('starter'))).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ApprovalUnavailableError);
    expect(error).toMatchObject({ code: 'authorization_unavailable', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });
});

describe('the Access check and the catalog', () => {
    const approveReq = (who: string, context: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
      principal: { type: 'user', id: idOf(who) },
      action: 'agent.approve',
      resource: { kind: 'resource', type: 'agent', id: T.agentId },
      context,
      ...over,
    });
    const invalid = async (input: unknown) => {
      const error = await simulate(tenant(), input).then(() => null, (e: unknown) => e as SimulateInputError);
      expect(error, JSON.stringify(input)).toBeInstanceOf(SimulateInputError);
      return error!;
    };

    it('takes the session\'s owner and the agent\'s setting as inputs, and says what it assumed', async () => {
      // nobody in particular started it, and the default setting: workspace and project admins
      expect(await simulate(tenant(), approveReq('admin'))).toMatchObject({ allowed: true, session: { ownerId: null, approvers: 'owner_or_admin' } });
      expect(await simulate(tenant(), approveReq('other'))).toMatchObject({ allowed: false });
      // the person who started it
      expect(await simulate(tenant(), approveReq('other', { ownerId: idOf('other') }))).toMatchObject({ allowed: true, session: { ownerId: idOf('other') } });
      // every member of the project
      expect(await simulate(tenant(), approveReq('other', { approvers: 'project_members' }))).toMatchObject({ allowed: true, session: { approvers: 'project_members' } });
      // only the starter: an admin is not let in
      expect(await simulate(tenant(), approveReq('admin', { approvers: 'owner' }))).toMatchObject({ allowed: false });
      // the project's limit narrows the person as at the gate
      expect(await simulate(tenant(), approveReq('capped', { ownerId: idOf('capped') }))).toMatchObject({ allowed: false });
    });

    it('answers for the other two session actions the same way, and rejects inputs that do not belong', async () => {
      const view = { ...approveReq('other'), action: 'agent.session_view_others' };
      expect(await simulate(tenant(), view)).toMatchObject({ allowed: true, enforcedAtGate: true, session: { ownerId: null } });
      expect((await invalid(approveReq('other', { ownerId: 'not a valid id!' }))).message).toContain('not a valid user id');
      expect((await invalid(approveReq('other', { approvers: 'everyone' }))).message).toContain('owner, owner_or_admin, project_members');
      const wrong = await invalid({ ...approveReq('other', { ownerId: idOf('starter') }), action: 'agent.get' });
      expect(wrong.message).toContain('apply to the session actions');
    });

    it('a rule written in the editor shows in the check', async () => {
      await createPolicy(T.dbName, {
        policyId: 'no-contractors', name: 'Contractors do not approve',
        cedar: `forbid (principal in Group::"${T.groupId}", action == Action::"agent.approve", resource);`,
      }, 'tester');
      resetIamEngineForTests();
      configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
      const result = await simulate(tenant(), approveReq('other', { approvers: 'project_members' }));
      expect(result).toMatchObject({ allowed: false });
      expect(result.reasons).toEqual([expect.objectContaining({ cedarId: 'custom:no-contractors', managed: false, effect: 'forbid' })]);
    });

    it('previews who a new deny about approvals would stop', async () => {
      const preview = await previewPolicy(tenant(), {
        spec: { effect: 'forbid', principals: { users: [idOf('padmin')] }, actions: ['agent.approve'], resources: { any: true } },
      });
      // the project admin is let in on a session somebody else started: the draft stops that
      expect(preview.flips.allowToDeny).toBeGreaterThan(0);
      expect(preview.flips.denyToAllow).toBe(0);
      expect(preview.samples.every((s) => s.principal.id === idOf('padmin') && s.action === 'agent.approve')).toBe(true);
    });

    it('previews a deny about looking at others\' sessions: the sessions of somebody else, never the person\'s own', async () => {
      const preview = await previewPolicy(tenant(), {
        spec: { effect: 'forbid', principals: { users: [idOf('other')] }, actions: ['agent.session_view_others', 'agent.session_manage_others'], resources: { projects: [T.p1] } },
      });
      // two actions x one session (somebody else's), for the person the draft names (and the tokens they own, which the rule covers)
      expect(preview.flips.allowToDeny).toBeGreaterThanOrEqual(2);
      expect(preview.flips.denyToAllow).toBe(0);
      expect([...new Set(preview.samples.map((s) => s.action))].sort()).toEqual(['agent.session_manage_others', 'agent.session_view_others']);
    });

    it('lists the session actions with where a real request is decided on them', async () => {
      const byId = new Map(buildCatalog().actions.map((a) => [a.id, a]));
      expect(byId.get('agent.approve')).toMatchObject({ level: 'write', resourceType: 'agent', enforcedIn: ['dashboard', 'api'] });
      expect(byId.get('agent.session_view_others')).toMatchObject({ level: 'read', enforcedIn: ['dashboard', 'api'] });
      expect(byId.get('agent.session_manage_others')).toMatchObject({ level: 'write', enforcedIn: ['dashboard', 'api'] });
      // the portal channel exists only where portals do
      registerIamPortalResolver(async () => null);
      expect(new Map(buildCatalog().actions.map((a) => [a.id, a])).get('agent.approve')?.enforcedIn).toEqual(['dashboard', 'api', 'portal']);
      expect(new Map(buildCatalog().actions.map((a) => [a.id, a])).get('agent.session_view_others')?.enforcedIn).toEqual(['dashboard', 'api']);
    });
  });
});
