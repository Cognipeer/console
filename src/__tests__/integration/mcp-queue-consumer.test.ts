/**
 * Integration test — MCP calls routed to another node through the job queue.
 *
 * The producer sends ids, not the server record; the consumer binds the
 * server's tenant database for the whole execution, loads the record itself
 * and runs against THAT. A job in the previous format (the whole record) is
 * still accepted during a rolling deploy, but only its ids are used.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-queue-consumer-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_queue_consumer_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-queue-consumer-tests';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'api.example.com') return [{ address: '93.184.216.34', family: 4 }];
    throw new Error(`ENOTFOUND ${host}`);
  }),
}));

const queue = vi.hoisted(() => ({
  handler: undefined as undefined | ((ctx: { name: string; data: unknown }) => Promise<unknown>),
  routed: [] as Array<{ ctx: unknown; payload: Record<string, unknown> }>,
}));

vi.mock('@/lib/core/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/queue')>();
  return {
    ...actual,
    getQueue: vi.fn(async () => ({
      consume: (_queueName: string, handler: typeof queue.handler) => {
        queue.handler = handler;
      },
    })),
  };
});

// Route every call "to another node": record what would be enqueued, then run
// the local handler as the producer's fallback.
vi.mock('@/lib/core/cluster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/cluster')>();
  return {
    ...actual,
    routeInstanceCall: vi.fn(async (ctx: unknown, payload: Record<string, unknown>, local: () => Promise<unknown>) => {
      queue.routed.push({ ctx, payload });
      return local();
    }),
  };
});

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import { createMcpServer, executeMcpTool, updateMcpServer } from '@/lib/services/mcp';
import { startMcpQueueConsumer } from '@/lib/services/mcp/mcpConsumer';

const TENANT_A_DB = 'mcp_queue_tenant_a';
const TENANT_B_DB = 'mcp_queue_tenant_b';
const USER_ID = 'user-1';
const TOKEN = 'QUEUE-UPSTREAM-TOKEN-777';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Upstream', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
});

let tenantAId: string;
let tenantBId: string;
let serverA: IMcpServer;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function job(data: Record<string, unknown>, name = 'invoke') {
  if (!queue.handler) throw new Error('consumer not started');
  return queue.handler({ name, data });
}

async function lastErrorInTenantA(): Promise<IMcpServer['lastError']> {
  const db = await getDatabase();
  return db.runWithTenant!(TENANT_A_DB, async () => (await db.findMcpServerById(String(serverA._id)))?.lastError ?? null);
}

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const a = await db.createTenant({
    companyName: 'Queue A', slug: 'queue-a', dbName: TENANT_A_DB, licenseType: 'FREE', ownerId: 'owner-a',
  });
  const b = await db.createTenant({
    companyName: 'Queue B', slug: 'queue-b', dbName: TENANT_B_DB, licenseType: 'FREE', ownerId: 'owner-b',
  });
  tenantAId = String(a._id);
  tenantBId = String(b._id);

  serverA = await createMcpServer(TENANT_A_DB, tenantAId, USER_ID, undefined, {
    name: 'Queue Server',
    openApiSpec: SPEC,
    upstreamAuth: { type: 'token', token: TOKEN },
  });
  await startMcpQueueConsumer();
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  queue.routed.length = 0;
  fetchMock = vi.fn(async () => jsonResponse({ id: '7' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MCP_LAST_ERROR_THROTTLE_MS;
  reloadConfig();
});

describe('producer — the job carries ids, not the server record', () => {
  it('enqueues only the identifiers, the tool name, the arguments and the runtime headers', async () => {
    await executeMcpTool(serverA, 'getUser', { id: '7' }, { 'x-caller': 'caller-header-value' });

    expect(queue.routed).toHaveLength(1);
    expect(queue.routed[0].payload).toEqual({
      tenantId: tenantAId,
      serverId: String(serverA._id),
      serverKey: serverA.key,
      toolName: 'getUser',
      args: { id: '7' },
      runtimeHeaders: { 'x-caller': 'caller-header-value' },
    });
    const text = JSON.stringify(queue.routed[0].payload);
    expect(text).not.toContain('upstreamAuth');
    expect(text).not.toContain('sealed');
    expect(text).not.toContain('openApiSpec');
  });

  it('runs a record that has no id locally instead of routing it', async () => {
    const unsaved: IMcpServer = { ...serverA };
    delete unsaved._id;
    await executeMcpTool(unsaved, 'getUser', { id: '7' });
    expect(queue.routed).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('consumer — the worker loads the record and binds the tenant', () => {
  it('executes an id-only job against the stored server', async () => {
    const result = await job({
      tenantId: tenantAId,
      serverId: String(serverA._id),
      serverKey: serverA.key,
      toolName: 'getUser',
      args: { id: '7' },
    }) as { result: unknown };

    expect(result.result).toEqual({ id: '7' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/users/7');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('runs inside the job tenant even while the process-global tenant is another one', async () => {
    process.env.MCP_LAST_ERROR_THROTTLE_MS = '0';
    reloadConfig();
    fetchMock.mockResolvedValueOnce(new Response('upstream failure', { status: 500 }));
    const db = await getDatabase();
    // Another request moved the process-global binding to the other tenant.
    await db.switchToTenant(TENANT_B_DB);

    await expect(job({
      tenantId: tenantAId,
      serverId: String(serverA._id),
      serverKey: serverA.key,
      toolName: 'getUser',
      args: { id: '7' },
    })).rejects.toThrow(/Upstream API error \(500\)/);

    // The failure was recorded on tenant A's server — the record lives there.
    await vi.waitFor(async () => expect(await lastErrorInTenantA()).not.toBeNull());
    expect((await lastErrorInTenantA())!.message).toContain('Upstream API error (500)');
  });

  it('accepts a job in the previous format, but uses only its ids', async () => {
    const shipped = {
      ...serverA,
      upstreamBaseUrl: 'https://other.example.com',
      upstreamAuth: { type: 'none' },
      stdioConfig: { runtime: 'npx', packageName: 'other-package', executionMode: 'subprocess' },
      tools: [{ name: 'shippedTool', description: 'x', inputSchema: { type: 'object', properties: {} }, httpMethod: 'GET', httpPath: '/x' }],
    };

    const ok = await job({ server: shipped, toolName: 'getUser', args: { id: '9' } }) as { result: unknown };
    expect(ok.result).toEqual({ id: '7' });
    // The stored base URL and credential were used, not the shipped ones.
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example.com/v1/users/9');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${TOKEN}`);

    fetchMock.mockClear();
    await expect(job({ server: shipped, toolName: 'shippedTool', args: {} })).rejects.toThrow('Unknown tool');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a job for a server that is no longer active', async () => {
    const disabled = await createMcpServer(TENANT_A_DB, tenantAId, USER_ID, undefined, {
      name: 'Queue Disabled',
      openApiSpec: SPEC,
      upstreamAuth: { type: 'none' },
    });
    await updateMcpServer(TENANT_A_DB, String(disabled._id), USER_ID, { status: 'disabled' });

    await expect(job({
      tenantId: tenantAId, serverId: String(disabled._id), serverKey: disabled.key, toolName: 'getUser', args: { id: '1' },
    })).rejects.toThrow(/disabled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not find a server through another tenant, or for an unknown tenant', async () => {
    await expect(job({
      tenantId: tenantBId, serverId: String(serverA._id), serverKey: serverA.key, toolName: 'getUser', args: { id: '1' },
    })).rejects.toThrow(/not found/i);

    await expect(job({
      tenantId: 'no-such-tenant', serverId: String(serverA._id), serverKey: serverA.key, toolName: 'getUser', args: { id: '1' },
    })).rejects.toThrow(/unknown tenant/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses jobs that do not identify a server, and unknown job names', async () => {
    await expect(job({ toolName: 'getUser', args: {} })).rejects.toThrow(/does not identify a server/i);
    await expect(job({ tenantId: tenantAId, toolName: 'getUser', args: {} })).rejects.toThrow(/does not identify a server/i);
    await expect(job({ server: {}, toolName: 'getUser', args: {} })).rejects.toThrow(/does not identify a server/i);
    await expect(job({}, 'something-else')).rejects.toThrow(/Unknown mcp job/);
  });
});
