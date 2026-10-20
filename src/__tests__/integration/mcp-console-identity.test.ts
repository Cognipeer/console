/**
 * Integration test — MCP servers set up for Console identity (`upstreamAuth.type: console_identity`).
 *
 * Real SQLite backend, real `createMcpServer` / `executeMcpTool(Local)`, the upstream replaced by a
 * stubbed `fetch`. What the upstream receives is checked with the workspace's published key set,
 * the way a real server would verify it:
 *
 *  - every call (and the discovery run at save time) carries a token for the person behind it,
 *    for that server's URL, in `Authorization`, over anything a caller tried to send there;
 *  - a call without a person never goes out, is not a server fault, and leaves no `lastError`;
 *  - the token does not leak back through what the upstream echoes;
 *  - a composite hands the person to its member, which mints for its own URL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-console-identity-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_console_identity_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-console-identity-tests';
process.env.APP_URL = 'https://console.example.com';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (['api.example.com', 'mcp.example.com', 'member.example.com'].includes(host)) {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    throw new Error(`ENOTFOUND ${host}`);
  }),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import { consoleIdentityIssuer, getConsoleIdentityJwks, isConsoleIdentityRefusal, resetConsoleIdentityCachesForTests } from '@/lib/iam/consoleIdentity';
import { createMcpServer, executeMcpTool, refreshMcpServerTools, updateMcpServer } from '@/lib/services/mcp';
import { executeMcpToolLocal } from '@/lib/services/mcp/mcpService';

const TENANT_DB_NAME = 'mcp_console_identity_tenant';
const PROJECT_ID = 'project-1';
const MCP_URL = 'https://mcp.example.com/mcp';
const MEMBER_URL = 'https://member.example.com/mcp';
let TENANT_ID: string;
let PERSON_ID: string;
let ADMIN_ID: string;

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'CRM', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: { '/customers': { get: { operationId: 'listCustomers' } } },
});

let fetchMock: ReturnType<typeof vi.fn>;
let echo: 'none' | 'error' | 'result' = 'none';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A JSON-RPC MCP upstream: `tools/list` lists `echo`, `tools/call` answers (or echoes the Authorization header). */
function mcpUpstream(_url: string, init: RequestInit): Response {
  const body = JSON.parse(String(init.body ?? '{}')) as { id?: number; method?: string };
  const auth = new Headers(init.headers).get('authorization') ?? '';
  if (body.method === 'tools/list') {
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] } });
  }
  if (echo === 'error') return new Response(`rejected credentials: ${auth}`, { status: 401 });
  const text = echo === 'result' ? `you sent ${auth}` : 'ok';
  return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } });
}

function sent(n: number): { url: string; headers: Headers } {
  const call = fetchMock.mock.calls[n];
  return { url: String(call?.[0]), headers: new Headers((call?.[1] as RequestInit | undefined)?.headers) };
}

async function verified(authorization: string | null, audience: string): Promise<JWTPayload> {
  expect(authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const jwks = createLocalJWKSet(await getConsoleIdentityJwks(TENANT_DB_NAME));
  const { payload } = await jwtVerify(authorization!.slice('Bearer '.length), jwks, {
    issuer: consoleIdentityIssuer(TENANT_ID),
    audience,
    algorithms: ['RS256'],
    typ: 'at+jwt',
  });
  return payload;
}

async function tenantDb() {
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
  return db;
}

async function remoteServer(name: string, url = MCP_URL): Promise<IMcpServer> {
  return createMcpServer(TENANT_DB_NAME, TENANT_ID, ADMIN_ID, PROJECT_ID, {
    name,
    sourceType: 'remote',
    remoteConfig: { url, transport: 'streamable-http' },
    upstreamAuth: { type: 'console_identity' },
  });
}

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'MCP Console Identity',
    slug: 'mcp-console-identity',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  TENANT_ID = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  const person = await db.createUser({
    tenantId: TENANT_ID, email: 'ayse@example.com', name: 'Ayşe', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [],
  } as never);
  const admin = await db.createUser({
    tenantId: TENANT_ID, email: 'admin@example.com', name: 'Admin', password: '$2b$10$x', role: 'admin', licenseId: 'FREE', features: [],
  } as never);
  PERSON_ID = String(person._id);
  ADMIN_ID = String(admin._id);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  echo = 'none';
  resetConsoleIdentityCachesForTests();
  fetchMock = vi.fn(async (url: string, init: RequestInit) => mcpUpstream(url, init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remote MCP server', () => {
  it('discovers its tools as the person saving it', async () => {
    const server = await remoteServer('Discovery');
    expect(server.tools.map((t) => t.name)).toEqual(['echo']);
    const payload = await verified(sent(0).headers.get('authorization'), MCP_URL);
    expect(payload).toMatchObject({ sub: ADMIN_ID, src: 'console', via: 'session', tenant_id: TENANT_ID, project_id: PROJECT_ID });

    fetchMock.mockClear();
    await refreshMcpServerTools(TENANT_DB_NAME, String(server._id), ADMIN_ID);
    expect((await verified(sent(0).headers.get('authorization'), MCP_URL)).sub).toBe(ADMIN_ID);
  });

  it('sends a token for the person behind each call, over a caller-supplied Authorization', async () => {
    const server = await remoteServer('Calls');
    fetchMock.mockClear();
    await executeMcpToolLocal(
      server,
      'echo',
      {},
      { authorization: 'Bearer caller-token', 'x-trace-id': 'trace-1' },
      { userId: PERSON_ID, tokenId: 'tok-1', source: 'api', agentKey: 'crm-helper' },
    );
    const request = sent(0);
    expect(request.url).toBe(MCP_URL);
    expect(request.headers.get('x-trace-id')).toBe('trace-1');
    expect(request.headers.get('authorization')).not.toContain('caller-token');
    const payload = await verified(request.headers.get('authorization'), MCP_URL);
    expect(payload).toMatchObject({ sub: PERSON_ID, email: 'ayse@example.com', name: 'Ayşe', via: 'api_token', src: 'api', act: { sub: 'agent:crm-helper' } });
  });

  it('refuses a call with nobody behind it before anything is sent, without blaming the server', async () => {
    const server = await remoteServer('Refusal');
    fetchMock.mockClear();
    const call = executeMcpTool(server, 'echo', {}, undefined, undefined);
    await expect(call).rejects.toSatisfy((error: unknown) => isConsoleIdentityRefusal(error));
    await expect(executeMcpToolLocal(server, 'echo', {}, undefined, { userId: 'system:trigger:t1' })).rejects.toThrow(/Console identity: /);
    expect(fetchMock).not.toHaveBeenCalled();
    const db = await tenantDb();
    expect((await db.findMcpServerById(String(server._id)))?.lastError ?? null).toBeNull();
  });

  it('keeps the token out of what the upstream echoes back', async () => {
    const server = await remoteServer('Echo');
    echo = 'result';
    const { result } = await executeMcpToolLocal(server, 'echo', {}, undefined, { userId: PERSON_ID });
    expect(String(result)).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);

    echo = 'error';
    const failure = await executeMcpToolLocal(server, 'echo', {}, undefined, { userId: PERSON_ID }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('401');
    expect((failure as Error).message).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const db = await tenantDb();
    const lastError = (await db.findMcpServerById(String(server._id)))?.lastError;
    expect(JSON.stringify(lastError ?? null)).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
  });
});

describe('OpenAPI server', () => {
  it('mints for the base URL, whatever operation is called', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, ADMIN_ID, PROJECT_ID, {
      name: 'CRM API',
      openApiSpec: SPEC,
      upstreamAuth: { type: 'console_identity' },
    });
    fetchMock.mockImplementation(async () => jsonResponse({ customers: [] }));
    await executeMcpToolLocal(server, 'listCustomers', {}, undefined, { userId: PERSON_ID, source: 'portal' });
    const request = sent(0);
    expect(request.url).toBe('https://api.example.com/v1/customers');
    const payload = await verified(request.headers.get('authorization'), 'https://api.example.com/v1');
    expect(payload).toMatchObject({ sub: PERSON_ID, src: 'portal', via: 'session' });
  });
});

describe('composite server', () => {
  it('hands the person to the member, which mints for its own URL', async () => {
    const member = await remoteServer('Member', MEMBER_URL);
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, ADMIN_ID, PROJECT_ID, {
      name: 'Bundle',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(member._id) }] },
    });
    fetchMock.mockClear();
    const toolName = composite.tools[0]!.name;
    await executeMcpToolLocal(composite, toolName, {}, undefined, { userId: PERSON_ID, source: 'mcp' });
    const request = sent(0);
    expect(request.url).toBe(MEMBER_URL);
    expect((await verified(request.headers.get('authorization'), MEMBER_URL)).sub).toBe(PERSON_ID);
  });
});

describe('configuration', () => {
  it('is offered for remote and OpenAPI servers only', async () => {
    await expect(createMcpServer(TENANT_DB_NAME, TENANT_ID, ADMIN_ID, PROJECT_ID, {
      name: 'Bundle 2',
      sourceType: 'composite',
      upstreamAuth: { type: 'console_identity' },
      compositeConfig: { members: [{ serverId: 'x' }] },
    })).rejects.toThrow('Console identity is available for remote MCP and OpenAPI servers only');

    const plain = await createMcpServer(TENANT_DB_NAME, TENANT_ID, ADMIN_ID, PROJECT_ID, {
      name: 'Plain',
      openApiSpec: SPEC,
      upstreamAuth: { type: 'token', token: 'STATIC-TOKEN-1' },
    });
    const switched = await updateMcpServer(TENANT_DB_NAME, String(plain._id), ADMIN_ID, { upstreamAuth: { type: 'console_identity' } });
    // The stored credential is gone with the switch.
    expect(switched?.upstreamAuth).toEqual({ type: 'console_identity' });
    expect(JSON.stringify(switched)).not.toContain('STATIC-TOKEN-1');
  });

  it('publishes the key set as soon as a server is set up for it', async () => {
    expect((await getConsoleIdentityJwks(TENANT_DB_NAME)).keys.length).toBeGreaterThan(0);
  });
});
