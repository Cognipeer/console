/**
 * Who may see / act on an agent SESSION, and who may end an open request of one - at the REAL
 * request gate and the REAL policy engine, over a real SQLite provider.
 *
 *   loadSessionForPrincipal   the one loader: the project / agent check once, the owner needs only the
 *                             route's own service check, anybody else needs `agent.session_view_others`
 *                             (read) or `agent.session_manage_others` (write) - default: today's behaviour
 *   canViewOthersSessions     a list decides once per request whether it shows everybody's sessions
 *   authorizeEndingOpenRequests / refuseCancelPending
 *                             cancelling a paused run and a new message under `cancel_pending` answer an
 *                             open request with "no", so they take `agent.approve`
 *
 * Probe routes stand in for the handlers: they call the helpers exactly as a handler does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn(), requireApiToken: vi.fn(), engineDown: { value: false } }));

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
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: hoisted.requireApiToken };
});
// An engine that can be told to fail: the helpers must refuse, never allow.
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    authorize: (input: Parameters<typeof actual.authorize>[0]) => (hoisted.engineDown.value
      ? Promise.resolve({ allowed: false, reasons: [], errors: ['the engine is down'], obligations: {}, durationUs: 0, failed: true } as Awaited<ReturnType<typeof actual.authorize>>)
      : actual.authorize(input)),
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IAgentConversation, IUser } from '@/lib/database';
import { configureIamEngine, getIamEngineStats, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { compileSpec } from '@/lib/iam/policySpec';
import { createPolicy } from '@/lib/iam/store';
import { withApiRequestContext, withClientApiRequestContext } from '@/server/api/fastify-utils';
import { authorizeEndingOpenRequests, refuseCancelPending } from '@/server/api/plugins/agent-approval-authz';
import { canViewOthersSessions, loadSessionForPrincipal, type SessionNeed } from '@/server/api/plugins/agent-session-access';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let db: SQLiteProvider;
let tmpDir: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId: string;
let p1: string;
let p2: string;
let agent: { _id: string; key: string };
const dbName = 'tenant_session_authz';
const users = {} as Record<'owner' | 'admin' | 'starter' | 'other' | 'padmin' | 'capped', IUser>;
const conversations = {} as Record<'own' | 'public' | 'schedule' | 'elsewhere' | 'otherAgent' | 'waiting', IAgentConversation>;

const sessionHeaders = (who: keyof typeof users, project = p1) => ({
  'x-tenant-db-name': dbName,
  'x-tenant-id': tenantId,
  'x-tenant-slug': 'session-authz',
  'x-user-id': String(users[who]._id),
  'x-user-role': String(users[who].role),
  'x-user-email': String(users[who].email),
  'x-license-type': 'FREE',
  cookie: `active_project_id=${project}`,
});

async function tokenOf(who: keyof typeof users, scope: Record<string, string> | null = null) {
  const owner = (await db.findUserById(String(users[who]._id)))!;
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: String(owner._id), servicePermissions: scope },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'session-authz',
    tenantDbName: dbName,
    projectId: p1,
    user: owner,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.engineDown.value = false;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'session-authz-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-session-authz', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  p1 = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  p2 = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'x' }))._id);
  const mk = async (key: keyof typeof users, role: 'owner' | 'admin' | 'user') => {
    users[key] = await db.createUser({ tenantId, email: `${key}@x.io`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [] });
  };
  await mk('owner', 'owner');
  await mk('admin', 'admin');
  for (const key of ['starter', 'other', 'padmin', 'capped'] as const) {
    await mk(key, 'user');
    await db.upsertUserProject({
      tenantId, userId: String(users[key]._id), projectId: p1, role: key === 'padmin' ? 'project_admin' : 'member',
      ...(key === 'capped' ? { servicePermissions: { agents: 'read' } } : {}),
    } as never);
  }
  agent = (await db.createAgent({ tenantId, projectId: p1, key: 'support', name: 'Support', config: { modelKey: 'm' }, status: 'draft', createdBy: 'x' } as never)) as never;
  agent = { _id: String((agent as { _id: unknown })._id), key: 'support' };

  const conversation = (createdBy: string, over: Partial<IAgentConversation> = {}) => db.createAgentConversation({
    tenantId, projectId: p1, agentKey: 'support', messages: [], createdBy, ...over,
  } as never);
  conversations.own = await conversation(String(users.starter._id));
  conversations.public = await conversation('a2a-public');
  conversations.schedule = await conversation('system:routine:rt1');
  conversations.elsewhere = await conversation(String(users.starter._id), { projectId: p2 });
  conversations.otherAgent = await conversation(String(users.starter._id), { agentKey: 'another-agent' });
  conversations.waiting = await conversation(String(users.starter._id), { runtimeStatus: 'requires_action' });
  await db.createAgentPendingActions([{
    tenantId, projectId: p1, agentKey: 'support', conversationId: String(conversations.waiting._id), kind: 'tool_approval', sdkId: 'sdk-1',
    toolName: 'sandbox_exec', status: 'pending', requestedAt: new Date(), createdBy: String(users.starter._id),
  }]);

  app = await createFastifyApiTestApp(async (instance) => {
    const load = (need: SessionNeed) => async (request: any, reply: any) => {
      const { id } = request.params as { id: string };
      const agentKey = (request.query as { agent?: string } | undefined)?.agent;
      const loaded = await loadSessionForPrincipal(request, id, { need, ...(agentKey ? { agentKey } : {}) });
      if (!loaded.ok) return reply.code(loaded.status).send({ reason: loaded.reason, decisionId: 'decisionId' in loaded ? loaded.decisionId : undefined });
      return reply.send({ ok: true, owner: loaded.owner, userId: loaded.userId, conversationId: String(loaded.conversation._id) });
    };
    for (const need of ['view', 'manage'] as const) {
      instance.get(`/agents/sessions/${need}/:id`, withApiRequestContext(load(need)));
      instance.post(`/agents/sessions/${need}/:id`, withApiRequestContext(load(need)));
      instance.get(`/client/v1/agents/sessions/${need}/:id`, withClientApiRequestContext(load(need) as never));
      instance.post(`/client/v1/agents/sessions/${need}/:id`, withClientApiRequestContext(load(need) as never));
    }
    instance.get('/agents/list-scope', withApiRequestContext(async (request, reply) => reply.send({ all: await canViewOthersSessions(request, { agent: agent as never }) })));
    instance.post('/agents/ending/:id', withApiRequestContext(async (request, reply) => {
      const { id } = request.params as { id: string };
      const conversation = await db.findAgentConversationById(id);
      return reply.send(await authorizeEndingOpenRequests(request, { tenantDbName: dbName, conversation: conversation! }));
    }));
    instance.post('/agents/cancel-pending/:id', withApiRequestContext(async (request, reply) => {
      const { id } = request.params as { id: string };
      const conversation = await db.findAgentConversationById(id);
      const refusal = await refuseCancelPending(request, {
        tenantDbName: dbName,
        conversation,
        agent: { ...agent, config: { humanInTheLoop: { onUserMessageWhilePending: (request.query as { policy?: string }).policy ?? 'cancel_pending' } } } as never,
      });
      return refusal ? reply.code(403).send(refusal) : reply.send({ ok: true });
    }));
    instance.get('/client/v1/agents/list-scope', withClientApiRequestContext((async (request: any, reply: any) => reply.send({ all: await canViewOthersSessions(request, { agent: agent as never }) })) as never));
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await drainPendingTasks();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

const asUser = (who: keyof typeof users, method: 'GET' | 'POST', url: string, project?: string) =>
  app.inject({ method, url, headers: sessionHeaders(who, project) });
const asToken = (method: 'GET' | 'POST', url: string) => app.inject({ method, url, headers: { authorization: 'Bearer tok' } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }) => parseJsonBody<any>(res.body);
const idOf = (key: keyof typeof conversations) => String(conversations[key]._id);
/** Engine decisions made about resources so far. */
const decisions = () => getIamEngineStats().resourceAuthz.decisions;

/** A deny written the way the visual editor writes it: it covers the person and the tokens they own. */
async function denyOthers(action: 'agent.session_view_others' | 'agent.session_manage_others' | 'agent.approve', who: keyof typeof users) {
  const compiled = await compileSpec({ effect: 'forbid', principals: { users: [String(users[who]._id)] }, actions: [action], resources: { any: true } });
  expect(compiled.errors).toEqual([]);
  await createPolicy(dbName, { policyId: `deny-${action}-${who}`, name: `${who} may not (${action})`, cedar: compiled.cedar, spec: compiled.spec }, 'tester');
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
}

describe('loadSessionForPrincipal', () => {
  it('lets the person who started the session through with only the route\'s own check - the engine is not asked', async () => {
    for (const need of ['view', 'manage'] as const) {
      const res = await asUser('starter', 'GET', `/api/agents/sessions/${need}/${idOf('own')}`);
      expect(res.statusCode, need).toBe(200);
      expect(json(res)).toMatchObject({ ok: true, owner: true, userId: String(users.starter._id), conversationId: idOf('own') });
    }
    expect(decisions()).toBe(0);
  });

  it('by default lets everybody the route admits see and act on somebody else\'s session - as before, now decided by the engine', async () => {
    for (const who of ['other', 'padmin', 'admin', 'owner', 'capped'] as const) {
      const res = await asUser(who, 'GET', `/api/agents/sessions/view/${idOf('own')}`);
      expect(res.statusCode, `${who} view`).toBe(200);
      expect(json(res).owner, who).toBe(false);
    }
    for (const who of ['other', 'padmin', 'admin', 'owner'] as const) {
      expect((await asUser(who, 'POST', `/api/agents/sessions/manage/${idOf('own')}`)).statusCode, `${who} manage`).toBe(200);
    }
    expect(decisions()).toBe(9);
  });

  it('treats a session no person started as everybody else\'s: a2a-public, a schedule', async () => {
    for (const key of ['public', 'schedule'] as const) {
      // the starter is not special here...
      expect(json(await asUser('starter', 'GET', `/api/agents/sessions/view/${idOf(key)}`)).owner).toBe(false);
    }
    await denyOthers('agent.session_view_others', 'starter');
    for (const key of ['public', 'schedule'] as const) {
      expect((await asUser('starter', 'GET', `/api/agents/sessions/view/${idOf(key)}`)).statusCode).toBe(403);
    }
    // ...but their own session stays theirs, whatever the rule says about others'
    expect((await asUser('starter', 'GET', `/api/agents/sessions/view/${idOf('own')}`)).statusCode).toBe(200);
  });

  it('a deny on viewing others\' sessions stops that person, and only viewing; the refusal has a decision id and an audit row', async () => {
    await denyOthers('agent.session_view_others', 'other');
    const refused = await asUser('other', 'GET', `/api/agents/sessions/view/${idOf('own')}`);
    expect(refused.statusCode).toBe(403);
    expect(json(refused)).toMatchObject({ reason: 'forbidden', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect((await asUser('other', 'POST', `/api/agents/sessions/manage/${idOf('own')}`)).statusCode).toBe(200); // a separate action
    expect((await asUser('padmin', 'GET', `/api/agents/sessions/view/${idOf('own')}`)).statusCode).toBe(200); // somebody else
    await drainPendingTasks();
    const feed = await db.iamListAuditEvents({ tenantId, service: 'agents', outcome: 'denied', limit: 20 });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      event: 'agent.session_view_others', action: 'read', resourceType: 'agent', resourceId: agent._id,
      metadata: expect.objectContaining({ decisionId: json(refused).decisionId, ownerId: String(users.starter._id), contextProjectId: p1 }),
    });
  });

  it('a deny on managing others\' sessions stops writes, not reads', async () => {
    await denyOthers('agent.session_manage_others', 'padmin');
    expect((await asUser('padmin', 'POST', `/api/agents/sessions/manage/${idOf('own')}`)).statusCode).toBe(403);
    expect((await asUser('padmin', 'GET', `/api/agents/sessions/view/${idOf('own')}`)).statusCode).toBe(200);
    expect((await asUser('padmin', 'POST', `/api/agents/sessions/manage/${idOf('public')}`)).statusCode).toBe(403);
  });

  it('applies the project\'s own limit like any Write-level action: read-only there, no managing others\' sessions', async () => {
    expect((await asUser('capped', 'GET', `/api/agents/sessions/view/${idOf('own')}`)).statusCode).toBe(200);
    // (the route gate would already have refused the write; the helper is the second line)
    const managed = await asUser('capped', 'GET', `/api/agents/sessions/manage/${idOf('own')}`);
    expect(managed.statusCode).toBe(403);
  });

  it('answers not_found - without asking the engine - for another project, another agent, an unknown or a malformed id', async () => {
    const before = decisions();
    expect((await asUser('admin', 'GET', `/api/agents/sessions/view/${idOf('elsewhere')}`)).statusCode).toBe(404);
    expect((await asUser('admin', 'GET', `/api/agents/sessions/view/${idOf('own')}?agent=another-agent`)).statusCode).toBe(404);
    expect((await asUser('admin', 'GET', `/api/agents/sessions/view/${idOf('otherAgent')}?agent=support`)).statusCode).toBe(404);
    expect((await asUser('admin', 'GET', '/api/agents/sessions/view/nope')).statusCode).toBe(404);
    expect((await asUser('admin', 'GET', '/api/agents/sessions/view/%20')).statusCode).toBe(404);
    expect(json(await asUser('admin', 'GET', '/api/agents/sessions/view/nope'))).toMatchObject({ reason: 'not_found' });
    expect(decisions()).toBe(before);
    // ...and a session of the agent the route names is found
    expect((await asUser('admin', 'GET', `/api/agents/sessions/view/${idOf('own')}?agent=support`)).statusCode).toBe(200);
  });

  describe('for an API token', () => {
    it('acts for its owner: the starter\'s token owns the session, another member\'s is somebody else', async () => {
      await tokenOf('starter');
      expect(json(await asToken('GET', `/api/client/v1/agents/sessions/view/${idOf('own')}`))).toMatchObject({ ok: true, owner: true });
      await tokenOf('other');
      expect(json(await asToken('GET', `/api/client/v1/agents/sessions/view/${idOf('own')}`))).toMatchObject({ ok: true, owner: false });
      expect((await asToken('POST', `/api/client/v1/agents/sessions/manage/${idOf('own')}`)).statusCode).toBe(200);
    });

    it('is stopped by the rules that stop its owner, and by its own scope', async () => {
      await denyOthers('agent.session_view_others', 'other');
      await tokenOf('other');
      const refused = await asToken('GET', `/api/client/v1/agents/sessions/view/${idOf('own')}`);
      expect(refused.statusCode).toBe(403);
      await drainPendingTasks();
      const [row] = (await db.iamListAuditEvents({ tenantId, service: 'agents', outcome: 'denied', limit: 5 })).items;
      expect(row).toMatchObject({ actorType: 'api_token', apiTokenId: 'tok-1', actorUserId: String(users.other._id) });

      await tokenOf('padmin', { agents: 'read' });
      expect((await asToken('GET', `/api/client/v1/agents/sessions/view/${idOf('own')}`)).statusCode).toBe(200);
      expect((await asToken('GET', `/api/client/v1/agents/sessions/manage/${idOf('own')}`)).statusCode).toBe(403); // read scope: no Write-level action
    });
  });

  it('fails closed: an engine that cannot answer is `unavailable` (the route\'s 503), never an allow and never a "no"', async () => {
    // (the gate itself needs the engine: let it pass, then take the engine away for the helper)
    const res = await app.inject({ method: 'GET', url: `/api/agents/sessions/view/${idOf('own')}`, headers: sessionHeaders('other') });
    expect(res.statusCode).toBe(200);
    hoisted.engineDown.value = true;
    const down = await asUser('other', 'GET', `/api/agents/sessions/view/${idOf('own')}`);
    expect(down.statusCode).toBe(503);
    // (the gate in front of every route would have answered 503 already: see iam-enforce-gate)
    expect(json(down)).toMatchObject({ reason: 'unavailable', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });
});

describe('canViewOthersSessions (a list decides once per request)', () => {
  it('is yes by default, no for someone a rule stops - and a "no" is an answer, not a refusal (no audit row)', async () => {
    expect(json(await asUser('other', 'GET', '/api/agents/list-scope')).all).toBe(true);
    await denyOthers('agent.session_view_others', 'other');
    expect(json(await asUser('other', 'GET', '/api/agents/list-scope')).all).toBe(false);
    expect(json(await asUser('padmin', 'GET', '/api/agents/list-scope')).all).toBe(true);
    await drainPendingTasks();
    expect((await db.iamListAuditEvents({ tenantId, service: 'agents', outcome: 'denied', limit: 5 })).items).toHaveLength(0);
  });

  it('asks as the token\'s owner for a token', async () => {
    await denyOthers('agent.session_view_others', 'other');
    await tokenOf('other');
    expect(json(await asToken('GET', '/api/client/v1/agents/list-scope')).all).toBe(false);
    await tokenOf('padmin');
    expect(json(await asToken('GET', '/api/client/v1/agents/list-scope')).all).toBe(true);
  });
});

describe('ending an open request (cancelling a paused run, a new message under cancel_pending)', () => {
  it('asks nothing of a session that waits on nothing', async () => {
    const before = decisions();
    const res = await asUser('other', 'POST', `/api/agents/ending/${idOf('own')}`);
    expect(json(res)).toEqual({ allowed: true });
    expect(decisions()).toBe(before);
  });

  it('takes agent.approve: the session\'s starter and an admin of the project may, another member may not (default: the owner and admins)', async () => {
    expect(json(await asUser('starter', 'POST', `/api/agents/ending/${idOf('waiting')}`))).toEqual({ allowed: true });
    expect(json(await asUser('padmin', 'POST', `/api/agents/ending/${idOf('waiting')}`))).toEqual({ allowed: true });
    expect(json(await asUser('admin', 'POST', `/api/agents/ending/${idOf('waiting')}`))).toEqual({ allowed: true });
    const refused = json(await asUser('other', 'POST', `/api/agents/ending/${idOf('waiting')}`));
    expect(refused).toMatchObject({ allowed: false, decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('follows a custom deny on agent.approve, even for the person who started the session', async () => {
    await denyOthers('agent.approve', 'starter');
    expect(json(await asUser('starter', 'POST', `/api/agents/ending/${idOf('waiting')}`))).toMatchObject({ allowed: false });
  });

  it('under cancel_pending a new message asks; under reject (the 409 is the route\'s) it asks nothing', async () => {
    expect((await asUser('other', 'POST', `/api/agents/cancel-pending/${idOf('waiting')}`)).statusCode).toBe(403);
    expect((await asUser('starter', 'POST', `/api/agents/cancel-pending/${idOf('waiting')}`)).statusCode).toBe(200);
    const before = decisions();
    expect((await asUser('other', 'POST', `/api/agents/cancel-pending/${idOf('waiting')}?policy=reject`)).statusCode).toBe(200);
    expect((await asUser('other', 'POST', `/api/agents/cancel-pending/${idOf('own')}`)).statusCode).toBe(200); // nothing open
    expect(decisions()).toBe(before);
  });

  it('is not an answer when the engine is down: the verdict says `unavailable` (the route answers 503), not a refusal', async () => {
    await asUser('starter', 'POST', `/api/agents/ending/${idOf('waiting')}`);
    hoisted.engineDown.value = true;
    const down = await asUser('starter', 'POST', `/api/agents/ending/${idOf('waiting')}`);
    expect(json(down)).toMatchObject({ allowed: false, unavailable: true, decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('an open QUESTION is the session\'s, not an approval: only open tool approvals take agent.approve', async () => {
    const asking = await db.createAgentConversation({
      tenantId, projectId: p1, agentKey: 'support', messages: [], createdBy: String(users.starter._id), runtimeStatus: 'requires_action',
    } as never);
    await db.createAgentPendingActions([{
      tenantId, projectId: p1, agentKey: 'support', conversationId: String(asking._id), kind: 'user_question', sdkId: 'sdk-q',
      questions: [{ question: 'Which?', header: 'H', options: [{ label: 'a' }, { label: 'b' }] }], status: 'pending', requestedAt: new Date(), createdBy: String(users.starter._id),
    }] as never);
    const before = decisions();
    // nothing to approve is open: any caller who got this far may end the question (they hold the session's rights)
    expect(json(await asUser('other', 'POST', `/api/agents/ending/${String(asking._id)}`))).toEqual({ allowed: true });
    expect(decisions()).toBe(before);
  });
});
