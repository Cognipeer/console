/**
 * The bulk endpoint is gated on the `members` service, but revoking tokens is also a
 * decision of the `tokens` service: a policy that forbids it must not be sidestepped
 * by asking the people route instead. Real database, real engine.
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
  'x-tenant-slug': 'bulk-gate',
  'x-user-id': String(user._id),
  'x-user-role': String(user.role),
  'x-user-email': String(user.email),
  'x-license-type': 'FREE',
});

beforeAll(async () => {
  env = await createIamTestDb('tenant_bulk_gate');
  hoisted.getDatabase.mockImplementation(async () => env.db);
  for (const [name, role] of [['owner', 'owner'], ['admin', 'admin'], ['alice', 'user'], ['bob', 'user']] as const) {
    users[name] = (await env.db.createUser({
      tenantId: env.tenantId, email: `${name}@gate.io`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [],
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

beforeEach(async () => {
  resetRateLimitStore();
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectNarrowingCachesForTests();
  // alice has a token to revoke
  for (const token of await env.db.listApiTokens(String(users.alice._id))) await env.db.deleteApiToken(String(token._id), String(users.alice._id));
  await env.db.createApiToken({
    tenantId: env.tenantId, userId: String(users.alice._id), label: 'alice-ci', tokenHash: `h-${Math.random()}`, tokenPrefix: 'cp_alice', createdBy: String(users.alice._id),
  } as never);
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
  return { status: res.statusCode, body: parsed, headers: res.headers };
};

describe('bulk revoke-tokens and the tokens service', () => {
  it('revokes tokens when nothing forbids it', async () => {
    const res = await call('POST', '/api/users/bulk', users.admin, { action: 'revoke-tokens', ids: [String(users.alice._id)] });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ outcome: 'ok', revoked: 1 });
    expect(await env.db.listApiTokens(String(users.alice._id))).toEqual([]);
  });

  it('is refused for the whole request, with the decision, when a policy forbids writing tokens', async () => {
    const created = await call('POST', '/api/iam/policies', users.owner, {
      name: 'Nobody touches tokens', enabled: true,
      spec: { effect: 'forbid', principals: { any: true }, actions: ['tokens.write'], resources: { any: true } },
    });
    expect(created.status).toBe(201);
    try {
      const res = await call('POST', '/api/users/bulk', users.admin, { action: 'revoke-tokens', ids: [String(users.alice._id)] });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'forbidden', service: 'tokens', required: 'write' });
      expect(res.body.decisionId).toBeTruthy();
      expect(res.headers['x-decision-id']).toBe(undefined); // the response header is stamped by the app's hook, not by this harness
      // nothing was revoked, and it is no dry run either
      expect(await env.db.listApiTokens(String(users.alice._id))).toHaveLength(1);
      const dry = await call('POST', '/api/users/bulk', users.admin, { action: 'revoke-tokens', ids: [String(users.alice._id)], dryRun: true });
      expect(dry.status).toBe(403);

      // the same policy does not touch what the members service decides
      const disable = await call('POST', '/api/users/bulk', users.admin, { action: 'disable', ids: [String(users.bob._id)] });
      expect(disable.status).toBe(200);
      expect(disable.body.results[0].outcome).toBe('ok');
    } finally {
      const removed = await call('DELETE', `/api/iam/policies/${created.body.policyId}`, users.owner);
      expect(removed.status).toBe(204);
      await call('POST', '/api/users/bulk', users.owner, { action: 'enable', ids: [String(users.bob._id)] });
    }
  });

  it('works again once the policy is gone', async () => {
    const res = await call('POST', '/api/users/bulk', users.admin, { action: 'revoke-tokens', ids: [String(users.alice._id)] });
    expect(res.status).toBe(200);
  });
});
