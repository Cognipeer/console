/**
 * The SSE transport of the three MCP plugins (public, client, console),
 * over real sockets: how a stream is advertised, that a session never outlives
 * its stream (HEAD included), that a message can only be delivered into a
 * session its own caller opened, and the limits on open streams.
 */

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

vi.mock('@/lib/database', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/database')>()),
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/mcp', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/mcp')>()),
  getMcpServerByKey: vi.fn(),
  executeMcpTool: vi.fn(),
  logMcpRequest: vi.fn(),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase, type IMcpServer } from '@/lib/database';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { getMcpServerByKey } from '@/lib/services/mcp';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { removeSseSession, sseSessionCount, sweepSseSessions } from '@/lib/services/mcp/sseSessionManager';
import { clientMcpApiPlugin } from '@/server/api/plugins/client-mcp';
import { clientMcpConsoleApiPlugin } from '@/server/api/plugins/client-mcp-console';
import { publicMcpApiPlugin } from '@/server/api/plugins/public-mcp';
import { createMockDb } from '../helpers/db.mock';
import {
  buildMcpTestApp,
  connectSse,
  eventually,
  listenOnLoopback,
  rawRequest,
  type SseConnection,
} from '../helpers/mcp-http';

const originalSource = getConfigSource();

const SLUG_A = 'slugaaaaaaaa1234';
const SLUG_B = 'slugbbbbbbbb1234';
const PUBLIC_A = `/api/public/mcp/tenant-1/${SLUG_A}`;
const PUBLIC_B = `/api/public/mcp/tenant-1/${SLUG_B}`;
const CLIENT_A = '/api/client/v1/mcp/srv-a';
const CLIENT_B = '/api/client/v1/mcp/srv-b';
const CONSOLE = '/api/client/v1/mcp/console';

function mcpServer(key: string, slug?: string): IMcpServer {
  return {
    _id: `id-${key}`,
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key,
    name: key,
    status: 'active',
    sourceType: 'openapi',
    endpointSlug: slug,
    exposure: { protocols: ['streamable-http', 'sse'], accessMode: slug ? 'public' : 'token' },
    tools: [],
  } as unknown as IMcpServer;
}

function tokenContext(id: string, tenantId = 'tenant-1', tenantDbName = 'tenant_acme') {
  return {
    token: `raw-${id}`,
    tokenRecord: { _id: id, userId: `user-${id}`, servicePermissions: null },
    tenant: { licenseType: 'ENTERPRISE' },
    tenantId,
    tenantSlug: 'acme',
    tenantDbName,
    projectId: 'proj-1',
    user: { _id: `user-${id}`, role: 'owner', tenantId },
  };
}

const TOKENS: Record<string, ReturnType<typeof tokenContext>> = {
  'tok-a': tokenContext('tok-a'),
  'tok-b': tokenContext('tok-b'),
  'tok-c': tokenContext('tok-c', 'tenant-2', 'tenant_other'),
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const allPlugins: FastifyPluginAsync = async (app) => {
  await app.register(clientMcpConsoleApiPlugin);
  await app.register(clientMcpApiPlugin);
  await app.register(publicMcpApiPlugin);
};

function setTestConfig(values: Record<string, string | undefined> = {}) {
  setConfigSource({ name: 'test', get: (key) => values[key] } satisfies ConfigSource);
}

describe('MCP SSE transport', () => {
  let app: FastifyInstance;
  let port: number;
  const open: SseConnection[] = [];

  async function start(config: Record<string, string | undefined> = {}) {
    setTestConfig(config);
    app = await buildMcpTestApp(allPlugins, { trustProxy: true });
    port = await listenOnLoopback(app);
  }

  async function stream(path: string, headers: Record<string, string> = {}) {
    const connection = await connectSse(port, path, headers);
    open.push(connection);
    return connection;
  }

  /** Open a stream that must succeed; returns it with the message path it advertised. */
  async function session(path: string, headers: Record<string, string> = {}) {
    const connection = await stream(path, headers);
    expect(connection.status).toBe(200);
    const endpoint = await connection.waitForEvent((event) => event.event === 'endpoint');
    // Every stream in this file is held to it: the advertised URL is a path,
    // never one that names a scheme or a host.
    expect(endpoint.data, 'the endpoint event carries a path').toMatch(/^\/(?!\/)/);
    return { connection, endpoint: endpoint.data, path: endpoint.data };
  }

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return rawRequest(port, {
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  const sessionIdOf = (messagePath: string) => new URL(messagePath, 'http://x').searchParams.get('sessionId') ?? '';
  const withSession = (path: string, sessionId: string) => `${path}/message?sessionId=${sessionId}`;

  beforeEach(() => {
    vi.resetAllMocks();
    resetRateLimitStore();
    const db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: 'tenant-1', dbName: 'tenant_acme' } as never);
    db.findMcpServerByEndpointSlug.mockImplementation(async (slug: string) => (
      slug === SLUG_A ? mcpServer('pub-a', SLUG_A) : slug === SLUG_B ? mcpServer('pub-b', SLUG_B) : null) as never);
    vi.mocked(getDatabase).mockResolvedValue(db as never);
    vi.mocked(getMcpServerByKey).mockImplementation((async (_db: string, key: string) => (
      key === 'srv-a' || key === 'srv-b' ? mcpServer(key) : null)) as never);
    vi.mocked(requireApiTokenFromHeader).mockImplementation((async (header: string | null) => {
      const context = TOKENS[(header ?? '').replace(/^Bearer /, '')];
      if (!context) throw new Error('Unauthorized');
      return context;
    }) as never);
  });

  afterEach(async () => {
    open.splice(0).forEach((connection) => connection.close());
    await app?.close();
    // Nothing a test leaves open may leak into the next one.
    await eventually(() => sseSessionCount() === 0, 'every session is gone after the connections close');
    setConfigSource(originalSource);
  });

  describe('the advertised message URL', () => {
    const FOREIGN_HEADERS = {
      host: 'other-host.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'other-host.example.test',
    };

    /** The three surfaces, each with the message path it must advertise. */
    async function openAllSurfaces(headers: Record<string, string>) {
      return {
        public: await session(`${PUBLIC_A}/sse`, headers),
        client: await session(`${CLIENT_A}/sse`, { ...auth('tok-a'), ...headers }),
        console: await session(`${CONSOLE}/sse`, { ...auth('tok-a'), ...headers }),
      };
    }

    function expectMessagePaths(streams: Awaited<ReturnType<typeof openAllSurfaces>>) {
      expect(streams.public.endpoint).toMatch(new RegExp(`^${PUBLIC_A}/message\\?sessionId=[0-9a-f-]{36}$`));
      expect(streams.client.endpoint).toMatch(/^\/api\/client\/v1\/mcp\/srv-a\/message\?sessionId=[0-9a-f-]{36}$/);
      expect(streams.console.endpoint).toMatch(/^\/api\/client\/v1\/mcp\/console\/message\?sessionId=[0-9a-f-]{36}$/);
    }

    it('is just a path, whatever the Host and X-Forwarded-* headers say', async () => {
      await start();
      expectMessagePaths(await openAllSurfaces(FOREIGN_HEADERS));
    });

    // The configured public URL makes no difference either: a client may reach
    // the gateway under a name other than the one configured.
    it.each([
      ['a public https URL', 'https://console.example.test/'],
      ['a URL with a path prefix', 'https://gw.example.test/console/?x=1#frag'],
      ['a URL with a port', 'http://127.0.0.1:3999'],
      ['a value that is not a URL', 'not a url'],
    ])('is just a path when APP_URL is %s', async (_label, appUrl) => {
      await start({ APP_URL: appUrl });
      expectMessagePaths(await openAllSurfaces(FOREIGN_HEADERS));
    });

    it('resolves, against the URL the stream was opened on, to the same host', async () => {
      await start({ APP_URL: 'https://console.example.test' });
      const { endpoint } = await session(`${PUBLIC_A}/sse`);
      for (const base of [`http://127.0.0.1:${port}`, 'https://gateway.internal.example.test:8443']) {
        const resolved = new URL(endpoint, `${base}${PUBLIC_A}/sse`);
        expect(resolved.origin).toBe(new URL(base).origin);
        expect(resolved.pathname).toBe(`${PUBLIC_A}/message`);
      }
    });

    it('carries the session id in the X-Mcp-Session-Id header too', async () => {
      await start();
      const { connection, path } = await session(`${PUBLIC_A}/sse`);
      expect(connection.headers['x-mcp-session-id']).toBe(sessionIdOf(path));
      expect(connection.headers['content-type']).toContain('text/event-stream');
    });
  });

  describe('a session never outlives its stream', () => {
    const streams: Array<[string, string, Record<string, string>]> = [
      ['public', `${PUBLIC_A}/sse`, {}],
      ['client', `${CLIENT_A}/sse`, auth('tok-a')],
      ['console', `${CONSOLE}/sse`, auth('tok-a')],
    ];

    it.each(streams)('is removed when the %s client hangs up', async (_name, path, headers) => {
      await start();
      const { connection } = await session(path, headers);
      expect(sseSessionCount()).toBe(1);
      connection.close();
      await eventually(() => sseSessionCount() === 0, 'the session is removed after the client hangs up');
    });

    it.each(streams)('is not created by a HEAD request to the %s stream URL', async (_name, path, headers) => {
      await start();
      const before = sseSessionCount();
      const response = await rawRequest(port, { method: 'HEAD', path, headers });
      expect(response.status).toBe(404);
      expect(response.headers['x-mcp-session-id']).toBeUndefined();
      expect(sseSessionCount()).toBe(before);
    });

    it('is removed when the gateway ends an idle stream, and the client sees the stream end', async () => {
      await start({ MCP_SSE_IDLE_TIMEOUT_MS: '60000' });
      const { connection } = await session(`${PUBLIC_A}/sse`);
      sweepSseSessions(Date.now() + 61_000);
      await connection.ended;
      expect(sseSessionCount()).toBe(0);
    });

    it('is kept by messages, and cut when none arrive', async () => {
      await start({ MCP_SSE_IDLE_TIMEOUT_MS: '60000' });
      const { connection, path } = await session(`${PUBLIC_A}/sse`);
      expect((await post(path, initialize)).status).toBe(202);
      sweepSseSessions(Date.now() + 59_000);
      expect(connection.isEnded()).toBe(false);
      sweepSseSessions(Date.now() + 61_000);
      await connection.ended;
    });

    it('stays open through a quiet spell thanks to a keep-alive comment, which is not a message', async () => {
      await start({ MCP_SSE_KEEPALIVE_MS: '25000', MCP_SSE_IDLE_TIMEOUT_MS: '3600000' });
      const { connection } = await session(`${PUBLIC_A}/sse`);
      sweepSseSessions(Date.now() + 26_000);
      await eventually(() => connection.raw().includes(': keepalive'), 'a keep-alive comment arrives');
      expect(connection.events.filter((event) => event.event !== 'endpoint')).toEqual([]);
    });

    it('is not left behind by a client that hung up while its request was still being authorised', async () => {
      await start();
      let resolveServer: (server: IMcpServer) => void = () => undefined;
      let lookupStarted = false;
      vi.mocked(getMcpServerByKey).mockImplementationOnce((() => new Promise((resolve) => {
        lookupStarted = true;
        resolveServer = resolve as never;
      })) as never);

      const request = http.get({ host: '127.0.0.1', port, path: `${CLIENT_A}/sse`, headers: auth('tok-a'), agent: false });
      request.on('error', () => undefined);
      await eventually(() => lookupStarted, 'the handler is waiting on the server lookup');
      request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));

      resolveServer(mcpServer('srv-a'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await eventually(() => sseSessionCount() === 0, 'no session remains');
    });
  });

  describe('a message reaches only the session its own caller opened', () => {
    it('delivers a message into the session it names, and the answer comes back on the stream', async () => {
      await start();
      const { connection, path } = await session(`${PUBLIC_A}/sse`);
      const response = await post(path, initialize);
      expect(response.status).toBe(202);
      const event = await connection.waitForEvent((e) => e.event === 'message');
      expect(JSON.parse(event.data)).toMatchObject({ id: 1, result: { serverInfo: { name: 'cognipeer-mcp-gateway' } } });
    });

    it('refuses a session opened on another public endpoint, and puts nothing on its stream', async () => {
      await start();
      const { connection, path } = await session(`${PUBLIC_A}/sse`);
      const sessionId = sessionIdOf(path);
      const response = await post(withSession(PUBLIC_B, sessionId), { jsonrpc: '2.0', id: 7, method: 'tools/list' });
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body).error).toEqual({ code: -32001, message: 'Session not found' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(connection.events.filter((e) => e.event === 'message')).toEqual([]);
    });

    it('refuses a session that does not exist, as it does one that belongs to someone else', async () => {
      await start();
      const unknown = await post(withSession(PUBLIC_A, '00000000-0000-4000-8000-000000000042'), initialize);
      const { path } = await session(`${PUBLIC_B}/sse`);
      const foreign = await post(withSession(PUBLIC_A, sessionIdOf(path)), initialize);
      expect(unknown.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toBe(unknown.body);
    });

    it('does not let a session opened by one token take a message from another', async () => {
      await start();
      const { connection, path } = await session(`${CLIENT_A}/sse`, auth('tok-a'));
      const sessionId = sessionIdOf(path);

      const otherToken = await post(withSession(CLIENT_A, sessionId), initialize, auth('tok-b'));
      const otherTenant = await post(withSession(CLIENT_A, sessionId), initialize, auth('tok-c'));
      const otherServer = await post(withSession(CLIENT_B, sessionId), initialize, auth('tok-a'));
      for (const response of [otherToken, otherTenant, otherServer]) {
        expect(response.status).toBe(404);
        expect(JSON.parse(response.body).error.code).toBe(-32001);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(connection.events.filter((e) => e.event === 'message')).toEqual([]);

      const own = await post(withSession(CLIENT_A, sessionId), initialize, auth('tok-a'));
      expect(own.status).toBe(202);
      await connection.waitForEvent((e) => e.event === 'message');
    });

    it('keeps public and token sessions apart in both directions', async () => {
      await start();
      const publicSession = await session(`${PUBLIC_A}/sse`);
      const tokenSession = await session(`${CLIENT_A}/sse`, auth('tok-a'));

      const publicIdOnTokenRoute = await post(withSession(CLIENT_A, sessionIdOf(publicSession.path)), initialize, auth('tok-a'));
      const tokenIdOnPublicRoute = await post(withSession(PUBLIC_A, sessionIdOf(tokenSession.path)), initialize);
      expect(publicIdOnTokenRoute.status).toBe(404);
      expect(tokenIdOnPublicRoute.status).toBe(404);
    });

    it('applies to the console server', async () => {
      await start();
      const { connection, path } = await session(`${CONSOLE}/sse`, auth('tok-a'));
      const sessionId = sessionIdOf(path);
      expect((await post(withSession(CONSOLE, sessionId), initialize, auth('tok-b'))).status).toBe(404);
      expect((await post(withSession(CONSOLE, sessionId), initialize, auth('tok-a'))).status).toBe(202);
      await connection.waitForEvent((e) => e.event === 'message');
      // The console server's session is not a session of an ordinary server of the same token.
      expect((await post(withSession(CLIENT_A, sessionId), initialize, auth('tok-a'))).status).toBe(404);
    });

    it('answers a parse error or an invalid body on the stream when the session is the caller\'s own', async () => {
      await start();
      const { connection, path } = await session(`${CLIENT_A}/sse`, auth('tok-a'));
      expect((await post(path, '{', auth('tok-a'))).status).toBe(202);
      expect((await post(path, 'null', auth('tok-a'))).status).toBe(202);
      await eventually(() => connection.events.filter((e) => e.event === 'message').length === 2, 'two errors arrive');
      const codes = connection.events.filter((e) => e.event === 'message').map((e) => JSON.parse(e.data).error.code);
      expect(codes).toEqual([-32700, -32600]);
    });
  });

  describe('limits on open streams', () => {
    it('refuses a public stream over the per-address cap with 429, a Retry-After and a JSON body', async () => {
      await start({ MCP_SSE_MAX_SESSIONS_PER_IP: '2' });
      const from = { 'x-forwarded-for': '198.51.100.7' };
      await session(`${PUBLIC_A}/sse`, from);
      await session(`${PUBLIC_B}/sse`, from);

      const refused = await stream(`${PUBLIC_A}/sse`, from);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(refused.headers['content-type']).toContain('application/json');
      await refused.ended;
      expect(JSON.parse(refused.raw()).error).toMatch(/too many open/i);
      expect(sseSessionCount()).toBe(2);

      // Another address is unaffected, and so is a token stream from the same one.
      await session(`${PUBLIC_A}/sse`, { 'x-forwarded-for': '198.51.100.8' });
      await session(`${CLIENT_A}/sse`, { ...auth('tok-a'), ...from });
    });

    it('lets the address open another once one of its streams has ended', async () => {
      await start({ MCP_SSE_MAX_SESSIONS_PER_IP: '1' });
      const from = { 'x-forwarded-for': '198.51.100.7' };
      const first = await session(`${PUBLIC_A}/sse`, from);
      expect((await stream(`${PUBLIC_A}/sse`, from)).status).toBe(429);
      first.connection.close();
      await eventually(() => sseSessionCount() === 0, 'the first session is gone');
      expect((await stream(`${PUBLIC_A}/sse`, from)).status).toBe(200);
    });

    it('refuses a stream over the process-wide cap with 503, a Retry-After and a JSON body', async () => {
      await start({ MCP_SSE_MAX_SESSIONS: '2' });
      await session(`${CLIENT_A}/sse`, auth('tok-a'));
      await session(`${CLIENT_B}/sse`, auth('tok-a'));

      for (const [path, headers] of [[`${CLIENT_A}/sse`, auth('tok-b')], [`${CONSOLE}/sse`, auth('tok-a')]] as const) {
        const refused = await stream(path, headers);
        expect(refused.status, path).toBe(503);
        expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        await refused.ended;
        expect(JSON.parse(refused.raw()).error).toBeTruthy();
      }
      expect(sseSessionCount()).toBe(2);
    });

    it('keeps room for token callers when anonymous streams fill their share', async () => {
      await start({ MCP_SSE_MAX_SESSIONS: '4', MCP_SSE_MAX_SESSIONS_PER_IP: '0' });
      await session(`${PUBLIC_A}/sse`);
      await session(`${PUBLIC_A}/sse`);
      await session(`${PUBLIC_A}/sse`);
      expect((await stream(`${PUBLIC_A}/sse`)).status).toBe(503);
      expect((await stream(`${CLIENT_A}/sse`, auth('tok-a'))).status).toBe(200);
    });

    it('applies no cap when both are 0', async () => {
      await start({ MCP_SSE_MAX_SESSIONS: '0', MCP_SSE_MAX_SESSIONS_PER_IP: '0' });
      for (let i = 0; i < 6; i += 1) await session(`${PUBLIC_A}/sse`);
      expect(sseSessionCount()).toBe(6);
    });
  });

  describe('failures', () => {
    it('answers a token stream that fails to open with a generic 500', async () => {
      await start();
      vi.mocked(getMcpServerByKey).mockRejectedValue(new Error('Cosmos 16500 ActivityId: 7d1 host=cosmos-prod.documents.example'));
      for (const path of [`${CLIENT_A}/sse`]) {
        const response = await stream(path, auth('tok-a'));
        expect(response.status).toBe(500);
        await response.ended;
        expect(JSON.parse(response.raw())).toEqual({ error: 'Internal error' });
      }
    });

    it('does not strand a session when the stream fails to open', async () => {
      await start();
      vi.mocked(getMcpServerByKey).mockResolvedValue(null as never);
      const response = await stream(`${CLIENT_A}/sse`, auth('tok-a'));
      expect(response.status).toBe(404);
      expect(sseSessionCount()).toBe(0);
    });
  });

  it('forgets a session that was removed by hand', async () => {
    await start();
    const { path } = await session(`${PUBLIC_A}/sse`);
    removeSseSession(sessionIdOf(path));
    expect((await post(path, initialize)).status).toBe(404);
  });
});
