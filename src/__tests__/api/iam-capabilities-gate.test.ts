/**
 * GET /api/iam/capabilities tells the screens which controls to show, so it has to put
 * the engine the question the route gates put to it: `<service>.write` for a change
 * (RBAC still demands the admin level of these services). A policy that forbids writing
 * members must take the people controls away - the gate refuses PATCH and bulk - and one
 * that forbids only `members.admin`, an action no route gate asks, must neither remove
 * them nor stop the changes. The same holds for the policies of the center.
 *
 * Real database, real plugins, real engine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { FastifyInstance } from 'fastify';
import type { IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { enqueueAuditLog } from '@/server/api/plugin';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let env: IamTestDb;
let app: FastifyInstance;
const users: Record<string, IUser> = {};

const sessionHeaders = (user: IUser) => ({
  'x-tenant-db-name': env.tenantDbName,
  'x-tenant-id': env.tenantId,
  'x-tenant-slug': 'caps-gate',
  'x-user-id': String(user._id),
  'x-user-role': String(user.role),
  'x-user-email': String(user.email),
  'x-license-type': 'FREE',
});

const call = async (method: string, url: string, user: IUser, body?: unknown) => {
  const res = await app.inject({
    method: method as never,
    url,
    // a JSON content type needs a body
    headers: body === undefined ? sessionHeaders(user) : { ...sessionHeaders(user), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  let parsed: any = null;
  try { parsed = res.body ? parseJsonBody<any>(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed };
};

beforeAll(async () => {
  env = await createIamTestDb('tenant_caps_gate');
  hoisted.getDatabase.mockImplementation(async () => env.db);
  for (const [name, role] of [['owner', 'owner'], ['admin', 'admin'], ['pat', 'user']] as const) {
    users[name] = (await env.db.createUser({
      tenantId: env.tenantId, email: `${name}@caps.io`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [],
    })) as IUser;
  }
  app = await createFastifyApiTestApp(async (instance) => {
    instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
    await instance.register(usersApiPlugin);
    await instance.register(iamApiPlugin);
  });
  await app.ready();
});

afterAll(async () => {
  await drainPendingTasks();
  await app?.close();
  await env?.cleanup();
});

beforeEach(() => {
  resetRateLimitStore();
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectNarrowingCachesForTests();
});

/** Forbid `action` to the admin for the duration of `run`; the owner removes the rule afterwards. */
async function whileForbidden(action: string, run: () => Promise<void>) {
  const created = await call('POST', '/api/iam/policies', users.owner, {
    name: `No ${action} for the admin`, enabled: true,
    spec: { effect: 'forbid', principals: { users: [String(users.admin._id)] }, actions: [action], resources: { any: true } },
  });
  expect(created.status).toBe(201);
  try {
    await run();
  } finally {
    expect((await call('DELETE', `/api/iam/policies/${created.body.policyId}`, users.owner)).status).toBe(204);
  }
}

const capabilities = async (who: IUser = users.admin) => (await call('GET', '/api/iam/capabilities', who)).body;
let renames = 0;
const rename = () => call('PATCH', `/api/users/${String(users.pat._id)}`, users.admin, { name: `Pat ${++renames}` });
const disableBulk = (action: 'disable' | 'enable') =>
  call('POST', '/api/users/bulk', users.admin, { action, ids: [String(users.pat._id)] });
/** A harmless, disabled policy: something only a writer of the center can create. */
const draftPolicy = () => call('POST', '/api/iam/policies', users.admin, {
  name: `Draft ${++renames}`, enabled: false,
  spec: { effect: 'forbid', principals: { users: [String(users.pat._id)] }, actions: ['agents.read'], resources: { any: true } },
});

describe('people controls follow the write the gate decides on', () => {
  it('offers them to an admin nothing forbids, and the changes work', async () => {
    expect((await capabilities()).people.manage).toBe(true);
    expect((await rename()).status).toBe(200);
    expect((await disableBulk('disable')).status).toBe(200);
    expect((await disableBulk('enable')).status).toBe(200);
  });

  it('takes them away when members.write is forbidden - and PATCH and bulk answer 403', async () => {
    await whileForbidden('members.write', async () => {
      const caps = await capabilities();
      expect(caps.people).toEqual({ manage: false, grantAdmin: true, assignableRoles: [] });
      expect((await rename()).status).toBe(403);
      expect((await disableBulk('disable')).status).toBe(403);
      // the owner is not the one forbidden
      expect((await capabilities(users.owner)).people.manage).toBe(true);
    });
    expect((await capabilities()).people.manage).toBe(true);
    expect((await rename()).status).toBe(200);
  });

  it('keeps them when only members.admin is forbidden - no gate asks that, and the changes still work', async () => {
    await whileForbidden('members.admin', async () => {
      expect((await capabilities()).people.manage).toBe(true);
      expect((await rename()).status).toBe(200);
      expect((await disableBulk('disable')).status).toBe(200);
      expect((await disableBulk('enable')).status).toBe(200);
    });
  });
});

describe('policy controls follow the write the gate decides on', () => {
  it('offers them to an admin nothing forbids', async () => {
    expect((await capabilities()).policies.manage).toBe(true);
    const created = await draftPolicy();
    expect(created.status).toBe(201);
    expect((await call('DELETE', `/api/iam/policies/${created.body.policyId}`, users.admin)).status).toBe(204);
  });

  it('takes them away when iam.write is forbidden - and creating a policy answers 403', async () => {
    await whileForbidden('iam.write', async () => {
      expect((await capabilities()).policies.manage).toBe(false);
      expect((await draftPolicy()).status).toBe(403);
    });
    expect((await capabilities()).policies.manage).toBe(true);
  });

  it('keeps them when only iam.admin is forbidden - the center still lets the admin write', async () => {
    await whileForbidden('iam.admin', async () => {
      expect((await capabilities()).policies.manage).toBe(true);
      const created = await draftPolicy();
      expect(created.status).toBe(201);
      expect((await call('DELETE', `/api/iam/policies/${created.body.policyId}`, users.admin)).status).toBe(204);
    });
  });

  it('follows tokens.write for the tokens of other people', async () => {
    expect((await capabilities()).tokens.manageOthers).toBe(true);
    await whileForbidden('tokens.write', async () => {
      expect((await capabilities()).tokens.manageOthers).toBe(false);
    });
  });
});
