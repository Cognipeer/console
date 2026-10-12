/**
 * The webhook management API on both surfaces — dashboard (`/api/webhooks…`)
 * and client (`/api/client/v1/webhooks…`) — against a real SQLite provider, the
 * REAL request gate and the REAL policy engine on both halves.
 *
 * Who may do what is the engine's answer on the `webhooks` service and nothing
 * else: an administration service, so owners and admins hold it, everybody else
 * holds nothing until the Authorization center grants it; reading needs `read`,
 * every change `admin`. What the routes add is data scoping: an endpoint of the
 * request's project is within reach of whoever passed the gate; a tenant-wide one
 * or another project's needs the permission in the workspace itself, and a token
 * never has that. Also here: the one-time secret, URL and event validation, test
 * sends, deliveries and redelivery, and the RBAC route mapping.
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
  requireApiToken: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});
vi.mock('@/lib/security/outboundFetch', () => ({
  assertPublicUrl: hoisted.assertPublicUrl,
  safeFetch: hoisted.safeFetch,
}));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
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

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IUser } from '@/lib/database';
import { reloadConfig } from '@/lib/core/config';
import { decryptObject } from '@/lib/utils/crypto';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetEffectiveLevelsForTests } from '@/lib/iam/effective';
import { createPolicy } from '@/lib/iam/store';
import { webhooksApiPlugin } from '@/server/api/plugins/webhooks';
import { clientWebhooksApiPlugin } from '@/server/api/plugins/client-webhooks';
import { authorizeServiceRequest, getPermissionServiceForPath, getRequiredPermissionLevel } from '@/lib/security/rbac';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
/** The active project of the dashboard requests, and one more. */
let PROJECT: string;
let OTHER: string;
const dbName = 'tenant_webhook_api';
const headers = { authorization: 'Bearer t' };
const jsonHeaders = { ...headers, 'content-type': 'application/json' };

/**
 * The people of the workspace. Nobody but the owner and the admin holds `webhooks` by default; the others get
 * what each test grants them (an explicit permission, a group, a project limit, a policy).
 */
type Who = 'owner' | 'admin' | 'member' | 'project_admin';
const users = {} as Record<Who, IUser>;

async function addUser(who: Who, role: 'owner' | 'admin' | 'user' | 'project_admin', extra: Partial<IUser> = {}): Promise<IUser> {
  const user = await db.createUser({
    tenantId, email: `${who}@x.io`, name: who, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
  });
  users[who] = user;
  return user;
}

const sessionHeaders = (who: Who, project = PROJECT) => ({
  'x-tenant-db-name': dbName,
  'x-tenant-id': tenantId,
  'x-tenant-slug': 'acme-wh-api',
  'x-user-id': String(users[who]._id),
  'x-user-role': String(users[who].role),
  'x-user-email': String(users[who].email),
  'x-license-type': 'FREE',
  cookie: `active_project_id=${project}`,
});

/** Who the next dashboard request is made by. */
let actor: Who = 'admin';
function actAs(who: Who, project?: string) {
  actor = who;
  if (project) activeProject = project;
}
let activeProject: string;

/** A token of `who` (the owner's row is read again: the gate sees the permissions the owner has NOW). */
async function tokenFor(who: Who, extra: { servicePermissions?: Record<string, string> | null } = {}) {
  users[who] = (await db.findUserById(String(users[who]._id)))!;
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: String(users[who]._id), servicePermissions: extra.servicePermissions ?? null },
    tenant: { licenseType: 'STARTER' },
    tenantId,
    tenantSlug: 'acme-wh-api',
    tenantDbName: dbName,
    projectId: PROJECT,
    user: users[who],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  reloadConfig();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'webhook-api-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  resetProjectNarrowingCachesForTests();
  resetEffectiveLevelsForTests();
  configureIamEngine({ validateRequests: false });
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-wh-api', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  PROJECT = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'owner-1' }))._id);
  OTHER = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'owner-1' }))._id);
  activeProject = PROJECT;
  actor = 'admin';
  await addUser('owner', 'owner');
  await addUser('admin', 'admin');
  await addUser('member', 'user');
  // A project admin by membership; as a person they hold nothing on administration services.
  await addUser('project_admin', 'user');
  for (const who of ['member', 'project_admin'] as const) {
    await db.upsertUserProject({ tenantId, userId: String(users[who]._id), projectId: PROJECT, role: who === 'project_admin' ? 'project_admin' : 'member' });
  }
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

/** A custom policy, in force from now on (the engine reads the policy set fresh). */
async function installPolicy(policyId: string, cedar: string) {
  await createPolicy(dbName, { policyId, name: policyId, cedar }, 'tester');
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetEffectiveLevelsForTests();
  resetPrincipalCacheForTests();
}
const userIs = (who: Who) => `principal == User::"${String(users[who]._id)}"`;

/** Every call that changes something, against the endpoint `id` (redelivery of an unknown id: it passes the gate and finds nothing). */
const changesOf = (id: string) => [
  ['POST', '', body()],
  ['PATCH', `/${id}`, { description: 'edited' }],
  ['POST', `/${id}/rotate-secret`, undefined],
  ['POST', `/${id}/test`, undefined],
  ['POST', '/deliveries/nope/redeliver', undefined],
  ['DELETE', `/${id}`, undefined],
] as const;
/** What each of those answers when the gate lets it through. */
const CHANGES_ALLOWED = [201, 200, 200, 200, 404, 200];
const SECRET_URL = 'https://hooks.example.com/services/T0/B0?token=abc';

describe('dashboard /api/webhooks', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  beforeEach(async () => { app = await createFastifyApiTestApp(webhooksApiPlugin); });
  afterEach(async () => { await app.close(); });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/webhooks${url}`,
      headers: { ...sessionHeaders(actor, activeProject), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = <T = Record<string, any>>(res: { body: string }) => parseJsonBody<T>(res.body);
  /** An explicit `webhooks` level on a person. */
  const grant = (who: Who, level: 'read' | 'admin' | 'none') => db.updateUser(String(users[who]._id), { servicePermissions: { webhooks: level } } as never);
  /** What the page is built from. */
  const capabilitiesOf = async () => json(await call('GET', '')).capabilities;
  const tenantWide = (extra: Record<string, unknown> = {}) => db.createWebhookEndpoint({
    tenantId, projectId: null, url: 'https://hooks.example.com/all', events: ['session.*'], secretSealed: 'x', status: 'active', createdBy: 'someone', ...extra,
  } as never);
  const inOtherProject = () => db.createWebhookEndpoint({
    tenantId, projectId: OTHER, url: 'https://o.example.com', events: ['*'], secretSealed: 'x', status: 'active', createdBy: 'u',
  });

  describe('the owner and the admin', () => {
    it('create returns the secret once; list and get never do, and the stored copy is sealed', async () => {
      actAs('admin');
      const created = await call('POST', '', body());
      expect(created.statusCode).toBe(201);
      const { endpoint } = json(created);
      expect(endpoint.id).toMatch(/^whk_/);
      expect(endpoint.secret).toMatch(/^whsec_/);
      expect(endpoint).toMatchObject({ projectId: PROJECT, status: 'active', events: ['session.idled', 'agent_run.*'], description: 'Ops channel', createdBy: String(users.admin._id) });

      const stored = await db.findWebhookEndpointById(endpoint.id);
      expect(stored?.secretSealed).not.toContain(endpoint.secret);
      expect(decryptObject<string>(stored!.secretSealed)).toBe(endpoint.secret);

      const listed = json(await call('GET', ''));
      expect(listed.endpoints).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain('secret');
      expect(JSON.stringify(json(await call('GET', `/${endpoint.id}`)))).not.toContain('whsec_');
    });

    it('the list says what the engine lets the caller do here (the page is built from it)', async () => {
      actAs('owner');
      expect(await capabilitiesOf()).toEqual({ manage: true, workspaceScope: true });
    });

    it('a tenant admin sees this project plus tenant-wide endpoints, manages them, and may target another project that exists', async () => {
      actAs('admin');
      const wide = json(await call('POST', '', body({ projectId: null }))).endpoint;
      const here = json(await call('POST', '', body())).endpoint;
      const there = await call('POST', '', body({ projectId: OTHER }));
      expect(there.statusCode).toBe(201);
      expect((await call('POST', '', body({ projectId: 'no-such-project' }))).statusCode).toBe(400);

      const listed = json(await call('GET', '')).endpoints;
      expect(listed.map((e: { id: string }) => e.id).sort()).toEqual([wide.id, here.id].sort());
      expect(listed.find((e: { id: string }) => e.id === wide.id).projectId).toBeNull();
      expect((await call('PATCH', `/${wide.id}`, { description: 'renamed' })).statusCode).toBe(200);
      // ...and reaches the other project's endpoint by id.
      expect((await call('GET', `/${json(there).endpoint.id}`)).statusCode).toBe(200);
    });

    it('rotate-secret returns a new secret and the next delivery is signed with it', async () => {
      actAs('admin');
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
  });

  describe('everybody else holds nothing until it is granted', () => {
    it('a plain member is refused by the gate on every route - the event catalog included - with the engine\'s reason', async () => {
      actAs('admin');
      const mine = json(await call('POST', '', body())).endpoint;
      actAs('member');
      for (const [method, url, payload] of [
        ['GET', '', undefined], ['POST', '', body()], ['GET', '/events', undefined],
        ['GET', `/${mine.id}`, undefined], ['PATCH', `/${mine.id}`, { description: 'x' }], ['DELETE', `/${mine.id}`, undefined],
        ['POST', `/${mine.id}/rotate-secret`, undefined], ['POST', `/${mine.id}/test`, undefined],
        ['GET', `/${mine.id}/deliveries`, undefined], ['POST', '/deliveries/nope/redeliver', undefined],
      ] as const) {
        const res = await call(method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(json(res), `${method} ${url}`).toMatchObject({ code: 'forbidden', service: 'webhooks', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      }
      expect(await db.findWebhookEndpointById(mine.id)).toBeTruthy();
      expect(hoisted.safeFetch).not.toHaveBeenCalled();
    });

    it('being the admin of a project is not a permission on webhooks: it takes a grant', async () => {
      actAs('project_admin');
      expect((await call('GET', '')).statusCode).toBe(403);
      expect((await call('POST', '', body())).statusCode).toBe(403);
      expect(await db.listWebhookEndpoints(tenantId)).toHaveLength(0);

      await grant('project_admin', 'admin');
      resetPrincipalCacheForTests();
      expect((await call('POST', '', body())).statusCode).toBe(201);
    });

    it('a person granted Read looks, and cannot change anything', async () => {
      actAs('admin');
      const mine = json(await call('POST', '', body())).endpoint;
      await grant('member', 'read');
      resetPrincipalCacheForTests();
      actAs('member');

      expect(json(await call('GET', '')).endpoints.map((e: { id: string }) => e.id)).toEqual([mine.id]);
      expect(await capabilitiesOf()).toEqual({ manage: false, workspaceScope: false });
      expect((await call('GET', `/${mine.id}`)).statusCode).toBe(200);
      expect((await call('GET', `/${mine.id}/deliveries`)).statusCode).toBe(200);
      expect((await call('GET', '/events')).statusCode).toBe(200);
      for (const [method, url, payload] of [
        ['POST', '', body()], ['PATCH', `/${mine.id}`, { description: 'x' }], ['DELETE', `/${mine.id}`, undefined],
        ['POST', `/${mine.id}/rotate-secret`, undefined], ['POST', `/${mine.id}/test`, undefined], ['POST', '/deliveries/nope/redeliver', undefined],
      ] as const) {
        expect((await call(method, url, payload)).statusCode, `${method} ${url}`).toBe(403);
      }
      expect((await db.findWebhookEndpointById(mine.id))?.description).toBe('Ops channel');
    });

    it('Read sees the receiver address without its query string and userinfo; Admin sees it whole (it is often a credential)', async () => {
      actAs('admin');
      const secretUrl = 'https://user:pw@hooks.example.com/services/T0/B0?token=abc#frag';
      const mine = json(await call('POST', '', body({ url: secretUrl }))).endpoint;
      expect(mine.url).toBe(secretUrl);
      expect(mine.urlRedacted).toBeUndefined();

      await grant('member', 'read');
      resetPrincipalCacheForTests();
      actAs('member');
      const listed = json(await call('GET', '')).endpoints[0];
      expect(listed).toMatchObject({ id: mine.id, url: 'https://hooks.example.com/services/T0/B0?…', urlRedacted: true });
      const got = json(await call('GET', `/${mine.id}`)).endpoint;
      expect(got).toMatchObject({ url: 'https://hooks.example.com/services/T0/B0?…', urlRedacted: true });
      expect(JSON.stringify([listed, got])).not.toMatch(/token=abc|user:pw|frag/);
      // the stored address is untouched, and an administrator still sees it whole
      expect((await db.findWebhookEndpointById(mine.id))?.url).toBe(secretUrl);
      await grant('member', 'admin');
      resetPrincipalCacheForTests();
      expect(json(await call('GET', `/${mine.id}`)).endpoint.url).toBe(secretUrl);
    });

    it('a tenant-wide address is whole only for Admin in the workspace: Read of a project never reaches it', async () => {
      const wide = await tenantWide({ url: 'https://hooks.example.com/all?key=zzz' });
      await grant('member', 'read');
      resetPrincipalCacheForTests();
      actAs('member');
      expect(json(await call('GET', `/${wide._id}`)).endpoint).toMatchObject({ url: 'https://hooks.example.com/all?…', urlRedacted: true });
      actAs('admin');
      expect(json(await call('GET', `/${wide._id}`)).endpoint.url).toBe('https://hooks.example.com/all?key=zzz');
    });

    it('Read in the workspace also shows the tenant-wide endpoints, still read-only', async () => {
      const wide = await tenantWide();
      await grant('member', 'read');
      resetPrincipalCacheForTests();
      actAs('member');
      expect(json(await call('GET', '')).endpoints.map((e: { id: string }) => e.id)).toEqual([String(wide._id)]);
      expect((await call('GET', `/${wide._id}`)).statusCode).toBe(200);
      expect((await call('PATCH', `/${wide._id}`, { description: 'hijack' })).statusCode).toBe(403);
    });

    it('a person granted Admin manages their project - and, the grant being workspace-level, tenant-wide endpoints too', async () => {
      await grant('member', 'admin');
      resetPrincipalCacheForTests();
      actAs('member');
      expect(await capabilitiesOf()).toEqual({ manage: true, workspaceScope: true });
      const mine = json(await call('POST', '', body())).endpoint;
      const wide = json(await call('POST', '', body({ projectId: null }))).endpoint;
      expect(wide.projectId).toBeNull();
      expect((await call('POST', `/${wide.id}/test`)).statusCode).toBe(200);
      expect((await call('DELETE', `/${mine.id}`)).statusCode).toBe(200);
    });

    it('a group that makes its members workspace admins gives them tenant-wide endpoints', async () => {
      const group = await db.createGroup({ tenantId, name: 'Ops', tenantRole: 'admin', createdBy: 't', source: 'local' } as never);
      await db.addGroupMember({ groupId: String(group._id), userId: String(users.member._id), tenantId, role: 'member' });
      resetPrincipalCacheForTests();
      actAs('member');
      const wide = json(await call('POST', '', body({ projectId: null })));
      expect(wide.endpoint.projectId).toBeNull();
    });

    it('a project\'s own limit on webhooks narrows the grant: read there, so no changes', async () => {
      const wide = await tenantWide();
      await grant('member', 'admin');
      // The project says Read for this member; its settings are older than nothing, so they count in full.
      await db.upsertUserProject({ tenantId, userId: String(users.member._id), projectId: PROJECT, role: 'member', servicePermissions: { webhooks: 'read' } } as never);
      resetPrincipalCacheForTests();
      actAs('member');
      expect((await call('GET', '')).statusCode).toBe(200);
      expect((await capabilitiesOf())).toEqual({ manage: false, workspaceScope: false });
      expect((await call('POST', '', body())).statusCode).toBe(403);
      expect((await call('PATCH', `/${wide._id}`, { description: 'x' })).statusCode).toBe(403);
      // another project of the same person is not limited
      await db.upsertUserProject({ tenantId, userId: String(users.member._id), projectId: OTHER, role: 'member' });
      activeProject = OTHER;
      expect((await call('POST', '', body())).statusCode).toBe(201);
    });

    it('an explicit none on a person takes webhooks away from an admin', async () => {
      await grant('admin', 'none');
      resetPrincipalCacheForTests();
      actAs('admin');
      expect((await call('GET', '')).statusCode).toBe(403);
      expect((await call('POST', '', body())).statusCode).toBe(403);
    });

    it('a deny policy on webhooks takes them away from whoever it names, and the refusal names the policy', async () => {
      await createPolicy(dbName, {
        policyId: 'no-webhook-changes',
        name: 'No webhook changes',
        cedar: `forbid (principal == User::"${String(users.admin._id)}", action == Action::"webhooks.admin", resource);`,
      }, 'tester');
      resetIamEngineForTests();
      configureIamEngine({ validateRequests: false });
      actAs('admin');
      expect((await call('GET', '')).statusCode).toBe(200);
      const refused = await call('POST', '', body());
      expect(refused.statusCode).toBe(403);
      expect(json(refused).decisionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await db.listWebhookEndpoints(tenantId)).toHaveLength(0);
      // the owner is not named
      actAs('owner');
      expect((await call('POST', '', body())).statusCode).toBe(201);
    });
  });

  describe('the gate asks for exactly Read to look and Admin to change', () => {
    // Cedar treats webhooks.read / .write / .admin as three actions; the gate of a route that changes something asks
    // for webhooks.admin (never the method-derived webhooks.write), so a rule that names only Write cannot edit a webhook.
    const withSecretUrl = async () => {
      actAs('admin');
      return json(await call('POST', '', body({ url: SECRET_URL }))).endpoint as { id: string };
    };
    const statusesOf = async (id: string) => {
      const out: number[] = [];
      for (const [method, url, payload] of changesOf(id)) out.push((await call(method, url, payload)).statusCode);
      return out;
    };

    it('an allow rule that names Write and Read lets a person look - and not change a thing, however it is called', async () => {
      const mine = await withSecretUrl();
      await installPolicy('write-and-read', `permit (${userIs('member')}, action in [Action::"webhooks.write", Action::"webhooks.read"], resource);`);
      actAs('member');

      const got = json(await call('GET', `/${mine.id}`)).endpoint;
      expect(got).toMatchObject({ url: 'https://hooks.example.com/services/T0/B0?…', urlRedacted: true });
      expect(await capabilitiesOf()).toEqual({ manage: false, workspaceScope: false });
      for (const [method, url, payload] of changesOf(mine.id)) {
        const res = await call(method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(json(res), `${method} ${url}`).toMatchObject({ code: 'forbidden', service: 'webhooks', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      }
      expect(await db.findWebhookEndpointById(mine.id)).toMatchObject({ description: 'Ops channel', url: SECRET_URL });
      expect(hoisted.safeFetch).not.toHaveBeenCalled();
    });

    it('the Write level group does not include Admin either', async () => {
      const mine = await withSecretUrl();
      await installPolicy('write-group', `permit (${userIs('member')}, action in [Action::"Write", Action::"Read"], resource);`);
      actAs('member');
      expect((await call('GET', '')).statusCode).toBe(200);
      expect((await call('PATCH', `/${mine.id}`, { description: 'edited' })).statusCode).toBe(403);
      expect((await call('POST', '', body())).statusCode).toBe(403);
      expect((await call('DELETE', `/${mine.id}`)).statusCode).toBe(403);
    });

    it('an allow rule that names Admin (with the levels it includes) lets a person change everything and see the address whole', async () => {
      const mine = await withSecretUrl();
      await installPolicy('admin-levels', `permit (${userIs('member')}, action in [Action::"webhooks.admin", Action::"webhooks.write", Action::"webhooks.read"], resource);`);
      actAs('member');
      expect(json(await call('GET', `/${mine.id}`)).endpoint.url).toBe(SECRET_URL);
      expect(await capabilitiesOf()).toEqual({ manage: true, workspaceScope: true });
      expect(await statusesOf(mine.id)).toEqual(CHANGES_ALLOWED);
    });

    it('a deny rule on Write blocks exactly Write: Admin still changes things and still sees the address whole', async () => {
      const mine = await withSecretUrl();
      await installPolicy('no-write', `forbid (${userIs('admin')}, action == Action::"webhooks.write", resource);`);
      actAs('admin');
      expect(json(await call('GET', `/${mine.id}`)).endpoint.url).toBe(SECRET_URL);
      expect(await capabilitiesOf()).toEqual({ manage: true, workspaceScope: true });
      expect(await statusesOf(mine.id)).toEqual(CHANGES_ALLOWED);
    });

    it('a deny rule on Admin blocks changes only: the person still reads, the address redacted', async () => {
      const mine = await withSecretUrl();
      await installPolicy('no-admin', `forbid (${userIs('admin')}, action == Action::"webhooks.admin", resource);`);
      actAs('admin');
      expect(json(await call('GET', `/${mine.id}`)).endpoint).toMatchObject({ url: 'https://hooks.example.com/services/T0/B0?…', urlRedacted: true });
      expect(await capabilitiesOf()).toEqual({ manage: false, workspaceScope: false });
      for (const [method, url, payload] of changesOf(mine.id)) {
        expect((await call(method, url, payload)).statusCode, `${method} ${url}`).toBe(403);
      }
      expect(await db.findWebhookEndpointById(mine.id)).toBeTruthy();
    });

    it('a deny rule on Read blocks reading only, as the rule says', async () => {
      const mine = await withSecretUrl();
      await installPolicy('no-read', `forbid (${userIs('admin')}, action == Action::"webhooks.read", resource);`);
      actAs('admin');
      expect((await call('GET', '')).statusCode).toBe(403);
      expect((await call('GET', `/${mine.id}`)).statusCode).toBe(403);
      expect((await call('GET', '/events')).statusCode).toBe(403);
      expect((await call('PATCH', `/${mine.id}`, { description: 'edited' })).statusCode).toBe(200);
    });
  });

  describe('what lies outside the request\'s project', () => {
    // (Nobody can hold the permission in a project without holding it in the workspace - a project only narrows - so
    // a caller that passes the gate and still lacks the workspace answer is a token, or someone a rule stops outside projects.)
    it('a custom rule that stops the workspace-level answer leaves only the project\'s endpoints in reach', async () => {
      // A deny that applies outside any project - no `projectId` in the context - removes the workspace-level Read and
      // Admin (a deny blocks exactly the actions it names). (Rules that name a project do not apply to a workspace-level answer.)
      const wide = await tenantWide();
      await createPolicy(dbName, {
        policyId: 'no-webhooks-outside-projects',
        name: 'No webhooks outside projects',
        cedar: `forbid (principal == User::"${String(users.admin._id)}", action in [Action::"webhooks.read", Action::"webhooks.admin"], resource) unless { context has projectId };`,
      }, 'tester');
      resetIamEngineForTests();
      configureIamEngine({ validateRequests: false });
      actAs('admin');
      const mine = json(await call('POST', '', body())).endpoint;
      expect(json(await call('GET', '')).endpoints.map((e: { id: string }) => e.id)).toEqual([mine.id]);
      expect((await call('GET', `/${wide._id}`)).statusCode).toBe(404);
      expect((await call('POST', '', body({ projectId: null }))).statusCode).toBe(403);
    });

    it('redelivery is as scoped as the endpoint', async () => {
      const foreign = await inOtherProject();
      const [delivery] = await db.createWebhookDeliveries([{
        tenantId, projectId: OTHER, endpointId: String(foreign._id), eventId: 'evt_x', eventType: 'session.idled',
        payload: {}, status: 'failed', attempts: 3, createdAt: new Date(),
      }]);
      // Admin of the workspace: reaches it. A holder of the permission in the project only: does not.
      actAs('admin');
      expect((await call('POST', `/deliveries/${String(delivery._id)}/redeliver`)).statusCode).toBe(202);
      expect((await call('POST', '/deliveries/nope/redeliver')).statusCode).toBe(404);
    });
  });

  describe('the endpoint itself', () => {
    it('validates the URL (public address) and the events', async () => {
      actAs('admin');
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
      actAs('admin');
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
      actAs('admin');
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
      actAs('admin');
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

    it('delete removes the endpoint and its deliveries', async () => {
      actAs('admin');
      const { endpoint } = json(await call('POST', '', body()));
      await call('POST', `/${endpoint.id}/test`);
      expect((await call('DELETE', `/${endpoint.id}`)).statusCode).toBe(200);
      expect(await db.findWebhookEndpointById(endpoint.id)).toBeNull();
      expect(await db.listWebhookDeliveries(endpoint.id)).toHaveLength(0);
      expect((await call('GET', `/${endpoint.id}`)).statusCode).toBe(404);
    });

    it('serves the event catalog for forms', async () => {
      actAs('admin');
      const { events } = json(await call('GET', '/events'));
      expect(events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining([
        'session.idled', 'session.work_done', 'action.required', 'budget.reached',
        'agent_run.succeeded', 'agent_run.failed', 'agent_run.canceled', 'agent_run.requires_action',
        'schedule.fired', 'schedule.failed',
      ]));
      expect(events.map((e: { type: string }) => e.type)).not.toContain('webhook.test');
    });
  });
});

describe('client /api/client/v1/webhooks', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  beforeEach(async () => { app = await createFastifyApiTestApp(clientWebhooksApiPlugin); });
  afterEach(async () => { await app.close(); });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/client/v1/webhooks${url}`, ...(payload !== undefined ? { headers: jsonHeaders, payload: JSON.stringify(payload) } : { headers }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = <T = Record<string, any>>(res: { body: string }) => parseJsonBody<T>(res.body);
  const grantAdmin = (who: Who) => db.updateUser(String(users[who]._id), { servicePermissions: { webhooks: 'admin' } } as never);

  it('a token acts as its owner: an owner with the permission manages the token\'s project; a member-owned token is refused', async () => {
    await grantAdmin('project_admin');
    await tokenFor('project_admin');
    const created = await call('POST', '', body());
    expect(created.statusCode).toBe(201);
    const { endpoint } = json(created);
    expect(endpoint).toMatchObject({ projectId: PROJECT, createdBy: String(users.project_admin._id) });
    expect(endpoint.secret).toMatch(/^whsec_/);
    expect(json(await call('GET', '')).endpoints).toHaveLength(1);
    expect((await call('POST', '', body({ projectId: null }))).statusCode).toBe(403);

    await tokenFor('member');
    resetPrincipalCacheForTests();
    expect((await call('GET', '')).statusCode).toBe(403);
    expect((await call('GET', `/${endpoint.id}`)).statusCode).toBe(403);
    expect((await call('DELETE', `/${endpoint.id}`)).statusCode).toBe(403);
    expect(await db.findWebhookEndpointById(endpoint.id)).not.toBeNull();
  });

  it('being the admin of the project is not a permission on webhooks for a token either', async () => {
    await tokenFor('project_admin');
    expect((await call('GET', '')).statusCode).toBe(403);
    expect((await call('POST', '', body())).statusCode).toBe(403);
  });

  it('a token never reaches beyond its project, even when its owner is a workspace admin: no tenant-wide endpoints, none for other projects', async () => {
    await tokenFor('admin');
    expect((await call('POST', '', body({ projectId: null }))).statusCode).toBe(403);
    expect((await call('POST', '', body({ projectId: OTHER }))).statusCode).toBe(403);

    // Its own project is still within reach.
    const own = json(await call('POST', '', body({ projectId: PROJECT }))).endpoint;
    expect(own.projectId).toBe(PROJECT);
    expect((await call('POST', `/${own.id}/test`)).statusCode).toBe(200);

    // A tenant-wide endpoint and another project's are out of the token's reach.
    const wide = await db.createWebhookEndpoint({
      tenantId, projectId: null, url: 'https://hooks.example.com/all', events: ['session.*'], secretSealed: 'x', status: 'active', createdBy: 'u-tenant-admin',
    } as never);
    const foreign = await db.createWebhookEndpoint({
      tenantId, projectId: OTHER, url: 'https://o.example.com', events: ['*'], secretSealed: 'x', status: 'active', createdBy: 'u',
    });
    for (const id of [String(wide._id), String(foreign._id)]) {
      expect((await call('GET', `/${id}`)).statusCode).toBe(404);
      expect((await call('GET', `/${id}/deliveries`)).statusCode).toBe(404);
      expect((await call('PATCH', `/${id}`, { description: 'hijack' })).statusCode).toBe(404);
      expect((await call('DELETE', `/${id}`)).statusCode).toBe(404);
    }
    const list = json(await call('GET', ''));
    expect(list.endpoints.map((e: { id: string }) => e.id)).toEqual([own.id]);
    expect(list.capabilities).toEqual({ manage: true, workspaceScope: false });
  });

  it('a token scoped to Read on webhooks lists, and cannot change anything; one scoped away is stopped by the gate', async () => {
    await tokenFor('admin', { servicePermissions: { webhooks: 'read' } });
    expect((await call('GET', '')).statusCode).toBe(200);
    expect((await call('GET', '/events')).statusCode).toBe(200);
    expect((await call('POST', '', body())).statusCode).toBe(403);

    await tokenFor('admin', { servicePermissions: { agents: 'admin' } });
    const res = await call('GET', '');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toMatch(/webhooks/);
  });

  describe('the gate asks for exactly Read to look and Admin to change', () => {
    const secretOwn = async () => {
      await tokenFor('admin');
      return json(await call('POST', '', body({ url: SECRET_URL }))).endpoint as { id: string };
    };

    it('a token whose owner is allowed Write and Read looks (address redacted) and changes nothing', async () => {
      const mine = await secretOwn();
      await installPolicy('token-write-and-read', 'permit (principal is ApiToken, action in [Action::"webhooks.write", Action::"webhooks.read"], resource);');
      await tokenFor('member');
      expect(json(await call('GET', `/${mine.id}`)).endpoint).toMatchObject({ url: 'https://hooks.example.com/services/T0/B0?…', urlRedacted: true });
      expect(json(await call('GET', '')).capabilities).toEqual({ manage: false, workspaceScope: false });
      for (const [method, url, payload] of changesOf(mine.id)) {
        const res = await call(method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(json(res), `${method} ${url}`).toMatchObject({ service: 'webhooks', decisionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      }
      expect(await db.findWebhookEndpointById(mine.id)).toMatchObject({ description: 'Ops channel', url: SECRET_URL });
      expect(hoisted.safeFetch).not.toHaveBeenCalled();
    });

    it('a token whose owner is allowed Admin changes everything in its project and sees the address whole', async () => {
      const mine = await secretOwn();
      await installPolicy('token-admin', 'permit (principal is ApiToken, action in [Action::"webhooks.admin", Action::"webhooks.write", Action::"webhooks.read"], resource);');
      await tokenFor('member');
      expect(json(await call('GET', `/${mine.id}`)).endpoint.url).toBe(SECRET_URL);
      expect(json(await call('GET', '')).capabilities).toEqual({ manage: true, workspaceScope: false });
      const statuses: number[] = [];
      for (const [method, url, payload] of changesOf(mine.id)) statuses.push((await call(method, url, payload)).statusCode);
      expect(statuses).toEqual(CHANGES_ALLOWED);
    });

    it('a deny rule on Write leaves Admin alone; a deny rule on Admin stops every change', async () => {
      const mine = await secretOwn();
      await installPolicy('token-no-write', 'forbid (principal is ApiToken, action == Action::"webhooks.write", resource);');
      expect((await call('PATCH', `/${mine.id}`, { description: 'edited' })).statusCode).toBe(200);
      expect(json(await call('GET', `/${mine.id}`)).endpoint.url).toBe(SECRET_URL);

      await installPolicy('token-no-admin', 'forbid (principal is ApiToken, action == Action::"webhooks.admin", resource);');
      for (const [method, url, payload] of changesOf(mine.id)) {
        expect((await call(method, url, payload)).statusCode, `${method} ${url}`).toBe(403);
      }
      expect((await call('GET', `/${mine.id}`)).statusCode).toBe(200);
    });
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

  it('is an administration service: reads need read, every change needs admin', () => {
    expect(getRequiredPermissionLevel('GET', 'webhooks')).toBe('read');
    expect(getRequiredPermissionLevel('POST', 'webhooks')).toBe('admin');
    expect(getRequiredPermissionLevel('PATCH', 'webhooks')).toBe('admin');
    expect(getRequiredPermissionLevel('DELETE', 'webhooks')).toBe('admin');
    // Owners and admins hold it; everybody else holds nothing until it is granted.
    expect(authorizeServiceRequest({ role: 'owner' }, 'POST', '/api/webhooks').allowed).toBe(true);
    expect(authorizeServiceRequest({ role: 'admin' }, 'POST', '/api/webhooks').allowed).toBe(true);
    expect(authorizeServiceRequest({ role: 'user' }, 'GET', '/api/webhooks').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'user' }, 'POST', '/api/webhooks').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'project_admin' }, 'POST', '/api/webhooks').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'user', servicePermissions: { webhooks: 'read' } }, 'GET', '/api/webhooks').allowed).toBe(true);
    expect(authorizeServiceRequest({ role: 'user', servicePermissions: { webhooks: 'read' } }, 'POST', '/api/webhooks').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'user', servicePermissions: { webhooks: 'admin' } }, 'POST', '/api/webhooks').allowed).toBe(true);
    expect(authorizeServiceRequest({ role: 'admin' }, 'POST', '/api/webhooks', [], { agents: 'admin' }).allowed).toBe(false);
  });
});
