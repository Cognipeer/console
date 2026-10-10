/**
 * The webhook management API on both surfaces — dashboard (`/api/webhooks…`)
 * and client (`/api/client/v1/webhooks…`) — against a real SQLite provider:
 * who may see and manage which endpoint (project admin / tenant admin / plain
 * member / another project), the one-time secret, URL and event validation,
 * test sends, deliveries and redelivery, and the RBAC route mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  safeFetch: vi.fn(),
  assertPublicUrl: vi.fn(),
  publish: vi.fn(),
  projectContext: vi.fn(),
  requireApiToken: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await hoisted.getDatabase()),
  };
});
vi.mock('@/lib/security/outboundFetch', () => ({
  assertPublicUrl: hoisted.assertPublicUrl,
  safeFetch: hoisted.safeFetch,
}));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return { ...actual, requireProjectContextForRequest: hoisted.projectContext };
});
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

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { decryptObject } from '@/lib/utils/crypto';
import { webhooksApiPlugin } from '@/server/api/plugins/webhooks';
import { clientWebhooksApiPlugin } from '@/server/api/plugins/client-webhooks';
import { authorizeServiceRequest, getPermissionServiceForPath, getRequiredPermissionLevel } from '@/lib/security/rbac';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_webhook_api';
const PROJECT = 'proj-1';
const headers = { authorization: 'Bearer t' };
const jsonHeaders = { ...headers, 'content-type': 'application/json' };

type Role = 'tenant_admin' | 'project_admin' | 'member';
const WHO: Record<Role, { user: { _id: string; role: string; email: string }; userProject: { role: string } | null }> = {
  tenant_admin: { user: { _id: 'u-admin', role: 'admin', email: 'a@x.io' }, userProject: null },
  project_admin: { user: { _id: 'u-padmin', role: 'user', email: 'p@x.io' }, userProject: { role: 'project_admin' } },
  member: { user: { _id: 'u-member', role: 'user', email: 'm@x.io' }, userProject: { role: 'member' } },
};

function actAs(role: Role, projectId = PROJECT) {
  hoisted.projectContext.mockResolvedValue({
    projectId,
    ...WHO[role],
    session: { tenantDbName: dbName, tenantId, userId: WHO[role].user._id },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  reloadConfig();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'webhook-api-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-wh-api', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'owner-1' });
  hoisted.assertPublicUrl.mockResolvedValue(undefined);
  hoisted.safeFetch.mockResolvedValue(new Response(null, { status: 200 }));
  hoisted.publish.mockResolvedValue(undefined);
});

afterEach(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

const body = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://hooks.example.com/in', events: ['session.idled', 'agent_run.*'], description: 'Ops channel', ...overrides,
});

describe('dashboard /api/webhooks', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  beforeEach(async () => { app = await createFastifyApiTestApp(webhooksApiPlugin); });
  afterEach(async () => { await app.close(); });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/webhooks${url}`, ...(payload !== undefined ? { headers: jsonHeaders, payload: JSON.stringify(payload) } : { headers }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = <T = Record<string, any>>(res: { body: string }) => parseJsonBody<T>(res.body);

  it('create returns the secret once; list and get never do, and the stored copy is sealed', async () => {
    actAs('project_admin');
    const created = await call('POST', '', body());
    expect(created.statusCode).toBe(201);
    const { endpoint } = json(created);
    expect(endpoint.id).toMatch(/^whk_/);
    expect(endpoint.secret).toMatch(/^whsec_/);
    expect(endpoint).toMatchObject({ projectId: PROJECT, status: 'active', events: ['session.idled', 'agent_run.*'], description: 'Ops channel', createdBy: 'u-padmin' });

    const stored = await db.findWebhookEndpointById(endpoint.id);
    expect(stored?.secretSealed).not.toContain(endpoint.secret);
    expect(decryptObject<string>(stored!.secretSealed)).toBe(endpoint.secret);

    const listed = json(await call('GET', ''));
    expect(listed.endpoints).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('secret');
    expect(JSON.stringify(json(await call('GET', `/${endpoint.id}`)))).not.toContain('whsec_');
  });

  it('rotate-secret returns a new secret and the next delivery is signed with it', async () => {
    actAs('project_admin');
    const { endpoint } = json(await call('POST', '', body()));
    const rotated = json(await call('POST', `/${endpoint.id}/rotate-secret`)).endpoint;
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(endpoint.secret);

    await call('POST', `/${endpoint.id}/test`);
    const [, init] = hoisted.safeFetch.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(init.headers['x-cognipeer-signature'])!;
    expect(v1).toBe(crypto.createHmac('sha256', rotated.secret).update(`${t}.${init.body}`).digest('hex'));
    expect(v1).not.toBe(crypto.createHmac('sha256', endpoint.secret).update(`${t}.${init.body}`).digest('hex'));
  });

  it('a plain project member can do nothing (403), not even list', async () => {
    actAs('member');
    expect((await call('GET', '')).statusCode).toBe(403);
    expect((await call('POST', '', body())).statusCode).toBe(403);
    expect(await db.listWebhookEndpoints(tenantId)).toHaveLength(0);
  });

  it('a member gets 403, never 404, on every route of an endpoint of their own project (404 is for managers out of reach)', async () => {
    actAs('project_admin');
    const mine = json(await call('POST', '', body())).endpoint;
    actAs('member');
    expect((await call('GET', `/${mine.id}`)).statusCode).toBe(403);
    expect((await call('PATCH', `/${mine.id}`, { description: 'x' })).statusCode).toBe(403);
    expect((await call('DELETE', `/${mine.id}`)).statusCode).toBe(403);
    expect((await call('POST', `/${mine.id}/rotate-secret`)).statusCode).toBe(403);
    expect((await call('POST', `/${mine.id}/test`)).statusCode).toBe(403);
    expect((await call('GET', `/${mine.id}/deliveries`)).statusCode).toBe(403);
    expect((await call('POST', '/deliveries/nope/redeliver')).statusCode).toBe(403);
    // The event catalog is the one thing a member may read.
    expect((await call('GET', '/events')).statusCode).toBe(200);
    expect(await db.findWebhookEndpointById(mine.id)).toBeTruthy();
  });

  it('a project admin manages only endpoints of their own project', async () => {
    actAs('tenant_admin');
    const wide = json(await call('POST', '', body({ projectId: null }))).endpoint;
    const otherProject = await db.createWebhookEndpoint({
      tenantId, projectId: 'a-real-other-project', url: 'https://o.example.com', events: ['*'], secretSealed: 'x', status: 'active', createdBy: 'u',
    });

    actAs('project_admin');
    const mine = json(await call('POST', '', body())).endpoint;
    const listed = json(await call('GET', '')).endpoints.map((e: { id: string }) => e.id);
    expect(listed).toEqual([mine.id]);

    // Tenant-wide and other-project endpoints do not exist as far as they can tell.
    for (const id of [wide.id, String(otherProject._id)]) {
      expect((await call('GET', `/${id}`)).statusCode).toBe(404);
      expect((await call('PATCH', `/${id}`, { description: 'hijack' })).statusCode).toBe(404);
      expect((await call('DELETE', `/${id}`)).statusCode).toBe(404);
      expect((await call('POST', `/${id}/rotate-secret`)).statusCode).toBe(404);
      expect((await call('POST', `/${id}/test`)).statusCode).toBe(404);
      expect((await call('GET', `/${id}/deliveries`)).statusCode).toBe(404);
    }
    expect((await db.findWebhookEndpointById(wide.id))?.description).toBe('Ops channel');
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('a project admin cannot create a tenant-wide endpoint or one for another project', async () => {
    actAs('project_admin');
    expect((await call('POST', '', body({ projectId: null }))).statusCode).toBe(403);
    expect((await call('POST', '', body({ projectId: '*' }))).statusCode).toBe(403);
    expect((await call('POST', '', body({ projectId: 'someone-elses' }))).statusCode).toBe(403);
    expect(await db.listWebhookEndpoints(tenantId)).toHaveLength(0);
  });

  it('a tenant admin sees this project plus tenant-wide endpoints, manages them, and may target another project that exists', async () => {
    const realOther = await db.createProject({ tenantId, key: 'second', name: 'Second', createdBy: 'owner-1' });
    actAs('tenant_admin');
    const wide = json(await call('POST', '', body({ projectId: null }))).endpoint;
    const here = json(await call('POST', '', body())).endpoint;
    const there = (await call('POST', '', body({ projectId: String(realOther._id) })));
    expect(there.statusCode).toBe(201);
    expect((await call('POST', '', body({ projectId: 'no-such-project' }))).statusCode).toBe(400);

    const listed = json(await call('GET', '')).endpoints;
    expect(listed.map((e: { id: string }) => e.id).sort()).toEqual([wide.id, here.id].sort());
    expect(listed.find((e: { id: string }) => e.id === wide.id).projectId).toBeNull();
    expect((await call('PATCH', `/${wide.id}`, { description: 'renamed' })).statusCode).toBe(200);
    // ...and reaches the other project's endpoint by id.
    expect((await call('GET', `/${json(there).endpoint.id}`)).statusCode).toBe(200);
  });

  it('validates the URL (public address) and the events', async () => {
    actAs('project_admin');
    expect((await call('POST', '', body({ url: undefined }))).statusCode).toBe(400);
    expect((await call('POST', '', body({ url: 'not a url' }))).statusCode).toBe(400);
    expect((await call('POST', '', body({ url: 'ftp://x.example.com' }))).statusCode).toBe(400);

    const ssrf = new Error('Refusing outbound request to private/loopback host: localhost');
    ssrf.name = 'OutboundNetworkError';
    hoisted.assertPublicUrl.mockRejectedValueOnce(ssrf);
    const refused = await call('POST', '', body({ url: 'http://localhost:8080/hook' }));
    expect(refused.statusCode).toBe(400);
    expect(json(refused).error).toMatch(/public address/);

    expect((await call('POST', '', body({ events: [] }))).statusCode).toBe(400);
    expect((await call('POST', '', body({ events: ['made.up'] }))).statusCode).toBe(400);
    expect((await call('POST', '', body({ description: 'x'.repeat(501) }))).statusCode).toBe(400);
    expect(await db.listWebhookEndpoints(tenantId)).toHaveLength(0);
  });

  it('PATCH edits url / events / description, and disabling fails what was queued; enabling again clears the reason and the streak', async () => {
    actAs('project_admin');
    const { endpoint } = json(await call('POST', '', body()));
    const patched = json(await call('PATCH', `/${endpoint.id}`, { url: 'https://new.example.com/h', events: ['budget.reached'], description: '' })).endpoint;
    expect(patched).toMatchObject({ url: 'https://new.example.com/h', events: ['budget.reached'], description: null });

    const { publishWebhookEvent } = await import('@/lib/services/webhooks/webhookService');
    await publishWebhookEvent({ tenantDbName: dbName, tenantId, projectId: PROJECT, type: 'budget.reached', data: {} });
    expect((await db.listWebhookDeliveries(endpoint.id))[0].status).toBe('pending');

    const off = json(await call('PATCH', `/${endpoint.id}`, { status: 'disabled' })).endpoint;
    expect(off).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    expect((await db.listWebhookDeliveries(endpoint.id))[0].status).toBe('failed');

    await db.updateWebhookEndpoint(endpoint.id, { failingSince: new Date() });
    const on = json(await call('PATCH', `/${endpoint.id}`, { status: 'active' })).endpoint;
    expect(on).toMatchObject({ status: 'active', disabledReason: null, failingSince: null });

    expect((await call('PATCH', `/${endpoint.id}`, { status: 'paused' })).statusCode).toBe(400);
    expect((await call('PATCH', `/${endpoint.id}`, { url: 'nope' })).statusCode).toBe(400);
  });

  it('test sends a webhook.test event once and reports the answer; a 3xx there does not disable the endpoint', async () => {
    actAs('project_admin');
    const { endpoint } = json(await call('POST', '', body()));

    const ok = json(await call('POST', `/${endpoint.id}/test`)).delivery;
    expect(ok).toMatchObject({ eventType: 'webhook.test', status: 'delivered', attempts: 1, lastStatusCode: 200 });
    expect((hoisted.safeFetch.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers['x-cognipeer-event']).toBe('webhook.test');

    hoisted.safeFetch.mockResolvedValue(new Response(null, { status: 302 }));
    const moved = json(await call('POST', `/${endpoint.id}/test`)).delivery;
    expect(moved).toMatchObject({ status: 'failed', lastStatusCode: 302 });
    hoisted.safeFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    const failed = json(await call('POST', `/${endpoint.id}/test`)).delivery;
    expect(failed).toMatchObject({ status: 'failed', lastStatusCode: 500 });

    const after = await db.findWebhookEndpointById(endpoint.id);
    expect(after).toMatchObject({ status: 'active' });
    expect(after?.failingSince ?? null).toBeNull();
    // Test sends are not queued retries.
    expect(await db.listDueWebhookDeliveries(tenantId, new Date(Date.now() + 86_400_000))).toHaveLength(0);
  });

  it('lists deliveries newest first (paged) and redelivers a failed one under the same event id', async () => {
    actAs('project_admin');
    const { endpoint } = json(await call('POST', '', body()));
    hoisted.safeFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    await call('POST', `/${endpoint.id}/test`);
    await call('POST', `/${endpoint.id}/test`);
    await call('POST', `/${endpoint.id}/test`);

    const page = json(await call('GET', `/${endpoint.id}/deliveries?limit=2`));
    expect(page.deliveries).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.deliveries[0]).toMatchObject({ eventType: 'webhook.test', status: 'failed', attempts: 1, lastStatusCode: 500 });
    const rest = json(await call('GET', `/${endpoint.id}/deliveries?limit=2&skip=2`));
    expect(rest.deliveries).toHaveLength(1);
    expect(rest.hasMore).toBe(false);

    const failed = page.deliveries[0];
    hoisted.publish.mockClear();
    const redelivered = await call('POST', '/deliveries/' + failed.id + '/redeliver');
    expect(redelivered.statusCode).toBe(202);
    expect(json(redelivered).delivery).toMatchObject({ id: failed.id, eventId: failed.eventId, status: 'pending', attempts: 0 });
    expect(hoisted.publish).toHaveBeenCalledTimes(1);
    expect(hoisted.publish.mock.calls[0][2]).toEqual({ deliveryId: failed.id, tenantDbName: dbName });

    // Already waiting: not again.
    expect((await call('POST', '/deliveries/' + failed.id + '/redeliver')).statusCode).toBe(409);
    // A disabled endpoint is not redelivered to.
    await call('PATCH', `/${endpoint.id}`, { status: 'disabled' });
    const other = page.deliveries[1];
    expect((await call('POST', '/deliveries/' + other.id + '/redeliver')).statusCode).toBe(409);
  });

  it('redelivery is as scoped as the endpoint: a project admin cannot redeliver into another project', async () => {
    const foreign = await db.createWebhookEndpoint({
      tenantId, projectId: 'a-real-other-project', url: 'https://o.example.com', events: ['*'], secretSealed: 'x', status: 'active', createdBy: 'u',
    });
    const [delivery] = await db.createWebhookDeliveries([{
      tenantId, projectId: 'a-real-other-project', endpointId: String(foreign._id), eventId: 'evt_x', eventType: 'session.idled',
      payload: {}, status: 'failed', attempts: 3, createdAt: new Date(),
    }]);
    actAs('project_admin');
    expect((await call('POST', `/deliveries/${String(delivery._id)}/redeliver`)).statusCode).toBe(404);
    expect((await call('POST', '/deliveries/nope/redeliver')).statusCode).toBe(404);
    expect(hoisted.publish).not.toHaveBeenCalled();
  });

  it('delete removes the endpoint and its deliveries', async () => {
    actAs('project_admin');
    const { endpoint } = json(await call('POST', '', body()));
    await call('POST', `/${endpoint.id}/test`);
    expect((await call('DELETE', `/${endpoint.id}`)).statusCode).toBe(200);
    expect(await db.findWebhookEndpointById(endpoint.id)).toBeNull();
    expect(await db.listWebhookDeliveries(endpoint.id)).toHaveLength(0);
    expect((await call('GET', `/${endpoint.id}`)).statusCode).toBe(404);
  });

  it('serves the event catalog for forms', async () => {
    actAs('project_admin');
    const { events } = json(await call('GET', '/events'));
    expect(events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining([
      'session.idled', 'session.work_done', 'action.required', 'budget.reached',
      'agent_run.succeeded', 'agent_run.failed', 'agent_run.canceled', 'agent_run.requires_action',
      'schedule.fired', 'schedule.failed',
    ]));
    expect(events.map((e: { type: string }) => e.type)).not.toContain('webhook.test');
  });
});

describe('client /api/client/v1/webhooks', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  beforeEach(async () => { app = await createFastifyApiTestApp(clientWebhooksApiPlugin); });
  afterEach(async () => { await app.close(); });

  function token(role: Role, extra: { servicePermissions?: Record<string, string> | null } = {}) {
    const who = WHO[role];
    hoisted.requireApiToken.mockResolvedValue({
      token: 'tok',
      tokenRecord: { _id: 'tok-1', userId: who.user._id, servicePermissions: extra.servicePermissions ?? null },
      tenant: { licenseType: 'STARTER' },
      tenantId,
      tenantSlug: 'acme-wh-api',
      tenantDbName: dbName,
      projectId: PROJECT,
      user: who.user,
    });
  }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/client/v1/webhooks${url}`, ...(payload !== undefined ? { headers: jsonHeaders, payload: JSON.stringify(payload) } : { headers }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = <T = Record<string, any>>(res: { body: string }) => parseJsonBody<T>(res.body);

  it('a token owned by a project admin manages its own project; a member-owned token is refused', async () => {
    await db.upsertUserProject({ tenantId, userId: 'u-padmin', projectId: PROJECT, role: 'project_admin' });
    token('project_admin');
    const created = await call('POST', '', body());
    expect(created.statusCode).toBe(201);
    const { endpoint } = json(created);
    expect(endpoint).toMatchObject({ projectId: PROJECT, createdBy: 'u-padmin' });
    expect(endpoint.secret).toMatch(/^whsec_/);
    expect(json(await call('GET', '')).endpoints).toHaveLength(1);
    expect((await call('POST', '', body({ projectId: null }))).statusCode).toBe(403);

    await db.upsertUserProject({ tenantId, userId: 'u-member', projectId: PROJECT, role: 'member' });
    token('member');
    expect((await call('GET', '')).statusCode).toBe(403);
    expect((await call('GET', `/${endpoint.id}`)).statusCode).toBe(403);
    expect((await call('DELETE', `/${endpoint.id}`)).statusCode).toBe(403);
    expect(await db.findWebhookEndpointById(endpoint.id)).not.toBeNull();
  });

  it('a project-scoped token never acts as a tenant admin: no tenant-wide endpoints, none for other projects', async () => {
    token('tenant_admin');
    const wide = await call('POST', '', body({ projectId: null }));
    expect(wide.statusCode).toBe(403);
    const other = await call('POST', '', body({ projectId: 'some-other-project' }));
    expect(other.statusCode).toBe(403);

    // Its own project is still within reach.
    const own = json(await call('POST', '', body({ projectId: PROJECT }))).endpoint;
    expect(own.projectId).toBe(PROJECT);
    expect((await call('POST', `/${own.id}/test`)).statusCode).toBe(200);

    // A tenant-wide endpoint (made by a dashboard tenant admin) is out of the token's reach.
    const tenantWide = await db.createWebhookEndpoint({
      tenantId, projectId: null, url: 'https://hooks.example.com/all', events: ['session.*'],
      secretSealed: 'x', status: 'active', createdBy: 'u-tenant-admin',
    } as never);
    expect((await call('GET', `/${tenantWide._id}`)).statusCode).toBe(404);
    expect((await call('GET', `/${tenantWide._id}/deliveries`)).statusCode).toBe(404);
    expect(json(await call('GET', '')).endpoints.map((e: { id: string }) => e.id)).toEqual([own.id]);
  });

  it('a token scoped away from webhooks is stopped by the RBAC gate before any handler runs', async () => {
    token('tenant_admin', { servicePermissions: { agents: 'admin' } });
    const res = await call('GET', '');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toMatch(/webhooks/);
  });

  it('a call without a valid token is refused', async () => {
    const { ApiTokenAuthError } = await import('@/lib/services/apiTokenAuth');
    hoisted.requireApiToken.mockRejectedValue(new ApiTokenAuthError('Invalid token', 401));
    expect((await call('GET', '')).statusCode).toBe(401);
  });
});

describe('RBAC route mapping', () => {
  it('maps both surfaces (every sub-route) to the webhooks service', () => {
    for (const prefix of ['/api/webhooks', '/api/client/v1/webhooks']) {
      expect(getPermissionServiceForPath(prefix)).toBe('webhooks');
      expect(getPermissionServiceForPath(`${prefix}/whk_1/deliveries`)).toBe('webhooks');
      expect(getPermissionServiceForPath(`${prefix}/deliveries/whd_1/redeliver`)).toBe('webhooks');
    }
  });

  it('reads need read, writes need write (not an admin-only service: project admins manage their own)', () => {
    expect(getRequiredPermissionLevel('GET', 'webhooks')).toBe('read');
    expect(getRequiredPermissionLevel('POST', 'webhooks')).toBe('write');
    expect(getRequiredPermissionLevel('DELETE', 'webhooks')).toBe('write');
    expect(authorizeServiceRequest({ role: 'user' }, 'POST', '/api/webhooks').allowed).toBe(true);
    expect(authorizeServiceRequest({ role: 'user' }, 'POST', '/api/webhooks', [], { agents: 'admin' }).allowed).toBe(false);
  });
});
