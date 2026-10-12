/**
 * The token IP allowlist through the real client-API wrapper and a real Fastify
 * instance with the app's own `trustProxy` resolution:
 *
 *  - the address that is matched is `request.ip`, i.e. the connection address,
 *    or the forwarded one only when the immediate peer is a trusted proxy
 *    (TRUSTED_PROXIES); a raw X-Forwarded-For / X-Real-IP header never counts
 *  - a refused call is a 403 `ip_not_allowed` in every error dialect
 *  - it is decided before the authorization engine is consulted
 *  - the refusal is audited (throttled), the successful call is untouched
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    findApiTokenByHash: vi.fn(),
    findTenantById: vi.fn(),
    switchToTenant: vi.fn(),
    findUserById: vi.fn(),
    updateTokenLastUsedByHash: vi.fn(),
    runWithTenant: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    // What the authorization engine reads for a token's owner (nothing stored: no groups,
    // no projects, no custom policies).
    iamDocGet: vi.fn(),
    iamDocPut: vi.fn(),
    listGroupMembersByUser: vi.fn(),
    listUserProjectsByUser: vi.fn(),
    listGroupProjectsByGroup: vi.fn(),
    listProjects: vi.fn(),
    findProjectByKey: vi.fn(),
  },
  recordAuditLog: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_dbName: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({ get: vi.fn(async () => undefined), set: vi.fn(), del: vi.fn() })),
}));
vi.mock('@/lib/core/asyncTask', () => ({
  fireAndForget: (_label: string, fn: () => Promise<void>) => { fn().catch(() => undefined); },
  criticalFireAndForget: (_label: string, fn: () => Promise<void>) => { fn().catch(() => undefined); },
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn(async () => ({ _id: 'p-default' })),
}));
vi.mock('@/lib/services/audit', () => ({ recordAuditLog: h.recordAuditLog }));

import { reloadConfig } from '@/lib/core/config';
import { resolveTrustProxyOption } from '@/server/app';
import {
  getApiTokenContextForRequest,
  sendApiTokenError,
  withAnthropicApiRequestContext,
  withClientApiRequestContext,
  withOpenAiApiRequestContext,
} from '@/server/api/fastify-utils';
import { resetTokenIpDenialThrottleForTests } from '@/lib/services/apiTokens/ipDenialAudit';

const RESTRICTED = ['203.0.113.0/24', '2001:db8::/32'];

function buildToken(allowedIpRanges: string[] | null | undefined) {
  return { _id: 'tok-1', tenantId: 't1', userId: 'u1', projectId: 'p1', allowedIpRanges };
}

const ORIGINAL_TRUSTED_PROXIES = process.env.TRUSTED_PROXIES;

/** The server as configured with `TRUSTED_PROXIES=<list>` (unset when empty): the app and the address rules read the same setting. */
async function buildApp(trustedProxies: string[]): Promise<FastifyInstance> {
  if (trustedProxies.length > 0) process.env.TRUSTED_PROXIES = trustedProxies.join(',');
  else delete process.env.TRUSTED_PROXIES;
  reloadConfig();
  const app = Fastify({ logger: false, trustProxy: resolveTrustProxyOption(trustedProxies) });
  app.addHook('onRequest', async (request) => {
    request.apiRequestId = 'req-1';
    request.apiContextHeaders = { 'x-request-id': 'req-1' };
  });
  const ok = (_request: unknown, reply: { send: (b: unknown) => unknown }) => reply.send({ ok: true });
  app.get('/api/client/v1/json', withClientApiRequestContext(ok as never, { rbac: false }));
  app.get('/api/client/v1/openai', withOpenAiApiRequestContext(ok as never, { rbac: false }));
  app.get('/api/client/v1/anthropic', withAnthropicApiRequestContext(ok as never, { rbac: false }));
  // The authorization stage is on here (a mapped path: the Model Hub): a refused address must never reach it.
  app.get('/api/client/v1/models/gated', withClientApiRequestContext(ok as never));
  // The older per-handler style.
  app.get('/api/client/v1/legacy-style', async (request, reply) => {
    try {
      await getApiTokenContextForRequest(request);
      return reply.send({ ok: true });
    } catch (error) {
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'boom' });
    }
  });
  return app;
}

const headers = { authorization: 'Bearer cpeer_secret' };

let app: FastifyInstance;

beforeEach(() => {
  vi.clearAllMocks();
  resetTokenIpDenialThrottleForTests();
  h.db.findApiTokenByHash.mockResolvedValue(buildToken(RESTRICTED));
  h.db.findTenantById.mockResolvedValue({ _id: 't1', dbName: 'tenant_acme', slug: 'acme', licenseType: 'FREE' });
  h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'user', tenantId: 't1' });
  h.db.updateTokenLastUsedByHash.mockResolvedValue(undefined);
  h.db.iamDocGet.mockResolvedValue(null);
  h.db.iamDocPut.mockResolvedValue(undefined);
  h.db.listGroupMembersByUser.mockResolvedValue([]);
  h.db.listUserProjectsByUser.mockResolvedValue([]);
  h.db.listGroupProjectsByGroup.mockResolvedValue([]);
  h.db.listProjects.mockResolvedValue([]);
  h.db.findProjectByKey.mockResolvedValue(null);
  h.recordAuditLog.mockResolvedValue(undefined);
});

afterEach(async () => {
  await app?.close();
  if (ORIGINAL_TRUSTED_PROXIES === undefined) delete process.env.TRUSTED_PROXIES;
  else process.env.TRUSTED_PROXIES = ORIGINAL_TRUSTED_PROXIES;
  reloadConfig();
});

describe('the matched address is the one Fastify resolved through the trust boundary', () => {
  it('a direct caller cannot claim an allowed address with X-Forwarded-For', async () => {
    app = await buildApp(['10.0.0.0/8']);
    const res = await app.inject({
      method: 'GET', url: '/api/client/v1/json', remoteAddress: '198.51.100.7',
      headers: { ...headers, 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'API token is not allowed from this IP address', code: 'ip_not_allowed' });
  });

  it('X-Real-IP and Forwarded are not honoured either', async () => {
    app = await buildApp(['10.0.0.0/8']);
    const res = await app.inject({
      method: 'GET', url: '/api/client/v1/json', remoteAddress: '198.51.100.7',
      headers: { ...headers, 'x-real-ip': '203.0.113.9', forwarded: 'for=203.0.113.9', 'true-client-ip': '203.0.113.9' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ip_not_allowed');
  });

  it('a trusted proxy\'s forwarded address is the caller (allowed and refused cases)', async () => {
    app = await buildApp(['10.0.0.0/8']);
    const viaProxy = (forwardedFor: string) => app.inject({
      method: 'GET', url: '/api/client/v1/json', remoteAddress: '10.0.0.5',
      headers: { ...headers, 'x-forwarded-for': forwardedFor },
    });
    expect((await viaProxy('203.0.113.9')).statusCode).toBe(200);
    expect((await viaProxy('198.51.100.7')).statusCode).toBe(403);
    // IPv6 caller through the proxy
    expect((await viaProxy('2001:db8::77')).statusCode).toBe(200);
  });

  it('entries a client prepends to X-Forwarded-For do not count, only what the proxy appended', async () => {
    app = await buildApp(['10.0.0.0/8']);
    // client sent "203.0.113.9"; the proxy appended the real peer 198.51.100.7
    const res = await app.inject({
      method: 'GET', url: '/api/client/v1/json', remoteAddress: '10.0.0.5',
      headers: { ...headers, 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('with no trusted proxy configured for this peer, the connection address is used', async () => {
    app = await buildApp(['192.0.2.0/24']);
    const res = await app.inject({
      method: 'GET', url: '/api/client/v1/json', remoteAddress: '10.0.0.5',
      headers: { ...headers, 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.statusCode).toBe(403);
    const direct = await app.inject({
      method: 'GET', url: '/api/client/v1/json', remoteAddress: '203.0.113.50', headers,
    });
    expect(direct.statusCode).toBe(200);
  });

  describe('with no trusted proxy configured (the default): forwarded headers are not an address source at all', () => {
    // Fastify then runs with `trustProxy: true`, which makes request.ip the LEFTMOST X-Forwarded-For
    // entry - a value the caller writes, even behind a proxy that appends to the header. Address rules
    // therefore use the connection's own peer, which nobody can forge.
    it('a direct caller cannot claim an allowed address', async () => {
      app = await buildApp([]);
      const res = await app.inject({
        method: 'GET', url: '/api/client/v1/json', remoteAddress: '198.51.100.7',
        headers: { ...headers, 'x-forwarded-for': '203.0.113.9' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ip_not_allowed');
      for (const spoof of [{ 'x-real-ip': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'true-client-ip': '203.0.113.9' }, { 'x-forwarded-for': '203.0.113.9, 203.0.113.10' }]) {
        const other = await app.inject({ method: 'GET', url: '/api/client/v1/json', remoteAddress: '198.51.100.7', headers: { ...headers, ...spoof } });
        expect(other.statusCode, JSON.stringify(spoof)).toBe(403);
      }
    });

    it('behind a proxy that appends to the header the client still cannot get in by writing to it', async () => {
      app = await buildApp([]);
      // the client wrote 203.0.113.9; the proxy (10.0.0.5) appended the real peer 198.51.100.7
      const res = await app.inject({
        method: 'GET', url: '/api/client/v1/json', remoteAddress: '10.0.0.5',
        headers: { ...headers, 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
      });
      expect(res.statusCode).toBe(403); // the peer is the proxy: not on the list either way
    });

    it('the connection address decides: an allowed peer is let in whatever the header says', async () => {
      app = await buildApp([]);
      const res = await app.inject({
        method: 'GET', url: '/api/client/v1/json', remoteAddress: '203.0.113.50',
        headers: { ...headers, 'x-forwarded-for': '198.51.100.7' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  it('a dual-stack listener\'s IPv4-mapped peer matches an IPv4 range', async () => {
    app = await buildApp(['192.0.2.0/24']);
    const res = await app.inject({
      method: 'GET', url: '/api/client/v1/json', remoteAddress: '::ffff:203.0.113.50', headers,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('unrestricted tokens', () => {
  it.each([[undefined], [null], [[]]])('are not affected, whatever the address (%j)', async (ranges) => {
    h.db.findApiTokenByHash.mockResolvedValue(buildToken(ranges as string[] | null | undefined));
    app = await buildApp(['10.0.0.0/8']);
    for (const remoteAddress of ['198.51.100.7', '203.0.113.9', '2001:db8::1']) {
      const res = await app.inject({
        method: 'GET', url: '/api/client/v1/json', remoteAddress,
        headers: { ...headers, 'x-forwarded-for': '1.2.3.4' },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('the refusal in every dialect', () => {
  const refused = (url: string) => app.inject({
    method: 'GET', url, remoteAddress: '198.51.100.7', headers,
  });

  it('json routes: 403 { error, code }', async () => {
    app = await buildApp([]);
    const res = await refused('/api/client/v1/json');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'API token is not allowed from this IP address', code: 'ip_not_allowed' });
  });

  it('OpenAI-compatible routes: 403 permission_error with the code (not the usual blanket 401)', async () => {
    app = await buildApp([]);
    const res = await refused('/api/client/v1/openai');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: { message: 'API token is not allowed from this IP address', type: 'permission_error', code: 'ip_not_allowed' },
    });
  });

  it('Anthropic-compatible routes: 403 permission_error in the Messages envelope', async () => {
    app = await buildApp([]);
    const res = await refused('/api/client/v1/anthropic');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      type: 'error',
      error: { type: 'permission_error', message: 'API token is not allowed from this IP address' },
    });
  });

  it('handlers that authenticate with getApiTokenContextForRequest get the same 403', async () => {
    app = await buildApp([]);
    const res = await refused('/api/client/v1/legacy-style');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ip_not_allowed');
  });

  it('other auth failures keep their dialect (a bad token is still a 401)', async () => {
    h.db.findApiTokenByHash.mockResolvedValue(null);
    app = await buildApp([]);
    const openai = await refused('/api/client/v1/openai');
    expect(openai.statusCode).toBe(401);
    expect(openai.json().error.type).toBe('invalid_request_error');
    const json = await refused('/api/client/v1/json');
    expect(json.statusCode).toBe(401);
    expect(json.json()).toEqual({ error: 'Invalid API token' });
  });
});

describe('decided before the authorization engine', () => {
  it('a refused address is refused before the engine is consulted', async () => {
    app = await buildApp([]);
    const res = await app.inject({
      method: 'GET', url: '/api/client/v1/models/gated', remoteAddress: '198.51.100.7', headers,
    });
    expect(res.statusCode).toBe(403);
    // `error` is the reason itself, `code` tells it apart from a refusal on merit
    expect(res.json()).toEqual({ error: 'API token is not allowed from this IP address', code: 'ip_not_allowed' });
    // neither the engine's reads nor the token's owner are touched
    expect(h.db.iamDocGet).not.toHaveBeenCalled();
    expect(h.db.findUserById).not.toHaveBeenCalled();
    expect(h.db.updateTokenLastUsedByHash).not.toHaveBeenCalled();
  });

  it('an allowed address does go through the engine', async () => {
    app = await buildApp([]);
    const res = await app.inject({
      method: 'GET', url: '/api/client/v1/models/gated', remoteAddress: '203.0.113.50', headers,
    });
    expect(res.statusCode).toBe(200);
    expect(h.db.iamDocGet).toHaveBeenCalled();
  });
});

describe('audit of the refusal', () => {
  const call = (remoteAddress: string, url = '/api/client/v1/json?secret=1') => app.inject({
    method: 'GET', url, remoteAddress, headers: { ...headers, 'user-agent': 'sdk/1.0' },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('writes one denied security row with who, from where and which route (no query string)', async () => {
    app = await buildApp([]);
    await call('198.51.100.7');
    await flush();
    expect(h.recordAuditLog).toHaveBeenCalledTimes(1);
    const [context, row] = h.recordAuditLog.mock.calls[0];
    expect(context).toEqual({ tenantDbName: 'tenant_acme', tenantId: 't1' });
    expect(row).toMatchObject({
      actorType: 'api_token',
      actorUserId: 'u1',
      apiTokenId: 'tok-1',
      projectId: 'p1',
      requestId: 'req-1',
      service: 'tokens',
      action: 'security',
      method: 'GET',
      path: '/api/client/v1/json',
      statusCode: 403,
      outcome: 'denied',
      ipAddress: '198.51.100.7',
      userAgent: 'sdk/1.0',
      metadata: { code: 'ip_not_allowed' },
    });
    expect(JSON.stringify(row)).not.toContain('secret=1');
  });

  it('is throttled per token and address, but a new address is recorded', async () => {
    app = await buildApp([]);
    for (let i = 0; i < 5; i++) await call('198.51.100.7');
    await call('198.51.100.8');
    await flush();
    expect(h.recordAuditLog).toHaveBeenCalledTimes(2);
  });

  it('writes nothing for a call that is allowed', async () => {
    app = await buildApp([]);
    const res = await call('203.0.113.9');
    await flush();
    expect(res.statusCode).toBe(200);
    expect(h.recordAuditLog).not.toHaveBeenCalled();
  });

  it('a failing audit write never changes the answer', async () => {
    h.recordAuditLog.mockRejectedValue(new Error('audit db down'));
    app = await buildApp([]);
    const res = await call('198.51.100.7');
    await flush();
    expect(res.statusCode).toBe(403);
  });
});
