/**
 * The request gates, with the REAL gates (enforceSessionRbac / enforceApiTokenRbac and
 * the handler-level checks), a real SQLite database and the real engine. Every request
 * of every workspace is decided by the policy engine from the first one:
 *
 *   - undeclared routes are refused (route_not_declared), declared kinds are honoured,
 *   - API tokens include the owner's group grants and the token scope still caps,
 *   - project-level service permissions narrow (explicit settings only; an explicit
 *     `none` that predates the workspace's first decision is read as "not set"),
 *   - when the engine cannot decide, the request is refused with a 503 - never allowed,
 *     never decided by some other rule - and the refusal is counted and audited,
 *   - the owner's own signed-in session can always reach the Authorization center,
 *   - project access through groups,
 *   - a 403 names its reason in `error`, in every error dialect.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
  gate: null as null | ((...args: unknown[]) => unknown),
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

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: async (header: string | null) => {
      const ctx = hoisted.tokens.get(String(header).replace(/^Bearer /, ''));
      if (!ctx) throw new ApiTokenAuthError('Invalid API token', 401);
      return ctx;
    },
  };
});

// The exporter reads every module of the tenant; this suite only cares who may call it.
vi.mock('@/lib/services/metrics/prometheusExporter', () => ({
  collectPrometheusMetrics: async () => '# metrics\n',
}));

// The overview numbers, recognisable on purpose (a new object per call: the handler blanks sections in place).
vi.mock('@/lib/services/dashboard/dashboardService', () => ({
  getDashboardData: async () => ({
    stats: {
      models: { total: 3, llm: 2, embedding: 1 },
      vectors: { providers: 1, indexes: 4 },
      tracing: { totalSessions: 9, totalTokens: 90, activeSessions: 1 },
      apiCalls: { total: 9, trend: 5 },
    },
    recentActivity: [{ id: 'a' }],
    recentSessions: [{ sessionId: 's' }],
    daily: [{ date: 'd' }],
  }),
}));

// The engine is real, except that a test can make authorizeGate misbehave.
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    authorizeGate: (...args: Parameters<typeof actual.authorizeGate>) =>
      hoisted.gate ? hoisted.gate(...args) : actual.authorizeGate(...args),
  };
});

import type { FastifyInstance } from 'fastify';
import type { IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { getEnforceStats, resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { authz } from '@/lib/iam/routeAuthz';
import { enqueueAuditLog, stampDecisionHeader } from '@/server/api/plugin';
import { createPolicy, deletePolicy } from '@/lib/iam/store';
import { reloadConfig } from '@/lib/core/config';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { metricsApiPlugin } from '@/server/api/plugins/metrics';
import { dashboardApiPlugin } from '@/server/api/plugins/dashboard';
import {
  authorizeServiceForRequest,
  requireProjectContextForRequest,
  sendProjectContextError,
  withAnthropicApiRequestContext,
  withApiRequestContext,
  withClientApiRequestContext,
  withOpenAiApiRequestContext,
} from '@/server/api/fastify-utils';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let env: IamTestDb;
let app: FastifyInstance;
const users: Record<string, IUser> = {};
let projectId: string;
let otherProjectId: string;

const sessionHeaders = (user: IUser) => ({
  'x-tenant-db-name': env.tenantDbName,
  'x-tenant-id': env.tenantId,
  'x-tenant-slug': 'iam-co',
  'x-user-id': String(user._id),
  'x-user-role': String(user.role),
  'x-user-email': String(user.email),
  'x-license-type': 'FREE',
});

const mkUser = async (name: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
  const user = (await env.db.createUser({
    tenantId: env.tenantId, email: `${name}@x.io`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
  })) as IUser;
  users[name] = user;
  return user;
};

const tokenCtx = (user: IUser, scope: Record<string, string> | null | undefined, tokenId: string, tokenProject?: string) => ({
  token: tokenId,
  tokenRecord: { _id: tokenId, userId: String(user._id), servicePermissions: scope, projectId: tokenProject },
  tenant: { licenseType: 'FREE' },
  tenantId: env.tenantId,
  tenantSlug: 'iam-co',
  tenantDbName: env.tenantDbName,
  projectId: tokenProject ?? 'default',
  user,
});

/** What the engine answers when it cannot decide (the shape authorizeGate returns on a failed evaluation). */
const failedEvaluation = (message: string) => async () => ({
  allowed: false, reasons: [], errors: [message], obligations: {}, durationUs: 1, failed: true,
});

beforeAll(async () => {
  env = await createIamTestDb('tenant_iam_enforce');
  hoisted.getDatabase.mockImplementation(async () => env.db);

  await mkUser('owner', 'owner');
  await mkUser('admin', 'admin');
  await mkUser('plain', 'user');
  await mkUser('reader', 'user', { servicePermissions: { agents: 'read', ldap: 'read' } });
  await mkUser('blocked', 'user', { servicePermissions: { agents: 'none' } });
  await mkUser('member', 'user');
  await mkUser('gonly', 'user');
  await mkUser('solo', 'user');
  await mkUser('dashy', 'user');
  await mkUser('olddash', 'user');
  const project = await env.db.createProject({ tenantId: env.tenantId, key: 'pj', name: 'PJ', createdBy: 'x' });
  projectId = String(project._id);
  const other = await env.db.createProject({ tenantId: env.tenantId, key: 'pj2', name: 'PJ2', createdBy: 'x' });
  otherProjectId = String(other._id);
  // member: agents read in pj; nothing explicit for prompts; also a member of pj2 with no overrides
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.member._id), projectId, role: 'member', servicePermissions: { agents: 'read' } });
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.member._id), projectId: otherProjectId, role: 'member' });
  // solo: a member of pj only (agents read there)
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.solo._id), projectId, role: 'member', servicePermissions: { agents: 'read' } });
  // blocked: agents:none at tenant level, raised to write by a group (sessions and tokens both see it)
  const raisers = await env.db.createGroup({ tenantId: env.tenantId, name: 'raisers', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
  await env.db.addGroupMember({ groupId: String(raisers._id), userId: String(users.blocked._id), tenantId: env.tenantId, role: 'member' });
  // gonly: no direct project, reaches pj only through a group (agents read there)
  const team = await env.db.createGroup({ tenantId: env.tenantId, name: 'team', createdBy: 't', source: 'local' } as never);
  await env.db.addGroupMember({ groupId: String(team._id), userId: String(users.gonly._id), tenantId: env.tenantId, role: 'member' });
  await env.db.upsertGroupProject({ tenantId: env.tenantId, groupId: String(team._id), projectId, role: 'member', servicePermissions: { agents: 'read' } });
  // olddash: models and tracing are explicitly none in pj, saved BEFORE the workspace's first decision
  // (the first request below), so those entries are read as "not set"
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.olddash._id), projectId, role: 'member', servicePermissions: { models: 'none', tracing: 'none' } });

  hoisted.tokens.set('tok-blocked', tokenCtx(users.blocked, null, 'tok-blocked'));
  hoisted.tokens.set('tok-scoped', tokenCtx(users.blocked, { agents: 'read' }, 'tok-scoped'));
  hoisted.tokens.set('tok-member-proj', tokenCtx(users.member, null, 'tok-member-proj', projectId));
  hoisted.tokens.set('tok-admin-empty', tokenCtx(users.admin, {}, 'tok-admin-empty'));
  hoisted.tokens.set('tok-plain', tokenCtx(users.plain, null, 'tok-plain'));
  hoisted.tokens.set('tok-owner', tokenCtx(users.owner, null, 'tok-owner'));
  // a token whose project is one its owner does not belong to (removed from it)
  const foreign = await env.db.createProject({ tenantId: env.tenantId, key: 'pj3', name: 'PJ3', createdBy: 'x' });
  hoisted.tokens.set('tok-member-foreign', tokenCtx(users.member, null, 'tok-member-foreign', String(foreign._id)));

  app = await createFastifyApiTestApp(async (instance) => {
    // the audit trail writer, as in the real API plugin
    instance.addHook('onSend', async (request, reply, payload) => { stampDecisionHeader(request, reply); return payload; });
    instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
    const ok = withApiRequestContext(async (_req, reply) => reply.send({ ok: true }));
    // mapped through ROUTE_PREFIXES
    instance.get('/agents/probe', ok);
    instance.post('/agents/probe', ok);
    instance.post('/prompts/probe', ok);
    instance.get('/providers/probe', ok);
    // declared
    instance.get('/declared/service', { config: authz.service('ldap') }, ok);
    instance.post('/declared/service', { config: authz.service('ldap') }, ok);
    instance.get('/declared/level', { config: authz.service('agents', 'admin') }, ok);
    instance.get('/declared/authenticated', { config: authz.authenticated() }, ok);
    instance.get('/declared/public', { config: authz.public() }, ok);
    instance.get('/declared/self', { config: authz.self('verifies a shared secret itself') }, ok);
    // undeclared (neither declared nor mapped)
    instance.get('/undeclared/thing', ok);
    // the project the handlers will run in
    instance.get('/ctx/project', { config: authz.authenticated() }, withApiRequestContext(async (request, reply) => {
      try {
        const ctx = await requireProjectContextForRequest(request);
        return reply.send({ projectId: ctx.projectId, role: ctx.userProject?.role ?? null, permissions: ctx.userProject?.servicePermissions ?? null });
      } catch (error) {
        return sendProjectContextError(reply, error) ?? reply.code(500).send({ error: String(error) });
      }
    }));
    // a handler that makes its own, second service decision (reports, realtime, mcp ...)
    const handlerCheck = async (request: any, reply: any) => {
      const decision = await authorizeServiceForRequest(request, 'agents', { level: 'write' });
      return reply.send({ allowed: decision.allowed, decisionId: decision.decisionId ?? null });
    };
    instance.get('/handler/check', { config: authz.authenticated() }, withApiRequestContext(handlerCheck));
    // the same decision turned into a 403 by the handler
    instance.get('/handler/refuse', { config: authz.authenticated() }, withApiRequestContext(async (request, reply) => {
      const decision = await authorizeServiceForRequest(request, 'agents', { level: 'write' });
      return decision.allowed ? reply.send({ ok: true }) : reply.code(403).send({ error: 'Forbidden' });
    }));
    // a handler with a blanket catch that ends in sendProjectContextError, which answers a thrown refusal as the gate would
    instance.get('/handler/catch-all', { config: authz.authenticated() }, withApiRequestContext(async (request, reply) => {
      try {
        const decision = await authorizeServiceForRequest(request, 'agents', { level: 'write' });
        return reply.send({ allowed: decision.allowed });
      } catch (error) {
        return sendProjectContextError(reply, error) ?? reply.code(500).send({ error: String(error) });
      }
    }));
    instance.get('/client/v1/handler/check', { config: authz.authenticated() }, withClientApiRequestContext(async (request, reply) => handlerCheck(request, reply)));
    // token (client) routes
    instance.get('/client/v1/agents/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.post('/client/v1/agents/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    // the same service-mapped route in the OpenAI / Anthropic error dialects
    instance.post('/client/v1/agents/openai-probe', withOpenAiApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.post('/client/v1/agents/anthropic-probe', withAnthropicApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.get('/client/v1/declared/authenticated', { config: authz.authenticated() }, withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.get('/client/v1/undeclared/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    // the Authorization center's own service, reached by a token
    instance.get('/client/v1/declared/iam', { config: authz.service('iam') }, withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    await instance.register(dashboardApiPlugin);
    await instance.register(iamApiPlugin);
    await instance.register(authApiPlugin);
    await instance.register(metricsApiPlugin);
  });
  await app.ready();
  // The rows above must be strictly older than the workspace's first decision (the first request of the
  // first test): see "an explicit none saved before the first decision".
  await new Promise((resolve) => setTimeout(resolve, 15));
});

afterAll(async () => {
  hoisted.gate = null;
  await app?.close();
  await env?.cleanup();
});

/** Everything a test may have left behind: the failure hook, the engine and its caches, the counters. */
function resetState() {
  hoisted.gate = null;
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
}

beforeEach(resetState);

const safeParse = (s: string) => { try { return parseJsonBody<any>(s); } catch { return s; } };

const call = async (method: string, url: string, user: IUser | null, opts: { token?: string; body?: unknown; cookie?: string } = {}) => {
  const headers: Record<string, string> = user ? sessionHeaders(user) : {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.inject({
    method: method as never,
    url,
    headers,
    payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.statusCode, body: res.body ? safeParse(res.body) : null, headers: res.headers };
};

const inProject = (id = projectId) => ({ cookie: `active_project_id=${id}` });

describe('declarations', () => {
  it('refuses an undeclared route with 403 route_not_declared (session and token), and counts it', async () => {
    // `error` carries the reason itself (what SDKs and the dashboard surface), `message` repeats it
    const reason = 'Forbidden: this route has no authorization declaration';
    const session = await call('GET', '/api/undeclared/thing', users.admin);
    expect(session.status).toBe(403);
    expect(session.body).toEqual({ error: reason, code: 'route_not_declared', message: reason });
    const token = await call('GET', '/api/client/v1/undeclared/probe', null, { token: 'tok-plain' });
    expect(token.status).toBe(403);
    expect(token.body).toEqual({ error: reason, code: 'route_not_declared', message: reason });
    expect(getEnforceStats().undeclaredDenies).toBe(2);
  });

  it('honours the declarations: authenticated admits any signed-in principal, public/self skip the gate', async () => {
    for (const kind of ['authenticated', 'public', 'self']) {
      expect((await call('GET', `/api/declared/${kind}`, users.blocked)).status).toBe(200);
    }
    expect((await call('GET', '/api/client/v1/declared/authenticated', null, { token: 'tok-scoped' })).status).toBe(200);
    expect((await call('GET', '/api/client/v1/declared/authenticated', null, { token: 'tok-bogus' })).status).toBe(401);
  });
});

describe('a service is decided by the engine', () => {
  it('a service declaration is decided with the documented denial body', async () => {
    expect((await call('GET', '/api/declared/service', users.reader)).status).toBe(200);
    const denied = await call('POST', '/api/declared/service', users.reader);
    expect(denied.status).toBe(403);
    // `error` is the human-readable reason; the structured fields ride next to it
    expect(denied.body).toEqual({
      error: 'Forbidden: ldap requires admin permission',
      code: 'forbidden',
      message: 'Forbidden: ldap requires admin permission',
      service: 'ldap',
      required: 'admin',
      decisionId: denied.body.decisionId,
    });
    expect(typeof denied.body.decisionId).toBe('string');
    expect(denied.body.decisionId.length).toBeGreaterThan(8);
    expect(denied.headers['x-decision-id']).toBe(denied.body.decisionId);
    // every denial gets its own id
    const again = await call('POST', '/api/declared/service', users.reader);
    expect(again.body.decisionId).not.toBe(denied.body.decisionId);
    expect((await call('POST', '/api/declared/service', users.admin)).status).toBe(200);
    // the level override
    expect((await call('GET', '/api/declared/level', users.plain)).body).toMatchObject({ code: 'forbidden', service: 'agents', required: 'admin' });
    expect((await call('GET', '/api/declared/level', users.admin)).status).toBe(200);
  });

  it('prefix-mapped routes follow the role arithmetic for users without groups or projects', async () => {
    expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
    expect((await call('POST', '/api/agents/probe', users.reader)).status).toBe(403);
    expect((await call('GET', '/api/agents/probe', users.reader)).status).toBe(200);
    expect((await call('GET', '/api/providers/probe', users.plain)).status).toBe(403);
    expect((await call('GET', '/api/providers/probe', users.admin)).status).toBe(200);
    expect(getEnforceStats()).toMatchObject({ engineDecisions: 5, unavailable: 0 });
  });

  it('a real engine deny is not an outage', async () => {
    expect((await call('POST', '/api/agents/probe', users.reader)).status).toBe(403);
    expect(getEnforceStats()).toMatchObject({ unavailable: 0, engineDenies: 1 });
  });
});

describe('API tokens include the owner\'s group grants; the scope stays a cap', () => {
  it('an unscoped token of a user whose group raises him gets the group\'s level', async () => {
    expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' })).status).toBe(200);
  });

  it('a scoped token is still capped after the group grants', async () => {
    expect((await call('GET', '/api/client/v1/agents/probe', null, { token: 'tok-scoped' })).status).toBe(200);
    const denied = await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-scoped' });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'forbidden', service: 'agents', required: 'write' });
  });

  it('an empty scope denies everything mapped, whatever the owner holds', async () => {
    expect((await call('GET', '/api/client/v1/agents/probe', null, { token: 'tok-admin-empty' })).status).toBe(403);
  });
});

describe('project-level service permissions narrow (explicit settings only)', () => {
  it('a session in a project with agents:read cannot write there, but can read', async () => {
    const denied = await call('POST', '/api/agents/probe', users.member, inProject());
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'forbidden', service: 'agents', required: 'write' });
    expect((await call('GET', '/api/agents/probe', users.member, inProject())).status).toBe(200);
  });

  it('a service the project says nothing about keeps its tenant-level answer', async () => {
    expect((await call('POST', '/api/prompts/probe', users.member, inProject())).status).toBe(200);
  });

  it('the same user in a project without overrides is not narrowed', async () => {
    expect((await call('POST', '/api/agents/probe', users.member, inProject(otherProjectId))).status).toBe(200);
  });

  it('the project is the one the handler runs in: no cookie or a forged cookie cannot dodge the narrowing', async () => {
    // solo's only project is pj (agents:read); that is where every handler lands
    for (const cookie of [undefined, inProject('64b7f0c2a1b2c3d4e5f60718'), inProject('x;DROP'), inProject(otherProjectId)]) {
      expect((await call('GET', '/api/ctx/project', users.solo, cookie ? { cookie: cookie.cookie } : {})).body.projectId).toBe(projectId);
      expect((await call('POST', '/api/agents/probe', users.solo, cookie ? { cookie: cookie.cookie } : {})).status).toBe(403);
    }
  });

  it('a token narrows by its project', async () => {
    expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-member-proj' })).status).toBe(403);
    expect((await call('GET', '/api/client/v1/agents/probe', null, { token: 'tok-member-proj' })).status).toBe(200);
  });

  it('owners and admins are never narrowed', async () => {
    await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.admin._id), projectId, role: 'member', servicePermissions: { agents: 'none' } });
    expect((await call('POST', '/api/agents/probe', users.admin, inProject())).status).toBe(200);
    expect((await call('POST', '/api/agents/probe', users.owner, inProject())).status).toBe(200);
  });

  it('a project reached through a group narrows too', async () => {
    expect((await call('POST', '/api/agents/probe', users.gonly, inProject())).status).toBe(403);
    expect((await call('GET', '/api/agents/probe', users.gonly, inProject())).status).toBe(200);
  });

  it('a token whose project its owner no longer belongs to is not narrowed by some other project', async () => {
    // member is narrowed to agents:read in pj and has no rights in pj3 (the token's project).
    // The session-style fallback would have borrowed pj's settings (member[0]) and refused the write.
    expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-member-foreign' })).status).toBe(200);
    expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-member-proj' })).status).toBe(403);
  });

  it('an explicit none saved before the first decision of the workspace is read as "not set"; one saved after it is honoured', async () => {
    // olddash's row (models + tracing none) was saved in beforeAll: nothing is hidden for it ...
    const before = (await call('GET', '/api/dashboard', users.olddash, inProject())).body;
    expect(before.stats.models.total).toBe(3);
    expect(before.stats.tracing.totalSessions).toBe(9);
    // ... a row saved after the first decision counts in full
    await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.dashy._id), projectId, role: 'member', servicePermissions: { models: 'none', tracing: 'none' } });
    resetPrincipalCacheForTests();
    const after = (await call('GET', '/api/dashboard', users.dashy, inProject())).body;
    expect(after.stats.models).toEqual({ total: 0, llm: 0, embedding: 0 });
    expect(after.stats.tracing).toEqual({ totalSessions: 0, totalTokens: 0, activeSessions: 0 });
  });
});

describe('project access through groups', () => {
  it('a user who reaches a project only through a group gets that project, with its settings', async () => {
    const res = await call('GET', '/api/ctx/project', users.gonly);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId, role: 'member', permissions: { agents: 'read' } });
    // ... and the session endpoint counts group-assigned projects
    expect((await call('GET', '/api/auth/session', users.gonly)).body).toMatchObject({ authenticated: true, projectCount: 1 });
  });
});

describe('when the engine cannot decide: refused with 503, never allowed', () => {
  const unavailable = (res: { body: any }) => ({
    error: 'Authorization is temporarily unavailable',
    code: 'authorization_unavailable',
    decisionId: res.body.decisionId,
  });

  it('a failing engine refuses session and token requests with the documented 503', async () => {
    hoisted.gate = failedEvaluation('wasm unavailable');
    // the role arithmetic would have allowed the plain user's write and token: they are refused anyway
    const session = await call('POST', '/api/agents/probe', users.plain);
    expect(session.status).toBe(503);
    expect(session.body).toEqual(unavailable(session));
    expect(typeof session.body.decisionId).toBe('string');
    expect(session.headers['retry-after']).toBe('5');
    expect(session.headers['x-decision-id']).toBe(session.body.decisionId);
    const token = await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-plain' });
    expect(token.status).toBe(503);
    expect(token.body).toEqual(unavailable(token));
    // a request that would have been denied is an outage as well (no half answers), each with its own id
    const reader = await call('POST', '/api/agents/probe', users.reader);
    expect(reader.status).toBe(503);
    expect(new Set([session.body.decisionId, token.body.decisionId, reader.body.decisionId]).size).toBe(3);

    const stats = getEnforceStats();
    expect(stats).toMatchObject({ unavailable: 3, engineAllows: 0, engineDenies: 0, lastUnavailableReason: 'engine_unavailable' });
    // only a coarse category is kept; the detail goes to the server log
    expect(JSON.stringify(stats)).not.toContain('wasm unavailable');
    const api = await call('GET', '/api/iam/engine/stats', users.owner);
    expect(api.status).toBe(200);
    expect(JSON.stringify(api.body)).not.toContain('wasm unavailable');
    expect(api.body.enforce).toMatchObject({ unavailable: 3, lastUnavailableReason: 'engine_unavailable' });
    expect(api.body.health.status).toBe('degraded');
  });

  it('an exception inside the engine path is the same refusal', async () => {
    hoisted.gate = async () => { throw new Error('boom'); };
    const res = await call('GET', '/api/agents/probe', users.plain);
    expect(res.status).toBe(503);
    expect(res.body).toEqual(unavailable(res));
    expect(JSON.stringify(res.body)).not.toContain('boom');
    expect(getEnforceStats()).toMatchObject({ unavailable: 1, lastUnavailableReason: 'evaluation_error' });
  });

  it('a caller that cannot be built is refused as well, with the principal as the reason', async () => {
    const spy = vi.spyOn(env.db, 'listGroupMembersByUser').mockRejectedValueOnce(new Error('connection reset by peer'));
    try {
      const res = await call('GET', '/api/agents/probe', users.plain);
      expect(res.status).toBe(503);
      expect(res.body).toEqual(unavailable(res));
      expect(JSON.stringify(res.body)).not.toContain('connection reset');
      expect(getEnforceStats()).toMatchObject({ unavailable: 1, lastUnavailableReason: 'principal_unavailable' });
    } finally {
      spy.mockRestore();
    }
    // and it recovers on its own: the failure was not cached
    expect((await call('GET', '/api/agents/probe', users.plain)).status).toBe(200);
  });

  it('the token routes keep the dialect of their error style (OpenAI, Anthropic, plain JSON)', async () => {
    hoisted.gate = failedEvaluation('engine down');
    const openai = await call('POST', '/api/client/v1/agents/openai-probe', null, { token: 'tok-plain' });
    const anthropic = await call('POST', '/api/client/v1/agents/anthropic-probe', null, { token: 'tok-plain' });
    const plain = await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-plain' });
    for (const res of [openai, anthropic, plain]) {
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
    }
    // a server error the SDKs retry, not a permission error
    expect(openai.body).toEqual({
      error: { message: 'Authorization is temporarily unavailable', type: 'server_error', code: 'authorization_unavailable', decision_id: expect.any(String) },
    });
    expect(anthropic.body).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'Authorization is temporarily unavailable', decision_id: expect.any(String) },
    });
    expect(plain.body).toEqual({ error: 'Authorization is temporarily unavailable', code: 'authorization_unavailable', decisionId: expect.any(String) });
    expect(openai.headers['x-decision-id']).toBe(openai.body.error.decision_id);
    expect(anthropic.headers['x-decision-id']).toBe(anthropic.body.error.decision_id);
  });

  it('a handler-level check throws the 503 instead of reading an outage as an answer', async () => {
    hoisted.gate = failedEvaluation('engine down');
    // withApiRequestContext maps the refusal a handler throws ...
    const session = await call('GET', '/api/handler/check', users.plain);
    expect(session.status).toBe(503);
    expect(session.body).toEqual(unavailable(session));
    expect(session.headers['retry-after']).toBe('5');
    // ... so does a handler whose own catch hands the error to sendProjectContextError ...
    const caught = await call('GET', '/api/handler/catch-all', users.plain);
    expect(caught.status).toBe(503);
    expect(caught.body).toEqual(unavailable(caught));
    // ... and withClientApiRequestContext
    const token = await call('GET', '/api/client/v1/handler/check', null, { token: 'tok-plain' });
    expect(token.status).toBe(503);
    expect(token.body).toEqual(unavailable(token));
    // a handler that tests `.allowed` and answers 403 itself is never reached
    expect((await call('GET', '/api/handler/refuse', users.plain)).status).toBe(503);
  });

  it('an outage is counted, audited as a denial (also for a GET) and resolves through the decision lookup', async () => {
    hoisted.gate = failedEvaluation('engine down');
    const res = await call('GET', '/api/agents/probe', users.plain);
    expect(res.status).toBe(503);
    hoisted.gate = null;

    let row: any;
    for (let i = 0; i < 80 && !row; i++) {
      const rows = await env.db.listAuditLogs({ service: 'agents', outcome: 'denied' } as never);
      row = rows.find((r: any) => r.metadata?.decisionId === res.body.decisionId);
      if (!row) await new Promise((r) => setTimeout(r, 25));
    }
    expect(row, 'the audit row carries the decision id the caller was shown').toBeDefined();
    expect(row).toMatchObject({ outcome: 'denied', statusCode: 503, method: 'GET' });
    expect(row.metadata).toMatchObject({ iamEnforce: true, code: 'authorization_unavailable', deniedService: 'agents', required: 'read' });

    // the owner (always allowed in the Authorization center) finds it in the Denials feed ...
    const feed = await call('GET', '/api/iam/audit?kind=denials', users.owner);
    expect(feed.status).toBe(200);
    const item = feed.body.items.find((i: any) => i.decisionId === res.body.decisionId);
    expect(item).toMatchObject({ kind: 'denials', code: 'authorization_unavailable', service: 'agents', method: 'GET', route: '/api/agents/probe' });
    // ... and the id resolves to the same event, which is not replayable (nobody was refused on merit)
    const decision = await call('GET', `/api/iam/decisions/${res.body.decisionId}`, users.owner);
    expect(decision.status).toBe(200);
    expect(decision.body).toMatchObject({ decisionId: res.body.decisionId, code: 'authorization_unavailable', service: 'agents', method: 'GET', simulateInput: null });
  });
});

describe('owner safety: the owner\'s own session can always reach the Authorization center', () => {
  it('a policy that denies everything on iam locks out an admin, not the owner - also while the engine is down', async () => {
    await createPolicy(env.tenantDbName, {
      policyId: 'lock-iam',
      name: 'lock iam',
      cedar: 'forbid(principal, action, resource) when { resource.service == "iam" };',
    }, 'test');
    try {
      const locked = await call('GET', '/api/iam/engine/stats', users.admin);
      expect(locked.status).toBe(403);
      expect(locked.body).toMatchObject({ code: 'forbidden', service: 'iam' });
      expect((await call('GET', '/api/iam/engine/stats', users.owner)).status).toBe(200);

      // an outage does not take the owner's access away; everybody else is refused with 503
      hoisted.gate = async () => { throw new Error('engine down'); };
      expect((await call('GET', '/api/iam/engine/stats', users.owner)).status).toBe(200);
      expect((await call('GET', '/api/iam/engine/stats', users.admin)).status).toBe(503);
      hoisted.gate = null;
      expect(getEnforceStats().ownerSafety).toBeGreaterThan(0);

      // the owner repairs it: deleting the policy through the API reopens the center for the admin
      const policies = await call('GET', '/api/iam/policies', users.owner);
      const policy = policies.body.custom.find((p: any) => p.name === 'lock iam');
      expect((await call('DELETE', `/api/iam/policies/${policy.policyId}`, users.owner)).status).toBe(204);
      expect((await call('GET', '/api/iam/engine/stats', users.admin)).status).toBe(200);
    } finally {
      await deletePolicy(env.tenantDbName, 'lock-iam').catch(() => undefined);
    }
  });

  it('is a promise about the owner\'s SESSION on the iam service only', async () => {
    await createPolicy(env.tenantDbName, {
      policyId: 'no-agents',
      name: 'no agents',
      cedar: 'forbid(principal, action, resource) when { resource.service == "agents" };',
    }, 'test');
    await createPolicy(env.tenantDbName, {
      policyId: 'lock-iam-2',
      name: 'lock iam again',
      cedar: 'forbid(principal, action, resource) when { resource.service == "iam" };',
    }, 'test');
    try {
      // other services are decided for the owner like for anybody ...
      expect((await call('POST', '/api/agents/probe', users.owner)).status).toBe(403);
      // ... and so is a token that happens to belong to the owner
      const token = await call('GET', '/api/client/v1/declared/iam', null, { token: 'tok-owner' });
      expect(token.status).toBe(403);
      expect(token.body).toMatchObject({ code: 'forbidden', service: 'iam' });
      // while the owner's session still reaches iam
      expect((await call('GET', '/api/iam/engine/stats', users.owner)).status).toBe(200);
      // an outage refuses both, the session on any other service and the owner's token
      hoisted.gate = async () => { throw new Error('engine down'); };
      expect((await call('GET', '/api/agents/probe', users.owner)).status).toBe(503);
      expect((await call('GET', '/api/client/v1/declared/iam', null, { token: 'tok-owner' })).status).toBe(503);
    } finally {
      hoisted.gate = null;
      await deletePolicy(env.tenantDbName, 'no-agents');
      await deletePolicy(env.tenantDbName, 'lock-iam-2');
    }
  });
});

describe('engine stats, and the retired workspace modes', () => {
  it('the mode and shadow endpoints do not exist any more', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/iam/mode'], ['PUT', '/api/iam/mode', { mode: 'enforce' }],
      ['GET', '/api/iam/shadow/summary'], ['GET', '/api/iam/shadow/entries'], ['POST', '/api/iam/shadow/reset'],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(method, url, users.owner, { body })).status, `${method} ${url}`).toBe(404);
    }
  });

  it('the operator switches of the old modes are not read any more: nothing turns the engine off', async () => {
    const names = ['IAM_ENFORCE_DISABLED', 'IAM_SHADOW_DISABLED'] as const;
    const saved = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = '1';
    try {
      expect((await call('GET', '/api/undeclared/thing', users.plain)).status).toBe(403);
      expect((await call('POST', '/api/agents/probe', users.reader)).status).toBe(403);
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-scoped' })).status).toBe(403);
      expect((await call('GET', '/api/metrics', null, { token: 'tok-scoped' })).status).toBe(403);
      expect(getEnforceStats()).toMatchObject({ engineDenies: 2, undeclaredDenies: 1, unavailable: 0 });
    } finally {
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
    }
  });

  it('engine stats tell health, the policy set, the undeclared routes and the counters (tenant scope in SaaS)', async () => {
    await call('POST', '/api/agents/probe', users.reader);
    const stats = (await call('GET', '/api/iam/engine/stats', users.owner)).body;
    expect(stats).toMatchObject({
      statsScope: expect.stringMatching(/^(process|tenant)$/),
      health: { status: 'ok' },
      policySet: { version: expect.any(Number), custom: expect.any(Number), skipped: [] },
      undeclaredRoutes: { count: expect.any(Number), sample: expect.any(Array) },
      engine: { decisions: expect.any(Number) },
      enforce: {
        engineDecisions: expect.any(Number),
        engineAllows: expect.any(Number),
        engineDenies: expect.any(Number),
        unavailable: 0,
        undeclaredDenies: expect.any(Number),
        ownerSafety: expect.any(Number),
        lastUnavailableAt: null,
        lastUnavailableReason: null,
      },
    });
    expect(stats.enforce.engineDenies).toBeGreaterThanOrEqual(1);
    for (const gone of ['mode', 'shadow', 'tenant', 'modeLookup', 'killSwitches']) expect(stats).not.toHaveProperty(gone);
    expect(JSON.stringify(stats)).not.toMatch(/fallback/i);
  });

  it('process-wide figures only on a single-organisation deployment; in SaaS this workspace\'s own counters', async () => {
    const previous = process.env.DEPLOYMENT_MODE;
    try {
      await call('GET', '/api/agents/probe', users.plain);
      process.env.DEPLOYMENT_MODE = 'onprem';
      reloadConfig();
      const onprem = (await call('GET', '/api/iam/engine/stats', users.owner)).body;
      expect(onprem.statsScope).toBe('process');
      expect(onprem.engine).toMatchObject({ decisions: expect.any(Number), p50Us: expect.any(Number), p99Us: expect.any(Number), principalCache: expect.objectContaining({ hitRate: expect.any(Number) }) });
      expect(onprem.engine.decisions).toBeGreaterThan(0);
      expect(onprem.tenantEnforce).toMatchObject({ engineDecisions: expect.any(Number) });

      process.env.DEPLOYMENT_MODE = 'saas';
      reloadConfig();
      const saas = (await call('GET', '/api/iam/engine/stats', users.owner)).body;
      expect(saas.statsScope).toBe('tenant');
      // no platform-level data: no latency percentiles, no cache hit rate, no per-process counters
      expect(saas.engine).toEqual({ decisions: expect.any(Number), p50Us: null, p99Us: null, principalCache: { hitRate: null } });
      expect(saas.engine.decisions).toBeGreaterThan(0); // this workspace's own evaluations
      expect(saas).not.toHaveProperty('tenantEnforce');
      expect(saas.engine).not.toHaveProperty('tenantsLoaded');
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_MODE;
      else process.env.DEPLOYMENT_MODE = previous;
      reloadConfig();
    }
  });

  it('is an administration service like the rest of /api/iam: a plain user is refused, an admin reads', async () => {
    expect((await call('GET', '/api/iam/engine/stats', users.plain)).status).toBe(403);
    expect((await call('GET', '/api/iam/engine/stats', users.admin)).status).toBe(200);
  });
});

describe('handler-level service checks (authorizeServiceForRequest)', () => {
  it('session: project narrowing applies', async () => {
    expect((await call('GET', '/api/handler/check', users.member, inProject())).body).toMatchObject({ allowed: false });
    expect((await call('GET', '/api/handler/check', users.member, inProject(otherProjectId))).body).toMatchObject({ allowed: true });
    expect((await call('GET', '/api/handler/check', users.plain)).body).toMatchObject({ allowed: true });
    expect((await call('GET', '/api/handler/check', users.reader)).body).toMatchObject({ allowed: false });
  });

  it('token: the owner\'s group grants count, the scope still caps, the token project narrows', async () => {
    expect((await call('GET', '/api/client/v1/handler/check', null, { token: 'tok-blocked' })).body).toMatchObject({ allowed: true });
    expect((await call('GET', '/api/client/v1/handler/check', null, { token: 'tok-scoped' })).body).toMatchObject({ allowed: false });
    expect((await call('GET', '/api/client/v1/handler/check', null, { token: 'tok-member-proj' })).body).toMatchObject({ allowed: false });
  });

  it('a custom forbid policy reaches the handler-level check too', async () => {
    await createPolicy(env.tenantDbName, {
      policyId: 'no-agents',
      name: 'no agents',
      cedar: 'forbid(principal, action, resource) when { resource.service == "agents" };',
    }, 'test');
    try {
      const denied = await call('GET', '/api/handler/check', users.plain);
      expect(denied.body).toMatchObject({ allowed: false });
      expect(typeof denied.body.decisionId).toBe('string');
      // only a 403 carries the header; a handler that merely filters stays quiet
      expect(denied.headers['x-decision-id']).toBeUndefined();
      const refused = await call('GET', '/api/handler/refuse', users.plain);
      expect(refused.status).toBe(403);
      expect(refused.headers['x-decision-id']).toEqual(expect.any(String));
    } finally {
      await deletePolicy(env.tenantDbName, 'no-agents');
    }
    expect((await call('GET', '/api/handler/check', users.plain)).body).toMatchObject({ allowed: true });
  });
});

describe('audit trail', () => {
  const denied = async (service: string, outcome = 'denied') => {
    for (let i = 0; i < 60; i++) {
      const rows = await env.db.listAuditLogs({ service, outcome } as never);
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  };

  it('an engine denial is audited with the decisionId the caller was shown', async () => {
    const res = await call('POST', '/api/agents/probe', users.reader);
    expect(res.status).toBe(403);
    const rows = await denied('agents');
    const row = rows.find((r: any) => r.metadata?.decisionId === res.body.decisionId);
    expect(row, 'audit row carries the decisionId').toBeDefined();
    expect(row!.metadata).toMatchObject({ iamEnforce: true, code: 'forbidden', deniedService: 'agents', required: 'write' });
  });

  it('an undeclared-route refusal is audited too (service iam, action security)', async () => {
    const res = await call('GET', '/api/undeclared/thing', users.plain);
    expect(res.status).toBe(403);
    const rows = await denied('iam');
    const row = rows.find((r: any) => r.metadata?.code === 'route_not_declared');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ action: 'security', outcome: 'denied', method: 'GET', statusCode: 403 });
  });
});

describe('what depends on the engine at the handlers', () => {
  it('the dashboard overview hides the sections the caller cannot read (project narrowing)', async () => {
    await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.dashy._id), projectId, role: 'member', servicePermissions: { models: 'none', tracing: 'none' } });
    resetPrincipalCacheForTests();
    const hidden = (await call('GET', '/api/dashboard', users.dashy, inProject())).body;
    expect(hidden.stats.models).toEqual({ total: 0, llm: 0, embedding: 0 });
    expect(hidden.stats.tracing).toEqual({ totalSessions: 0, totalTokens: 0, activeSessions: 0 });
    expect(hidden.stats.apiCalls).toEqual({ total: 0, trend: 0 });
    expect(hidden.recentActivity).toEqual([]);
    expect(hidden.recentSessions).toEqual([]);
    expect(hidden.daily).toEqual([]);
    expect(hidden.stats.vectors).toEqual({ providers: 1, indexes: 4 }); // untouched service
    // outside the narrowed project nothing is hidden
    expect((await call('GET', '/api/dashboard', users.member, inProject(otherProjectId))).body.stats.models.total).toBe(3);
  });

  it('/metrics is tenant-wide: a token with a service scope is refused, an unscoped one is not', async () => {
    const scoped = await call('GET', '/api/metrics', null, { token: 'tok-scoped' });
    expect(scoped.status).toBe(403);
    // `error` is the reason, not a bare "Forbidden"
    const reason = 'Forbidden: /metrics is tenant-wide and needs an API token without a service scope';
    expect(scoped.body).toEqual({ error: reason, code: 'forbidden', message: reason });
    expect((await call('GET', '/api/metrics', null, { token: 'tok-plain' })).status).toBe(200);
  });
});

describe('a 403 names its reason in `error`, in every error dialect', () => {
  // SDKs and the dashboard surface `body.error`, so it is the human-readable reason; the structured
  // fields (`code`, `service`, `required`, `decisionId`) ride next to it.
  interface Refusal { status: number; body: Record<string, any>; headers: Record<string, unknown> }
  interface Case {
    name: string;
    reason: string;
    service: string;
    required: string;
    run: () => Promise<Refusal>;
  }

  const cases: Case[] = [
    {
      name: 'session, route mapped by prefix',
      reason: 'Forbidden: agents requires write permission',
      service: 'agents',
      required: 'write',
      run: () => call('POST', '/api/agents/probe', users.reader),
    },
    {
      name: 'session, explicit service declaration (admin service)',
      reason: 'Forbidden: ldap requires admin permission',
      service: 'ldap',
      required: 'admin',
      run: () => call('POST', '/api/declared/service', users.reader),
    },
    {
      name: 'session, declared level override',
      reason: 'Forbidden: agents requires admin permission',
      service: 'agents',
      required: 'admin',
      run: () => call('GET', '/api/declared/level', users.plain),
    },
    {
      name: 'token, the scope caps the owner',
      reason: 'Forbidden: agents requires write permission',
      service: 'agents',
      required: 'write',
      run: () => call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-scoped' }),
    },
    {
      name: 'token, an empty scope caps everything',
      reason: 'Forbidden: agents requires read permission',
      service: 'agents',
      required: 'read',
      run: () => call('GET', '/api/client/v1/agents/probe', null, { token: 'tok-admin-empty' }),
    },
  ];

  const refusals: Refusal[] = [];
  let openai: Refusal;
  let anthropic: Refusal;

  beforeAll(async () => {
    resetState();
    for (const c of cases) refusals.push(await c.run());
    openai = await call('POST', '/api/client/v1/agents/openai-probe', null, { token: 'tok-scoped' });
    anthropic = await call('POST', '/api/client/v1/agents/anthropic-probe', null, { token: 'tok-scoped' });
  });

  it.each(cases.map((c, index) => [c.name, index] as const))('%s: the reason in `error`, the structured fields next to it', (_name, index) => {
    const c = cases[index];
    const refusal = refusals[index];
    expect(refusal.status).toBe(403);
    expect(refusal.body).toEqual({
      error: c.reason,
      code: 'forbidden',
      message: c.reason,
      service: c.service,
      required: c.required,
      decisionId: expect.any(String),
    });
    expect(refusal.headers['x-decision-id']).toBe(refusal.body.decisionId);
  });

  it('OpenAI- and Anthropic-style envelopes keep their own shape; the reason is error.message', () => {
    const reason = 'Forbidden: agents requires write permission';
    expect(openai.status).toBe(403);
    expect(anthropic.status).toBe(403);
    // OpenAI SDKs read error.message / error.code; the decision rides along
    expect(openai.body).toEqual({
      error: { message: reason, type: 'permission_error', code: 'forbidden', decision_id: expect.any(String) },
    });
    expect(anthropic.body).toEqual({
      type: 'error',
      error: { type: 'permission_error', message: reason, decision_id: expect.any(String) },
    });
    for (const [dialect, refusal] of [['openai', openai], ['anthropic', anthropic]] as const) {
      expect(refusal.headers['x-decision-id'], dialect).toBe(refusal.body.error.decision_id);
    }
  });
});
