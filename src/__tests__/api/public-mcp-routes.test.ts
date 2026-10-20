/**
 * Public (unauthenticated) MCP endpoints, /api/public/mcp/...: what they
 * accept (JSON bodies of a bounded size, objects only), how much they serve one
 * caller (request rate, concurrent tool calls), what they tell a caller about a
 * failed call, and what they record about a call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import winston from 'winston';

vi.mock('@/lib/database', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/database')>()),
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/mcp', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/mcp')>()),
  executeMcpTool: vi.fn(),
  logMcpRequest: vi.fn(),
}));

import { getDatabase, type IMcpServer } from '@/lib/database';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { logger, resetLogger } from '@/lib/core/logger';
import {
  executeMcpTool,
  logMcpRequest,
  McpToolInputError,
  McpUpstreamError,
} from '@/lib/services/mcp';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { sseSessionCount } from '@/lib/services/mcp/sseSessionManager';
import { publicMcpApiPlugin } from '@/server/api/plugins/public-mcp';
import { createMockDb, type MockDb } from '../helpers/db.mock';
import { buildMcpTestApp } from '../helpers/mcp-http';

const originalSource = getConfigSource();
const SLUG = 'slugslugslug1234';
const OTHER_SLUG = 'otherslugother567';
const BASE = `/api/public/mcp/tenant-1/${SLUG}`;

function server(overrides: Partial<IMcpServer> = {}): IMcpServer {
  return {
    _id: 'srv-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'public-server',
    name: 'Public server',
    status: 'active',
    sourceType: 'openapi',
    endpointSlug: SLUG,
    exposure: { protocols: ['streamable-http', 'sse'], accessMode: 'public' },
    tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }],
    ...overrides,
  } as unknown as IMcpServer;
}

function setTestConfig(values: Record<string, string | undefined> = {}) {
  const source: ConfigSource = { name: 'test', get: (key) => values[key] };
  setConfigSource(source);
}

interface RpcBody {
  jsonrpc: string;
  id: unknown;
  result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
}

describe('public MCP routes', () => {
  let app: FastifyInstance;
  let db: MockDb;
  let current: IMcpServer;

  async function start(
    config: Record<string, string | undefined> = {},
    options: { trustProxy?: boolean } = {},
  ) {
    setTestConfig(config);
    app = await buildMcpTestApp(publicMcpApiPlugin, options);
  }

  /** Everything the process logs from now until `stop()`, as text. */
  function captureLogs() {
    // Rebuilt from the test's own config, so the capture does not depend on the
    // LOG_LEVEL of the environment the tests run in.
    resetLogger();
    const chunks: string[] = [];
    const transport = new winston.transports.Stream({
      stream: new Writable({
        write(chunk, _encoding, done) {
          chunks.push(String(chunk));
          done();
        },
      }),
    });
    logger.add(transport);
    return {
      text: () => chunks.join(''),
      stop: () => {
        logger.remove(transport);
        resetLogger();
      },
    };
  }

  function post(
    payload: unknown,
    options: { url?: string; contentType?: string | null; remoteAddress?: string; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json';
    return app.inject({
      method: 'POST',
      url: options.url ?? `${BASE}/message`,
      headers,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      remoteAddress: options.remoteAddress,
    });
  }

  const rpc = (method: string, params?: Record<string, unknown>, id: unknown = 1) =>
    ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const callTool = (name = 'echo', args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args });
  const json = (response: { body: string }) => JSON.parse(response.body) as RpcBody;

  beforeEach(() => {
    vi.resetAllMocks();
    resetRateLimitStore();
    current = server();
    db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: 'tenant-1', dbName: 'tenant_acme' } as never);
    db.findMcpServerByEndpointSlug.mockImplementation(async (slug: string) => (slug === SLUG ? current : null) as never);
    vi.mocked(getDatabase).mockResolvedValue(db as never);
    vi.mocked(executeMcpTool).mockResolvedValue({ result: { echoed: true }, latencyMs: 5 });
    vi.mocked(logMcpRequest).mockResolvedValue('log-42');
  });

  afterEach(async () => {
    await app?.close();
    setConfigSource(originalSource);
  });

  describe('what a POST may carry', () => {
    it('accepts a JSON body, with or without parameters on the content type', async () => {
      await start();
      for (const contentType of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
        const response = await post(rpc('ping'), { contentType });
        expect(response.statusCode, contentType).toBe(200);
        expect(json(response).result).toEqual({});
      }
    });

    it('refuses any other content type with 415, before the endpoint is looked up', async () => {
      await start();
      for (const contentType of ['text/plain', 'text/plain;charset=UTF-8', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', null]) {
        const response = await post(JSON.stringify(rpc('ping')), { contentType });
        expect(response.statusCode, String(contentType)).toBe(415);
      }
      expect(db.findTenantById).not.toHaveBeenCalled();
    });

    it('applies the same rule to the streamable-HTTP POST on the /sse URL', async () => {
      await start();
      const response = await post(JSON.stringify(rpc('ping')), { url: `${BASE}/sse`, contentType: 'text/plain' });
      expect(response.statusCode).toBe(415);
    });

    it('refuses a body over MCP_PUBLIC_BODY_LIMIT_BYTES with 413', async () => {
      await start({ MCP_PUBLIC_BODY_LIMIT_BYTES: '2048' });
      const small = await post(callTool('echo', { text: 'x'.repeat(500) }));
      expect(small.statusCode).toBe(200);
      const large = await post(callTool('echo', { text: 'x'.repeat(5000) }));
      expect(large.statusCode).toBe(413);
      expect(executeMcpTool).toHaveBeenCalledTimes(1);
    });

    it('limits a body to 1 MiB by default, where the server as a whole accepts 10 MiB', async () => {
      await start();
      expect((await post(callTool('echo', { text: 'x'.repeat(900_000) }))).statusCode).toBe(200);
      expect((await post(callTool('echo', { text: 'x'.repeat(1_100_000) }))).statusCode).toBe(413);
    });

    it.each([
      ['null', 'null'],
      ['an array', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]'],
      ['a number', '123'],
      ['a string', '"ping"'],
      ['a boolean', 'true'],
    ])('answers a body that is %s with 400 and -32600, not 500', async (_label, body) => {
      await start();
      const response = await post(body);
      expect(response.statusCode).toBe(400);
      expect(json(response).error).toEqual({ code: -32600, message: 'Invalid Request' });
    });

    it('answers text that is not JSON with 400 and -32700', async () => {
      await start();
      for (const body of ['{', '', 'not json']) {
        const response = await post(body);
        expect(response.statusCode, body).toBe(400);
        expect(json(response).error?.code, body).toBe(-32700);
      }
    });

    it('answers a request without a method with 400 and -32600', async () => {
      await start();
      for (const body of [{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, method: 7 }, { jsonrpc: '2.0', id: 1, method: '' }]) {
        const response = await post(body);
        expect(response.statusCode).toBe(400);
        expect(json(response).error?.code).toBe(-32600);
      }
    });

    it('does not echo a long method name back', async () => {
      await start();
      const response = await post(rpc('m'.repeat(5000)));
      expect(json(response).error?.code).toBe(-32601);
      expect(json(response).error?.message.length).toBeLessThan(200);
    });
  });

  describe('request rate', () => {
    it('refuses a caller over its rate with 429 and a Retry-After, without running anything', async () => {
      await start({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '3' });
      for (let i = 0; i < 3; i += 1) {
        expect((await post(callTool())).statusCode).toBe(200);
      }
      const refused = await post(callTool());
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(refused.body)).toEqual({ error: 'Rate limit exceeded' });
      expect(executeMcpTool).toHaveBeenCalledTimes(3);
    });

    it('counts each client address on its own', async () => {
      await start({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1' });
      expect((await post(rpc('ping'), { remoteAddress: '203.0.113.1' })).statusCode).toBe(200);
      expect((await post(rpc('ping'), { remoteAddress: '203.0.113.1' })).statusCode).toBe(429);
      expect((await post(rpc('ping'), { remoteAddress: '203.0.113.2' })).statusCode).toBe(200);
    });

    it('counts each endpoint on its own', async () => {
      await start({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1' });
      const other = server({ _id: 'srv-2', endpointSlug: OTHER_SLUG, key: 'other-server' });
      db.findMcpServerByEndpointSlug.mockImplementation(async (slug: string) => (
        slug === SLUG ? current : slug === OTHER_SLUG ? other : null) as never);
      expect((await post(rpc('ping'))).statusCode).toBe(200);
      expect((await post(rpc('ping'))).statusCode).toBe(429);
      expect((await post(rpc('ping'), { url: `/api/public/mcp/tenant-1/${OTHER_SLUG}/message` })).statusCode).toBe(200);
    });

    it('stops a caller from reaching the database with requests for endpoints that do not exist', async () => {
      await start({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1' });
      const missing = '/api/public/mcp/tenant-1/doesnotexist0001/message';
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        statuses.push((await post(rpc('ping'), { url: missing })).statusCode);
      }
      // Ten times the per-endpoint rate is allowed through (to a 404), then no more.
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
      expect(statuses.slice(10)).toEqual([429, 429]);
      expect(db.findMcpServerByEndpointSlug).toHaveBeenCalledTimes(10);
    });

    it('also limits opening a stream', async () => {
      await start({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1' });
      expect((await post(rpc('ping'))).statusCode).toBe(200);
      const response = await app.inject({ method: 'GET', url: `${BASE}/sse` });
      expect(response.statusCode).toBe(429);
      expect(sseSessionCount()).toBe(0);
    });

    it('does not limit when the limit is 0', async () => {
      await start({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0' });
      for (let i = 0; i < 40; i += 1) {
        expect((await post(rpc('ping'))).statusCode).toBe(200);
      }
    });

    it('holds an endpoint to its own rate however the callers are addressed', async () => {
      // With every proxy trusted, the address is whatever X-Forwarded-For says.
      await start(
        { MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '12' },
        { trustProxy: true },
      );
      const statuses: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const response = await post(rpc('ping'), { headers: { 'x-forwarded-for': `203.0.113.${i + 1}` } });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 12)).toEqual(Array(12).fill(200));
      expect(statuses.slice(12)).toEqual(Array(28).fill(429));
    });

    it('counts opening a stream against the endpoint as a whole', async () => {
      await start(
        { MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '2' },
        { trustProxy: true },
      );
      for (const address of ['203.0.113.1', '203.0.113.2']) {
        expect((await post(rpc('ping'), { headers: { 'x-forwarded-for': address } })).statusCode).toBe(200);
      }
      const response = await app.inject({
        method: 'GET',
        url: `${BASE}/sse`,
        headers: { 'x-forwarded-for': '203.0.113.3' },
      });
      expect(response.statusCode).toBe(429);
      expect(sseSessionCount()).toBe(0);
    });

    it('lets an address that is over its own rate be the only one turned away', async () => {
      await start(
        { MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '2', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '5' },
        { trustProxy: true },
      );
      const heavy = { headers: { 'x-forwarded-for': '203.0.113.200' } };
      const heavyStatuses: number[] = [];
      for (let i = 0; i < 20; i += 1) heavyStatuses.push((await post(rpc('ping'), heavy)).statusCode);
      expect(heavyStatuses.filter((status) => status === 200)).toHaveLength(2);
      // Its refused requests used none of the endpoint's remaining three.
      for (let i = 0; i < 3; i += 1) {
        const other = await post(rpc('ping'), { headers: { 'x-forwarded-for': `203.0.113.${i + 1}` } });
        expect(other.statusCode, `other caller ${i + 1}`).toBe(200);
      }
      expect((await post(rpc('ping'), { headers: { 'x-forwarded-for': '203.0.113.4' } })).statusCode).toBe(429);
    });

    it('counts the spellings of a tenant id in the URL as one caller of one endpoint', async () => {
      // Some databases resolve an id without regard to case.
      await start({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1' });
      const url = (tenantId: string) => `/api/public/mcp/${tenantId}/${SLUG}/message`;
      expect((await post(rpc('ping'), { url: url('tenant-1') })).statusCode).toBe(200);
      expect((await post(rpc('ping'), { url: url('TENANT-1') })).statusCode).toBe(429);
      expect((await post(rpc('ping'), { url: url('Tenant-1') })).statusCode).toBe(429);
    });

    it('writes no endpoint slug to the log when it turns a caller away', async () => {
      await start({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1' });
      const logs = captureLogs();
      try {
        expect((await post(rpc('ping'))).statusCode).toBe(200);
        expect((await post(rpc('ping'))).statusCode).toBe(429);
        expect((await post(rpc('ping'))).statusCode).toBe(429);
        // The refusal was logged; the line names the endpoint by its ids, not by its slug.
        expect(logs.text()).toContain('Rate limit exceeded');
        expect(logs.text()).not.toContain(SLUG);
        expect(logs.text()).toContain('mcp-public:tenant-1:srv-1:');
      } finally {
        logs.stop();
      }
    });

    it('writes no endpoint slug to the log when the endpoint as a whole is over its rate', async () => {
      await start(
        { MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '1' },
        { trustProxy: true },
      );
      const logs = captureLogs();
      try {
        await post(rpc('ping'), { headers: { 'x-forwarded-for': '203.0.113.1' } });
        expect((await post(rpc('ping'), { headers: { 'x-forwarded-for': '203.0.113.2' } })).statusCode).toBe(429);
        expect(logs.text()).toContain('Rate limit exceeded');
        expect(logs.text()).not.toContain(SLUG);
        expect(logs.text()).toContain('mcp-public-endpoint:tenant-1:srv-1');
      } finally {
        logs.stop();
      }
    });
  });

  describe('concurrent tool calls', () => {
    it('refuses a call over the tenant cap with 503 and a Retry-After, and takes calls again once one ends', async () => {
      await start({ MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT: '1', MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0' });
      let finishFirst: (value: { result: unknown; latencyMs: number }) => void = () => undefined;
      vi.mocked(executeMcpTool).mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));

      const first = post(callTool());
      for (let i = 0; i < 200 && vi.mocked(executeMcpTool).mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(executeMcpTool).toHaveBeenCalledTimes(1);

      const second = await post(callTool());
      expect(second.statusCode).toBe(503);
      expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(executeMcpTool).toHaveBeenCalledTimes(1);

      // Calls that do not run a tool are not held back.
      expect((await post(rpc('tools/list'))).statusCode).toBe(200);

      finishFirst({ result: { ok: 1 }, latencyMs: 1 });
      expect((await first).statusCode).toBe(200);
      expect((await post(callTool())).statusCode).toBe(200);
    });

    it('gives the slot back when a call fails', async () => {
      await start({ MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT: '1', MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0' });
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error('boom'));
      expect((await post(callTool())).statusCode).toBe(200);
      expect((await post(callTool())).statusCode).toBe(200);
      expect(executeMcpTool).toHaveBeenCalledTimes(2);
    });
  });

  describe('what a caller is told about a failed call', () => {
    it('says only that it failed, with the log id to quote', async () => {
      await start();
      vi.mocked(executeMcpTool).mockRejectedValueOnce(
        new Error('connect ECONNREFUSED postgres://svc:pw@db.internal.example:5432 stack at /srv/app/index.js:12'),
      );
      const response = await post(callTool());
      expect(response.statusCode).toBe(200);
      const body = json(response);
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0].text).toBe('Tool execution failed (ref: log-42)');
      expect(response.body).not.toMatch(/postgres|db\.internal|ECONNREFUSED|index\.js/);
    });

    it('keeps the detail in the request log', async () => {
      await start();
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error('connect ECONNREFUSED db.internal.example:5432'));
      await post(callTool());
      expect(logMcpRequest).toHaveBeenCalledTimes(1);
      const [, entry] = vi.mocked(logMcpRequest).mock.calls[0];
      expect(entry).toMatchObject({
        status: 'error',
        errorMessage: 'connect ECONNREFUSED db.internal.example:5432',
        callerType: 'public',
        toolName: 'echo',
      });
    });

    it('reports an upstream HTTP failure by its status alone', async () => {
      await start();
      vi.mocked(executeMcpTool).mockRejectedValueOnce(
        new McpUpstreamError('Upstream API error (503): {"detail":"queue crm-prod-7 is down","trace":"..."}', 503),
      );
      const response = await post(callTool());
      expect(json(response).result?.content?.[0].text).toBe('Upstream request failed (status 503) (ref: log-42)');
      expect(response.body).not.toMatch(/crm-prod|queue|trace/);
    });

    it('does not reveal the upstream host of a refused request', async () => {
      await start();
      vi.mocked(executeMcpTool).mockRejectedValueOnce(
        new Error('Refusing outbound request to private/loopback host: crm.corp.internal'),
      );
      const response = await post(callTool());
      expect(response.body).not.toContain('crm.corp.internal');
      expect(json(response).result?.content?.[0].text).toBe('Tool execution failed (ref: log-42)');
    });

    it('does not reveal why a guardrail or a disabled tool refused', async () => {
      await start();
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error('Blocked by Aegis shield: contains customer IBAN'));
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error('Tool "echo" is disabled on MCP server "Payments prod"'));
      for (let i = 0; i < 2; i += 1) {
        const response = await post(callTool());
        expect(response.body).not.toMatch(/IBAN|Payments prod/);
      }
    });

    it('passes a tool-input error through as invalid params (-32602)', async () => {
      await start();
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new McpToolInputError('Unknown tool'));
      const response = await post(callTool('nope'));
      expect(response.statusCode).toBe(200);
      expect(json(response).error).toEqual({ code: -32602, message: 'Unknown tool' });
      expect(json(response).id).toBe(1);
    });

    it('omits the reference when the request log could not be written', async () => {
      await start();
      vi.mocked(logMcpRequest).mockResolvedValue(undefined);
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error('boom'));
      const response = await post(callTool());
      expect(json(response).result?.content?.[0].text).toBe('Tool execution failed');
    });

    it('does not include a stack or a database error in a 500', async () => {
      await start();
      db.findMcpServerByEndpointSlug.mockRejectedValue(new Error('Cosmos 16500 ActivityId: 7d1 host=cosmos-prod.documents.example'));
      const message = await post(rpc('ping'));
      expect(message.statusCode).toBe(500);
      expect(message.body).not.toMatch(/Cosmos|ActivityId|cosmos-prod/);
      const stream = await app.inject({ method: 'GET', url: `${BASE}/sse` });
      expect(stream.statusCode).toBe(500);
      expect(JSON.parse(stream.body)).toEqual({ error: 'Internal error' });
    });

    it('returns a successful result unchanged', async () => {
      await start();
      const response = await post(callTool('echo', { text: 'hi' }));
      expect(json(response).result).toEqual({ content: [{ text: '{"echoed":true}', type: 'text' }], isError: false });
      expect(executeMcpTool).toHaveBeenCalledWith(expect.anything(), 'echo', { text: 'hi' });
    });
  });

  describe('what a call leaves in the request log', () => {
    it('is bounded and says where the call came from', async () => {
      await start();
      await post(callTool('echo', { text: 'x' }), {
        remoteAddress: '198.51.100.20',
        headers: { 'user-agent': `agent/${'u'.repeat(600)}` },
      });
      expect(logMcpRequest).toHaveBeenCalledTimes(1);
      const [dbName, entry, , options] = vi.mocked(logMcpRequest).mock.calls[0];
      expect(dbName).toBe('tenant_acme');
      expect(entry).toMatchObject({ callerType: 'public', status: 'success', transport: 'jsonrpc' });
      expect(options?.payloadLimitBytes).toBe(16384);
      expect(options?.client?.ip).toBe('198.51.100.20');
      expect(options?.client?.userAgent).toHaveLength(256);
    });

    it('takes its payload limit from MCP_PUBLIC_LOG_PAYLOAD_LIMIT_BYTES', async () => {
      await start({ MCP_PUBLIC_LOG_PAYLOAD_LIMIT_BYTES: '4096' });
      await post(callTool());
      expect(vi.mocked(logMcpRequest).mock.calls[0][3]?.payloadLimitBytes).toBe(4096);
    });

    it('applies the same bound to the log of a failed call', async () => {
      await start();
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error('boom'));
      await post(callTool(), { headers: { 'user-agent': 'curl/8' } });
      const [, , , options] = vi.mocked(logMcpRequest).mock.calls[0];
      expect(options).toMatchObject({ payloadLimitBytes: 16384, client: { userAgent: 'curl/8' } });
    });
  });

  describe('sessions', () => {
    it('answers a message that names an unknown session with 404, not with an inline result', async () => {
      await start();
      const response = await post(rpc('tools/list'), { url: `${BASE}/message?sessionId=00000000-0000-4000-8000-000000000001` });
      expect(response.statusCode).toBe(404);
      expect(json(response).error).toEqual({ code: -32001, message: 'Session not found' });
    });

    it('answers 404 for a session id that is not a single string', async () => {
      await start();
      const response = await post(rpc('ping'), { url: `${BASE}/message?sessionId=a&sessionId=b` });
      expect(response.statusCode).toBe(404);
    });

    it('does not let an unknown session id change which protocol is checked', async () => {
      await start();
      current = server({ exposure: { protocols: ['sse'], accessMode: 'public' } });
      const sessionless = await post(rpc('ping'));
      expect(sessionless.statusCode).toBe(403);
      const withBogusSession = await post(rpc('ping'), { url: `${BASE}/message?sessionId=00000000-0000-4000-8000-000000000001` });
      expect(withBogusSession.statusCode).toBe(404);
      expect(executeMcpTool).not.toHaveBeenCalled();
    });

    it('treats an empty sessionId as none', async () => {
      await start();
      const response = await post(rpc('ping'), { url: `${BASE}/message?sessionId=` });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('opening a stream with HEAD', () => {
    it('does not reach the stream handler and leaves no session behind', async () => {
      await start();
      const before = sseSessionCount();
      const response = await app.inject({ method: 'HEAD', url: `${BASE}/sse` });
      expect(response.statusCode).toBe(404);
      expect(response.headers['x-mcp-session-id']).toBeUndefined();
      expect(sseSessionCount()).toBe(before);
    });
  });

  describe('media tool results', () => {
    it('sends a ToolOutput as a native MCP image block', async () => {
      await start();
      vi.mocked(executeMcpTool).mockResolvedValue({
        result: { kind: 'tool_output', content: [{ type: 'text', text: 'shot' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
        latencyMs: 5,
      } as never);
      const body = json(await post(callTool()));
      expect(body.result?.content).toEqual([
        { type: 'text', text: 'shot' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ]);
    });

    it('keeps a text-only result as one text block', async () => {
      await start();
      const body = json(await post(callTool()));
      expect(body.result?.content).toEqual([{ type: 'text', text: '{"echoed":true}' }]);
    });
  });
});
