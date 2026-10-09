/**
 * Shadow mode at the HTTP gate and the /api/iam API, with the REAL gates
 * (enforceSessionRbac / enforceApiTokenRbac), a real SQLite database and the
 * real engine:
 *   - responses are identical with mode legacy and mode shadow,
 *   - the gates record what the spec asks for (token-groups, project-narrowing,
 *     unmapped-path) and never a parity mismatch,
 *   - the /api/iam routes are admin-only RBAC routes and validate their input.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn(), tokens: new Map<string, unknown>() }));

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
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import {
  drainShadowQueue,
  flushShadowEvents,
  resetAuthzModeCacheForTests,
  resetShadowBufferForTests,
} from '@/lib/iam/shadow';
import { resetShadowMetricsForTests, shadowMetrics } from '@/lib/iam/shadow/metrics';
import { recordShadowEvent } from '@/lib/iam/shadow/aggregate';
import { reloadConfig } from '@/lib/core/config';
import { parseMode, parseStats, parseSummary } from '@/components/settings/authorizationEngineData';
import { resetProjectMembershipCacheForTests } from '@/lib/iam/shadow/projectMembership';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import { withApiRequestContext, withClientApiRequestContext } from '@/server/api/fastify-utils';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let env: IamTestDb;
let app: FastifyInstance;
const users: Record<string, IUser> = {};
let projectId: string;

const sessionHeaders = (user: IUser, extra: Record<string, string> = {}) => ({
  'x-tenant-db-name': env.tenantDbName,
  'x-tenant-id': env.tenantId,
  'x-tenant-slug': 'iam-co',
  'x-user-id': String(user._id),
  'x-user-role': String(user.role),
  'x-user-email': String(user.email),
  'x-license-type': 'FREE',
  ...extra,
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
  env = await createIamTestDb('tenant_iam_gate');
  hoisted.getDatabase.mockImplementation(async () => env.db);

  await mkUser('owner', 'owner');
  await mkUser('admin', 'admin');
  await mkUser('plain', 'user');
  await mkUser('reader', 'user', { servicePermissions: { agents: 'read', iam: 'read' } });
  await mkUser('blocked', 'user', { servicePermissions: { agents: 'none' } });
  await mkUser('member', 'user');
  const project = await env.db.createProject({ tenantId: env.tenantId, key: 'pj', name: 'PJ', createdBy: 'x' });
  projectId = String(project._id);
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.member._id), projectId, role: 'member', servicePermissions: { agents: 'read' } });
  const group = await env.db.createGroup({ tenantId: env.tenantId, name: 'raisers', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
  await env.db.addGroupMember({ groupId: String(group._id), userId: String(users.blocked._id), tenantId: env.tenantId, role: 'member' });

  hoisted.tokens.set('tok-blocked', tokenCtx(users.blocked, null, 'tok-blocked'));
  hoisted.tokens.set('tok-scoped', tokenCtx(users.blocked, { agents: 'read' }, 'tok-scoped'));
  hoisted.tokens.set('tok-member-proj', tokenCtx(users.member, null, 'tok-member-proj', projectId));
  hoisted.tokens.set('tok-admin-empty', tokenCtx(users.admin, {}, 'tok-admin-empty'));

  app = await createFastifyApiTestApp(async (instance) => {
    instance.get('/agents/probe', withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.post('/agents/probe', withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.get('/providers/probe', withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.delete('/providers/probe', withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.get('/misc/:thing', withApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.get('/client/v1/agents/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.post('/client/v1/agents/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    instance.get('/client/v1/open/probe', withClientApiRequestContext(async (_req, reply) => reply.send({ ok: true })));
    await instance.register(iamApiPlugin);
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  resetShadowBufferForTests();
  await env?.cleanup();
});

beforeEach(() => {
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectMembershipCacheForTests();
});

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
  return { status: res.statusCode, body: res.body ? safeParse(res.body) : null };
};

const safeParse = (s: string) => { try { return parseJsonBody<any>(s); } catch { return s; } };

const setMode = (mode: string, user: IUser = users.owner) => call('PUT', '/api/iam/mode', user, { body: { mode } });

/** One pass over a fixed matrix of requests; returns "who method url -> status". */
async function runMatrix() {
  const out: Record<string, number> = {};
  const sessionUsers = ['owner', 'admin', 'plain', 'reader', 'blocked', 'member'];
  for (const name of sessionUsers) {
    for (const [method, url] of [
      ['GET', '/api/agents/probe'], ['POST', '/api/agents/probe'], ['GET', '/api/providers/probe'], ['DELETE', '/api/providers/probe'],
      ['GET', '/api/misc/one'], ['HEAD', '/api/agents/probe'],
    ]) {
      out[`${name} ${method} ${url}`] = (await call(method, url, users[name])).status;
      out[`${name} ${method} ${url} +project`] = (await call(method, url, users[name], { cookie: `active_project_id=${projectId}` })).status;
    }
  }
  for (const token of ['tok-blocked', 'tok-scoped', 'tok-member-proj', 'tok-admin-empty', 'tok-bogus']) {
    for (const [method, url] of [['GET', '/api/client/v1/agents/probe'], ['POST', '/api/client/v1/agents/probe'], ['GET', '/api/client/v1/open/probe']]) {
      out[`${token} ${method} ${url}`] = (await call(method, url, null, { token })).status;
    }
  }
  return out;
}

describe('shadow mode never changes a response', () => {
  it('every status code is identical in legacy and shadow mode, and no parity mismatch is ever recorded', async () => {
    resetAuthzModeCacheForTests();
    expect((await setMode('legacy')).status).toBe(200);
    resetShadowMetricsForTests();
    const legacy = await runMatrix();
    await drainShadowQueue();
    expect(shadowMetrics.enqueued).toBe(0); // legacy: the engine is not involved at all

    expect((await setMode('shadow')).status).toBe(200);
    const shadow = await runMatrix();
    await drainShadowQueue();
    await flushShadowEvents();

    expect(shadow).toEqual(legacy);
    // sanity: the matrix really exercised allow and deny
    expect(new Set(Object.values(legacy))).toEqual(new Set([200, 401, 403]));
    expect(shadowMetrics.enqueued).toBeGreaterThan(40);
    expect(shadowMetrics.evaluated).toBe(shadowMetrics.enqueued);
    expect(shadowMetrics.evaluationFailures).toBe(0);
    expect(shadowMetrics.parityMismatches).toBe(0);
  });
});

describe('what the gates record in shadow mode', () => {
  let summary: any;
  beforeAll(async () => {
    await call('POST', '/api/iam/shadow/reset', users.owner);
    await setMode('shadow');
    resetShadowMetricsForTests();
    // token-groups: owner 'blocked' has agents:none but a group raising to write; tokens ignore groups
    await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' });
    // project-narrowing: session with the active project cookie
    await call('POST', '/api/agents/probe', users.member, { cookie: `active_project_id=${projectId}` });
    // ... and a project-bound token
    await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-member-proj' });
    // unmapped
    await call('GET', '/api/misc/507f1f77bcf86cd799439011', users.plain);
    await call('GET', '/api/client/v1/open/probe', null, { token: 'tok-blocked' });
    await drainShadowQueue();
    summary = (await call('GET', '/api/iam/shadow/summary', users.owner)).body;
  });

  it('summary has the documented shape', () => {
    expect(summary).toMatchObject({ mode: 'shadow', collecting: true });
    expect(summary.categories.map((c: any) => c.category)).toEqual(['parity-mismatch', 'token-groups', 'project-narrowing', 'unmapped-path']);
    expect(summary.totals.events).toBeGreaterThanOrEqual(4);
    expect(summary.maxSamples).toBe(20);
    expect(Array.isArray(summary.services)).toBe(true);
    expect(Array.isArray(summary.topRoutes)).toBe(true);
    expect(summary.dropped).toEqual({ keys: 0, events: 0 });
  });

  it('records token-groups, project-narrowing (session and token) and unmapped-path; no parity mismatch', () => {
    const cat = Object.fromEntries(summary.categories.map((c: any) => [c.category, c]));
    expect(cat['parity-mismatch'].events).toBe(0);
    expect(cat['token-groups']).toMatchObject({ events: 1, wouldAllow: 1 });
    expect(cat['project-narrowing']).toMatchObject({ events: 2, wouldDeny: 2 });
    expect(cat['unmapped-path'].events).toBe(2);

    const route = (category: string) => summary.topRoutes.filter((r: any) => r.category === category);
    expect(route('token-groups')[0]).toMatchObject({ service: 'agents', method: 'POST', route: '/api/client/v1/agents/probe', legacyAllowed: false, targetAllowed: true });
    expect(route('token-groups')[0].samples[0]).toMatchObject({ tokenId: 'tok-blocked', userId: String(users.blocked._id) });
    expect(route('project-narrowing').map((r: any) => r.route).sort()).toEqual(['/api/agents/probe', '/api/client/v1/agents/probe']);
    const unmapped = route('unmapped-path').map((r: any) => r.route).sort();
    expect(unmapped).toEqual(['/api/client/v1/open/probe', '/api/misc/:thing']);
  });

  it('entries endpoint filters and paginates; samples carry no bodies or query strings', async () => {
    const all = (await call('GET', '/api/iam/shadow/entries?limit=2&offset=0', users.owner)).body;
    expect(all.entries).toHaveLength(2);
    expect(all.total).toBeGreaterThanOrEqual(4);
    const only = (await call('GET', '/api/iam/shadow/entries?category=unmapped-path', users.owner)).body;
    expect(only.entries.every((e: any) => e.category === 'unmapped-path')).toBe(true);
    expect((await call('GET', '/api/iam/shadow/entries?category=bogus', users.owner)).status).toBe(400);
    for (const e of all.entries) for (const s of e.samples) expect(Object.keys(s).sort()).toEqual(expect.arrayContaining(['at', 'requestId', 'role', 'userId']));
  });

  it('reset clears the data', async () => {
    const res = await call('POST', '/api/iam/shadow/reset', users.owner);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.cleared).toBeGreaterThanOrEqual(4);
    const after = (await call('GET', '/api/iam/shadow/summary', users.owner)).body;
    expect(after.totals).toEqual({ events: 0, keys: 0 });
  });

  it('engine stats expose engine and shadow counters (single-organisation deployment: process-wide)', async () => {
    const previous = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'onprem';
    reloadConfig();
    await setMode('shadow');
    await call('GET', '/api/agents/probe', users.plain);
    await drainShadowQueue();
    const stats = (await call('GET', '/api/iam/engine/stats', users.owner)).body;
    if (previous === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = previous;
    reloadConfig();
    expect(stats.mode).toBe('shadow');
    expect(stats.engine).toMatchObject({ decisions: expect.any(Number), p50Us: expect.any(Number), p99Us: expect.any(Number), principalCache: expect.objectContaining({ hitRate: expect.any(Number) }) });
    expect(stats.engine.decisions).toBeGreaterThan(0);
    expect(stats.shadow).toMatchObject({ queueDrops: 0, parityMismatches: 0, evaluationFailures: 0, queue: expect.objectContaining({ maxQueue: expect.any(Number) }) });
  });
});

describe('/api/iam RBAC and validation', () => {
  it('is an admin service: plain users are refused, a read grant reads but cannot change anything', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/iam/mode'], ['PUT', '/api/iam/mode', { mode: 'shadow' }], ['GET', '/api/iam/shadow/summary'],
      ['POST', '/api/iam/shadow/reset'], ['GET', '/api/iam/engine/stats'],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(method, url, users.plain, { body })).status).toBe(403);
    }
    expect((await call('GET', '/api/iam/mode', users.reader)).status).toBe(200);
    expect((await call('GET', '/api/iam/shadow/summary', users.reader)).status).toBe(200);
    expect((await call('PUT', '/api/iam/mode', users.reader, { body: { mode: 'legacy' } })).status).toBe(403);
    expect((await call('POST', '/api/iam/shadow/reset', users.reader)).status).toBe(403);
  });

  it('owner and admin can read and change the mode', async () => {
    for (const name of ['owner', 'admin']) {
      expect((await setMode('legacy', users[name])).body).toMatchObject({ mode: 'legacy', updatedBy: String(users[name]._id) });
      const got = (await call('GET', '/api/iam/mode', users[name])).body;
      expect(got).toMatchObject({ mode: 'legacy', availableModes: ['legacy', 'shadow', 'enforce'], comingModes: [] });
      expect((await setMode('shadow', users[name])).body.mode).toBe('shadow');
    }
  });

  it('validates the mode: enforce is refused while the operator kill switch is on, junk is rejected', async () => {
    // The test setup runs with IAM_ENFORCE_DISABLED=1 (see __tests__/setup.ts).
    expect(await setMode('enforce')).toMatchObject({ status: 409, body: { code: 'enforce_disabled' } });
    expect(await setMode('turbo')).toMatchObject({ status: 400, body: { code: 'invalid_mode' } });
    expect((await call('PUT', '/api/iam/mode', users.owner, { body: {} })).status).toBe(400);
    expect((await call('GET', '/api/iam/shadow/summary?category=nope', users.owner)).status).toBe(400);
  });

  it('switching back to legacy stops collection', async () => {
    await setMode('shadow');
    await call('POST', '/api/iam/shadow/reset', users.owner);
    await setMode('legacy');
    resetShadowMetricsForTests();
    await call('GET', '/api/misc/zzz', users.plain);
    await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' });
    await drainShadowQueue();
    const summary = (await call('GET', '/api/iam/shadow/summary', users.owner)).body;
    expect(summary).toMatchObject({ mode: 'legacy', collecting: false });
    expect(summary.totals.events).toBe(0);
  });
});

describe('settings page contract: the UI parsers read the REAL /api/iam payloads', () => {
  it('summary: category counts, parity alert, services, flattened samples, direction counts, dropped', async () => {
    await call('POST', '/api/iam/shadow/reset', users.owner);
    await setMode('shadow');
    resetShadowMetricsForTests();
    await call('POST', '/api/client/v1/agents/probe', null, { token: 'tok-blocked' }); // token-groups (wouldAllow)
    await call('POST', '/api/agents/probe', users.member, { cookie: `active_project_id=${projectId}` }); // project-narrowing (wouldDeny)
    await call('GET', '/api/misc/abc', users.plain); // unmapped-path
    await drainShadowQueue();
    // A parity mismatch can only come from an engine bug; inject the aggregate the evaluator would write.
    recordShadowEvent(env.tenantDbName, {
      category: 'parity-mismatch', service: 'agents', method: 'POST', route: '/api/agents/x',
      legacyAllowed: true, targetAllowed: false,
      sample: { requestId: 'r1', userId: 'u1', role: 'user', at: new Date().toISOString(), detail: 'legacy=allow engine=deny' },
    });

    const body = (await call('GET', '/api/iam/shadow/summary', users.owner)).body;
    const view = parseSummary(body);
    expect(view.mode).toBe('shadow');
    expect(view.collecting).toBe(true);
    expect(view.categories['parity-mismatch'].events).toBe(1); // the red alert's input
    expect(view.categories['token-groups']).toMatchObject({ events: 1, wouldAllow: 1, wouldDeny: 0 });
    expect(view.categories['project-narrowing']).toMatchObject({ events: 1, wouldDeny: 1 });
    expect(view.categories['unmapped-path'].events).toBe(1);
    expect(view.totalEvents).toBe(4);
    expect(view.perService.find((r) => r.service === 'agents')?.total).toBeGreaterThanOrEqual(3);
    expect(view.topRoutes.length).toBeGreaterThanOrEqual(4);
    // samples are nested in topRoutes[] in the API; the view flattens them with route context
    expect(view.samples.length).toBeGreaterThanOrEqual(4);
    const mismatchSample = view.samples.find((x) => x.category === 'parity-mismatch');
    expect(mismatchSample).toMatchObject({ route: '/api/agents/x', method: 'POST', detail: 'legacy=allow engine=deny' });
    expect(view.dropped).toEqual({ keys: 0, events: 0 });
  });

  it('mode and stats (process scope on-prem, tenant scope in SaaS without platform-level figures)', async () => {
    expect(parseMode((await call('GET', '/api/iam/mode', users.owner)).body)).toBe('shadow');
    const previous = process.env.DEPLOYMENT_MODE;
    try {
      await call('GET', '/api/agents/probe', users.plain);
      await drainShadowQueue();
      process.env.DEPLOYMENT_MODE = 'onprem';
      reloadConfig();
      const onprem = (await call('GET', '/api/iam/engine/stats', users.owner)).body;
      const p = parseStats(onprem);
      expect(p.statsScope).toBe('process');
      expect(p.decisions).toBeGreaterThan(0);
      expect(p.p50Us).toEqual(expect.any(Number));
      expect(p.cacheHitRate).toEqual(expect.any(Number));
      expect(p.queueDepth).toEqual(expect.any(Number));

      process.env.DEPLOYMENT_MODE = 'saas';
      reloadConfig();
      const saas = (await call('GET', '/api/iam/engine/stats', users.owner)).body;
      const t = parseStats(saas);
      expect(t.statsScope).toBe('tenant');
      expect(saas.engine.tenantsLoaded).toBeUndefined();
      expect(saas.engine.allows).toBeUndefined();
      expect(saas.shadow.queue).toBeUndefined();
      expect(saas.shadow.uptimeMs).toBeUndefined();
      expect(t.decisions).toBeGreaterThan(0); // this tenant's evaluations
      expect(t.p50Us).toBeNull();

      // summary "dropped" is this tenant's figure too
      const summary = (await call('GET', '/api/iam/shadow/summary', users.owner)).body;
      expect(summary.dropped).toEqual({ keys: expect.any(Number), events: expect.any(Number) });
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_MODE;
      else process.env.DEPLOYMENT_MODE = previous;
      reloadConfig();
    }
  });
});
