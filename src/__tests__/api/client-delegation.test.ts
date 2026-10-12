/**
 * Acting for a user through an API token (header `X-Cognipeer-User-Token`), through the REAL gates: the wrapper every
 * client route runs in, the policy engine with a real SQLite database, custom policies, project levels, the quota guard and
 * the audit hook. Only the application token's own authentication is stood in for (it hands back the token context a
 * database row would), and the upstream model call is stubbed.
 *
 *   the person         is the principal, the application token the actor; every handler, quota key and runtime
 *                      context sees the person; the token keeps its id, its scope and its project
 *   the engine         a custom forbid on the person blocks the call; the token's scope and the project cap it
 *   quotas             a user limit counts the person, not the application, not their colleague
 *   refusals           401 with the typed code, 403 for owners and administrators, 503 when the stores fail; every
 *                      one with a decision id (body, header, audit row); the token's owner is NEVER the fallback
 *   the project        the call runs in the token's project and the person must be able to open it themselves, as in
 *                      the dashboard: their own membership, a group's, any project for an administrator; an external
 *                      account only through a delegated group that was given the project (403 project_not_accessible)
 *   dialects           the same refusals in the JSON, OpenAI and Anthropic envelopes
 *   audit              the person is the subject and the application token the actor, `via` names the issuer
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.QUOTA_POLICY_CACHE_TTL_SECONDS = '0';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
  handleChatCompletion: vi.fn(),
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

// The application token's own authentication is stood in for: it hands back the context the database row would.
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status = 401, code?: string) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiTokenAuthError,
    invalidateApiTokenAuthCache: async () => undefined,
    requireApiTokenFromHeader: async (header: string | null) => {
      const ctx = hoisted.tokens.get(String(header).replace(/^Bearer /, ''));
      if (!ctx) throw new ApiTokenAuthError('Invalid API token', 401);
      return ctx;
    },
  };
});

// Everything up to the model runs for real; only the upstream call is stubbed.
vi.mock('@/lib/services/models/inferenceService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/inferenceService')>()),
  handleChatCompletion: hoisted.handleChatCompletion,
}));

import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { reloadConfig } from '@/lib/core/config';
import { getRequestContext } from '@/lib/core/requestContext';
import type { IApiToken, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetIdentityAssertionCachesForTests } from '@/lib/iam/identityAssertion';
import { resetDelegatedIdentityCachesForTests } from '@/lib/iam/delegatedIdentity';
import { delegatedGroupExternalId, resetDelegatedGroupsForTests } from '@/lib/iam/delegatedGroups';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { authz } from '@/lib/iam/routeAuthz';
import { createPolicy, deletePolicy } from '@/lib/iam/store';
import { putTokenDelegation, resetTokenDelegationCacheForTests, type TokenDelegationConfig } from '@/lib/iam/tokenDelegation';
import { resetQuotaGroupCacheForTests } from '@/lib/quota/quotaGuard';
import { buildRuntimeContextFromRequest } from '@/lib/services/runtimeContext';
import { resolveUsageAttribution } from '@/lib/services/usage/usageEvents';
import {
  authorizeServiceForRequest,
  getApiTokenContextForRequest,
  sendApiTokenError,
  withAnthropicApiRequestContext,
  withClientApiRequestContext,
  withOpenAiApiRequestContext,
} from '@/server/api/fastify-utils';
import { enqueueAuditLog, stampDecisionHeader } from '@/server/api/plugin';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const ISSUER = 'https://idp.bank.example/realms/retail';
const AUDIENCE = 'cognipeer-console';
const SECRET = 'a-shared-secret-of-at-least-32-characters-ok';
const enc = new TextEncoder();

let env: IamTestDb;
let app: FastifyInstance;
const users: Record<string, IUser> = {};
const apps: Record<string, IApiToken> = {};
let defaultProjectId: string;
let projectOneId: string;
let projectTwoId: string;

const mkUser = async (name: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
  const user = (await env.db.createUser({
    tenantId: env.tenantId, email: `${name}@bank.example`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
  })) as IUser;
  users[name] = user;
  return user;
};

/** A real token row, and the context the application's authentication would hand the wrapper. */
const mkAppToken = async (name: string, owner: IUser, scope: Record<string, string> | null, projectId?: string) => {
  const row = await env.db.createApiToken({
    label: name, projectId: projectId ?? defaultProjectId, tenantId: env.tenantId, tokenHash: `hash-${name}`, tokenPrefix: `cpeer_${name}`,
    userId: String(owner._id), servicePermissions: scope as never,
  } as never);
  apps[name] = row;
  hoisted.tokens.set(`tok-${name}`, {
    token: `tok-${name}`,
    tokenRecord: { ...row, _id: String(row._id), userId: String(owner._id) },
    tenant: { licenseType: 'FREE' },
    tenantId: env.tenantId,
    tenantSlug: 'bank',
    tenantDbName: env.tenantDbName,
    projectId: projectId ?? defaultProjectId,
    user: owner,
  });
  return row;
};

const baseConfig = (patch: { trust?: Partial<TokenDelegationConfig['trust']>; mapping?: Partial<TokenDelegationConfig['mapping']>; allowPrivileged?: boolean; enabled?: boolean } = {}): TokenDelegationConfig => ({
  enabled: patch.enabled ?? true,
  trust: {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
    keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }] },
    requireSingleUse: false,
    ...patch.trust,
  },
  mapping: { matchBy: ['externalId', 'verifiedEmail'], jit: 'none', ...patch.mapping },
  allowPrivileged: patch.allowPrivileged ?? false,
});

const delegate = (tokenName: string, patch: Parameters<typeof baseConfig>[0] = {}) =>
  putTokenDelegation(env.tenantDbName, String(apps[tokenName]._id), baseConfig(patch), 'test');

interface UserTokenOptions {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  groups?: string[];
  iss?: string;
  aud?: string;
  kid?: string;
  secret?: string;
  lifetime?: number;
  iat?: number;
}
/**
 * A group created for the issuer (what the first arrival with the claim creates), given a project the way an administrator
 * does: the only way an external account reaches one.
 */
const delegatedGroupWithProject = (consoleGroupName: string, projectId: string) =>
  env.db.runWithTenant!(env.tenantDbName, async () => {
    const group = await env.db.createGroup({
      tenantId: env.tenantId, name: consoleGroupName, source: 'delegated', externalId: delegatedGroupExternalId(ISSUER, consoleGroupName), createdBy: 'test',
    } as never);
    await env.db.upsertGroupProject({ tenantId: env.tenantId, groupId: String(group._id), projectId, role: 'member' });
    return group;
  });

const userToken = (options: UserTokenOptions = {}): Promise<string> => {
  const now = options.iat ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {};
  if (options.email) claims.email = options.email;
  if (options.emailVerified !== undefined) claims.email_verified = options.emailVerified;
  if (options.name) claims.name = options.name;
  if (options.groups) claims.groups = options.groups;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', kid: options.kid ?? 'k1' })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? AUDIENCE)
    .setSubject(options.sub ?? 'sub-alice')
    .setIssuedAt(now)
    .setExpirationTime(now + (options.lifetime ?? 300))
    .sign(enc.encode(options.secret ?? SECRET));
};

const safeParse = (s: string) => { try { return parseJsonBody<any>(s); } catch { return s; } };

const call = async (
  method: string,
  url: string,
  opts: { token?: string; userToken?: string | string[]; body?: unknown; headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string | string[]> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.userToken !== undefined) headers['x-cognipeer-user-token'] = opts.userToken;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.inject({
    method: method as never,
    url,
    headers: headers as never,
    payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.statusCode, body: res.body ? safeParse(res.body) : null, headers: res.headers };
};

/** The audit rows of the calls to one path, newest first. */
const auditRowsOf = async (path: string) => {
  await drainPendingTasks();
  return (await env.db.runWithTenant!(env.tenantDbName, async () => env.db.listAuditLogs({ limit: 500 }))).filter((row) => row.path === path);
};

/** What the probe routes report about the request they run in. */
const describeRequest = (request: any, auth: any) => ({
  principalUserId: auth.tokenRecord.userId,
  user: auth.user ? { id: String(auth.user._id), role: auth.user.role, kind: auth.user.kind ?? null } : null,
  tokenId: String(auth.tokenRecord._id),
  projectId: auth.projectId,
  delegation: auth.delegation ?? null,
  context: (() => {
    const ctx = getRequestContext();
    return ctx ? { userId: ctx.userId, apiTokenId: ctx.apiTokenId, actorType: ctx.actorType, via: ctx.via ?? null } : null;
  })(),
  attribution: resolveUsageAttribution(),
  runtime: buildRuntimeContextFromRequest(undefined, request.headers, { userId: auth.tokenRecord.userId, tokenId: String(auth.tokenRecord._id), source: 'api' }) ?? null,
});

beforeAll(async () => {
  reloadConfig();
  env = await createIamTestDb('tenant_deleg_gate');
  hoisted.getDatabase.mockImplementation(async () => env.db);

  const owner = await mkUser('owner', 'owner');
  await mkUser('admin', 'admin');
  const svc = await mkUser('svc', 'user', { canLogin: false, email: '' });
  await mkUser('alice', 'user');
  await mkUser('bob', 'user');
  await mkUser('carol', 'user');
  await mkUser('erin', 'user'); // belongs to no project at all
  await mkUser('gone', 'user', { status: 'disabled' });
  await mkUser('grouped', 'user');
  void owner;

  defaultProjectId = String((await env.db.createProject({ tenantId: env.tenantId, key: 'default', name: 'Default', createdBy: 'x' }))._id);
  projectOneId = String((await env.db.createProject({ tenantId: env.tenantId, key: 'p1', name: 'P1', createdBy: 'x' }))._id);
  projectTwoId = String((await env.db.createProject({ tenantId: env.tenantId, key: 'p2', name: 'P2', createdBy: 'x' }))._id);
  // The people the application acts for can open the project its tokens are bound to (the gate asks, as a session does).
  for (const name of ['alice', 'bob', 'carol', 'grouped']) {
    await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users[name]._id), projectId: defaultProjectId, role: 'member' });
  }
  // alice reads models in P1 only (an explicit `read`, below what her role gives her elsewhere)
  await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.alice._id), projectId: projectOneId, role: 'member', servicePermissions: { models: 'read' } });
  // grouped: an administrator through a group
  const admins = await env.db.createGroup({ tenantId: env.tenantId, name: 'admins', tenantRole: 'admin', createdBy: 't', source: 'local' } as never);
  await env.db.addGroupMember({ groupId: String(admins._id), userId: String(users.grouped._id), tenantId: env.tenantId, role: 'member' });

  await env.db.createModel({
    tenantId: env.tenantId, projectId: defaultProjectId, name: 'Alpha chat', key: 'chat-alpha', providerKey: 'mock-llm', providerDriver: 'openai-compatible',
    category: 'llm', modelId: 'chat-alpha', settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 }, createdBy: 'seed',
  } as never);

  await mkAppToken('app', svc, null);
  await mkAppToken('scoped', svc, { models: 'read' });
  await mkAppToken('p1', svc, null, projectOneId);
  await mkAppToken('p2', svc, null, projectTwoId);
  await mkAppToken('off', svc, null);

  app = await createFastifyApiTestApp(async (instance) => {
    instance.addHook('onSend', async (request, reply, payload) => { stampDecisionHeader(request, reply); return payload; });
    instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
    const probe = async (request: any, reply: any, auth: any) => reply.send(describeRequest(request, auth));
    instance.get('/client/v1/probe/models', { config: authz.service('models') }, withClientApiRequestContext(probe));
    instance.post('/client/v1/probe/models', { config: authz.service('models') }, withClientApiRequestContext(probe));
    instance.get('/client/v1/probe/agents', { config: authz.service('agents') }, withClientApiRequestContext(probe));
    // one route per audit test: the test app gives every request the same id
    for (const name of ['audit-a', 'audit-b', 'audit-c', 'audit-d']) {
      instance.post(`/client/v1/probe/${name}`, { config: authz.service('models') }, withClientApiRequestContext(probe));
    }
    instance.post('/client/v1/probe/openai', { config: authz.service('models') }, withOpenAiApiRequestContext(probe));
    instance.post('/client/v1/probe/anthropic', { config: authz.service('models') }, withAnthropicApiRequestContext(probe));
    // a handler that makes its own, second decision (reports, realtime, mcp ...)
    instance.get('/client/v1/probe/handler-check', { config: authz.authenticated() }, withClientApiRequestContext(async (request, reply) => {
      const decision = await authorizeServiceForRequest(request, 'agents', { level: 'write' });
      return reply.send({ allowed: decision.allowed });
    }));
    // a route that authenticates itself instead of running in the client wrapper (realtime, sandbox sessions ...)
    instance.get('/client/v1/probe/unwrapped', { config: authz.self('test: authenticates outside the client wrapper') }, async (request, reply) => {
      try {
        const auth = await getApiTokenContextForRequest(request);
        return reply.send({ principalUserId: String(auth.tokenRecord.userId), delegation: auth.delegation ?? null });
      } catch (error) {
        return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: String(error) });
      }
    });
    // the gate without the permission check: delegation still decides who the call is for
    instance.get('/client/v1/probe/norbac', { config: authz.authenticated() }, withClientApiRequestContext(probe, { rbac: false }));
    await instance.register(clientInferenceApiPlugin);
  });
  await app.ready();
});

afterAll(async () => {
  delete process.env.QUOTA_POLICY_CACHE_TTL_SECONDS;
  reloadConfig();
  await app?.close();
  await env?.cleanup();
});

beforeEach(async () => {
  hoisted.handleChatCompletion.mockReset().mockRejectedValue(new Error('upstream stubbed'));
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: false });
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetIdentityAssertionCachesForTests();
  resetDelegatedIdentityCachesForTests();
  resetDelegatedGroupsForTests();
  resetTokenDelegationCacheForTests();
  resetQuotaGroupCacheForTests();
  // alice is a member linked to her identity; everything else a test needs it creates itself
  await env.db.runWithTenant!(env.tenantDbName, async () => {
    for (const user of await env.db.listUsers({ includeExternal: true })) {
      if (user.kind === 'external') await env.db.deleteUser(String(user._id));
    }
    await env.db.updateUser(String(users.alice._id), { externalIds: { [ISSUER]: 'sub-alice' } });
    await env.db.updateUser(String(users.bob._id), { externalIds: { [ISSUER]: 'sub-bob' } });
    await env.db.updateUser(String(users.carol._id), { externalIds: {} });
    await env.db.updateUser(String(users.erin._id), { externalIds: { [ISSUER]: 'sub-erin' } });
    // the privileged accounts start unlinked and out of the groups of any issuer, whatever an earlier test did
    for (const name of ['owner', 'admin', 'grouped']) await env.db.updateUser(String(users[name]._id), { externalIds: {} });
    for (const group of await env.db.listGroups(env.tenantId)) {
      if (group.source !== 'delegated') continue;
      await env.db.deleteGroupMembersByGroup(String(group._id));
      await env.db.deleteGroupProjectsByGroup(String(group._id));
      await env.db.deleteGroup(String(group._id));
    }
  });
  await delegate('app');
  await delegate('scoped');
  await delegate('p1');
  await delegate('p2');
});

describe('who the call is for', () => {
  it('without the header a call runs as the token\'s owner, exactly as before', async () => {
    const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      principalUserId: String(users.svc._id),
      tokenId: String(apps.app._id),
      delegation: null,
      context: { userId: String(users.svc._id), apiTokenId: String(apps.app._id), actorType: 'api_token', via: null },
    });
  });

  it('with the header the person is the principal and the application token the actor', async () => {
    const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const alice = String(users.alice._id);
    const via = { kind: 'delegated', issuer: ISSUER };
    expect(res.body).toMatchObject({
      principalUserId: alice,
      user: { id: alice, role: 'user' },
      tokenId: String(apps.app._id),
      delegation: { state: 'active', issuer: ISSUER, subject: 'sub-alice', kind: 'person', appOwnerId: String(users.svc._id), created: false },
      // every service that stamps its logs from the request context sees the person as the subject and the token as the actor
      context: { userId: alice, apiTokenId: String(apps.app._id), actorType: 'api_token', via },
      attribution: { userId: alice, apiTokenId: String(apps.app._id), actorType: 'api_token', via },
      // the runtime context of an agent run: the person is the user, the application token stays the token
      runtime: { userId: alice, tokenId: String(apps.app._id), source: 'api', via },
    });
  });

  it('accepts the token with a Bearer prefix, and links a member found by a verified address - once', async () => {
    const token = await userToken({ sub: 'sub-carol', email: users.carol.email, emailVerified: true });
    const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: `Bearer ${token}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ principalUserId: String(users.carol._id), delegation: { state: 'active', kind: 'person' } });
    // carol now holds the identity: the next call needs no address
    const again = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub: 'sub-carol' }) });
    expect(again.body).toMatchObject({ principalUserId: String(users.carol._id) });
    // a second subject of the same issuer claiming her address is a conflict, not a takeover
    const other = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub: 'sub-carol-2', email: users.carol.email, emailVerified: true }) });
    expect(other.status).toBe(401);
    expect(other.body).toMatchObject({ code: 'conflict' });
    // an address the issuer did not verify finds nobody
    const unverified = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub: 'sub-carol-3', email: users.carol.email, emailVerified: false }) });
    expect(unverified.body).toMatchObject({ code: 'unknown_principal' });
  });

  it('creates an external account for a person nobody knew, and finds it again', async () => {
    // (an external account reaches the token's project through a delegated group that was given it)
    await delegatedGroupWithProject('Partners', defaultProjectId);
    await delegate('app', { mapping: { jit: 'external', groupMap: [{ idpGroup: 'partners', consoleGroupName: 'Partners' }] } });
    const token = await userToken({ sub: 'sub-new-1', email: 'newcomer@host.example', name: 'New Comer', groups: ['partners'] });
    const first = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: token });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      user: { role: 'user', kind: 'external' },
      delegation: { state: 'active', kind: 'external', created: true },
    });
    const second = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub: 'sub-new-1', groups: ['partners'] }) });
    expect(second.body).toMatchObject({ delegation: { kind: 'external', created: false }, principalUserId: first.body.principalUserId });
    // the account cannot sign in or hold tokens, and it stays out of the member lists
    const stored = await env.db.runWithTenant!(env.tenantDbName, () => env.db.findUserById(first.body.principalUserId));
    expect(stored).toMatchObject({ kind: 'external', canLogin: false, role: 'user' });
  });

  it('is the same for the routes that opt out of the permission gate', async () => {
    const res = await call('GET', '/api/client/v1/probe/norbac', { token: 'tok-app', userToken: await userToken() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ principalUserId: String(users.alice._id), delegation: { state: 'active' } });
    const refused = await call('GET', '/api/client/v1/probe/norbac', { token: 'tok-app', userToken: await userToken({ sub: 'nobody' }) });
    expect(refused.status).toBe(401);
  });
});

describe('a route outside the client wrapper', () => {
  it('does not act for users: the user token header is refused (400), never answered as the token\'s owner', async () => {
    const res = await call('GET', '/api/client/v1/probe/unwrapped', { token: 'tok-app', userToken: await userToken() });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'user_token_not_supported', error: expect.any(String) });
    expect(res.body.principalUserId).toBeUndefined();
    // an empty or malformed header is a header all the same
    expect((await call('GET', '/api/client/v1/probe/unwrapped', { token: 'tok-app', userToken: '' })).status).toBe(400);
    // the application's own authentication still comes first: no token, no hint about the header
    expect((await call('GET', '/api/client/v1/probe/unwrapped', { userToken: await userToken() })).status).toBe(401);
  });

  it('without the header it authenticates as the token\'s owner, as before', async () => {
    const res = await call('GET', '/api/client/v1/probe/unwrapped', { token: 'tok-app' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ principalUserId: String(users.svc._id), delegation: null });
  });
});

describe('the engine decides for the person', () => {
  const forbidModelsFor = (userId: string, policyId: string) => createPolicy(env.tenantDbName, {
    policyId,
    name: `no models for ${policyId}`,
    // the form the visual editor compiles a rule about a person to: the person, and the tokens that act as them
    cedar: `forbid (principal, action, resource) when { (principal == User::"${userId}" || (principal is ApiToken && principal.owner == User::"${userId}")) && resource.service == "models" };`,
  }, 'test');

  it('a custom forbid on the person blocks the application\'s call; the application itself and other people are untouched', async () => {
    await forbidModelsFor(String(users.alice._id), 'no-models-alice');
    try {
      const blocked = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() });
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ code: 'forbidden', service: 'models' });
      expect(typeof blocked.body.decisionId).toBe('string');
      expect(blocked.headers['x-decision-id']).toBe(blocked.body.decisionId);

      // the same token acts as its owner without the header ...
      expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-app' })).status).toBe(200);
      // ... and for somebody else
      expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub: 'sub-bob' }) })).status).toBe(200);
    } finally {
      await deletePolicy(env.tenantDbName, 'no-models-alice');
    }
  });

  it('a rule about the application\'s own owner does not apply to the people it acts for', async () => {
    await forbidModelsFor(String(users.svc._id), 'no-models-svc');
    try {
      expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-app' })).status).toBe(403);
      expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() })).status).toBe(200);
    } finally {
      await deletePolicy(env.tenantDbName, 'no-models-svc');
    }
  });

  it('a rule about the application token itself still applies when it acts for somebody', async () => {
    await createPolicy(env.tenantDbName, {
      policyId: 'no-models-token',
      name: 'no models for this token',
      cedar: `forbid (principal is ApiToken, action, resource) when { principal == ApiToken::"${String(apps.app._id)}" && resource.service == "models" };`,
    }, 'test');
    try {
      expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() })).status).toBe(403);
      expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-p1', userToken: await userToken() })).status).toBe(200);
    } finally {
      await deletePolicy(env.tenantDbName, 'no-models-token');
    }
  });

  it('a handler\'s own second decision is made for the person too', async () => {
    await createPolicy(env.tenantDbName, {
      policyId: 'no-agents-alice',
      name: 'no agents for alice',
      cedar: `forbid (principal, action, resource) when { (principal is ApiToken && principal.owner == User::"${String(users.alice._id)}") && resource.service == "agents" };`,
    }, 'test');
    try {
      const alice = await call('GET', '/api/client/v1/probe/handler-check', { token: 'tok-app', userToken: await userToken() });
      expect(alice.body).toEqual({ allowed: false });
      const bob = await call('GET', '/api/client/v1/probe/handler-check', { token: 'tok-app', userToken: await userToken({ sub: 'sub-bob' }) });
      expect(bob.body).toEqual({ allowed: true });
    } finally {
      await deletePolicy(env.tenantDbName, 'no-agents-alice');
    }
  });

  it('the application token\'s scope caps the person', async () => {
    // models read only: alice's role gives her more, the token does not
    expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-scoped', userToken: await userToken() })).status).toBe(200);
    const write = await call('POST', '/api/client/v1/probe/models', { token: 'tok-scoped', userToken: await userToken() });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: 'forbidden', service: 'models', required: 'write' });
    // a service outside the scope is closed altogether
    const agents = await call('GET', '/api/client/v1/probe/agents', { token: 'tok-scoped', userToken: await userToken() });
    expect(agents.status).toBe(403);
    // the unscoped token lets the same person write
    expect((await call('POST', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() })).status).toBe(200);
  });

  it('the token\'s project caps the person: their level in THAT project applies', async () => {
    // alice reads models in P1 (her tenant role would let her write)
    expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-p1', userToken: await userToken() })).status).toBe(200);
    const write = await call('POST', '/api/client/v1/probe/models', { token: 'tok-p1', userToken: await userToken() });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: 'forbidden', service: 'models' });
    // P2 is not hers to open at all: the call is refused before the engine is asked (see "the project of the token")
    const other = await call('POST', '/api/client/v1/probe/models', { token: 'tok-p2', userToken: await userToken() });
    expect(other.status, JSON.stringify(other.body)).toBe(403);
    expect(other.body).toMatchObject({ code: 'project_not_accessible', decisionId: expect.any(String) });
  });

  it('fails closed when the engine cannot decide: 503, never an allow', async () => {
    const down = vi.spyOn(env.db, 'iamDocGet').mockRejectedValueOnce(new Error('iam store down'));
    try {
      const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'delegation_unavailable' });
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      down.mockRestore();
    }
  });
});

describe('the project of the token', () => {
  const asPerson = (tokenName: string, sub: string, extra: UserTokenOptions = {}, method = 'GET', path = '/api/client/v1/probe/models') =>
    userToken({ sub, ...extra }).then((userTokenValue) => call(method, path, { token: `tok-${tokenName}`, userToken: userTokenValue }));

  it('refuses a person who cannot open the token\'s project: 403 project_not_accessible with a decision id, and no handler runs', async () => {
    // alice: default project and P1. bob: the default project. erin: no project at all. Nobody is a member of P2.
    const refused: Array<[string, string]> = [['p2', 'sub-alice'], ['p2', 'sub-bob'], ['p1', 'sub-bob'], ['app', 'sub-erin'], ['p1', 'sub-erin']];
    for (const [tokenName, sub] of refused) {
      const res = await asPerson(tokenName, sub);
      expect(res.status, `${sub} through ${tokenName}`).toBe(403);
      expect(res.body, `${sub} through ${tokenName}`).toMatchObject({ code: 'project_not_accessible', decisionId: expect.any(String) });
      expect(res.headers['x-decision-id']).toBe(res.body.decisionId);
      expect(res.body.principalUserId).toBeUndefined();
    }
    // the project of their own is theirs
    expect((await asPerson('p1', 'sub-alice')).status).toBe(200);
    expect((await asPerson('app', 'sub-alice')).status).toBe(200);
    expect((await asPerson('app', 'sub-bob')).status).toBe(200);
  });

  it('is the same on writes, and for the routes that opt out of the permission gate', async () => {
    const write = await asPerson('p2', 'sub-alice', {}, 'POST');
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ code: 'project_not_accessible' });
    const norbac = await asPerson('p1', 'sub-bob', {}, 'GET', '/api/client/v1/probe/norbac');
    expect(norbac.status).toBe(403);
    expect(norbac.body).toMatchObject({ code: 'project_not_accessible' });
  });

  it('is told in the OpenAI and the Anthropic envelopes too', async () => {
    const openai = await asPerson('p2', 'sub-alice', {}, 'POST', '/api/client/v1/probe/openai');
    expect(openai.status).toBe(403);
    expect(openai.body).toMatchObject({ error: { type: 'permission_error', code: 'project_not_accessible', decision_id: expect.any(String), message: expect.any(String) } });
    expect(openai.headers['x-decision-id']).toBe(openai.body.error.decision_id);
    const anthropic = await asPerson('p2', 'sub-alice', {}, 'POST', '/api/client/v1/probe/anthropic');
    expect(anthropic.status).toBe(403);
    expect(anthropic.body).toMatchObject({ type: 'error', error: { type: 'permission_error', code: 'project_not_accessible', decision_id: expect.any(String) } });
  });

  it('opens with a membership of the person\'s own, and closes again at once when it is taken away', async () => {
    await env.db.upsertUserProject({ tenantId: env.tenantId, userId: String(users.bob._id), projectId: projectTwoId, role: 'member' });
    try {
      const ok = await asPerson('p2', 'sub-bob');
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ projectId: projectTwoId, principalUserId: String(users.bob._id) });
    } finally {
      await env.db.deleteUserProject(String(users.bob._id), projectTwoId);
    }
    expect((await asPerson('p2', 'sub-bob')).status).toBe(403);
  });

  it('an external account reaches a project only through a delegated group that was given it', async () => {
    const groupMap = [{ idpGroup: 'partners', consoleGroupName: 'Partners' }];
    await delegate('p2', { mapping: { jit: 'external', groupMap } });
    await delegate('app', { mapping: { matchBy: ['externalId'], jit: 'none' } });
    const claim = { email: 'ext1@host.example', name: 'Ext One' };

    // arriving with no group claim: the account is created (the issuer vouches for the person) but has no project
    const bare = await asPerson('p2', 'sub-ext-1', claim);
    expect(bare.status).toBe(403);
    expect(bare.body).toMatchObject({ code: 'project_not_accessible', decisionId: expect.any(String) });
    const created = await env.db.runWithTenant!(env.tenantDbName, () => env.db.findUsersByExternalIdentity(ISSUER, 'sub-ext-1'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: 'external', role: 'user' });

    // with the claim the issuer's group is created - and has no project yet
    const grouped = await asPerson('p2', 'sub-ext-1', { ...claim, groups: ['partners'] });
    expect(grouped.status).toBe(403);
    const group = await env.db.runWithTenant!(env.tenantDbName, () => env.db.findGroupByExternalId(delegatedGroupExternalId(ISSUER, 'Partners')));
    expect(group).toMatchObject({ source: 'delegated' });

    // an administrator gives the group P2: the person is let in, in that project and no other
    await env.db.runWithTenant!(env.tenantDbName, () => env.db.upsertGroupProject({
      tenantId: env.tenantId, groupId: String(group!._id), projectId: projectTwoId, role: 'member',
    }));
    const ok = await asPerson('p2', 'sub-ext-1', { ...claim, groups: ['partners'] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ projectId: projectTwoId, user: { role: 'user', kind: 'external' }, delegation: { state: 'active', kind: 'external' } });
    expect((await asPerson('p1', 'sub-ext-1')).status).toBe(403);
    expect((await asPerson('app', 'sub-ext-1')).status).toBe(403);

    // leaving the claim takes the membership away, and with it the access
    const left = await asPerson('p2', 'sub-ext-1', claim);
    expect(left.status).toBe(403);
    expect(left.body).toMatchObject({ code: 'project_not_accessible' });

    // and taking the project away from the group closes it too
    expect((await asPerson('p2', 'sub-ext-1', { ...claim, groups: ['partners'] })).status).toBe(200);
    await env.db.runWithTenant!(env.tenantDbName, () => env.db.removeGroupProject(String(group!._id), projectTwoId));
    expect((await asPerson('p2', 'sub-ext-1', { ...claim, groups: ['partners'] })).status).toBe(403);
  });

  it('administrators are in every project (where the configuration admits them); the owner is never acted for', async () => {
    await env.db.runWithTenant!(env.tenantDbName, async () => {
      await env.db.updateUser(String(users.admin._id), { externalIds: { [ISSUER]: 'sub-admin' } });
      await env.db.updateUser(String(users.owner._id), { externalIds: { [ISSUER]: 'sub-owner' } });
    });
    await delegate('p2', { allowPrivileged: true });
    const admin = await asPerson('p2', 'sub-admin');
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(admin.body).toMatchObject({ projectId: projectTwoId, principalUserId: String(users.admin._id) });
    const owner = await asPerson('p2', 'sub-owner');
    expect(owner.status).toBe(403);
    expect(owner.body).toMatchObject({ code: 'delegation_refused' });
  });

  it('a project that no longer exists is not one the person can open', async () => {
    const gone = await env.db.createProject({ tenantId: env.tenantId, key: 'p-gone', name: 'Gone', createdBy: 'x' });
    await mkAppToken('gone-project', users.svc, null, String(gone._id));
    await delegate('gone-project');
    await env.db.runWithTenant!(env.tenantDbName, () => env.db.deleteProject(String(gone._id)));
    const res = await asPerson('gone-project', 'sub-alice');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'project_not_accessible' });
  });

  it('fails closed when the project cannot be looked up: 503, never an allow', async () => {
    const down = vi.spyOn(env.db, 'listUserProjectsByUser').mockRejectedValue(new Error('project store down'));
    try {
      const res = await asPerson('p1', 'sub-alice');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'delegation_unavailable', decisionId: expect.any(String) });
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      down.mockRestore();
    }
  });

  it('writes the refusal against the application token alone, with the typed reason and the decision id', async () => {
    const res = await asPerson('p2', 'sub-alice', {}, 'POST', '/api/client/v1/probe/audit-d');
    expect(res.status).toBe(403);
    const [row] = await auditRowsOf('/api/client/v1/probe/audit-d');
    expect(row).toMatchObject({
      actorType: 'api_token',
      apiTokenId: String(apps.p2._id),
      outcome: 'denied',
      statusCode: 403,
      metadata: { iamEnforce: true, code: 'delegation_refused', decisionId: res.body.decisionId, reasons: ['project_not_accessible'], via: { kind: 'delegated', issuer: ISSUER }, delegationSubject: 'sub-alice' },
    });
    expect(row.actorUserId ?? null).toBeNull();
  });

  it('applies to calls that act for a person only: a call without the header is decided as before', async () => {
    const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-p2' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ principalUserId: String(users.svc._id), delegation: null, projectId: projectTwoId });
  });
});

describe('limits count the person', () => {
  let modelRoute: string;
  const chat = (userTokenValue?: string | Promise<string>) =>
    userTokenValue === undefined
      ? call('POST', modelRoute, { token: 'tok-app', body: { model: 'chat-alpha', messages: [{ role: 'user', content: 'hi' }] } })
      : Promise.resolve(userTokenValue).then((value) => call('POST', modelRoute, { token: 'tok-app', userToken: value, body: { model: 'chat-alpha', messages: [{ role: 'user', content: 'hi' }] } }));

  beforeEach(() => {
    modelRoute = '/api/client/v1/chat/completions';
  });

  it('a limit on the person is used up by the person\'s calls through the application, and by nobody else\'s', async () => {
    const policy = await env.db.runWithTenant!(env.tenantDbName, () => env.db.createQuotaPolicy({
      tenantId: env.tenantId, projectId: defaultProjectId, scope: 'user', scopeId: String(users.alice._id), domain: 'global', priority: 0, enabled: true,
      limits: { rateLimit: { requests: { perMinute: 1 } } },
    } as never));
    try {
      const first = await chat(userToken());
      expect(first.status, JSON.stringify(first.body)).not.toBe(429);
      const second = await chat(userToken());
      expect(second.status, JSON.stringify(second.body)).toBe(429);
      // her colleague, through the same application token, is not held to her limit
      for (let i = 0; i < 3; i += 1) expect((await chat(userToken({ sub: 'sub-bob' }))).status).not.toBe(429);
      // and the application on its own (as its owner) is not either
      for (let i = 0; i < 3; i += 1) expect((await chat()).status).not.toBe(429);
    } finally {
      await env.db.runWithTenant!(env.tenantDbName, () => env.db.deleteQuotaPolicy(String(policy._id), env.tenantId));
    }
  });

  it('a limit on the application token is shared by every person it acts for', async () => {
    const policy = await env.db.runWithTenant!(env.tenantDbName, () => env.db.createQuotaPolicy({
      tenantId: env.tenantId, projectId: defaultProjectId, scope: 'token', scopeId: String(apps.app._id), domain: 'global', priority: 0, enabled: true,
      limits: { rateLimit: { requests: { perMinute: 1000 } } },
    } as never));
    try {
      // the token scope matches (the context carries the token's id); the policy is far from reached
      expect((await chat(userToken())).status).not.toBe(429);
      expect((await chat(userToken({ sub: 'sub-bob' }))).status).not.toBe(429);
    } finally {
      await env.db.runWithTenant!(env.tenantDbName, () => env.db.deleteQuotaPolicy(String(policy._id), env.tenantId));
    }
  });
});

describe('what is refused, and how it is told', () => {
  const failures: Array<{
    name: string;
    token: () => Promise<string | string[]>;
    setup?: () => Promise<unknown>;
    status: number;
    code: string;
  }> = [
    { name: 'a bad signature', token: () => userToken({ secret: 'another-secret-of-at-least-32-characters-x' }), status: 401, code: 'invalid_assertion' },
    { name: 'the wrong audience', token: () => userToken({ aud: 'someone-else' }), status: 401, code: 'invalid_assertion' },
    { name: 'the wrong issuer', token: () => userToken({ iss: 'https://evil.example' }), status: 401, code: 'invalid_assertion' },
    { name: 'an expired assertion', token: () => userToken({ iat: Math.floor(Date.now() / 1000) - 3600, lifetime: 60 }), status: 401, code: 'expired' },
    { name: 'a key id nobody configured', token: () => userToken({ kid: 'unknown' }), status: 401, code: 'untrusted_key' },
    { name: 'a person nobody matches', token: () => userToken({ sub: 'sub-nobody' }), status: 401, code: 'unknown_principal' },
    { name: 'a disabled account', token: () => userToken({ sub: 'sub-gone', email: 'gone@bank.example', emailVerified: true }), status: 401, code: 'disabled' },
    { name: 'garbage', token: async () => 'not-a-token', status: 401, code: 'invalid_assertion' },
    { name: 'an empty header', token: async () => '', status: 401, code: 'invalid_assertion' },
    { name: 'two headers', token: async () => [await userToken(), await userToken()], status: 401, code: 'invalid_assertion' },
  ];

  it.each(failures)('$name: $status $code with a decision id, and never as the token\'s owner', async ({ token, status, code }) => {
    const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await token() });
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.body).toMatchObject({ code, decisionId: expect.any(String) });
    expect(res.body.error).toEqual(expect.any(String));
    expect(res.headers['x-decision-id']).toBe(res.body.decisionId);
    // a handler never ran: nothing but the refusal came back
    expect(res.body.principalUserId).toBeUndefined();
  });

  it('refuses a user token the token is not set up for, switched off or never set up: delegation_not_enabled', async () => {
    const token = await userToken();
    const never = await call('GET', '/api/client/v1/probe/models', { token: 'tok-off', userToken: token });
    expect(never.status).toBe(401);
    expect(never.body).toMatchObject({ code: 'delegation_not_enabled', decisionId: expect.any(String) });
    // without the header the same token works as ever
    expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-off' })).status).toBe(200);

    await delegate('off', { enabled: false });
    const off = await call('GET', '/api/client/v1/probe/models', { token: 'tok-off', userToken: token });
    expect(off.status).toBe(401);
    expect(off.body).toMatchObject({ code: 'delegation_not_enabled' });
    // switching it on takes effect at once on this node
    await delegate('off');
    expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-off', userToken: token })).status).toBe(200);
    await env.db.runWithTenant!(env.tenantDbName, () => env.db.iamDocDelete('iam_delegations', String(apps.off._id)));
    resetTokenDelegationCacheForTests();
  });

  it('a person disabled after their first call is refused on the next, although the identity is remembered', async () => {
    expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() })).status).toBe(200);
    await env.db.runWithTenant!(env.tenantDbName, () => env.db.updateUser(String(users.alice._id), { status: 'disabled' }));
    try {
      const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'disabled' });
    } finally {
      await env.db.runWithTenant!(env.tenantDbName, () => env.db.updateUser(String(users.alice._id), { status: 'active' }));
    }
  });

  it('owners are never acted for, administrators only when the configuration says so', async () => {
    await env.db.runWithTenant!(env.tenantDbName, async () => {
      await env.db.updateUser(String(users.owner._id), { externalIds: { [ISSUER]: 'sub-owner' } });
      await env.db.updateUser(String(users.admin._id), { externalIds: { [ISSUER]: 'sub-admin' } });
      await env.db.updateUser(String(users.grouped._id), { externalIds: { [ISSUER]: 'sub-grouped' } });
    });
    for (const sub of ['sub-owner', 'sub-admin', 'sub-grouped']) {
      const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub }) });
      expect(res.status, sub).toBe(403);
      expect(res.body, sub).toMatchObject({ code: 'delegation_refused', decisionId: expect.any(String) });
      expect(res.headers['x-decision-id']).toBe(res.body.decisionId);
    }

    await delegate('app', { allowPrivileged: true });
    // the administrator, also through a group, may be acted for now ...
    for (const sub of ['sub-admin', 'sub-grouped']) {
      const ok = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub }) });
      expect(ok.status, sub).toBe(200);
    }
    // ... the owner never
    const owner = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub: 'sub-owner' }) });
    expect(owner.status).toBe(403);
    expect(owner.body).toMatchObject({ code: 'delegation_refused' });
  });

  it('leaves a refused owner or administrator exactly as they were: no link to the subject, no groups', async () => {
    const groupMap = [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }];
    await delegate('app', { mapping: { matchBy: ['externalId', 'verifiedEmail'], jit: 'none', groupMap } });
    const inGroups = (user: IUser) => env.db.runWithTenant!(env.tenantDbName, async () => (await env.db.listGroupMembersByUser(String(user._id))).filter((row) => row.source === 'delegated').length);
    const issuerGroups = () => env.db.runWithTenant!(env.tenantDbName, async () => (await env.db.listGroups(env.tenantId)).filter((group) => group.source === 'delegated').length);
    const linked = (user: IUser) => env.db.runWithTenant!(env.tenantDbName, async () => (await env.db.findUserById(String(user._id)))?.externalIds ?? {});

    // arriving by a verified address (the path that would LINK the account) and with a group claim
    for (const name of ['owner', 'admin', 'grouped']) {
      const res = await call('GET', '/api/client/v1/probe/models', {
        token: 'tok-app',
        userToken: await userToken({ sub: `sub-${name}-new`, email: users[name].email, emailVerified: true, groups: ['sales'] }),
      });
      expect(res.status, name).toBe(403);
      expect(res.body, name).toMatchObject({ code: 'delegation_refused', decisionId: expect.any(String) });
      expect(await linked(users[name]), `${name} was linked`).toEqual({});
      expect(await inGroups(users[name]), `${name} was put in a group`).toBe(0);
    }
    expect(await issuerGroups()).toBe(0);

    // a person who may be acted for is linked and put in the group by the very same calls
    const ok = await call('GET', '/api/client/v1/probe/models', {
      token: 'tok-app',
      userToken: await userToken({ sub: 'sub-carol-linked', email: users.carol.email, emailVerified: true, groups: ['sales'] }),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await linked(users.carol)).toEqual({ [ISSUER]: 'sub-carol-linked' });
    expect(await inGroups(users.carol)).toBe(1);

    // and where the configuration admits administrators, they are too (the owner never)
    await delegate('app', { allowPrivileged: true, mapping: { matchBy: ['externalId', 'verifiedEmail'], jit: 'none', groupMap } });
    const admin = await call('GET', '/api/client/v1/probe/models', {
      token: 'tok-app',
      userToken: await userToken({ sub: 'sub-admin-new', email: users.admin.email, emailVerified: true, groups: ['sales'] }),
    });
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(await linked(users.admin)).toEqual({ [ISSUER]: 'sub-admin-new' });
    const owner = await call('GET', '/api/client/v1/probe/models', {
      token: 'tok-app',
      userToken: await userToken({ sub: 'sub-owner-new', email: users.owner.email, emailVerified: true, groups: ['sales'] }),
    });
    expect(owner.status).toBe(403);
    expect(await linked(users.owner)).toEqual({});
    expect(await inGroups(users.owner)).toBe(0);
  });

  it('gives every refused call its own decision id, also when concurrent calls for one person share a lookup', async () => {
    await env.db.runWithTenant!(env.tenantDbName, () => env.db.updateUser(String(users.admin._id), { externalIds: { [ISSUER]: 'sub-admin' } }));
    const token = await userToken({ sub: 'sub-admin' });
    const results = await Promise.all([1, 2, 3, 4].map(() => call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: token })));
    for (const res of results) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'delegation_refused' });
      expect(res.headers['x-decision-id']).toBe(res.body.decisionId);
    }
    expect(new Set(results.map((res) => res.body.decisionId)).size).toBe(results.length);
  });

  it('refuses a seat the licence does not have', async () => {
    await delegate('app', { mapping: { jit: 'external' } });
    const policy = await env.db.runWithTenant!(env.tenantDbName, async () => env.db.createQuotaPolicy({
      tenantId: env.tenantId, projectId: defaultProjectId, scope: 'tenant', domain: 'global', priority: 0, enabled: true,
      limits: { quotas: { maxUsers: (await env.db.listUsers({ includeExternal: true })).length } },
    } as never));
    try {
      const res = await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken({ sub: 'sub-brand-new' }) });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'seat_limit' });
      // people who already have an account are not affected
      expect((await call('GET', '/api/client/v1/probe/models', { token: 'tok-app', userToken: await userToken() })).status).toBe(200);
    } finally {
      await env.db.runWithTenant!(env.tenantDbName, () => env.db.deleteQuotaPolicy(String(policy._id), env.tenantId));
    }
  });

  it('is the same in the OpenAI and the Anthropic envelopes', async () => {
    const missing = await userToken({ sub: 'sub-nobody' });
    const openai = await call('POST', '/api/client/v1/probe/openai', { token: 'tok-app', userToken: missing });
    expect(openai.status).toBe(401);
    expect(openai.body).toMatchObject({ error: { type: 'invalid_request_error', code: 'unknown_principal', decision_id: expect.any(String), message: expect.any(String) } });
    expect(openai.headers['x-decision-id']).toBe(openai.body.error.decision_id);

    const anthropic = await call('POST', '/api/client/v1/probe/anthropic', { token: 'tok-app', userToken: missing });
    expect(anthropic.status).toBe(401);
    expect(anthropic.body).toMatchObject({ type: 'error', error: { type: 'authentication_error', code: 'unknown_principal', decision_id: expect.any(String) } });

    await env.db.runWithTenant!(env.tenantDbName, () => env.db.updateUser(String(users.admin._id), { externalIds: { [ISSUER]: 'sub-admin' } }));
    const refused = await call('POST', '/api/client/v1/probe/openai', { token: 'tok-app', userToken: await userToken({ sub: 'sub-admin' }) });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { type: 'permission_error', code: 'delegation_refused' } });
    const refusedAnthropic = await call('POST', '/api/client/v1/probe/anthropic', { token: 'tok-app', userToken: await userToken({ sub: 'sub-admin' }) });
    expect(refusedAnthropic.status).toBe(403);
    expect(refusedAnthropic.body).toMatchObject({ error: { type: 'permission_error', code: 'delegation_refused' } });
  });
});

describe('the audit trail', () => {
  it('writes the person as the subject, the application token as the actor, and who vouched for them', async () => {
    const res = await call('POST', '/api/client/v1/probe/audit-a', { token: 'tok-app', userToken: await userToken() });
    expect(res.status).toBe(200);
    const [row] = await auditRowsOf('/api/client/v1/probe/audit-a');
    expect(row).toMatchObject({
      actorType: 'api_token',
      actorUserId: String(users.alice._id),
      actorEmail: users.alice.email,
      apiTokenId: String(apps.app._id),
      service: 'models',
      outcome: 'success',
      metadata: { via: { kind: 'delegated', issuer: ISSUER } },
    });
  });

  it('writes a refused attempt against the application token alone, with the decision id, never against its owner', async () => {
    const res = await call('POST', '/api/client/v1/probe/audit-b', { token: 'tok-app', userToken: await userToken({ sub: 'sub-nobody' }) });
    expect(res.status).toBe(401);
    const [row] = await auditRowsOf('/api/client/v1/probe/audit-b');
    expect(row).toMatchObject({
      actorType: 'api_token',
      apiTokenId: String(apps.app._id),
      outcome: 'denied',
      statusCode: 401,
      metadata: { iamEnforce: true, code: 'delegation_refused', decisionId: res.body.decisionId, reasons: ['unknown_principal'], via: { kind: 'delegated', issuer: ISSUER }, delegationSubject: 'sub-nobody' },
    });
    // (a column with nothing in it reads back as null on one backend and as missing on the other)
    expect(row.actorUserId ?? null).toBeNull();
    expect(row.actorEmail ?? null).toBeNull();
  });

  it('a refusal before the assertion verified has no issuer to name', async () => {
    const res = await call('POST', '/api/client/v1/probe/audit-c', { token: 'tok-app', userToken: 'garbage' });
    expect(res.status).toBe(401);
    const [row] = await auditRowsOf('/api/client/v1/probe/audit-c');
    expect(row).toMatchObject({ apiTokenId: String(apps.app._id), outcome: 'denied', metadata: { code: 'delegation_refused', reasons: ['invalid_assertion'] } });
    expect(row.actorUserId ?? null).toBeNull();
    expect((row.metadata as Record<string, unknown>).via).toBeUndefined();
  });
});
