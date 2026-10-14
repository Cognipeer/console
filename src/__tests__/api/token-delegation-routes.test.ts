/**
 * Setting up an API token to act for users: GET / PUT / DELETE /api/tokens/:id/delegation, through the real gates
 * (the route gate declared on the routes, the live role, the never-upward rule of every other token edit) and a real
 * SQLite database.
 *
 *   who         owners and admins only, by the live account; an admin never touches the owner's token
 *   what        the body is checked as a whole (algorithm pinned, key material that belongs to it, a mapping that can run)
 *   secrets     sealed at rest, never returned, never audited; a key id without a secret keeps the stored one
 *   audit       one row per change with the before and the after - issuer, algorithms, kinds of key, never a key
 *   tidy        deleting the token deletes its delegation
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
import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { IApiToken, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { getTokenDelegation, resetTokenDelegationCacheForTests } from '@/lib/iam/tokenDelegation';
import { TOKEN_DELEGATION_EVENT } from '@/lib/services/apiTokens/delegationAudit';
import { enqueueAuditLog, stampDecisionHeader } from '@/server/api/plugin';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const SECRET = 'plain-text-secret-that-must-never-leak-0123456789';
const ISSUER = 'https://idp.bank.example/realms/retail';

let env: IamTestDb;
let app: FastifyInstance;
let projectId: string;
const users: Record<string, IUser> = {};
const tokens: Record<string, IApiToken> = {};

const mkUser = async (name: string, role: 'owner' | 'admin' | 'project_admin' | 'user', extra: Record<string, unknown> = {}) => {
  users[name] = (await env.db.createUser({
    tenantId: env.tenantId, email: `${name}@bank.example`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
  })) as IUser;
  return users[name];
};
const mkToken = async (name: string, owner: IUser, scope: Record<string, string> | null = { models: 'read' }) => {
  tokens[name] = await env.db.createApiToken({
    label: name, projectId, tenantId: env.tenantId, tokenHash: `hash-${name}`, tokenPrefix: `cpeer_${name}`,
    userId: String(owner._id), servicePermissions: scope as never,
  } as never);
  return tokens[name];
};

const sessionHeaders = (user: IUser) => ({
  'x-tenant-db-name': env.tenantDbName,
  'x-tenant-id': env.tenantId,
  'x-tenant-slug': 'bank',
  'x-user-id': String(user._id),
  'x-user-role': String(user.role),
  'x-user-email': String(user.email),
  'x-license-type': 'FREE',
});

const body = (patch: Record<string, unknown> = {}) => ({
  enabled: true,
  trust: {
    issuer: ISSUER,
    audience: 'cognipeer-console',
    algorithms: ['HS256'],
    keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }] },
    maxTokenAgeSeconds: 3600,
  },
  mapping: { matchBy: ['externalId', 'verifiedEmail'], jit: 'external' },
  allowPrivileged: false,
  ...patch,
});

const call = async (method: string, user: IUser, tokenName: string, payload?: unknown, tokenId?: string) => {
  const res = await app.inject({
    method: method as never,
    url: `/api/tokens/${tokenId ?? String(tokens[tokenName]._id)}/delegation`,
    headers: { ...sessionHeaders(user), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let parsed: any = null;
  try { parsed = res.body ? parseJsonBody<any>(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed, headers: res.headers };
};

const auditRows = async (event: string) => {
  await drainPendingTasks();
  return (await env.db.runWithTenant!(env.tenantDbName, async () => env.db.listAuditLogs({ limit: 500 }))).filter((row) => row.event === event);
};

beforeAll(async () => {
  env = await createIamTestDb('tenant_deleg_routes');
  hoisted.getDatabase.mockImplementation(async () => env.db);
  await mkUser('owner', 'owner');
  await mkUser('admin', 'admin');
  await mkUser('admin2', 'admin');
  await mkUser('pa', 'project_admin');
  await mkUser('plain', 'user');
  // a plain user who has been given the tokens service at admin level: the gate lets them through, the live role does not
  await mkUser('tokenadmin', 'user', { servicePermissions: { tokens: 'admin' } });
  const svc = await mkUser('svc', 'user', { canLogin: false, email: '' });
  projectId = String((await env.db.createProject({ tenantId: env.tenantId, key: 'default', name: 'Default', createdBy: 'x' }))._id);
  await mkToken('app', svc);
  await mkToken('owners', users.owner, null);
  await mkToken('admins', users.admin);
  await mkToken('plains', users.plain);
  await mkToken('traced', svc);

  app = await createFastifyApiTestApp(async (instance) => {
    instance.addHook('onSend', async (request, reply, payload) => { stampDecisionHeader(request, reply); return payload; });
    instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
    await instance.register(tokensApiPlugin);
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await env?.cleanup();
});
beforeEach(async () => {
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectNarrowingCachesForTests();
  resetTokenDelegationCacheForTests();
  await env.db.runWithTenant!(env.tenantDbName, async () => {
    for (const doc of await env.db.iamDocList('iam_delegations')) await env.db.iamDocDelete('iam_delegations', doc.id);
  });
});

describe('who may set it up', () => {
  it('an admin sets it up for an application token, reads it back and removes it', async () => {
    const empty = await call('GET', users.admin, 'app');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ delegation: null, tokenScoped: true });

    const put = await call('PUT', users.admin, 'app', body());
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.delegation).toMatchObject({
      tokenId: String(tokens.app._id),
      enabled: true,
      trust: { issuer: ISSUER, audience: 'cognipeer-console', algorithms: ['HS256'], keys: { hsSecrets: [{ kid: 'k1' }] }, maxTokenAgeSeconds: 3600 },
      mapping: { matchBy: ['externalId', 'verifiedEmail'], jit: 'external' },
      allowPrivileged: false,
      updatedBy: String(users.admin._id),
    });
    expect(put.body.tokenScoped).toBe(true);

    const got = await call('GET', users.admin, 'app');
    expect(got.body.delegation).toEqual(put.body.delegation);

    const removed = await call('DELETE', users.admin, 'app');
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });
    expect((await call('GET', users.admin, 'app')).body.delegation).toBeNull();
    expect((await call('DELETE', users.admin, 'app')).body).toEqual({ deleted: false });
  });

  it('says so for a token without a scope', async () => {
    await call('PUT', users.owner, 'owners', body());
    expect((await call('GET', users.owner, 'owners')).body.tokenScoped).toBe(false);
  });

  it('refuses everybody who is not an owner or an admin - by the live account, not by the permissions they hold', async () => {
    for (const who of ['plain', 'pa', 'tokenadmin']) {
      for (const [method, payload] of [['GET', undefined], ['PUT', body()], ['DELETE', undefined]] as const) {
        const res = await call(method, users[who], 'app', payload);
        expect(res.status, `${who} ${method}`).toBe(403);
      }
    }
    // not even the owner of the token, when that owner is a plain user
    expect((await call('PUT', users.plain, 'plains', body())).status).toBe(403);
    expect(await getTokenDelegation(env.tenantDbName, String(tokens.app._id))).toBeNull();
  });

  it('never upward: an admin does not touch the owner\'s token, the owner touches everybody\'s', async () => {
    const refused = await call('PUT', users.admin, 'owners', body());
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'higher_privileges' });
    expect((await call('GET', users.admin, 'owners')).status).toBe(403);
    expect((await call('DELETE', users.admin, 'owners')).status).toBe(403);
    expect((await call('PUT', users.owner, 'admins', body())).status).toBe(200);
    // an admin acts on another admin's token and on a plain user's
    expect((await call('PUT', users.admin2, 'admins', body())).status).toBe(200);
    expect((await call('PUT', users.admin, 'plains', body())).status).toBe(200);
  });

  it('answers 404 for a token that does not exist, and for an id that is not one', async () => {
    expect((await call('GET', users.admin, 'app', undefined, '0123456789abcdef01234567')).status).toBe(404);
    expect((await call('PUT', users.admin, 'app', body(), 'not-a-real-id')).status).toBe(404);
    expect((await call('DELETE', users.admin, 'app', undefined, 'x'.repeat(90))).status).toBe(404);
  });
});

describe('what is accepted', () => {
  const rejects = async (payload: unknown, fragment: string | RegExp) => {
    const res = await call('PUT', users.admin, 'app', payload);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_body' });
    const text = (res.body.problems as Array<{ message: string }>).map((problem) => problem.message).join(' | ');
    expect(text).toMatch(fragment);
    expect(await getTokenDelegation(env.tenantDbName, String(tokens.app._id))).toBeNull();
  };

  it('checks the trust as a whole', async () => {
    await rejects(body({ trust: { ...body().trust, algorithms: ['none'] } }), /Algorithms must be among/);
    await rejects(body({ trust: { ...body().trust, algorithms: [] } }), /At least one algorithm/);
    await rejects(body({ trust: { ...body().trust, issuer: '' } }), /issuer/);
    await rejects(body({ trust: { ...body().trust, audience: [] } }), /audience/);
    await rejects(body({ trust: { ...body().trust, keys: { hsSecrets: [{ kid: 'k1', secret: 'short' }] } } }), /at least 32 characters/);
    await rejects(body({ trust: { ...body().trust, keys: {} } }), /no shared secret/);
    await rejects(body({ trust: { ...body().trust, algorithms: ['RS256'], keys: { jwksUrl: 'http://idp.example.com/jwks.json' } } }), /https/);
    await rejects(body({ trust: { ...body().trust, algorithms: ['RS256'], keys: { pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' } } }), /private key/);
    await rejects(body({ trust: { ...body().trust, maxTokenAgeSeconds: 0 } }), /maximum token age/);
    await rejects(body({ trust: { ...body().trust, clockSkewSeconds: 9999 } }), /clock skew/);
  });

  it('keeps an algorithm and its key material together: an HS256 secret does not serve RS256', async () => {
    await rejects(body({ trust: { ...body().trust, algorithms: ['HS256', 'RS256'] } }), /RS256 \/ ES256 is pinned but no public key/);
    await rejects(body({ trust: { ...body().trust, algorithms: ['RS256'], keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }], jwksUrl: 'https://idp.example.com/jwks.json' } } }), /HS256 is not pinned/);
  });

  it('is not single-use: a user token is sent with many calls', async () => {
    await rejects(body({ trust: { ...body().trust, requireSingleUse: true } }), /cannot be single-use/);
    const ok = await call('PUT', users.admin, 'app', body({ trust: { ...body().trust, requireSingleUse: false } }));
    expect(ok.status).toBe(200);
    const stored = await getTokenDelegation(env.tenantDbName, String(tokens.app._id));
    expect(stored?.config.trust.requireSingleUse).toBe(false);
  });

  it('checks the mapping, and refuses what it does not know', async () => {
    await rejects(body({ mapping: { matchBy: [], jit: 'none' } }), /Match by/);
    await rejects(body({ mapping: { matchBy: ['externalId'], jit: 'everybody' } }), /Provisioning/);
    await rejects(body({ mapping: { matchBy: ['externalId'], jit: 'none', groupMap: [{ idpGroup: 'a', consoleGroupName: 'A' }, { idpGroup: 'a', consoleGroupName: 'B' }] } }), /mapped twice/);
    await rejects(body({ extra: true }), /Unknown setting "extra"/);
    await rejects(body({ trust: { ...body().trust, surprise: 1 } }), /Unknown setting "trust.surprise"/);
    await rejects(body({ enabled: 'yes' }), /enabled must be true or false/);
    await rejects({ enabled: true }, /trust must be an object/);
    const notAnObject = await call('PUT', users.admin, 'app', [1, 2]);
    expect(notAnObject.status).toBe(400);
  });

  it('takes a public key or a key set for RS256 and ES256, and the group map', async () => {
    const res = await call('PUT', users.admin, 'app', body({
      trust: { issuer: ISSUER, audience: ['a', 'b'], algorithms: ['RS256', 'ES256'], keys: { jwksUrl: 'https://idp.bank.example/.well-known/jwks.json' } },
      mapping: { matchBy: ['externalId'], jit: 'person', groupMap: [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }] },
      allowPrivileged: true,
    }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.delegation).toMatchObject({
      trust: { audience: ['a', 'b'], algorithms: ['RS256', 'ES256'], keys: { jwksUrl: 'https://idp.bank.example/.well-known/jwks.json' } },
      mapping: { jit: 'person', groupMap: [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }] },
      allowPrivileged: true,
    });
    expect(res.body.delegation.trust.keys.hsSecrets).toBeUndefined();
  });
});

describe('secrets', () => {
  it('are sealed at rest, never returned and never audited', async () => {
    const put = await call('PUT', users.admin, 'app', body());
    expect(JSON.stringify(put.body)).not.toContain(SECRET);
    expect(JSON.stringify((await call('GET', users.admin, 'app')).body)).not.toContain(SECRET);

    const doc = await env.db.runWithTenant!(env.tenantDbName, () => env.db.iamDocGet('iam_delegations', String(tokens.app._id)));
    expect(doc).not.toBeNull();
    expect(JSON.stringify(doc?.data)).not.toContain(SECRET);
    expect(doc?.data).toMatchObject({ hsKids: ['k1'], hsSecretsSealed: expect.any(String) });
    // the gate reads the secret back
    const stored = await getTokenDelegation(env.tenantDbName, String(tokens.app._id));
    expect(stored?.config.trust.keys.hsSecrets).toEqual([{ kid: 'k1', secret: SECRET }]);

    const rows = await auditRows(TOKEN_DELEGATION_EVENT);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('a key id without a secret keeps the stored secret; a new key id needs one', async () => {
    await call('PUT', users.admin, 'app', body());
    const keep = await call('PUT', users.admin, 'app', body({
      trust: { ...body().trust, keys: { hsSecrets: [{ kid: 'k1' }] }, maxTokenAgeSeconds: 600 },
    }));
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    expect((await getTokenDelegation(env.tenantDbName, String(tokens.app._id)))?.config.trust.keys.hsSecrets).toEqual([{ kid: 'k1', secret: SECRET }]);
    expect(keep.body.delegation.trust.maxTokenAgeSeconds).toBe(600);

    const next = 'a-second-secret-of-at-least-32-characters-ok';
    const rotate = await call('PUT', users.admin, 'app', body({ trust: { ...body().trust, keys: { hsSecrets: [{ kid: 'k1' }, { kid: 'k2', secret: next }] } } }));
    expect(rotate.status).toBe(200);
    expect(rotate.body.delegation.trust.keys.hsSecrets).toEqual([{ kid: 'k1' }, { kid: 'k2' }]);
    expect((await getTokenDelegation(env.tenantDbName, String(tokens.app._id)))?.config.trust.keys.hsSecrets).toEqual([{ kid: 'k1', secret: SECRET }, { kid: 'k2', secret: next }]);

    const missing = await call('PUT', users.admin, 'app', body({ trust: { ...body().trust, keys: { hsSecrets: [{ kid: 'k3' }] } } }));
    expect(missing.status).toBe(400);
    expect((missing.body.problems as Array<{ message: string }>).map((problem) => problem.message).join(' | ')).toMatch(/key id "k3" must be provided/);
  });
});

describe('the trail', () => {
  it('writes one row per change with what it was and what it became', async () => {
    await call('PUT', users.admin, 'traced', body());
    await call('PUT', users.admin, 'traced', body({ allowPrivileged: true, mapping: { matchBy: ['externalId'], jit: 'person' } }));
    await call('DELETE', users.admin, 'traced');
    await call('DELETE', users.admin, 'traced'); // nothing to remove: no row
    const rows = (await auditRows(TOKEN_DELEGATION_EVENT)).filter((row) => row.resourceId === String(tokens.traced._id));
    expect(rows).toHaveLength(3);
    const byChange = Object.fromEntries(rows.map((row) => [(row.metadata as { change: string }).change, row]));
    expect(byChange.created).toMatchObject({
      service: 'tokens', actorUserId: String(users.admin._id), actorRole: 'admin', outcome: 'success', resourceType: 'api_token',
      metadata: { label: 'traced', ownerUserId: String(users.svc._id), before: null, after: { enabled: true, issuer: ISSUER, algorithms: ['HS256'], keySources: ['secret'], jit: 'external', allowPrivileged: false } },
    });
    expect(byChange.updated).toMatchObject({
      metadata: { before: { allowPrivileged: false, jit: 'external' }, after: { allowPrivileged: true, jit: 'person', matchBy: ['externalId'] } },
    });
    expect(byChange.removed).toMatchObject({ metadata: { before: { allowPrivileged: true }, after: null } });
  });

  it('a refused attempt is still the generic audit row of the refused call', async () => {
    const refused = await call('PUT', users.plain, 'app', body());
    expect(refused.status).toBe(403);
    await drainPendingTasks();
    const rows = (await env.db.runWithTenant!(env.tenantDbName, async () => env.db.listAuditLogs({ limit: 500 })))
      .filter((row) => row.path === `/api/tokens/${String(tokens.app._id)}/delegation` && row.method === 'PUT' && row.actorUserId === String(users.plain._id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ outcome: 'denied', statusCode: 403, service: 'tokens' });
  });
});

describe('tidy', () => {
  it('deleting the token deletes what it was set up to do', async () => {
    const throwaway = await mkToken('throwaway', users.svc);
    await call('PUT', users.admin, 'throwaway', body());
    expect(await getTokenDelegation(env.tenantDbName, String(throwaway._id))).not.toBeNull();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/tokens/${String(throwaway._id)}`,
      headers: sessionHeaders(users.admin),
    });
    expect(res.statusCode, res.body).toBe(200);
    resetTokenDelegationCacheForTests();
    expect(await getTokenDelegation(env.tenantDbName, String(throwaway._id))).toBeNull();
  });
});
