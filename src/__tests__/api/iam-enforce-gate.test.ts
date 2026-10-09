/**
 * Enforce mode (C4) at the HTTP gate, with the REAL gates, a real SQLite
 * database and the real engine:
 *
 *   - every decision applies to enforce-mode tenants only; legacy is unchanged,
 *   - undeclared routes are refused (route_not_declared), declared kinds are honoured,
 *   - API tokens include the owner's group grants and the token scope still caps,
 *   - project-level service permissions narrow (explicit settings only),
 *   - a failing engine falls back to the legacy decision (never fails open),
 *   - the tenant owner can always switch back, the operator kill switch wins,
 *   - project access through groups is fixed for enforce tenants only,
 *   - a 403 keeps the legacy contract: `error` is the same reason sentence in both modes
 *     (enforce only adds fields), and the OpenAI / Anthropic envelopes keep their own shape.
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
import { resetAuthzModeCacheForTests, resetShadowBufferForTests, getAuthzMode } from '@/lib/iam/shadow';
import { resetProjectMembershipCacheForTests } from '@/lib/iam/shadow/projectMembership';
import { resetShadowMetricsForTests } from '@/lib/iam/shadow/metrics';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { metricsApiPlugin } from '@/server/api/plugins/metrics';
import { hideUnreadableOverviewSections } from '@/server/api/plugins/dashboard';
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
let savedKillSwitch: string | undefined;

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

beforeAll(async () => {
  savedKillSwitch = process.env.IAM_ENFORCE_DISABLED;
  delete process.env.IAM_ENFORCE_DISABLED; // __tests__/setup.ts turns enforcement off globally

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
  const project = await env.db.createProject({ tenantId: env.tenantId, key: 'pj', name: 'PJ', createdBy: 'x' });
  projectId = String(project._id);
  const other = await env.db.createProject({ tenantId: env.tenantId, key: 'pj2', name: 'PJ2', createdBy: 'x' });
  otherProjectId = String(other._id);
  // member: agents read in pj; nothing explicit for prompts; also a member of pj2 with no overrides
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.member._id), projectId, role: 'member', servicePermissions: { agents: 'read' } });
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.member._id), projectId: otherProjectId, role: 'member' });
  // dashy: models and tracing are none inside pj, vector is untouched
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.dashy._id), projectId, role: 'member', servicePermissions: { models: 'none', tracing: 'none' } });
  // solo: a member of pj only (agents read there)
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.solo._id), projectId, role: 'member', servicePermissions: { agents: 'read' } });
  // blocked: agents:none at tenant level, raised to write by a group (sessions already see it; tokens do not today)
  const raisers = await env.db.createGroup({ tenantId: env.tenantId, name: 'raisers', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
  await env.db.addGroupMember({ groupId: String(raisers._id), userId: String(users.blocked._id), tenantId: env.tenantId, role: 'member' });
  // gonly: no direct project, reaches pj only through a group (agents read there)
  const team = await env.db.createGroup({ tenantId: env.tenantId, name: 'team', createdBy: 't', source: 'local' } as never);
  await env.db.addGroupMember({ groupId: String(team._id), userId: String(users.gonly._id), tenantId: env.tenantId, role: 'member' });
  await env.db.upsertGroupProject({ tenantId: env.tenantId, groupId: String(team._id), projectId, role: 'member', servicePermissions: { agents: 'read' } });

  hoisted.tokens.set('tok-blocked', tokenCtx(users.blocked, null, 'tok-blocked'));
  hoisted.tokens.set('tok-scoped', tokenCtx(users.blocked, { agents: 'read' }, 'tok-scoped'));
  hoisted.tokens.set('tok-member-proj', tokenCtx(users.member, null, 'tok-member-proj', projectId));
  hoisted.tokens.set('tok-admin-empty', tokenCtx(users.admin, {}, 'tok-admin-empty'));
  hoisted.tokens.set('tok-plain', tokenCtx(users.plain, null, 'tok-plain'));
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
      return reply.send({ allowed: decision.allowed, enforced: decision.enforced, decisionId: decision.decisionId ?? null });
    };
    instance.get('/handler/check', { config: authz.authenticated() }, withApiRequestContext(handlerCheck));
    // the same decision turned into a 403 by the handler
    instance.get('/handler/refuse', { config: authz.authenticated() }, withApiRequestContext(async (request, reply) => {
      const decision = await authorizeServiceForRequest(request, 'agents', { level: 'write' });
      return decision.allowed ? reply.send({ ok: true }) : reply.code(403).send({ error: 'Forbidden' });
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
    // the overview sections hidden by service (dashboard.ts), with recognisable numbers
    instance.get('/dash/hide', { config: authz.authenticated() }, withApiRequestContext(async (request, reply) => {
      const data: any = {
        stats: { models: { total: 3, llm: 2, embedding: 1 }, vectors: { providers: 1, indexes: 4 }, tracing: { totalSessions: 9, totalTokens: 90, activeSessions: 1 }, apiCalls: { total: 9, trend: 5 } },
        recentActivity: [{ id: 'a' }], recentSessions: [{ sessionId: 's' }], daily: [{ date: 'd' }],
      };
      await hideUnreadableOverviewSections(request, env.tenantDbName, data);
      return reply.send(data);
    }));
    await instance.register(iamApiPlugin);
    await instance.register(authApiPlugin);
    await instance.register(metricsApiPlugin);
  });
  await app.ready();
});

afterAll(async () => {
  if (savedKillSwitch === undefined) delete process.env.IAM_ENFORCE_DISABLED;
  else process.env.IAM_ENFORCE_DISABLED = savedKillSwitch;
  hoisted.gate = null;
  await app?.close();
  resetShadowBufferForTests();
  await env?.cleanup();
});

/** Everything a test may have left behind: the failure hook, the kill switch, the engine and its caches, the counters. */
function resetState() {
  hoisted.gate = null;
  delete process.env.IAM_ENFORCE_DISABLED;
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectMembershipCacheForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetShadowMetricsForTests();
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

const setMode = (mode: string, user: IUser = users.owner) => call('PUT', '/api/iam/mode', user, { body: { mode } });
const inProject = (id = projectId) => ({ cookie: `active_project_id=${id}` });

describe('legacy mode is unchanged by declarations and by the enforce code', () => {
  beforeAll(async () => {
    expect((await setMode('legacy')).status).toBe(200);
  });

  it('undeclared routes stay reachable; mapped routes are decided by rbac.ts alone', async () => {
    expect((await call('GET', '/api/undeclared/thing', users.plain)).status).toBe(200);
    expect((await call('GET', '/api/client/v1/undeclared/probe', null, { token: 'tok-plain' })).status).toBe(200);
    expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
    expect((await call('POST', '/api/agents/probe', users.reader)).status).toBe(403);
    // tokens ignore the owner's group grants; project settings are not consulted
    expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' })).status).toBe(403);
    expect((await call('POST', '/api/agents/probe', users.member, inProject())).status).toBe(200);
    expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-member-proj' })).status).toBe(200);
    expect(getEnforceStats()).toMatchObject({ engineDecisions: 0, undeclaredDenies: 0, fallbacks: 0 });
  });

  it('an explicit service declaration is enforced in legacy mode too (route that no prefix maps)', async () => {
    // ldap is an adminService: plain users have none, owners/admins admin, an explicit read grant reads
    expect((await call('GET', '/api/declared/service', users.plain)).status).toBe(403);
    expect((await call('POST', '/api/declared/service', users.plain)).status).toBe(403);
    expect((await call('GET', '/api/declared/service', users.reader)).status).toBe(200);
    expect((await call('POST', '/api/declared/service', users.reader)).status).toBe(403);
    expect((await call('POST', '/api/declared/service', users.admin)).status).toBe(200);
    expect((await call('POST', '/api/declared/service', users.owner)).status).toBe(200);
    // `level` overrides the method-derived level (a GET that needs admin)
    expect((await call('GET', '/api/declared/level', users.plain)).status).toBe(403);
    expect((await call('GET', '/api/declared/level', users.admin)).status).toBe(200);
  });

  it('authenticated / public / self declarations on unmapped routes change nothing in legacy', async () => {
    for (const kind of ['authenticated', 'public', 'self']) {
      expect((await call('GET', `/api/declared/${kind}`, users.blocked)).status).toBe(200);
    }
  });

  it('handler-level service checks stay the rbac.ts answer: no project narrowing, no token groups', async () => {
    expect((await call('GET', '/api/handler/check', users.member, inProject())).body).toMatchObject({ allowed: true, enforced: false });
    expect((await call('GET', '/api/handler/check', users.reader)).body).toMatchObject({ allowed: false, enforced: false });
    expect((await call('GET', '/api/client/v1/handler/check', null, { token: 'tok-blocked' })).body).toMatchObject({ allowed: false });
    expect((await call('GET', '/api/client/v1/handler/check', null, { token: 'tok-plain' })).body).toMatchObject({ allowed: true });
  });

  it('the dashboard overview keeps every section, and /metrics admits a scoped token (unchanged)', async () => {
    const all = (await call('GET', '/api/dash/hide', users.dashy, inProject())).body;
    expect(all.stats.models.total).toBe(3);
    expect(all.stats.tracing.totalSessions).toBe(9);
    expect((await call('GET', '/api/metrics', null, { token: 'tok-scoped' })).status).toBe(200);
  });

  it('project access of a user who only reaches a project through a group is NOT fixed in legacy', async () => {
    const res = await call('GET', '/api/ctx/project', users.gonly);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'No project assigned' });
    // the session endpoint counts direct memberships only
    expect((await call('GET', '/api/auth/session', users.gonly)).body).toMatchObject({ authenticated: true, projectCount: 0 });
  });
});

describe('enforce mode', () => {
  beforeAll(async () => {
    resetAuthzModeCacheForTests();
    const res = await setMode('enforce');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'enforce', effectiveMode: 'enforce', killSwitches: { enforce: false } });
  });

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

  it('a service declaration is decided by the engine, with the documented denial body', async () => {
    expect((await call('GET', '/api/declared/service', users.reader)).status).toBe(200);
    const denied = await call('POST', '/api/declared/service', users.reader);
    expect(denied.status).toBe(403);
    // `error` is the reason legacy mode words the same way; the structured fields ride next to it
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

  it('prefix-mapped routes keep the same verdicts as legacy for users without groups/projects', async () => {
    expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
    expect((await call('POST', '/api/agents/probe', users.reader)).status).toBe(403);
    expect((await call('GET', '/api/agents/probe', users.reader)).status).toBe(200);
    expect((await call('GET', '/api/providers/probe', users.plain)).status).toBe(403);
    expect((await call('GET', '/api/providers/probe', users.admin)).status).toBe(200);
    expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
    expect(getEnforceStats().engineDecisions).toBeGreaterThan(0);
  });

  describe('decision 1: API tokens include the owner\'s group grants; the scope stays a cap', () => {
    it('an unscoped token of a user whose group raises him now gets the group\'s level', async () => {
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' })).status).toBe(200);
    });

    it('a scoped token is still capped after the group grants', async () => {
      expect((await call('GET', '/api/client/v1/agents/probe', null, { token: 'tok-scoped' })).status).toBe(200);
      const denied = await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-scoped' });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'forbidden', service: 'agents', required: 'write' });
    });

    it('an empty scope still denies everything mapped, whatever the owner holds', async () => {
      expect((await call('GET', '/api/client/v1/agents/probe', null, { token: 'tok-admin-empty' })).status).toBe(403);
    });
  });

  describe('decision 2: project-level service permissions narrow (explicit settings only)', () => {
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
  });

  it('project access for a user who reaches a project only through a group is fixed', async () => {
    const res = await call('GET', '/api/ctx/project', users.gonly);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId, role: 'member', permissions: { agents: 'read' } });
    // ... and the session endpoint counts group-assigned projects
    expect((await call('GET', '/api/auth/session', users.gonly)).body).toMatchObject({ authenticated: true, projectCount: 1 });
  });

  describe('failure behaviour: never fail open beyond legacy', () => {
    it('engine failure -> the legacy decision, counted', async () => {
      hoisted.gate = async () => ({ allowed: false, reasons: [], errors: ['wasm unavailable'], obligations: {}, durationUs: 1, failed: true });
      // legacy allows a plain user's write, denies the reader's
      expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
      const denied = await call('POST', '/api/agents/probe', users.reader);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'forbidden', service: 'agents' });
      // legacy for tokens: no group grants -> deny
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' })).status).toBe(403);
      const stats = getEnforceStats();
      expect(stats.fallbacks).toBe(3);
      // only a coarse category is kept; the detail goes to the server log
      expect(stats.lastFallbackReason).toBe('engine_unavailable');
      expect(JSON.stringify(stats)).not.toContain('wasm unavailable');
      const api = await call('GET', '/api/iam/engine/stats', users.owner);
      expect(JSON.stringify(api.body)).not.toContain('wasm unavailable');
    });

    it('an exception inside the engine path is the same fallback', async () => {
      hoisted.gate = async () => { throw new Error('boom'); };
      expect((await call('GET', '/api/agents/probe', users.plain)).status).toBe(200);
      expect((await call('POST', '/api/agents/probe', users.reader)).status).toBe(403);
      expect(getEnforceStats().fallbacks).toBe(2);
      expect(getEnforceStats().lastFallbackReason).toBe('evaluation_error');
      expect(JSON.stringify(getEnforceStats())).not.toContain('boom');
    });

    it('a real engine deny is not a fallback', async () => {
      expect((await call('POST', '/api/agents/probe', users.reader)).status).toBe(403);
      expect(getEnforceStats()).toMatchObject({ fallbacks: 0, engineDenies: 1 });
    });
  });

  describe('owner safety', () => {
    it('the owner can always switch back, even when custom policies deny everything on iam and the engine is down', async () => {
      await createPolicy(env.tenantDbName, {
        policyId: 'lock-iam',
        name: 'lock iam',
        cedar: 'forbid(principal, action, resource) when { resource.service == "iam" };',
      }, 'test');
      try {
        // a non-owner admin is locked out by the policy ...
        const locked = await setMode('legacy', users.admin);
        expect(locked.status).toBe(403);
        expect(locked.body).toMatchObject({ code: 'forbidden', service: 'iam' });
        expect((await call('GET', '/api/iam/mode', users.admin)).status).toBe(403);
        // ... the owner is not (and is not affected by an engine outage either)
        hoisted.gate = async () => { throw new Error('engine down'); };
        expect((await call('GET', '/api/iam/mode', users.owner)).status).toBe(200);
        hoisted.gate = null;
        expect(getEnforceStats().ownerSafety).toBeGreaterThan(0);
        const back = await setMode('legacy', users.owner);
        expect(back.status).toBe(200);
        expect(back.body.mode).toBe('legacy');
        // and the tenant really is legacy again: the undeclared route is reachable
        expect((await call('GET', '/api/undeclared/thing', users.plain)).status).toBe(200);
        expect((await getAuthzMode(env.tenantDbName)).mode).toBe('legacy');
      } finally {
        await deletePolicy(env.tenantDbName, 'lock-iam');
        await setMode('enforce');
      }
    });
  });

  it('GET /api/iam/mode tells the UI what is applied, the tenant, and whether routes would be refused', async () => {
    const res = await call('GET', '/api/iam/mode', users.owner);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'enforce',
      effectiveMode: 'enforce',
      availableModes: ['legacy', 'shadow', 'enforce'],
      comingModes: [],
      killSwitches: { enforce: false, shadow: false },
      tenant: { id: env.tenantId, name: 'Iam Co' },
    });
    expect(res.body.undeclaredRoutes).toEqual({ count: expect.any(Number), sample: expect.any(Array) });
  });

  it('engine stats expose the enforce counters', async () => {
    await call('POST', '/api/agents/probe', users.reader);
    const stats = (await call('GET', '/api/iam/engine/stats', users.owner)).body;
    expect(stats.enforce).toMatchObject({ engineDecisions: expect.any(Number), engineDenies: expect.any(Number), fallbacks: expect.any(Number), undeclaredDenies: expect.any(Number) });
  });

  it('the shadow trail keeps recording legacy-vs-engine differences while enforcing', async () => {
    const { drainShadowQueue, flushShadowEvents, resetShadowEntries, listShadowEntries } = await import('@/lib/iam/shadow');
    await resetShadowEntries(env.tenantDbName);
    await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' }); // token-groups
    await call('POST', '/api/agents/probe', users.member, inProject()); // project-narrowing
    await call('GET', '/api/undeclared/thing', users.plain); // unmapped-path
    await drainShadowQueue();
    await flushShadowEvents();
    const entries = await listShadowEntries(env.tenantDbName);
    const categories = new Set(entries.map((e) => e.category));
    expect(categories).toEqual(new Set(['token-groups', 'project-narrowing', 'unmapped-path']));
  });

  describe('handler-level service checks follow the mode (authorizeServiceForRequest)', () => {
    it('session: project narrowing applies', async () => {
      expect((await call('GET', '/api/handler/check', users.member, inProject())).body).toMatchObject({ allowed: false, enforced: true });
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
        expect(denied.body).toMatchObject({ allowed: false, enforced: true });
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

    it('an engine failure is the legacy answer here as well', async () => {
      hoisted.gate = async () => { throw new Error('boom'); };
      expect((await call('GET', '/api/handler/check', users.plain)).body).toMatchObject({ allowed: true });
      expect((await call('GET', '/api/handler/check', users.reader)).body).toMatchObject({ allowed: false });
      expect(getEnforceStats().fallbacks).toBe(2);
    });
  });

  it('a token whose project its owner no longer belongs to is not narrowed by some other project', async () => {
    // member is narrowed to agents:read in pj and has no rights in pj3 (the token's project).
    // The old session-style fallback would have borrowed pj's settings (member[0]) and refused the write.
    expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-member-foreign' })).status).toBe(200);
    expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-member-proj' })).status).toBe(403);
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

  it('the dashboard overview hides the sections the caller cannot read (project narrowing)', async () => {
    const hidden = (await call('GET', '/api/dash/hide', users.dashy, inProject())).body;
    expect(hidden.stats.models).toEqual({ total: 0, llm: 0, embedding: 0 });
    expect(hidden.stats.tracing).toEqual({ totalSessions: 0, totalTokens: 0, activeSessions: 0 });
    expect(hidden.stats.apiCalls).toEqual({ total: 0, trend: 0 });
    expect(hidden.recentActivity).toEqual([]);
    expect(hidden.recentSessions).toEqual([]);
    expect(hidden.daily).toEqual([]);
    expect(hidden.stats.vectors).toEqual({ providers: 1, indexes: 4 }); // untouched service
    // outside the narrowed project nothing is hidden
    expect((await call('GET', '/api/dash/hide', users.plain)).body.stats.models.total).toBe(3);
  });

  it('/metrics is tenant-wide: a token with a service scope is refused, an unscoped one is not', async () => {
    const scoped = await call('GET', '/api/metrics', null, { token: 'tok-scoped' });
    expect(scoped.status).toBe(403);
    // an enforce-only refusal (legacy admits a scoped token): `error` is the reason, not a bare "Forbidden"
    const reason = 'Forbidden: /metrics is tenant-wide and needs an API token without a service scope';
    expect(scoped.body).toEqual({ error: reason, code: 'forbidden', message: reason });
    expect((await call('GET', '/api/metrics', null, { token: 'tok-plain' })).status).toBe(200);
  });

  it('the shadow summary reports collecting while enforcing', async () => {
    const summary = (await call('GET', '/api/iam/shadow/summary', users.owner)).body;
    expect(summary).toMatchObject({ mode: 'enforce', collecting: true });
  });

  it('IAM_ENFORCE_DISABLED=1 forces legacy decisions even though the tenant is stored as enforce', async () => {
    process.env.IAM_ENFORCE_DISABLED = '1';
    try {
      expect((await call('GET', '/api/undeclared/thing', users.plain)).status).toBe(200); // not refused
      expect((await call('POST', '/api/agents/probe', users.member, inProject())).status).toBe(200); // no narrowing
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' })).status).toBe(403); // no token groups
      expect((await call('GET', '/api/ctx/project', users.gonly)).status).toBe(403); // legacy project resolution
      const mode = (await call('GET', '/api/iam/mode', users.owner)).body;
      expect(mode).toMatchObject({ mode: 'enforce', effectiveMode: 'legacy', killSwitches: { enforce: true } });
      expect((await setMode('enforce')).status).toBe(409);
    } finally {
      delete process.env.IAM_ENFORCE_DISABLED;
    }
    expect((await call('GET', '/api/undeclared/thing', users.plain)).status).toBe(403);
  });
});

describe('a 403 keeps the legacy contract when a tenant flips to enforce', () => {
  // The status codes of the two modes were always the same; the bodies were not: legacy answered
  // { error: 'Forbidden: agents requires write permission' }, enforce { error: 'Forbidden', message: <the reason>, ... },
  // and SDKs and the dashboard surface `body.error`, so a tenant that flipped to enforce lost the reason.
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

  const refusals: Record<'legacy' | 'enforce', Refusal[]> = { legacy: [], enforce: [] };
  const pending: Refusal = { status: 0, body: {}, headers: {} };
  const dialects: Record<'legacy' | 'enforce', { openai: Refusal; anthropic: Refusal }> = {
    legacy: { openai: pending, anthropic: pending },
    enforce: { openai: pending, anthropic: pending },
  };

  beforeAll(async () => {
    // The same requests, once per mode, answered by the real gates.
    for (const mode of ['legacy', 'enforce'] as const) {
      resetState();
      resetAuthzModeCacheForTests();
      expect((await setMode(mode)).status).toBe(200);
      for (const c of cases) refusals[mode].push(await c.run());
      dialects[mode] = {
        openai: await call('POST', '/api/client/v1/agents/openai-probe', null, { token: 'tok-scoped' }),
        anthropic: await call('POST', '/api/client/v1/agents/anthropic-probe', null, { token: 'tok-scoped' }),
      };
    }
  });

  afterAll(async () => {
    resetState();
    resetAuthzModeCacheForTests();
    await setMode('enforce');
  });

  it.each(cases.map((c, index) => [c.name, index] as const))('%s: the same `error` string in both modes', (_name, index) => {
    const c = cases[index];
    const legacy = refusals.legacy[index];
    const enforce = refusals.enforce[index];
    expect([legacy.status, enforce.status]).toEqual([403, 403]);
    // legacy: the plain reason, as it always was
    expect(legacy.body).toEqual({ error: c.reason });
    // enforce: that very string in `error`, and the structured fields next to it
    expect(enforce.body.error).toBe(legacy.body.error);
    expect(enforce.body).toEqual({
      error: c.reason,
      code: 'forbidden',
      message: c.reason,
      service: c.service,
      required: c.required,
      decisionId: expect.any(String),
    });
  });

  it('OpenAI- and Anthropic-style envelopes keep their own shape; the reason is error.message in both modes', () => {
    const reason = 'Forbidden: agents requires write permission';
    for (const mode of ['legacy', 'enforce'] as const) {
      expect(dialects[mode].openai.status).toBe(403);
      expect(dialects[mode].anthropic.status).toBe(403);
    }
    // legacy has no decision; enforce names it in the body and the X-Decision-Id header
    expect(dialects.legacy.anthropic.body).toEqual({ type: 'error', error: { type: 'permission_error', message: reason } });
    expect(dialects.legacy.openai.body).toEqual({ error: { message: reason, type: 'permission_error' } });
    expect(dialects.legacy.openai.headers['x-decision-id']).toBeUndefined();
    // OpenAI SDKs read error.message / error.code: enforce adds the code
    expect(dialects.enforce.openai.body).toEqual({
      error: { message: reason, type: 'permission_error', code: 'forbidden', decision_id: expect.any(String) },
    });
    expect(dialects.enforce.anthropic.body).toEqual({
      type: 'error',
      error: { type: 'permission_error', message: reason, decision_id: expect.any(String) },
    });
    for (const dialect of ['openai', 'anthropic'] as const) {
      const { body, headers } = dialects.enforce[dialect];
      expect(headers['x-decision-id']).toBe(body.error.decision_id);
    }
  });
});
