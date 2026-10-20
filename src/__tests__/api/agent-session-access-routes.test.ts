/**
 * Session ownership as a permission, at the REAL routes, the REAL gate and the REAL policy engine, over a
 * real SQLite provider: every path to a session's content asks "did THIS caller start it, and if not may
 * they view / act on it" - the list, the record, the events, the files, the runs, the Files API objects, the
 * tracing thread, the Responses continuation.
 *
 * The default is today's behaviour (everybody the route admits); a deny rule about
 * `agent.session_view_others` / `agent.session_manage_others` is what narrows it, written the way the
 * visual editor writes it. Lists are cut IN THE DATABASE before the page, so a busy teammate cannot push the
 * caller's own sessions off it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  requireApiToken: vi.fn(),
  engine: { down: false as boolean, only: null as null | string },
}));

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
// An engine that can be told to fail for the questions about a resource only (the gate in front of every route keeps working).
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    authorize: (input: Parameters<typeof actual.authorize>[0]) => (hoisted.engine.down && (!hoisted.engine.only || input.action.startsWith(hoisted.engine.only))
      ? Promise.resolve({ allowed: false, reasons: [], errors: ['the engine is down'], obligations: {}, durationUs: 0, failed: true } as Awaited<ReturnType<typeof actual.authorize>>)
      : actual.authorize(input)),
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { encryptObject } from '@/lib/utils/crypto';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IAgentConversation, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { compileSpec } from '@/lib/iam/policySpec';
import { createPolicy } from '@/lib/iam/store';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { agentSessionFilesApiPlugin } from '@/server/api/plugins/agent-session-files';
import { clientAgentRunsApiPlugin } from '@/server/api/plugins/client-agent-runs';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { clientTracingApiPlugin } from '@/server/api/plugins/client-tracing';
import { filesApiPlugin } from '@/server/api/plugins/files';
import { tracingApiPlugin } from '@/server/api/plugins/tracing';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let db: SQLiteProvider;
let tmpDir: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId: string;
let p1: string;
let agentId: string;
const dbName = 'tenant_session_routes';
const users = {} as Record<'owner' | 'admin' | 'starter' | 'other' | 'padmin', IUser>;
const sessions = {} as Record<'starters' | 'others' | 'scheduled' | 'waiting' | 'questioning', IAgentConversation>;

const sessionHeaders = (who: keyof typeof users, project = p1) => ({
  'x-tenant-db-name': dbName,
  'x-tenant-id': tenantId,
  'x-tenant-slug': 'session-routes',
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
    tenantSlug: 'session-routes',
    tenantDbName: dbName,
    projectId: p1,
    user: owner,
  });
}

const idOf = (key: keyof typeof sessions) => String(sessions[key]._id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }) => parseJsonBody<any>(res.body);
const dash = (who: keyof typeof users, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, headers: { ...sessionHeaders(who), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
const viaToken = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, headers: { authorization: 'Bearer tok', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });

/** A deny written the way the visual editor writes it: it covers the person and the tokens they own. */
async function deny(action: 'agent.session_view_others' | 'agent.session_manage_others', who: keyof typeof users) {
  const compiled = await compileSpec({ effect: 'forbid', principals: { users: [String(users[who]._id)] }, actions: [action], resources: { any: true } });
  expect(compiled.errors).toEqual([]);
  await createPolicy(dbName, { policyId: `deny-${action}-${who}`, name: `${who} may not (${action})`, cedar: compiled.cedar, spec: compiled.spec }, 'tester');
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.engine.down = false;
  hoisted.engine.only = null;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'session-routes-'));
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

  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-session-routes', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  p1 = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  const mk = async (key: keyof typeof users, role: 'owner' | 'admin' | 'user') => {
    users[key] = await db.createUser({ tenantId, email: `${key}@x.io`, name: `Name of ${key}`, password: '$2b$10$x', role, licenseId: 'FREE', features: [] });
  };
  await mk('owner', 'owner');
  await mk('admin', 'admin');
  for (const key of ['starter', 'other', 'padmin'] as const) {
    await mk(key, 'user');
    await db.upsertUserProject({ tenantId, userId: String(users[key]._id), projectId: p1, role: key === 'padmin' ? 'project_admin' : 'member' } as never);
  }
  const agent = await db.createAgent({ tenantId, projectId: p1, key: 'support', name: 'Support', config: { modelKey: 'm' }, status: 'active', createdBy: 'x' } as never);
  agentId = String(agent._id);

  const conversation = (createdBy: string, over: Partial<IAgentConversation> = {}) => db.createAgentConversation({
    tenantId, projectId: p1, agentKey: 'support', title: `by ${createdBy}`, messages: [{ role: 'user', content: `secret of ${createdBy}` }], metadata: { source: 'console' }, createdBy, ...over,
  } as never);
  sessions.starters = await conversation(String(users.starter._id));
  sessions.others = await conversation(String(users.other._id));
  sessions.scheduled = await conversation('system:trigger:trg1', { metadata: { source: 'trigger' } as never });
  sessions.waiting = await conversation(String(users.starter._id), { runtimeStatus: 'requires_action' });
  sessions.questioning = await conversation(String(users.starter._id), { runtimeStatus: 'requires_action' });
  await db.createAgentPendingActions([
    {
      tenantId, projectId: p1, agentKey: 'support', conversationId: idOf('waiting'), kind: 'tool_approval', sdkId: 'sdk-1',
      toolName: 'sandbox_exec', status: 'pending', requestedAt: new Date(), createdBy: String(users.starter._id),
    },
    {
      tenantId, projectId: p1, agentKey: 'support', conversationId: idOf('questioning'), kind: 'user_question', sdkId: 'sdk-2',
      questions: [{ question: 'Which?', header: 'H', options: [{ label: 'a' }, { label: 'b' }] }], status: 'pending', requestedAt: new Date(), createdBy: String(users.starter._id),
    },
  ] as never);

  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(agentsApiPlugin);
    await instance.register(agentSessionFilesApiPlugin);
    await instance.register(clientAgentSessionsApiPlugin);
    await instance.register(clientAgentRunsApiPlugin);
    await instance.register(clientAgentsApiPlugin);
    await instance.register(clientFilesApiPlugin);
    await instance.register(clientTracingApiPlugin);
    await instance.register(filesApiPlugin);
    await instance.register(tracingApiPlugin);
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await drainPendingTasks();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('the Sessions list of an agent', () => {
  it('by default shows everybody\'s sessions, each with whose it is and whether the viewer started it', async () => {
    const res = await dash('other', 'GET', `/agents/${agentId}/sessions`);
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.scope).toEqual({ viewOthers: true });
    const byId = Object.fromEntries(body.sessions.map((s: { _id: string }) => [s._id, s]));
    expect(Object.keys(byId)).toHaveLength(5);
    expect(byId[idOf('others')]).toMatchObject({ createdBy: String(users.other._id), ownSession: true, owner: { kind: 'user', name: 'Name of other' } });
    expect(byId[idOf('starters')]).toMatchObject({ ownSession: false, owner: { kind: 'user', name: 'Name of starter', email: 'starter@x.io' } });
    expect(byId[idOf('scheduled')]).toMatchObject({ ownSession: false, owner: { kind: 'trigger' } });
  });

  it('for someone a rule stops from viewing others\' sessions it holds only their own - cut before the page, whatever a teammate adds', async () => {
    await deny('agent.session_view_others', 'other');
    // a lot of other people's sessions, newer than theirs: the list limit must not push theirs off the page
    for (let i = 0; i < 120; i++) {
      await db.createAgentConversation({ tenantId, projectId: p1, agentKey: 'support', messages: [], metadata: { source: 'console' }, createdBy: String(users.starter._id) } as never);
    }
    const mine = await dash('other', 'GET', `/agents/${agentId}/sessions`);
    expect(mine.statusCode).toBe(200);
    expect(json(mine).scope).toEqual({ viewOthers: false });
    expect(json(mine).sessions.map((s: { _id: string }) => s._id)).toEqual([idOf('others')]);
    // everybody else is where they were, and the 100-row page is theirs to fill
    const theirs = await dash('padmin', 'GET', `/agents/${agentId}/sessions`);
    expect(json(theirs).scope).toEqual({ viewOthers: true });
    expect(json(theirs).sessions).toHaveLength(100);
  });

  it('says for each waiting session whether THIS viewer could answer it - the engine\'s rule, not a guess from a role', async () => {
    const rows = async (who: keyof typeof users) => Object.fromEntries(json(await dash(who, 'GET', `/agents/${agentId}/sessions`)).sessions
      .filter((s: { runtimeStatus?: string }) => s.runtimeStatus === 'requires_action')
      .map((s: { _id: string }) => [s._id, s]));
    // the starter answers their own, both the approval and the question
    expect(await rows('starter')).toMatchObject({ [idOf('waiting')]: { canResolve: true }, [idOf('questioning')]: { canResolve: true } });
    // another member may do neither by default (approvers: the owner and admins), and is told which kind of limit it is
    expect(await rows('other')).toMatchObject({
      [idOf('waiting')]: { canResolve: false, resolveBlockedReason: 'approvers_admin' },
      // a question is the session\'s: any member who may act on others\' sessions answers it
      [idOf('questioning')]: { canResolve: true },
    });
    // the project admin answers the approval
    expect(await rows('padmin')).toMatchObject({ [idOf('waiting')]: { canResolve: true } });
    await deny('agent.session_manage_others', 'other');
    expect(await rows('other')).toMatchObject({ [idOf('questioning')]: { canResolve: false, resolveBlockedReason: 'session_owner' } });
  });
});

describe('one session of an agent', () => {
  it('is the viewer\'s own without a question; somebody else\'s by default too (today\'s behaviour) - and then a deny narrows it', async () => {
    expect((await dash('starter', 'GET', `/agents/${agentId}/sessions/${idOf('starters')}`)).statusCode).toBe(200);
    expect((await dash('other', 'GET', `/agents/${agentId}/sessions/${idOf('starters')}`)).statusCode).toBe(200);

    await deny('agent.session_view_others', 'other');
    const refused = await dash('other', 'GET', `/agents/${agentId}/sessions/${idOf('starters')}`);
    expect(refused.statusCode).toBe(403);
    expect(json(refused)).toMatchObject({ code: 'forbidden', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(JSON.stringify(json(refused))).not.toContain('secret');
    // their own session is still theirs
    expect((await dash('other', 'GET', `/agents/${agentId}/sessions/${idOf('others')}`)).statusCode).toBe(200);
  });

  it('carries the owner and, for the open requests, what the viewer may do with each', async () => {
    const res = json(await dash('other', 'GET', `/agents/${agentId}/sessions/${idOf('waiting')}`));
    expect(res.ownSession).toBe(false);
    expect(res.owner).toMatchObject({ kind: 'user', name: 'Name of starter' });
    expect(res.pendingActions).toHaveLength(1);
    expect(res.pendingActions[0]).toMatchObject({ kind: 'tool_approval', canResolve: false, resolveBlockedReason: 'approvers_admin' });
    const mine = json(await dash('starter', 'GET', `/agents/${agentId}/sessions/${idOf('waiting')}`));
    expect(mine.ownSession).toBe(true);
    expect(mine.pendingActions[0]).toMatchObject({ canResolve: true });
    expect(mine.pendingActions[0].resolveBlockedReason).toBeUndefined();
  });

  it('lists the actions of a session with the same verdict, and a custom allow rule that appoints an approver turns it into a yes', async () => {
    const actionsOf = async (who: keyof typeof users) => json(await dash(who, 'GET', `/agents/${agentId}/sessions/${idOf('waiting')}/actions`)).actions;
    expect((await actionsOf('other'))[0]).toMatchObject({ kind: 'tool_approval', status: 'pending', canResolve: false, resolveBlockedReason: 'approvers_admin' });
    expect((await actionsOf('padmin'))[0]).toMatchObject({ canResolve: true });
    // a compliance group is appointed by an allow rule: the same request now reads as theirs to answer
    const compiled = await compileSpec({ effect: 'permit', principals: { users: [String(users.other._id)] }, actions: ['agent.approve'], resources: { any: true } });
    expect(compiled.errors).toEqual([]);
    await createPolicy(dbName, { policyId: 'appoint-other', name: 'other approves', cedar: compiled.cedar, spec: compiled.spec }, 'tester');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    expect((await actionsOf('other'))[0]).toMatchObject({ canResolve: true });
    // ...and a question is unaffected: it follows the session, not the appointment
    const [question] = await db.listAgentPendingActions(idOf('questioning'), { status: 'pending' });
    expect(question.kind).toBe('user_question');
  });

  it('is acted on only by its owner or somebody allowed to manage others\' sessions: budget, delete, events follow the right need', async () => {
    await deny('agent.session_manage_others', 'padmin');
    // reading is a separate action: still fine
    expect((await dash('padmin', 'GET', `/agents/${agentId}/sessions/${idOf('starters')}/events`)).statusCode).toBe(200);
    expect((await dash('padmin', 'GET', `/agents/${agentId}/sessions/${idOf('starters')}/actions`)).statusCode).toBe(200);
    // changing it is not
    const budget = await dash('padmin', 'PATCH', `/agents/${agentId}/sessions/${idOf('starters')}`, { budget: { maxCostUsd: 5, onReach: 'pause' } });
    expect(budget.statusCode).toBe(403);
    const del = await dash('padmin', 'DELETE', `/agents/${agentId}/sessions/${idOf('starters')}`);
    expect(del.statusCode).toBe(403);
    expect(await db.findAgentConversationById(idOf('starters'))).toBeTruthy();
    // the owner deletes theirs without being asked
    expect((await dash('starter', 'DELETE', `/agents/${agentId}/sessions/${idOf('starters')}`)).statusCode).toBe(200);
    expect(await db.findAgentConversationById(idOf('starters'))).toBeNull();
  });

  it('answers 404 for a session of another agent or project, before any permission is asked', async () => {
    const other = await db.createAgent({ tenantId, projectId: p1, key: 'other-agent', name: 'Other', config: { modelKey: 'm' }, status: 'active', createdBy: 'x' } as never);
    expect((await dash('starter', 'GET', `/agents/${String(other._id)}/sessions/${idOf('starters')}`)).statusCode).toBe(404);
  });

  it('an engine that cannot decide is a 503 with a decision id - never a 403 and never an allow - and the owner is not locked out', async () => {
    hoisted.engine.down = true;
    hoisted.engine.only = 'agent.';
    const down = await dash('other', 'GET', `/agents/${agentId}/sessions/${idOf('starters')}`);
    expect(down.statusCode).toBe(503);
    expect(json(down)).toMatchObject({ code: 'authorization_unavailable', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(down.headers['retry-after']).toBeDefined();
    expect((await dash('starter', 'GET', `/agents/${agentId}/sessions/${idOf('starters')}`)).statusCode).toBe(200);
    // a list cannot tell what to show either: not an empty list
    expect((await dash('other', 'GET', `/agents/${agentId}/sessions`)).statusCode).toBe(503);
  });
});

describe('answering a pending request', () => {
  const resolve = (who: keyof typeof users, id: keyof typeof sessions, actionKind: 'tool_approval' | 'user_question') => async () => {
    const [action] = await db.listAgentPendingActions(idOf(id), { status: 'pending' });
    expect(action.kind).toBe(actionKind);
    const body = actionKind === 'tool_approval' ? { decision: 'allow' } : { answers: { 'Which?': 'a' } };
    return dash(who, 'POST', `/agents/${agentId}/sessions/${idOf(id)}/actions/${String(action._id)}/resolve`, body);
  };

  it('a tool approval is `agent.approve`: a member who is not an approver is refused with the decision, and nothing is recorded', async () => {
    const refused = await resolve('other', 'waiting', 'tool_approval')();
    expect(refused.statusCode).toBe(403);
    expect(json(refused)).toMatchObject({ code: 'forbidden', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const [action] = await db.listAgentPendingActions(idOf('waiting'), { status: 'pending' });
    expect(action.status).toBe('pending');
  });

  it('a QUESTION follows the session\'s ownership: a member who may act on others\' sessions answers it, a stopped one does not', async () => {
    await deny('agent.session_manage_others', 'other');
    const refused = await resolve('other', 'questioning', 'user_question')();
    expect(refused.statusCode).toBe(403);
    expect(json(refused).error).toContain('somebody else started');
    const [action] = await db.listAgentPendingActions(idOf('questioning'), { status: 'pending' });
    expect(action.status).toBe('pending');
  });

  it('an engine that cannot decide who may answer is a 503 on the dashboard and in the client API alike, with nothing recorded', async () => {
    hoisted.engine.down = true;
    hoisted.engine.only = 'agent.';
    const dashboard = await resolve('other', 'waiting', 'tool_approval')();
    expect(dashboard.statusCode).toBe(503);
    expect(json(dashboard)).toMatchObject({ code: 'authorization_unavailable', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });

    await tokenOf('other');
    const [action] = await db.listAgentPendingActions(idOf('waiting'), { status: 'pending' });
    const client = await viaToken('POST', `/client/v1/agents/sessions/${idOf('waiting')}/actions/${String(action._id)}`, { decision: 'allow' });
    expect(client.statusCode).toBe(503);
    expect(json(client).error).toMatchObject({ code: 'authorization_unavailable', decision_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect((await db.findAgentPendingActionById(String(action._id)))?.status).toBe('pending');
  });
});

describe('the files a session holds', () => {
  const uploadUrl = (id: keyof typeof sessions) => `/agents/${agentId}/sessions/${idOf(id)}/files`;

  it('are listed to whoever may view the session, and only that', async () => {
    expect((await dash('other', 'GET', uploadUrl('starters'))).statusCode).toBe(200);
    await deny('agent.session_view_others', 'other');
    expect((await dash('other', 'GET', uploadUrl('starters'))).statusCode).toBe(403);
    expect((await dash('other', 'GET', `${uploadUrl('starters')}/some-file/content`)).statusCode).toBe(403);
    expect((await dash('starter', 'GET', uploadUrl('starters'))).statusCode).toBe(200);
  });

  it('are uploaded and deleted only by whoever may act on the session', async () => {
    await deny('agent.session_manage_others', 'other');
    const upload = await app.inject({
      method: 'POST', url: `/api${uploadUrl('starters')}?name=notes.txt`,
      headers: { ...sessionHeaders('other'), 'content-type': 'text/plain' }, payload: 'hello',
    });
    expect(upload.statusCode).toBe(403);
    expect((await dash('other', 'DELETE', `${uploadUrl('starters')}/some-file`)).statusCode).toBe(403);
  });

  it('are the same files through the client API: the token\'s owner is the one asked', async () => {
    await deny('agent.session_view_others', 'other');
    await tokenOf('other');
    const listed = await viaToken('GET', `/client/v1/agents/sessions/${idOf('starters')}/files`);
    expect(listed.statusCode).toBe(403);
    expect(json(listed).error).toMatchObject({ code: 'session_forbidden', decision_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await tokenOf('starter');
    expect((await viaToken('GET', `/client/v1/agents/sessions/${idOf('starters')}/files`)).statusCode).toBe(200);
  });
});

describe('the client API sessions', () => {
  it('list: a caller a rule stops from viewing others\' sessions gets only their own, across agents and for one agent', async () => {
    const second = await db.createAgent({ tenantId, projectId: p1, key: 'second', name: 'Second', config: { modelKey: 'm' }, status: 'active', createdBy: 'x' } as never);
    expect(second).toBeTruthy();
    await db.createAgentConversation({ tenantId, projectId: p1, agentKey: 'second', messages: [], metadata: { source: 'api' }, createdBy: String(users.starter._id) } as never);
    await tokenOf('other');
    expect(json(await viaToken('GET', '/client/v1/agents/sessions?limit=100')).data).toHaveLength(6);

    await deny('agent.session_view_others', 'other');
    const own = json(await viaToken('GET', '/client/v1/agents/sessions?limit=100'));
    expect(own.data.map((s: { id: string }) => s.id)).toEqual([idOf('others')]);
    const forAgent = json(await viaToken('GET', '/client/v1/agents/sessions?agent=support&limit=100'));
    expect(forAgent.data.map((s: { id: string }) => s.id)).toEqual([idOf('others')]);
    // another person is not narrowed
    await tokenOf('padmin');
    expect(json(await viaToken('GET', '/client/v1/agents/sessions?limit=100')).data).toHaveLength(6);
  });

  it('list: a rule about ONE agent narrows that agent only (the per-agent decision is applied before the page)', async () => {
    const second = await db.createAgent({ tenantId, projectId: p1, key: 'second', name: 'Second', config: { modelKey: 'm' }, status: 'active', createdBy: 'x' } as never);
    await db.createAgentConversation({ tenantId, projectId: p1, agentKey: 'second', messages: [], metadata: { source: 'api' }, createdBy: String(users.starter._id) } as never);
    const compiled = await compileSpec({
      effect: 'forbid', principals: { users: [String(users.other._id)] }, actions: ['agent.session_view_others'],
      resources: { resources: [{ type: 'agent', id: String(second._id) }] },
    });
    expect(compiled.errors).toEqual([]);
    await createPolicy(dbName, { policyId: 'second-private', name: 'second is private', cedar: compiled.cedar, spec: compiled.spec }, 'tester');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    await tokenOf('other');
    const listed = json(await viaToken('GET', '/client/v1/agents/sessions?limit=100')).data as Array<{ id: string; agent: string }>;
    // every session of `support` (the rule does not name it), none of `second` that somebody else started
    expect(listed.filter((s) => s.agent === 'support')).toHaveLength(5);
    expect(listed.filter((s) => s.agent === 'second')).toHaveLength(0);
  });

  it('get, events and delete follow the need of the action', async () => {
    await deny('agent.session_view_others', 'other');
    await tokenOf('other');
    expect((await viaToken('GET', `/client/v1/agents/sessions/${idOf('starters')}`)).statusCode).toBe(403);
    expect((await viaToken('GET', `/client/v1/agents/sessions/${idOf('starters')}/events`)).statusCode).toBe(403);
    // deleting is acting: a separate action, which this rule does not touch
    expect((await viaToken('DELETE', `/client/v1/agents/sessions/${idOf('starters')}`)).statusCode).toBe(200);
  });

  it('a run is a handle on its session: polling it is viewing the session', async () => {
    const run = await db.createAgentRun({
      tenantId, tenantDbName: dbName, projectId: p1, agentKey: 'support', conversationId: idOf('starters'), mode: 'background', userMessage: 'hi',
      status: 'succeeded', userId: String(users.starter._id),
    } as never);
    await deny('agent.session_view_others', 'other');
    await tokenOf('other');
    expect((await viaToken('GET', `/client/v1/agents/runs/${String(run._id)}`)).statusCode).toBe(403);
    await tokenOf('starter');
    expect((await viaToken('GET', `/client/v1/agents/runs/${String(run._id)}`)).statusCode).toBe(200);
    // the Studio list of background runs is cut to the viewer's own for a caller who may not view others'
    await db.createAgentRun({
      tenantId, tenantDbName: dbName, projectId: p1, agentKey: 'support', conversationId: idOf('others'), mode: 'background', userMessage: 'hi',
      status: 'succeeded', userId: String(users.other._id),
    } as never);
    const runs = json(await dash('other', 'GET', `/agents/${agentId}/runs`)).runs as Array<{ conversation_id?: string; conversationId?: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].conversation_id ?? runs[0].conversationId).toBe(idOf('others'));
    expect(json(await dash('padmin', 'GET', `/agents/${agentId}/runs`)).runs).toHaveLength(2);
    // and asking for one session's runs is viewing that session
    expect((await dash('other', 'GET', `/agents/${agentId}/runs?conversationId=${idOf('starters')}`)).statusCode).toBe(403);
  });

  it('the Studio runs list can be asked for the scheduled runs', async () => {
    await db.createAgentRun({
      tenantId, tenantDbName: dbName, projectId: p1, agentKey: 'support', conversationId: idOf('starters'), mode: 'background', userMessage: 'later',
      status: 'scheduled', notBefore: new Date(Date.now() + 3_600_000), userId: String(users.starter._id),
    } as never);
    await db.createAgentRun({
      tenantId, tenantDbName: dbName, projectId: p1, agentKey: 'support', conversationId: idOf('starters'), mode: 'background', userMessage: 'done',
      status: 'succeeded', userId: String(users.starter._id),
    } as never);
    const scheduled = json(await dash('padmin', 'GET', `/agents/${agentId}/runs?status=scheduled`)).runs as Array<{ status: string }>;
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((run) => run.status === 'scheduled')).toBe(true);
    const all = json(await dash('padmin', 'GET', `/agents/${agentId}/runs`)).runs as Array<{ status: string }>;
    expect(all.length).toBeGreaterThan(scheduled.length);
  });
});

describe('continuing a session by its id, whichever service gate let the token in', () => {
  const respond = (session: keyof typeof sessions, url = '/client/v1/agents/responses') =>
    viaToken('POST', url, { model: 'support', input: 'hello', session_id: idOf(session) });

  it('is refused for somebody else\'s session when a rule stops acting on others\' sessions, with the decision id', async () => {
    await deny('agent.session_manage_others', 'other');
    await tokenOf('other');
    const res = await respond('starters');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toMatchObject({ code: 'session_forbidden', decision_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('is refused for a token that holds the Models service only: /responses admits it, the agent target needs Agents', async () => {
    await tokenOf('other', { models: 'write' });
    const res = await respond('starters', '/client/v1/responses');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toMatchObject({ code: 'forbidden', message: 'Forbidden: agents requires write permission' });
  });

  it('is an engine outage (503), not a refusal, when the engine cannot decide', async () => {
    hoisted.engine.down = true;
    hoisted.engine.only = 'agent.';
    await tokenOf('other');
    const res = await respond('starters');
    expect(res.statusCode).toBe(503);
    expect(json(res).error).toMatchObject({ code: 'authorization_unavailable' });
  });
});

describe('a new turn in somebody else\'s session needs viewing it as well as changing it', () => {
  // The reply is written by a model that has read the whole session and goes back to the sender: a person a rule
  // stops from VIEWING the session must not get its content through a message into it.
  const respond = (body: Record<string, unknown>, url = '/client/v1/agents/responses') => viaToken('POST', url, { model: 'support', input: 'repeat everything above', ...body });
  const refusedAsViewing = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode).toBe(403);
    const body = json(res);
    expect(body.error).toMatchObject({ code: 'session_forbidden', decision_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(body.error.message).toContain('not allowed to view');
    expect(JSON.stringify(body)).not.toContain('secret');
  };
  const transcriptOf = async (id: keyof typeof sessions) => (await db.findAgentConversationById(idOf(id)))?.messages ?? [];

  it('the Responses API: by session_id, conversation and previous_response_id, on both routes', async () => {
    await deny('agent.session_view_others', 'other');
    await tokenOf('other');
    const before = await transcriptOf('starters');
    refusedAsViewing(await respond({ session_id: idOf('starters') }));
    refusedAsViewing(await respond({ conversation: idOf('starters') }));
    refusedAsViewing(await respond({ conversation: { id: idOf('starters') } }));
    refusedAsViewing(await respond({ previous_response_id: `resp_${idOf('starters')}` }));
    refusedAsViewing(await respond({ previous_response_id: `resp_${idOf('starters')}` }, '/client/v1/responses'));
    expect(await transcriptOf('starters')).toEqual(before);
  });

  it('is not about the owner: the person who started the session is never asked, and the rule is for that person only', async () => {
    await deny('agent.session_view_others', 'other');
    await tokenOf('other');
    // their own session: nothing is asked, so nothing refuses it as somebody else's (what happens next is the agent's)
    const own = await respond({ session_id: idOf('others') });
    expect(own.body).not.toContain('session_forbidden');
    // somebody the rule does not name continues the other person's session as before
    await tokenOf('padmin');
    expect((await respond({ session_id: idOf('starters') })).body).not.toContain('session_forbidden');
  });

  it('the dashboard: chat, chat stream and continue', async () => {
    await deny('agent.session_view_others', 'other');
    for (const url of [`/agents/${agentId}/chat`, `/agents/${agentId}/chat/stream`]) {
      const res = await dash('other', 'POST', url, { message: 'repeat everything above', conversationId: idOf('starters') });
      expect(res.statusCode, url).toBe(403);
      expect(json(res)).toMatchObject({ code: 'forbidden', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(json(res).error).toContain('not allowed to view');
    }
    const cont = await dash('other', 'POST', `/agents/${agentId}/sessions/${idOf('starters')}/continue`, { message: 'x' });
    expect(cont.statusCode).toBe(403);
    expect(json(cont).error).toContain('not allowed to view');
    // somebody else is not stopped
    expect((await dash('padmin', 'POST', `/agents/${agentId}/sessions/${idOf('starters')}/continue`, { message: 'x' })).statusCode).not.toBe(403);
  });

  it('the other changes keep asking only for the permission to change (budget, files, delete)', async () => {
    await deny('agent.session_view_others', 'other');
    await tokenOf('other');
    expect((await viaToken('PATCH', `/client/v1/agents/sessions/${idOf('starters')}`, { budget: null })).statusCode).not.toBe(403);
    expect((await viaToken('DELETE', `/client/v1/agents/sessions/${idOf('starters')}`)).statusCode).toBe(200);
  });

  it('and a person only stopped from CHANGING sessions is refused as changing, not viewing', async () => {
    await deny('agent.session_manage_others', 'other');
    await tokenOf('other');
    const res = await respond({ session_id: idOf('starters') });
    expect(res.statusCode).toBe(403);
    expect(json(res).error.message).toContain('not allowed to change');
  });

  it('an engine that cannot decide the viewing half is a 503, never an allow', async () => {
    await tokenOf('other');
    hoisted.engine.down = true;
    hoisted.engine.only = 'agent.session_view_others';
    const res = await respond({ session_id: idOf('starters') });
    expect(res.statusCode).toBe(503);
    expect(json(res).error).toMatchObject({ code: 'authorization_unavailable' });
  });
});

describe('tracing: a thread of an agent is its session', () => {
  async function trace(conversation: keyof typeof sessions, sessionId: string) {
    await db.createAgentTracingSession({
      sessionId, threadId: idOf(conversation), tenantId, projectId: p1, agentName: 'support', status: 'success',
      startedAt: new Date(), endedAt: new Date(), totalEvents: 0,
    } as never);
  }

  it('the detail of somebody else\'s thread needs viewing their session; the owner\'s own is open', async () => {
    await trace('starters', 'trace-1');
    await deny('agent.session_view_others', 'other');
    expect((await dash('other', 'GET', `/tracing/threads/${idOf('starters')}`)).statusCode).toBe(403);
    expect((await dash('other', 'GET', '/tracing/sessions/trace-1')).statusCode).toBe(403);
    expect((await dash('other', 'GET', '/tracing/sessions/trace-1/events/e1')).statusCode).toBe(403);
    expect((await dash('padmin', 'GET', `/tracing/threads/${idOf('starters')}`)).statusCode).toBe(200);
    expect((await dash('starter', 'GET', `/tracing/threads/${idOf('starters')}`)).statusCode).toBe(200);
    // an id that is no agent session is not the permission\'s business
    expect((await dash('other', 'GET', '/tracing/threads/some-other-producer')).statusCode).toBe(404);
  });

  it('the lists leave out the threads and sessions of sessions the caller may not view', async () => {
    await trace('starters', 'trace-1');
    await trace('others', 'trace-2');
    await deny('agent.session_view_others', 'other');
    const threads = json(await dash('other', 'GET', '/tracing/threads')).threads as Array<{ threadId: string }>;
    expect(threads.map((t) => t.threadId)).toEqual([idOf('others')]);
    const traced = json(await dash('other', 'GET', '/tracing/sessions')).sessions as Array<{ sessionId: string }>;
    expect(traced.map((t) => t.sessionId)).toEqual(['trace-2']);
    expect(json(await dash('padmin', 'GET', '/tracing/threads')).threads).toHaveLength(2);
  });

  it('the client API reads threads the same way', async () => {
    await trace('starters', 'trace-1');
    await deny('agent.session_view_others', 'other');
    await tokenOf('other');
    expect((await viaToken('GET', `/client/v1/tracing/threads/${idOf('starters')}`)).statusCode).toBe(403);
  });
});

describe('the Document Store, for the files a session holds', () => {
  async function sessionFile(conversation: keyof typeof sessions, key: string, over: Record<string, unknown> = {}) {
    if (!(await db.findProviderByKey(tenantId, 'local', p1))) {
      await db.createProvider({ tenantId, projectId: p1, key: 'local', type: 'file', driver: 'local-filesystem', label: 'Local', status: 'active', credentialsEnc: encryptObject({}), settings: { basePath: tmpDir }, createdBy: 'x' });
      await db.createFileBucket({ tenantId, projectId: p1, key: 'docs', name: 'Docs', providerKey: 'local', status: 'active', createdBy: 'x' } as never);
    }
    await db.createFileRecord({
      tenantId, projectId: p1, providerKey: 'local', bucketKey: 'docs', key, name: key, size: 3, markdownStatus: 'none',
      purpose: 'conversation', conversationId: idOf(conversation), agentKey: 'support', createdBy: 'x', uploadedBy: 'x',
      ...over,
    } as never);
  }

  it('a file of somebody else\'s session is read and deleted as that session: refused to a caller a rule stops', async () => {
    await sessionFile('starters', 'agent-sessions/support/s1/notes.txt');
    await deny('agent.session_view_others', 'other');
    const read = await dash('other', 'GET', '/files/buckets/docs/objects/agent-sessions/support/s1/notes.txt');
    expect(read.statusCode).toBe(403);
    expect(json(read)).toMatchObject({ code: 'forbidden' });
    await deny('agent.session_manage_others', 'other');
    expect((await dash('other', 'DELETE', '/files/buckets/docs/objects/agent-sessions/support/s1/notes.txt')).statusCode).toBe(403);
    // a person the rules leave alone reads it
    expect((await dash('padmin', 'GET', '/files/buckets/docs/objects/agent-sessions/support/s1/notes.txt')).statusCode).toBe(200);
  });

  it('a preview is a read like the others: refused for somebody else\'s session before the object is touched, shown to whoever may view it', async () => {
    await sessionFile('starters', 'agent-sessions/support/s1/p.txt', { contentType: 'text/plain', size: 5 });
    // The object itself, where the local disk provider keeps it: <base>/<tenant>/<provider>/<bucket prefix>/<key>.
    const stored = path.join(tmpDir, tenantId, 'local', 'docs', 'agent-sessions', 'support', 's1', 'p.txt');
    mkdirSync(path.dirname(stored), { recursive: true });
    writeFileSync(stored, 'hello');
    await deny('agent.session_view_others', 'other');
    const url = '/files/buckets/docs/objects/agent-sessions/support/s1/p.txt';

    for (const query of ['preview=1', 'preview=1&variant=markdown', 'preview=true', 'download=1', 'download=markdown']) {
      const refused = await dash('other', 'GET', `${url}?${query}`);
      expect(refused.statusCode, query).toBe(403);
      expect(json(refused), query).toMatchObject({ code: 'forbidden' });
      // Nothing of the file leaks into the refusal.
      expect(refused.body, query).not.toContain('hello');
    }

    for (const who of ['padmin', 'starter'] as const) {
      const shown = await dash(who, 'GET', `${url}?preview=1`);
      expect(shown.statusCode, who).toBe(200);
      expect(shown.body, who).toBe('hello');
      expect(shown.headers['content-type'], who).toBe('text/plain; charset=utf-8');
      expect(String(shown.headers['content-disposition']), who).toMatch(/^inline;/);
      expect(shown.headers['x-content-type-options'], who).toBe('nosniff');
      expect(shown.headers['content-security-policy'], who).toBe('sandbox');
    }
  });

  it('a listing leaves out the files of sessions the caller may not view, and shows ordinary files to everybody', async () => {
    await sessionFile('starters', 'agent-sessions/support/s1/a.txt');
    await sessionFile('others', 'agent-sessions/support/s2/b.txt');
    await db.createFileRecord({
      tenantId, projectId: p1, providerKey: 'local', bucketKey: 'docs', key: 'plain.txt', name: 'plain.txt', size: 3, markdownStatus: 'none', createdBy: 'x',
    } as never);
    await deny('agent.session_view_others', 'other');
    const listed = await dash('other', 'GET', '/files/buckets/docs/objects');
    expect(listed.statusCode).toBe(200);
    expect((json(listed).items as Array<{ key: string }>).map((i) => i.key).sort()).toEqual(['agent-sessions/support/s2/b.txt', 'plain.txt']);
    expect((json(await dash('padmin', 'GET', '/files/buckets/docs/objects')).items as unknown[])).toHaveLength(3);
  });

  it('the client Files API asks the same question for the file record', async () => {
    await sessionFile('starters', 'agent-sessions/support/s1/c.txt');
    await deny('agent.session_view_others', 'other');
    await tokenOf('other');
    const res = await viaToken('GET', `/client/v1/files/buckets/docs/objects/${encodeURIComponent('agent-sessions/support/s1/c.txt')}`);
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toMatchObject({ code: 'session_forbidden' });
    const download = await viaToken('GET', `/client/v1/files/buckets/docs/objects/${encodeURIComponent('agent-sessions/support/s1/c.txt')}/download`);
    expect(download.statusCode).toBe(403);
    expect((await viaToken('DELETE', `/client/v1/files/buckets/docs/objects/${encodeURIComponent('agent-sessions/support/s1/c.txt')}`)).statusCode).toBe(200); // deleting is acting: a separate action this rule does not touch
    const list = await viaToken('GET', '/client/v1/files/buckets/docs/objects');
    expect(list.statusCode).toBe(200);
  });

  describe('an upload through the client Files API under the key of a session file', () => {
    const KEY = 'agent-sessions/support/s1/c.txt';
    const SESSION_BYTES = 'what the session wrote';
    const objectOf = (key: string) => path.join(tmpDir, tenantId, 'local', 'docs', ...key.split('/'));
    const upload = (keyHint: string, content = 'bytes of the caller') => viaToken('POST', '/client/v1/files/buckets/docs/objects', {
      fileName: 'upload.txt', contentType: 'text/plain', data: Buffer.from(content).toString('base64'), keyHint,
    });
    const recordsUnder = async (key: string) => {
      await db.switchToTenant(dbName);
      return db.listFileRecordsByKeys({ providerKey: 'local', bucketKey: 'docs', projectId: p1, keys: [key] });
    };

    beforeEach(async () => {
      // The file of the session of `starter`, with the object it holds.
      await sessionFile('starters', KEY, { size: SESSION_BYTES.length, contentType: 'text/plain' });
      mkdirSync(path.dirname(objectOf(KEY)), { recursive: true });
      writeFileSync(objectOf(KEY), SESSION_BYTES);
    });

    it('is refused to a token whose owner a rule stops from changing that session: the object and its record stay as the session left them', async () => {
      await deny('agent.session_manage_others', 'other');
      await tokenOf('other');

      const refused = await upload(KEY);
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error).toMatchObject({ code: 'session_forbidden' });
      expect(readFileSync(objectOf(KEY), 'utf8')).toBe(SESSION_BYTES);
      const records = await recordsUnder(KEY);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ purpose: 'conversation', conversationId: idOf('starters'), size: SESSION_BYTES.length });
    });

    it.each([
      ['a doubled slash', 'agent-sessions//support/s1/c.txt'],
      ['backslashes', 'agent-sessions\\support\\s1\\c.txt'],
      ['a leading slash', '/agent-sessions/support/s1/c.txt'],
      ['spaces around it', `  ${KEY}  `],
    ])('is refused when the key is spelled with %s: the key looked up is the key the object lands on', async (_label, spelled) => {
      await deny('agent.session_manage_others', 'other');
      await tokenOf('other');

      const refused = await upload(spelled);
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error).toMatchObject({ code: 'session_forbidden' });
      expect(readFileSync(objectOf(KEY), 'utf8')).toBe(SESSION_BYTES);
      expect(await recordsUnder(KEY)).toHaveLength(1);
    });

    it('is allowed to the owner of the session, whatever a rule says about other people\'s sessions, and replaces the file', async () => {
      await deny('agent.session_manage_others', 'starter');
      await tokenOf('starter');

      const written = await upload(KEY, 'the owner writes again');
      expect(written.statusCode).toBe(201);
      expect(readFileSync(objectOf(KEY), 'utf8')).toBe('the owner writes again');
      expect(await recordsUnder(KEY)).toHaveLength(1);
    });

    it('is allowed to a token whose owner may change every session, while somebody a rule stops is refused', async () => {
      await deny('agent.session_manage_others', 'other');

      await tokenOf('other');
      expect((await upload(KEY, 'refused')).statusCode).toBe(403);
      expect(readFileSync(objectOf(KEY), 'utf8')).toBe(SESSION_BYTES);

      await tokenOf('padmin');
      const written = await upload(KEY, 'a teammate\'s edit');
      expect(written.statusCode).toBe(201);
      expect(readFileSync(objectOf(KEY), 'utf8')).toBe('a teammate\'s edit');
    });

    it('is not the session\'s business under a key that holds no session file', async () => {
      await deny('agent.session_manage_others', 'other');
      await tokenOf('other');

      const written = await upload('plain.txt');
      expect(written.statusCode).toBe(201);
      expect(readFileSync(objectOf('plain.txt'), 'utf8')).toBe('bytes of the caller');
      expect(readFileSync(objectOf(KEY), 'utf8')).toBe(SESSION_BYTES);
    });
  });
});
