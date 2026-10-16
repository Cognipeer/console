/**
 * Public MCP endpoints behind a load balancer: a message that names an SSE
 * session held by ANOTHER node is accepted only when the session's registered
 * binding is this endpoint and an anonymous caller, and its response is
 * relayed over Redis to the node holding the stream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

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
import { setRelayTransportForTests, type RelayTransport } from '@/lib/core/cluster/streamRelay';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { publicMcpApiPlugin } from '@/server/api/plugins/public-mcp';
import { createMockDb } from '../helpers/db.mock';
import { buildMcpTestApp } from '../helpers/mcp-http';

const SLUG = 'slugslugslug1234';
const BASE = `/api/public/mcp/tenant-1/${SLUG}`;
const SESSION = 'remote-session-0001';

const server = {
  _id: 'srv-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'public-server',
  name: 'Public server',
  status: 'active',
  sourceType: 'openapi',
  endpointSlug: SLUG,
  exposure: { protocols: ['streamable-http', 'sse'], accessMode: 'public' },
  tools: [],
} as unknown as IMcpServer;

describe('public MCP SSE across nodes', () => {
  let app: FastifyInstance;
  let kv: Map<string, string>;
  let published: Array<{ channel: string; message: string }>;

  function ping(sessionId: string) {
    return app.inject({
      method: 'POST',
      url: `${BASE}/message?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
    });
  }

  const register = (ref: Record<string, unknown>) => kv.set(`mcp:sse:session:${SESSION}`, JSON.stringify(ref));

  beforeEach(async () => {
    vi.resetAllMocks();
    resetRateLimitStore();
    kv = new Map();
    published = [];
    const transport: RelayTransport = {
      async publish(channel, message) { published.push({ channel, message }); },
      async subscribe() { return async () => undefined; },
      async setKey(key, value) { kv.set(key, value); },
      async getKey(key) { return kv.get(key) ?? null; },
      async delKey(key) { kv.delete(key); },
    };
    setRelayTransportForTests(transport);
    const db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: 'tenant-1', dbName: 'tenant_acme' } as never);
    db.findMcpServerByEndpointSlug.mockImplementation(async (slug: string) => (slug === SLUG ? server : null) as never);
    vi.mocked(getDatabase).mockResolvedValue(db as never);
    app = await buildMcpTestApp(publicMcpApiPlugin);
  });

  afterEach(async () => {
    setRelayTransportForTests(undefined);
    await app.close();
  });

  it('relays the response to the node that holds the stream', async () => {
    register({ serverKey: 'public-server', tenantId: 'tenant-1', projectId: 'proj-1', principal: 'public' });
    const response = await ping(SESSION);
    expect(response.statusCode).toBe(202);
    expect(published).toEqual([
      { channel: `mcp:sse:down:${SESSION}`, message: JSON.stringify({ id: 7, jsonrpc: '2.0', result: {} }) },
    ]);
  });

  it('answers 404 for an id that is registered nowhere', async () => {
    const response = await ping('nobody-has-this-id');
    expect(response.statusCode).toBe(404);
    expect(published).toEqual([]);
  });

  it.each([
    ['another endpoint', { serverKey: 'other-server', tenantId: 'tenant-1', projectId: 'proj-1', principal: 'public' }],
    ['another tenant', { serverKey: 'public-server', tenantId: 'tenant-2', projectId: 'proj-1', principal: 'public' }],
    ['another project', { serverKey: 'public-server', tenantId: 'tenant-1', projectId: 'proj-2', principal: 'public' }],
    ['a token holder', { serverKey: 'public-server', tenantId: 'tenant-1', projectId: 'proj-1', principal: 'token:abc' }],
    ['no recorded principal', { serverKey: 'public-server', tenantId: 'tenant-1', projectId: 'proj-1' }],
  ])('does not deliver into a stream that belongs to %s', async (_name, ref) => {
    register(ref);
    const response = await ping(SESSION);
    expect(response.statusCode).toBe(404);
    expect(published).toEqual([]);
  });
});
