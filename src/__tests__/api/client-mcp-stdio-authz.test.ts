/**
 * Token MCP authoring (POST /client/v1/mcp, PATCH /client/v1/mcp/:serverKey):
 * a stdio server that runs as a SUBPROCESS of the gateway (npx / uvx with a
 * caller-supplied package) needs admin-level `mcp` permission on top of the
 * route's write level, and that extra decision is made the way the dashboard
 * makes it (authorizeServiceForRequest):
 *
 * The policy engine decides, i.e. custom forbid policies, the owner's group
 * grants, the token's project narrowing and the token scope as a cap.
 *
 * Real gates, real SQLite database, real engine; only the MCP service calls that
 * would discover tools (and spawn the package) are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
  createMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  getMcpServerByKey: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) => {
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

// Creating / updating a server discovers its tools (for a subprocess: runs the package). Stubbed.
vi.mock('@/lib/services/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/mcp')>();
  return {
    ...actual,
    createMcpServer: hoisted.createMcpServer,
    updateMcpServer: hoisted.updateMcpServer,
    getMcpServerByKey: hoisted.getMcpServerByKey,
  };
});

import type { FastifyInstance } from 'fastify';
import type { IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { createPolicy, deletePolicy } from '@/lib/iam/store';
import { clientMcpApiPlugin } from '@/server/api/plugins/client-mcp';
import { mcpApiPlugin } from '@/server/api/plugins/mcp';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

let env: IamTestDb;
let app: FastifyInstance;
let projectId: string;
const users: Record<string, IUser> = {};

const mkUser = async (name: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
  const user = (await env.db.createUser({
    tenantId: env.tenantId, email: `${name}@x.io`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
  })) as IUser;
  users[name] = user;
  return user;
};

const tokenCtx = (user: IUser, scope: Record<string, string> | null, tokenId: string, tokenProject?: string) => ({
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
  env = await createIamTestDb('tenant_client_mcp_authz');
  hoisted.getDatabase.mockImplementation(async () => env.db);

  await mkUser('owner', 'owner');
  await mkUser('admin', 'admin');
  await mkUser('plain', 'user'); // role default for mcp: write
  // lead: an explicit tenant-level mcp:admin grant, but only mcp:write inside project pj
  await mkUser('lead', 'user', { servicePermissions: { mcp: 'admin' } });
  // grouped: mcp:write by role, mcp:admin only through a group
  await mkUser('grouped', 'user');

  const project = await env.db.createProject({ tenantId: env.tenantId, key: 'pj', name: 'PJ', createdBy: 'x' });
  projectId = String(project._id);
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.lead._id), projectId, role: 'member', servicePermissions: { mcp: 'write' } });
  // the dashboard needs every session user to have a project; no overrides, so nothing is narrowed
  for (const name of ['plain', 'grouped']) {
    await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users[name]._id), projectId, role: 'member' });
  }
  const admins = await env.db.createGroup({ tenantId: env.tenantId, name: 'mcp-admins', createdBy: 't', source: 'local', servicePermissions: { mcp: 'admin' } } as never);
  await env.db.addGroupMember({ groupId: String(admins._id), userId: String(users.grouped._id), tenantId: env.tenantId, role: 'member' });

  hoisted.tokens.set('tok-owner', tokenCtx(users.owner, null, 'tok-owner'));
  hoisted.tokens.set('tok-admin', tokenCtx(users.admin, null, 'tok-admin'));
  hoisted.tokens.set('tok-admin-scope-admin', tokenCtx(users.admin, { mcp: 'admin' }, 'tok-admin-scope-admin'));
  // an admin's token scoped DOWN to write: capped, even though its owner is an admin
  hoisted.tokens.set('tok-admin-scope-write', tokenCtx(users.admin, { mcp: 'write' }, 'tok-admin-scope-write'));
  // a scope names what the token may reach: nothing for mcp here
  hoisted.tokens.set('tok-admin-scope-other', tokenCtx(users.admin, { agents: 'admin' }, 'tok-admin-scope-other'));
  hoisted.tokens.set('tok-plain', tokenCtx(users.plain, null, 'tok-plain'));
  // a scope never raises its owner
  hoisted.tokens.set('tok-plain-scope-admin', tokenCtx(users.plain, { mcp: 'admin' }, 'tok-plain-scope-admin'));
  hoisted.tokens.set('tok-lead-pj', tokenCtx(users.lead, null, 'tok-lead-pj', projectId));
  hoisted.tokens.set('tok-lead', tokenCtx(users.lead, null, 'tok-lead'));
  hoisted.tokens.set('tok-grouped', tokenCtx(users.grouped, null, 'tok-grouped'));

  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientMcpApiPlugin);
    await instance.register(mcpApiPlugin);
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await env?.cleanup();
});

beforeEach(() => {
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  hoisted.createMcpServer.mockReset().mockImplementation(async (_db, _tenant, _user, _project, input: { name: string; key?: string }) => ({
    _id: 'srv-new', key: input.key ?? 'created', name: input.name, sourceType: 'x', status: 'active',
  }));
  hoisted.updateMcpServer.mockReset().mockImplementation(async () => ({
    _id: 'srv-1', key: 'fs', name: 'Fs', sourceType: 'stdio', status: 'active',
  }));
  hoisted.getMcpServerByKey.mockReset().mockResolvedValue({ _id: 'srv-1', key: 'fs', name: 'Fs', sourceType: 'stdio', status: 'active' });
});

// ── requests ─────────────────────────────────────────────────────────────

const SUBPROCESS = { runtime: 'npx', packageName: '@acme/fs-mcp', executionMode: 'subprocess' };

const createBody = (extra: Record<string, unknown>) => ({ name: 'Fs', upstreamAuth: { type: 'none' }, ...extra });
const createSubprocess = () => createBody({ sourceType: 'stdio', stdioConfig: SUBPROCESS });

const post = async (token: string, body: unknown) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/client/v1/mcp',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
};

const patch = async (token: string, body: unknown) => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/client/v1/mcp/fs',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
};

const SUBPROCESS_REFUSAL = {
  error: expect.stringContaining('Creating or editing a stdio MCP server with subprocess execution requires elevated "mcp" admin permission'),
};

/** Both authoring routes, with the subprocess config in the request. */
const subprocessResults = async (token: string) => ({
  create: await post(token, createSubprocess()),
  update: await patch(token, { stdioConfig: SUBPROCESS }),
});

const expectAllowed = async (token: string) => {
  const { create, update } = await subprocessResults(token);
  expect(create.status).toBe(201);
  expect(update.status).toBe(200);
  expect(hoisted.createMcpServer).toHaveBeenCalledTimes(1);
  expect(hoisted.createMcpServer.mock.calls[0][4]).toMatchObject({ sourceType: 'stdio', stdioConfig: { executionMode: 'subprocess', packageName: '@acme/fs-mcp' } });
  expect(hoisted.updateMcpServer).toHaveBeenCalledTimes(1);
  expect(hoisted.updateMcpServer.mock.calls[0][3]).toMatchObject({ stdioConfig: { executionMode: 'subprocess', packageName: '@acme/fs-mcp' } });
};

/** Refused on both routes, and nothing was created or changed (so nothing could run). */
const expectRefused = async (token: string) => {
  const { create, update } = await subprocessResults(token);
  expect(create.status).toBe(403);
  expect(create.body).toMatchObject(SUBPROCESS_REFUSAL);
  expect(update.status).toBe(403);
  expect(update.body).toMatchObject(SUBPROCESS_REFUSAL);
  expect(hoisted.createMcpServer).not.toHaveBeenCalled();
  expect(hoisted.updateMcpServer).not.toHaveBeenCalled();
};

/** What a write-level token may still do: every other source type, and edits that carry no subprocess config. */
const expectOtherSourcesUnaffected = async (token: string) => {
  const remote = await post(token, createBody({ sourceType: 'remote', remoteConfig: { url: 'https://mcp.example.com/mcp' } }));
  expect(remote.status).toBe(201);
  const openapi = await post(token, createBody({ sourceType: 'openapi', openApiSpec: 'openapi: 3.0.0' }));
  expect(openapi.status).toBe(201);
  const rename = await patch(token, { name: 'Renamed' });
  expect(rename.status).toBe(200);
  expect(hoisted.createMcpServer).toHaveBeenCalledTimes(2);
  expect(hoisted.updateMcpServer).toHaveBeenCalledTimes(1);
  // the persistent sandbox is a licence question (402 on this plan), not a permission one (403)
  const sandbox = { runtime: 'npx', packageName: '@acme/fs-mcp', executionMode: 'sandbox' };
  const sandboxCreate = await post(token, createBody({ sourceType: 'stdio', stdioConfig: sandbox }));
  expect(sandboxCreate.status).toBe(402);
  const sandboxUpdate = await patch(token, { stdioConfig: sandbox });
  expect(sandboxUpdate.status).toBe(402);
  expect(hoisted.createMcpServer).toHaveBeenCalledTimes(2);
  expect(hoisted.updateMcpServer).toHaveBeenCalledTimes(1);
};

// ── the policy engine decides ────────────────────────────────────────────

describe('the policy engine decides, the token scope still caps', () => {
  it('an admin-capable token may create and edit a subprocess server', async () => {
    for (const token of ['tok-owner', 'tok-admin', 'tok-admin-scope-admin']) {
      hoisted.createMcpServer.mockClear();
      hoisted.updateMcpServer.mockClear();
      await expectAllowed(token);
    }
  });

  it('a write-only token is refused (403) on create and on edit, and nothing is created', async () => {
    await expectRefused('tok-plain');
  });

  it('a token scoped down to mcp:write is refused although its owner is an admin', async () => {
    await expectRefused('tok-admin-scope-write');
  });

  it('a scope cannot raise its owner: a write-only owner with an mcp:admin scope is still refused', async () => {
    await expectRefused('tok-plain-scope-admin');
  });

  it('a scope without mcp is stopped by the route gate, with the denial body (the reason in `error`, the structured fields next to it)', async () => {
    const created = await post('tok-admin-scope-other', createSubprocess());
    expect(created.status).toBe(403);
    expect(created.body).toMatchObject({
      error: 'Forbidden: mcp requires write permission',
      message: 'Forbidden: mcp requires write permission',
      code: 'forbidden',
      service: 'mcp',
      required: 'write',
    });
    expect(hoisted.createMcpServer).not.toHaveBeenCalled();
  });

  it('a custom forbid on mcp.admin refuses an admin token on both routes (the gap this closes), while write-level work continues', async () => {
    await createPolicy(env.tenantDbName, {
      policyId: 'no-mcp-admin',
      name: 'no mcp admin',
      cedar: 'forbid(principal, action == Action::"mcp.admin", resource);',
    }, 'test');
    try {
      await expectRefused('tok-admin');
      await expectRefused('tok-owner');
      await expectOtherSourcesUnaffected('tok-admin');
    } finally {
      await deletePolicy(env.tenantDbName, 'no-mcp-admin');
    }
    hoisted.createMcpServer.mockClear();
    hoisted.updateMcpServer.mockClear();
    await expectAllowed('tok-admin');
  });

  it('project narrowing applies: mcp:admin at tenant level, mcp:write inside the token\'s project, so the subprocess is refused', async () => {
    await expectRefused('tok-lead-pj');
    // the same owner's token that is not bound to that project keeps the tenant-level admin
    await expectAllowed('tok-lead');
  });

  it('the owner\'s group grants count for a token: mcp:admin through a group is enough', async () => {
    await expectAllowed('tok-grouped');
  });

  it('every other source type stays available to a write-level token', async () => {
    await expectOtherSourcesUnaffected('tok-plain');
  });
});

// ── the dashboard path decides the same way ──────────────────────────────

describe('the dashboard and the token API give the same answer for the same person', () => {
  const sessionPost = async (user: IUser, body: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: {
        'x-tenant-db-name': env.tenantDbName,
        'x-tenant-id': env.tenantId,
        'x-tenant-slug': 'iam-co',
        'x-user-id': String(user._id),
        'x-user-role': String(user.role),
        'x-user-email': String(user.email),
        'x-license-type': 'FREE',
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  // person, their dashboard session, their token, what both must answer
  const people: Array<[string, () => IUser, string, 201 | 403]> = [
    ['an admin', () => users.admin, 'tok-admin', 201],
    ['the owner', () => users.owner, 'tok-owner', 201],
    ['a write-only member', () => users.plain, 'tok-plain', 403],
    ['a member narrowed to mcp:write in the project', () => users.lead, 'tok-lead-pj', 403],
    ['a member whose admin level comes from a group', () => users.grouped, 'tok-grouped', 201],
  ];

  it.each(people)('%s: the subprocess server is answered alike', async (_who, user, token, expected) => {
    const dashboard = await sessionPost(user(), createSubprocess());
    const viaToken = await post(token, createSubprocess());
    expect([dashboard.status, viaToken.status]).toEqual([expected, expected]);
    if (expected === 403) {
      // the same refusal, not an unrelated 403 (no project, route gate ...)
      expect(dashboard.body).toMatchObject({ error: expect.stringContaining('requires elevated "mcp" admin permission') });
      expect(viaToken.body).toMatchObject(SUBPROCESS_REFUSAL);
    }
  });

  it('and so does a custom forbid on mcp.admin', async () => {
    await createPolicy(env.tenantDbName, {
      policyId: 'no-mcp-admin-both',
      name: 'no mcp admin',
      cedar: 'forbid(principal, action == Action::"mcp.admin", resource);',
    }, 'test');
    try {
      const dashboard = await sessionPost(users.admin, createSubprocess());
      const viaToken = await post('tok-admin', createSubprocess());
      expect([dashboard.status, viaToken.status]).toEqual([403, 403]);
      expect(dashboard.body).toMatchObject({ error: expect.stringContaining('requires elevated "mcp" admin permission') });
      expect(viaToken.body).toMatchObject(SUBPROCESS_REFUSAL);
    } finally {
      await deletePolicy(env.tenantDbName, 'no-mcp-admin-both');
    }
  });

  it('a configuration the MCP service refuses is a 400 with its reason on the dashboard too', async () => {
    const { McpServerConfigError } = await import('@/lib/services/mcp');
    hoisted.createMcpServer.mockRejectedValueOnce(new McpServerConfigError('A browser server is available with an API token only'));
    const dashboard = await sessionPost(users.owner, createBody({
      sourceType: 'internal',
      internalConfig: { provider: 'browser', instanceKey: 'back-office' },
      exposure: { protocols: ['streamable-http'], accessMode: 'public' },
    }));
    expect(dashboard).toEqual({ status: 400, body: { error: 'A browser server is available with an API token only' } });
  });
});

describe('upstreamAuth default', () => {
  it('a remote server created without upstreamAuth is stored with type none; other sources still need it', async () => {
    const remote = await post('tok-owner', { name: 'Remote', sourceType: 'remote', remoteConfig: { url: 'https://mcp.example.com/mcp' } });
    expect(remote.status).toBe(201);
    expect(hoisted.createMcpServer.mock.calls[0][4]).toMatchObject({ upstreamAuth: { type: 'none' } });
    const openapi = await post('tok-owner', { name: 'Api', sourceType: 'openapi', openApiSpec: 'openapi: 3.0.0' });
    expect(openapi.status).toBe(400);
  });
});
