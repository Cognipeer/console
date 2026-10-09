/**
 * The Authorization center's policies at the REAL request gates (enforce mode,
 * real SQLite database, real engine): request context (IP, channel, project, time,
 * method, path), group policies reaching API tokens, boundaries, owner safety,
 * the denial audit trail -> decision lookup -> access check round trip, and the
 * monitor-mode counts of enforce and shadow tenants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
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

import type { FastifyInstance } from 'fastify';
import type { IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { authz } from '@/lib/iam/routeAuthz';
import {
  drainShadowQueue,
  flushShadowEvents,
  resetAuthzModeCacheForTests,
  resetShadowBufferForTests,
  getPolicyMonitorTotals,
} from '@/lib/iam/shadow';
import { resetProjectMembershipCacheForTests } from '@/lib/iam/shadow/projectMembership';
import { resetShadowMetricsForTests } from '@/lib/iam/shadow/metrics';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { reloadConfig } from '@/lib/core/config';
import { enqueueAuditLog } from '@/server/api/plugin';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import {
  authorizeServiceForRequest,
  withApiRequestContext,
  withClientApiRequestContext,
} from '@/server/api/fastify-utils';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let env: IamTestDb;
let app: FastifyInstance;
const users: Record<string, IUser> = {};
let projectId: string;
let otherProjectId: string;
let defaultProjectId: string;
let engGroup: string;
let savedKillSwitch: string | undefined;
const created: string[] = [];

const sessionHeaders = (user: IUser) => ({
  'x-tenant-db-name': env.tenantDbName,
  'x-tenant-id': env.tenantId,
  'x-tenant-slug': 'iam-center-gate',
  'x-user-id': String(user._id),
  'x-user-role': String(user.role),
  'x-user-email': String(user.email),
  'x-license-type': 'FREE',
});

const mkUser = async (name: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
  const user = (await env.db.createUser({
    tenantId: env.tenantId, email: `${name}@gate.io`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
  })) as IUser;
  users[name] = user;
  return user;
};

const tokenCtx = (user: IUser, scope: Record<string, string> | null, tokenId: string, tokenProject?: string) => ({
  token: tokenId,
  tokenRecord: { _id: tokenId, userId: String(user._id), servicePermissions: scope, projectId: tokenProject },
  tenant: { licenseType: 'FREE' },
  tenantId: env.tenantId,
  tenantSlug: 'iam-center-gate',
  tenantDbName: env.tenantDbName,
  projectId: tokenProject ?? 'default',
  user,
});

beforeAll(async () => {
  savedKillSwitch = process.env.IAM_ENFORCE_DISABLED;
  delete process.env.IAM_ENFORCE_DISABLED; // __tests__/setup.ts turns enforcement off globally

  env = await createIamTestDb('tenant_iam_center_gate');
  hoisted.getDatabase.mockImplementation(async () => env.db);

  await mkUser('owner', 'owner');
  await mkUser('admin', 'admin');
  await mkUser('plain', 'user');
  await mkUser('alice', 'user');
  await mkUser('bob', 'user');
  await mkUser('pat', 'user'); // a member of project pj

  const project = await env.db.createProject({ tenantId: env.tenantId, key: 'pj', name: 'PJ', createdBy: 'x' });
  projectId = String(project._id);
  const other = await env.db.createProject({ tenantId: env.tenantId, key: 'pj2', name: 'PJ2', createdBy: 'x' });
  otherProjectId = String(other._id);
  const fallback = await env.db.createProject({ tenantId: env.tenantId, key: 'default', name: 'Default', createdBy: 'x' });
  defaultProjectId = String(fallback._id);
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.pat._id), projectId, role: 'member' });
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.pat._id), projectId: otherProjectId, role: 'member' });

  const eng = await env.db.createGroup({ tenantId: env.tenantId, name: 'Engineering', createdBy: 't', source: 'local' } as never);
  engGroup = String(eng._id);
  for (const name of ['alice']) await env.db.addGroupMember({ groupId: engGroup, userId: String(users[name]._id), tenantId: env.tenantId, role: 'member' });

  hoisted.tokens.set('tok-alice', tokenCtx(users.alice, null, 'tok-alice'));
  hoisted.tokens.set('tok-alice-scoped', tokenCtx(users.alice, { agents: 'read' }, 'tok-alice-scoped'));
  hoisted.tokens.set('tok-bob', tokenCtx(users.bob, null, 'tok-bob'));
  hoisted.tokens.set('tok-owner', tokenCtx(users.owner, null, 'tok-owner'));
  hoisted.tokens.set('tok-plain-scoped', tokenCtx(users.plain, { prompts: 'write' }, 'tok-plain-scoped'));

  app = await createFastifyApiTestApp(async (instance) => {
    instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
    const ok = withApiRequestContext(async (_req, reply) => reply.send({ ok: true }));
    instance.get('/agents/probe', ok);
    instance.post('/agents/probe', ok);
    instance.post('/agents/danger/zone', ok);
    instance.post('/prompts/probe', ok);
    instance.get('/users/probe', ok); // /api/users is the members service
    instance.post('/client/v1/agents/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.get('/client/v1/agents/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.post('/client/v1/prompts/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.get('/client/v1/members/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    const handlerCheck = async (request: any, reply: any) => {
      const decision = await authorizeServiceForRequest(request, 'agents', { level: 'write' });
      return reply.send({ allowed: decision.allowed, enforced: decision.enforced });
    };
    instance.get('/handler/check', { config: authz.authenticated() }, withApiRequestContext(handlerCheck));
    // a service-level check on the iam service, as a session and as a token
    const iamCheck = async (request: any, reply: any) => {
      const decision = await authorizeServiceForRequest(request, 'iam', { level: 'admin' });
      return reply.send({ allowed: decision.allowed, enforced: decision.enforced });
    };
    instance.get('/handler/check-iam', { config: authz.authenticated() }, withApiRequestContext(iamCheck));
    instance.get('/client/v1/handler/check-iam', { config: authz.authenticated() }, withClientApiRequestContext(iamCheck));
    // a route ABOUT a project (its path names it), like /api/projects/:projectId/...
    instance.post('/projects/:projectId/probe', withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    await instance.register(iamApiPlugin);
  });
  await app.ready();

  resetAuthzModeCacheForTests();
  const mode = await call('PUT', '/api/iam/mode', users.owner, { body: { mode: 'enforce' } });
  expect(mode.status).toBe(200);
});

afterAll(async () => {
  if (savedKillSwitch === undefined) delete process.env.IAM_ENFORCE_DISABLED;
  else process.env.IAM_ENFORCE_DISABLED = savedKillSwitch;
  await drainPendingTasks();
  await app?.close();
  resetShadowBufferForTests();
  await env?.cleanup();
});

beforeEach(() => {
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectMembershipCacheForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetShadowMetricsForTests();
});

const call = async (
  method: string,
  url: string,
  user: IUser | null,
  opts: { token?: string; body?: unknown; cookie?: string; remoteAddress?: string; headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = { ...(user ? sessionHeaders(user) : {}), ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.inject({
    method: method as never,
    url,
    headers,
    payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
  });
  let body: any = null;
  try { body = res.body ? parseJsonBody<any>(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body };
};

/** Create a policy through the API (as the owner); removed again by `cleanup`. */
async function policy(body: Record<string, unknown>) {
  const res = await call('POST', '/api/iam/policies', users.owner, { body: { enabled: true, mode: 'enforce', ...body } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  created.push(res.body.policyId);
  return res.body;
}
async function cleanup() {
  for (const id of created.splice(0)) await call('DELETE', `/api/iam/policies/${id}`, users.owner);
}
const forbidAgentWrites = (extra: Record<string, unknown> = {}) => ({
  effect: 'forbid', principals: { any: true }, actions: ['agents.write'], resources: { any: true }, ...extra,
});

describe('request context at the gate', () => {
  it('conditions on the caller address, using the address the server resolved (never a header)', async () => {
    await policy({ name: 'Office network', spec: forbidAgentWrites({ conditions: { ipRanges: ['203.0.113.0/24', '2001:db8::/32'] } }) });
    try {
      const from = (remoteAddress: string, headers?: Record<string, string>) => call('POST', '/api/agents/probe', users.plain, { remoteAddress, headers });
      expect((await from('203.0.113.9')).status).toBe(403);
      expect((await from('::ffff:203.0.113.9')).status).toBe(403); // IPv4 reported through a dual-stack socket
      expect((await from('2001:db8::7')).status).toBe(403);
      expect((await from('198.51.100.9')).status).toBe(200);
      // a caller cannot talk its way into (or out of) a range with a header
      expect((await from('198.51.100.9', { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' })).status).toBe(200);
      expect((await from('203.0.113.9', { 'x-forwarded-for': '198.51.100.9' })).status).toBe(403);
      // tokens too
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-bob', remoteAddress: '203.0.113.50' })).status).toBe(403);
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-bob', remoteAddress: '198.51.100.50' })).status).toBe(200);
      // reads are not covered
      expect((await call('GET', '/api/agents/probe', users.plain, { remoteAddress: '203.0.113.9' })).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('a handler-level check sees the same address', async () => {
    await policy({ name: 'Office network', spec: forbidAgentWrites({ conditions: { ipRanges: ['203.0.113.0/24'] } }) });
    try {
      expect((await call('GET', '/api/handler/check', users.plain, { remoteAddress: '203.0.113.9' })).body.allowed).toBe(false);
      expect((await call('GET', '/api/handler/check', users.plain, { remoteAddress: '198.51.100.9' })).body.allowed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('conditions on the channel: a session is "dashboard", an API token is "api"', async () => {
    await policy({ name: 'No API writes', spec: forbidAgentWrites({ conditions: { channels: ['api'] } }) });
    try {
      expect((await call('POST', '/api/agents/probe', users.bob)).status).toBe(200);
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-bob' })).status).toBe(403);
    } finally {
      await cleanup();
    }
    await policy({ name: 'No dashboard writes', spec: forbidAgentWrites({ conditions: { channels: ['dashboard'] } }) });
    try {
      expect((await call('POST', '/api/agents/probe', users.bob)).status).toBe(403);
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-bob' })).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('conditions on the project the handler runs in', async () => {
    await policy({ name: 'Freeze PJ', spec: forbidAgentWrites({ resources: { projects: [projectId] } }) });
    try {
      const inProject = (id: string) => call('POST', '/api/agents/probe', users.pat, { cookie: `active_project_id=${id}` });
      expect((await inProject(projectId)).status).toBe(403);
      expect((await inProject(otherProjectId)).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('an owner or admin without an active project runs in the default one, and project policies see that', async () => {
    await policy({ name: 'Freeze the default project', spec: forbidAgentWrites({ resources: { projects: [defaultProjectId] } }) });
    try {
      expect((await call('POST', '/api/agents/probe', users.admin)).status).toBe(403); // no cookie: the default project
      expect((await call('POST', '/api/agents/probe', users.admin, { cookie: `active_project_id=${defaultProjectId}` })).status).toBe(403);
      expect((await call('POST', '/api/agents/probe', users.admin, { cookie: `active_project_id=${otherProjectId}` })).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('conditions on time', async () => {
    await policy({ name: 'Frozen for the decade', spec: forbidAgentWrites({ conditions: { validFrom: '2020-01-01T00:00:00Z', validUntil: '2999-01-01T00:00:00Z' } }) });
    try {
      expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(403);
    } finally {
      await cleanup();
    }
    await policy({ name: 'Not yet', spec: forbidAgentWrites({ conditions: { validFrom: '2999-01-01T00:00:00Z' } }) });
    try {
      expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('raw Cedar can use the method and the path', async () => {
    await policy({
      name: 'Danger zone',
      cedar: 'forbid(principal, action == Action::"agents.write", resource) when { context has path && context.path like "/api/agents/danger*" && context has method && context.method == "POST" };',
    });
    try {
      expect((await call('POST', '/api/agents/danger/zone', users.plain)).status).toBe(403);
      expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
    } finally {
      await cleanup();
    }
  });
});

describe('the caller address with the server in its default proxy setting (trustProxy: true, TRUSTED_PROXIES unset)', () => {
  // Fastify then reads the LEFTMOST X-Forwarded-For entry as request.ip - a value the caller writes. A policy that
  // conditions on the address (or a rule an admin builds on it) must therefore use the connection's own peer.
  let trusting: FastifyInstance;

  beforeAll(async () => {
    trusting = await createFastifyApiTestApp(async (instance) => {
      instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
      instance.post('/agents/probe', withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
      instance.post('/client/v1/agents/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    }, { trustProxy: true });
    await trusting.ready();
  });
  afterAll(async () => {
    await trusting?.close();
  });

  const send = (user: IUser, remoteAddress: string, headers: Record<string, string> = {}) =>
    trusting.inject({ method: 'POST', url: '/api/agents/probe', headers: { ...sessionHeaders(user), ...headers }, remoteAddress });

  it('a header cannot move a caller into or out of the range a policy names', async () => {
    await policy({ name: 'Office network', spec: forbidAgentWrites({ conditions: { ipRanges: ['203.0.113.0/24'] } }) });
    try {
      // from outside the office, claiming (several ways) to be inside: the forbid does NOT apply to the claim...
      expect((await send(users.plain, '198.51.100.9')).statusCode).toBe(200);
      expect((await send(users.plain, '198.51.100.9', { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(200);
      // ... and from inside the office, claiming to be outside, the caller is still held to it
      expect((await send(users.plain, '203.0.113.9')).statusCode).toBe(403);
      expect((await send(users.plain, '203.0.113.9', { 'x-forwarded-for': '198.51.100.9' })).statusCode).toBe(403);
      expect((await send(users.plain, '203.0.113.9', { 'x-forwarded-for': '198.51.100.9, 198.51.100.10', 'x-real-ip': '198.51.100.9' })).statusCode).toBe(403);
    } finally {
      await cleanup();
    }
  });

  it('the same for a token', async () => {
    await policy({ name: 'Office network', spec: forbidAgentWrites({ conditions: { ipRanges: ['203.0.113.0/24'] } }) });
    try {
      const viaToken = (remoteAddress: string, xff?: string) => trusting.inject({
        method: 'POST', url: '/api/client/v1/agents/probe', remoteAddress,
        headers: { authorization: 'Bearer tok-bob', ...(xff ? { 'x-forwarded-for': xff } : {}) },
      });
      expect((await viaToken('203.0.113.50', '198.51.100.1')).statusCode).toBe(403);
      expect((await viaToken('198.51.100.50', '203.0.113.1')).statusCode).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('the address a denial is replayed with is the one the engine saw, not the log value', async () => {
    const forbid = await policy({ name: 'Office network', spec: forbidAgentWrites({ conditions: { ipRanges: ['203.0.113.0/24'] } }) });
    try {
      const denied = await send(users.plain, '203.0.113.20', { 'x-forwarded-for': '10.9.8.7' });
      expect(denied.statusCode).toBe(403);
      const decisionId = (denied.json() as { decisionId: string }).decisionId;
      await drainPendingTasks();
      const decision = await call('GET', `/api/iam/decisions/${decisionId}`, users.owner);
      expect(decision.status).toBe(200);
      expect(decision.body.policyIds).toEqual([forbid.policyId]);
      expect(decision.body.simulateInput.context.ip).toBe('203.0.113.20'); // never the spoofable header
    } finally {
      await cleanup();
    }
  });
});

describe('the IP of an audit row follows the trust boundary, not a raw header', () => {
  it('behind a trusted proxy the row carries the address the proxy saw, never what the client wrote to the left of it', async () => {
    const savedProxies = process.env.TRUSTED_PROXIES;
    process.env.TRUSTED_PROXIES = '10.0.0.0/8'; // the server is configured the way the app below is built
    reloadConfig();
    const behindProxy = await createFastifyApiTestApp(async (instance) => {
      instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
      instance.post('/agents/probe', withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    }, { trustProxy: ['10.0.0.0/8'] });
    await behindProxy.ready();
    try {
      const forbid = await policy({ name: 'No agent writes', spec: forbidAgentWrites() });
      const denied = await behindProxy.inject({
        method: 'POST', url: '/api/agents/probe', remoteAddress: '10.0.0.5',
        headers: { ...sessionHeaders(users.plain), 'x-forwarded-for': '1.1.1.1, 203.0.113.9' },
      });
      expect(denied.statusCode).toBe(403);
      const decisionId = (denied.json() as { decisionId: string }).decisionId;
      await drainPendingTasks();
      const row = (await env.db.listAuditLogs({ service: 'agents', outcome: 'denied' } as never)).find((r: any) => r.metadata?.decisionId === decisionId) as any;
      expect(row.ipAddress).toBe('203.0.113.9'); // (the leftmost entry, 1.1.1.1, is the client talking about itself)
      expect(row.metadata.contextIp).toBe('203.0.113.9');
      expect(forbid.policyId).toBeTruthy();
    } finally {
      await behindProxy.close();
      if (savedProxies === undefined) delete process.env.TRUSTED_PROXIES;
      else process.env.TRUSTED_PROXIES = savedProxies;
      reloadConfig();
      await cleanup();
    }
  });
});

describe('the project a route is about', () => {
  it('a project policy follows the project the path names, not the one the cookie claims', async () => {
    await policy({ name: 'Freeze the project settings of PJ', spec: forbidAgentWrites({ actions: ['projects.write'], resources: { projects: [projectId] } }) });
    try {
      const touch = (pathProject: string, cookieProject?: string) =>
        call('POST', `/api/projects/${pathProject}/probe`, users.admin, cookieProject ? { cookie: `active_project_id=${cookieProject}` } : {});
      // the admin acts on PJ, whatever the active project cookie says
      expect((await touch(projectId)).status).toBe(403);
      expect((await touch(projectId, otherProjectId)).status).toBe(403);
      expect((await touch(projectId, defaultProjectId)).status).toBe(403);
      // ... and on the other project the policy is silent, also with a cookie naming the frozen one
      expect((await touch(otherProjectId)).status).toBe(200);
      expect((await touch(otherProjectId, projectId)).status).toBe(200);
      // a route that is NOT about a project still goes by the cookie
      expect((await call('POST', '/api/agents/probe', users.admin, { cookie: `active_project_id=${projectId}` })).status).toBe(200); // (agents.write is not what is frozen)
    } finally {
      await cleanup();
    }
  });

  it('a member of two projects cannot step out of a frozen one by choosing another cookie', async () => {
    await policy({ name: 'Freeze agents in PJ', spec: forbidAgentWrites({ actions: ['projects.write'], resources: { projects: [projectId] } }) });
    try {
      // pat is a plain member (no projects.write): the gate refuses for the role anyway - the point is that the
      // policy's project is the path's, so a user with project rights is held to it too
      const asPat = (cookieProject: string) => call('POST', `/api/projects/${projectId}/probe`, users.pat, { cookie: `active_project_id=${cookieProject}` });
      expect((await asPat(projectId)).status).toBe(403);
      expect((await asPat(otherProjectId)).status).toBe(403);
    } finally {
      await cleanup();
    }
  });
});

describe('the owner promise belongs to the owner\'s session, not to a token that happens to be theirs', () => {
  it('a policy can restrict the owner\'s API token on the iam service while the owner keeps the page', async () => {
    await policy({ name: 'No token may administer IAM', spec: { effect: 'forbid', principals: { anyToken: true }, actions: ['iam.admin'], resources: { any: true } } });
    try {
      expect((await call('GET', '/api/handler/check-iam', users.owner)).body.allowed).toBe(true); // the session: owner safety
      expect((await call('GET', '/api/client/v1/handler/check-iam', null, { token: 'tok-owner' })).body.allowed).toBe(false); // the token: an ordinary principal
    } finally {
      await cleanup();
    }
    // without the policy the owner's token is as good as the owner
    expect((await call('GET', '/api/client/v1/handler/check-iam', null, { token: 'tok-owner' })).body.allowed).toBe(true);
  });
});

describe('who a policy reaches', () => {
  it('a group forbid also stops the tokens of its members, a non-member is untouched', async () => {
    await policy({ name: 'Engineering is read-only', spec: forbidAgentWrites({ principals: { groups: [engGroup] } }) });
    try {
      expect((await call('POST', '/api/agents/probe', users.alice)).status).toBe(403);
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-alice' })).status).toBe(403);
      expect((await call('POST', '/api/agents/probe', users.bob)).status).toBe(200);
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-bob' })).status).toBe(200);
      expect((await call('GET', '/api/client/v1/agents/probe', null, { token: 'tok-alice' })).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('a permit grants beyond RBAC to a group and to its tokens - but never beyond a token scope', async () => {
    await policy({ name: 'Engineering reads members', spec: { effect: 'permit', principals: { groups: [engGroup] }, actions: ['members.read'], resources: { any: true } } });
    try {
      expect((await call('GET', '/api/users/probe', users.alice)).status).toBe(200);
      expect((await call('GET', '/api/client/v1/members/probe', null, { token: 'tok-alice' })).status).toBe(200);
      expect((await call('GET', '/api/client/v1/members/probe', null, { token: 'tok-alice-scoped' })).status).toBe(403); // scope: agents only
      expect((await call('GET', '/api/users/probe', users.bob)).status).toBe(403);
    } finally {
      await cleanup();
    }
  });

  it('an allow-everything policy cannot lift a token scope', async () => {
    await policy({ name: 'Everything for everyone', cedar: 'permit(principal, action, resource);' });
    try {
      expect((await call('GET', '/api/client/v1/members/probe', null, { token: 'tok-bob' })).status).toBe(200); // unscoped token + custom permit
      const scoped = await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-plain-scoped' });
      expect(scoped.status).toBe(403); // prompts: write only
      expect((await call('POST', '/api/client/v1/prompts/probe', null, { token: 'tok-plain-scoped' })).status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('the workspace owner keeps the Authorization Engine whatever a policy says; an admin can be locked out', async () => {
    await policy({ name: 'Nobody touches IAM', spec: { effect: 'forbid', principals: { any: true }, actions: ['iam.read', 'iam.write', 'iam.admin'], resources: { any: true } } });
    const owner = await call('GET', '/api/iam/policies', users.owner);
    expect(owner.status).toBe(200);
    expect((await call('GET', '/api/iam/policies', users.admin)).status).toBe(403);
    // ... so the owner can always remove it again
    await cleanup();
    expect((await call('GET', '/api/iam/policies', users.admin)).status).toBe(200);
  });
});

describe('denials are audited and can be replayed', () => {
  it('a policy denial carries its decision, deciding policy and context into the audit trail, the decision lookup and the access check', async () => {
    const forbid = await policy({ name: 'No agent writes from the office', spec: forbidAgentWrites({ principals: { groups: [engGroup] }, conditions: { ipRanges: ['203.0.113.0/24'] } }) });
    try {
      const denied = await call('POST', '/api/agents/probe', users.alice, { remoteAddress: '203.0.113.77' });
      expect(denied.status).toBe(403);
      const decisionId = denied.body.decisionId as string;
      expect(decisionId).toBeTruthy();
      expect(denied.body.policyIds).toBeUndefined(); // what decided it is for admins, never for the caller

      // the audit row is written after the response
      let row: any;
      for (let i = 0; i < 80 && !row; i++) {
        row = (await env.db.listAuditLogs({ service: 'agents', outcome: 'denied' } as never)).find((r: any) => r.metadata?.decisionId === decisionId);
        if (!row) await new Promise((r) => setTimeout(r, 25));
      }
      expect(row, 'audit row').toBeDefined();
      expect(row.metadata).toMatchObject({ iamEnforce: true, code: 'forbidden', deniedService: 'agents', required: 'write', action: 'agents.write', policyIds: [forbid.policyId] });

      // decision lookup -> access check input
      const decision = await call('GET', `/api/iam/decisions/${decisionId}`, users.owner);
      expect(decision.status).toBe(200);
      expect(decision.body).toMatchObject({
        service: 'agents', required: 'write', method: 'POST', route: '/api/agents/probe', code: 'forbidden', policyIds: [forbid.policyId],
        principal: { type: 'user', id: String(users.alice._id), label: 'alice' },
      });
      expect(decision.body.simulateInput).toMatchObject({ action: 'agents.write', context: { channel: 'dashboard', ip: '203.0.113.77' } });

      // replaying it reproduces the denial and names the policy
      const replay = await call('POST', '/api/iam/simulate', users.owner, { body: decision.body.simulateInput });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.allowed).toBe(false);
      expect(replay.body.reasons[0]).toMatchObject({ policyId: forbid.policyId, name: 'No agent writes from the office', effect: 'forbid' });
      expect(replay.body.mode).toBe('enforce');

      // ... and the audit tab lists it, with the policy and the principal
      const feed = await call('GET', '/api/iam/audit?kind=denials', users.owner);
      const item = feed.body.items.find((i: any) => i.decisionId === decisionId);
      expect(item).toMatchObject({ action: 'agents.write', policyId: forbid.policyId, principal: { type: 'user', id: String(users.alice._id) } });
      expect(item.summary).toMatch(/by policy "No agent writes from the office"/);
    } finally {
      await cleanup();
    }
  });

  it('a boundary denial names the boundary', async () => {
    const denied = await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-alice-scoped' });
    expect(denied.status).toBe(403);
    let row: any;
    for (let i = 0; i < 80 && !row; i++) {
      row = (await env.db.listAuditLogs({ service: 'agents', outcome: 'denied' } as never)).find((r: any) => r.metadata?.decisionId === denied.body.decisionId);
      if (!row) await new Promise((r) => setTimeout(r, 25));
    }
    expect(row.metadata.reasons).toEqual(['managed:boundary:token-cap-write']);
    expect(row.metadata.policyIds).toBeUndefined();
    const feed = await call('GET', '/api/iam/audit?kind=denials&service=agents', users.owner);
    const item = feed.body.items.find((i: any) => i.decisionId === denied.body.decisionId);
    expect(item.summary).toMatch(/by the token scope/);
    expect(item.principal).toMatchObject({ type: 'token', id: 'tok-alice-scoped' });
  });
});

describe('monitor-mode policies count what they would change', () => {
  const watch = () => policy({ name: 'Watch agent writes', mode: 'monitor', spec: forbidAgentWrites() });

  it('in an enforce tenant: once per request, never changing the decision', async () => {
    const watched = await watch();
    try {
      for (let i = 0; i < 3; i++) expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
      expect((await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-bob' })).status).toBe(200);
      expect((await call('GET', '/api/agents/probe', users.plain)).status).toBe(200); // not covered by the policy
      await drainShadowQueue();
      await flushShadowEvents(env.tenantDbName);

      const totals = (await getPolicyMonitorTotals(env.tenantDbName)).get(watched.policyId);
      expect(totals).toMatchObject({ wouldDeny: 4, wouldAllow: 0 }); // 3 + 1, not doubled by the shadow trail
      const row = (await call('GET', `/api/iam/policies/${watched.policyId}`, users.owner)).body;
      expect(row.monitorStats).toMatchObject({ wouldDeny: 4, wouldAllow: 0 });
      const feed = await call('GET', '/api/iam/audit?kind=monitor', users.owner);
      const routes = feed.body.items.filter((i: any) => i.policyId === watched.policyId).map((i: any) => i.route).sort();
      expect(routes).toEqual(['/agents/probe', '/client/v1/agents/probe'].map((r) => `/api${r}`));
    } finally {
      await cleanup();
    }
  });

  it('in a shadow tenant: recorded by the background evaluation', async () => {
    const watched = await watch();
    try {
      expect((await call('PUT', '/api/iam/mode', users.owner, { body: { mode: 'shadow' } })).status).toBe(200);
      for (let i = 0; i < 3; i++) expect((await call('POST', '/api/agents/probe', users.plain)).status).toBe(200);
      await drainShadowQueue();
      await flushShadowEvents(env.tenantDbName);
      const totals = (await getPolicyMonitorTotals(env.tenantDbName)).get(watched.policyId);
      expect(totals).toMatchObject({ wouldDeny: 3, wouldAllow: 0 });
    } finally {
      await call('PUT', '/api/iam/mode', users.owner, { body: { mode: 'enforce' } });
      await cleanup();
    }
  });

  it('a monitor permit reports what it would newly allow', async () => {
    const watched = await policy({ name: 'Would open members', mode: 'monitor', spec: { effect: 'permit', principals: { any: true }, actions: ['members.read'], resources: { any: true } } });
    try {
      expect((await call('GET', '/api/users/probe', users.plain)).status).toBe(403);
      await flushShadowEvents(env.tenantDbName);
      expect((await getPolicyMonitorTotals(env.tenantDbName)).get(watched.policyId)).toMatchObject({ wouldAllow: 1, wouldDeny: 0 });
    } finally {
      await cleanup();
    }
  });
});
