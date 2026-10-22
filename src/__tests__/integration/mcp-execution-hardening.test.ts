/**
 * Integration test — what an MCP server will run, and what it lets out.
 *
 * Real SQLite backend, real `createMcpServer` / `executeMcpToolLocal`, the
 * upstream replaced by a stubbed `fetch` (so nothing here opens a socket).
 *
 *  - OpenAPI tools: placeholders are filled in the path only, only declared
 *    arguments are forwarded, and path parameters are checked against the
 *    tool's own path.
 *  - `tools/call` may only name a tool the server advertises, for every source.
 *  - Secret values the server holds are masked in the errors it throws, in the
 *    `lastError` it stores (bounded, not rewritten on every call) and in the
 *    results it returns.
 *  - Request-log rows bound what the caller chose (tool name, session id,
 *    payload size) and can carry who called.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-exec-hardening-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_exec_hardening_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-exec-hardening-tests';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'api.example.com' || host === 'mcp.example.com') {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    throw new Error(`ENOTFOUND ${host}`);
  }),
}));

// The subprocess runner is the one source that would start a real process;
// the call path is replaced, discovery and the rest stay real.
vi.mock('@/lib/services/mcp/stdioRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/mcp/stdioRunner')>();
  return { ...actual, stdioCallTool: vi.fn(async () => ({ ran: true })) };
});

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer, IMcpTool } from '@/lib/database';
import {
  createMcpServer,
  listMcpRequestLogs,
  logMcpRequest,
  mcpRequestSecretValues,
  refreshMcpServerTools,
  updateMcpServer,
} from '@/lib/services/mcp';
import { executeMcpToolLocal } from '@/lib/services/mcp/mcpService';
import { McpToolInputError, McpUpstreamError } from '@/lib/services/mcp/errors';
import { stdioCallTool } from '@/lib/services/mcp/stdioRunner';
import { mcpSandboxRunner } from '@/enterprise/registry';
import { sealAuthConfig, sealStdioEnv } from '@/lib/services/mcp/secretVault';
import { LOG_SECRET_MASK } from '@/lib/services/logRedaction';

const TENANT_DB_NAME = 'mcp_exec_hardening_tenant';
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
let TENANT_ID: string;

const TOKEN = 'UPSTREAM-SECRET-TOKEN-123';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Upstream', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/users/{id}/profile': {
      get: {
        operationId: 'getProfile',
        summary: 'Get a profile',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
      },
    },
    '/items/{category}/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [
          { name: 'category', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
      },
      delete: {
        operationId: 'deleteItem',
        parameters: [
          { name: 'category', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
      },
    },
    '/projects': {
      post: {
        operationId: 'createProject',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
      get: { operationId: 'listProjects' },
    },
  },
});

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

function sentRequest(n = 0): { url: string; method: string; headers: Headers; body?: string } {
  const call = fetchMock.mock.calls[n];
  const init = (call?.[1] ?? {}) as RequestInit;
  return {
    url: String(call?.[0]),
    method: String(init.method),
    headers: new Headers(init.headers),
    body: typeof init.body === 'string' ? init.body : undefined,
  };
}

async function tenantDb() {
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
  return db;
}

async function storedLastError(server: IMcpServer) {
  const db = await tenantDb();
  return (await db.findMcpServerById(String(server._id)))?.lastError ?? null;
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function openApiServer(
  name: string,
  upstreamAuth: Parameters<typeof createMcpServer>[4]['upstreamAuth'] = { type: 'token', token: TOKEN },
  extra: Partial<Parameters<typeof createMcpServer>[4]> = {},
): Promise<IMcpServer> {
  return createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name,
    openApiSpec: SPEC,
    upstreamAuth,
    ...extra,
  });
}

/** A server row written directly, so the stored tool snapshot is exactly what a test says. */
async function insertServer(
  fields: Pick<IMcpServer, 'name' | 'key' | 'sourceType' | 'tools'> & Partial<IMcpServer>,
): Promise<IMcpServer> {
  const db = await tenantDb();
  return db.createMcpServer({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    upstreamAuth: { type: 'none' },
    exposure: { protocols: ['streamable-http', 'sse'], accessMode: 'public' },
    status: 'active',
    endpointSlug: `slug-${fields.key}-${Math.random().toString(16).slice(2, 10)}`,
    totalRequests: 0,
    createdBy: USER_ID,
    ...fields,
  } as never);
}

const tool = (name: string, extra: Partial<IMcpTool> = {}): IMcpTool => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  ...extra,
});

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'MCP Exec Hardening',
    slug: 'mcp-exec-hardening',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  TENANT_ID = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(stdioCallTool).mockClear();
});

const MCP_ENV_NAMES = [
  'MCP_ERROR_MESSAGE_MAX_CHARS',
  'MCP_LAST_ERROR_MAX_CHARS',
  'MCP_LAST_ERROR_THROTTLE_MS',
  'MCP_LOG_TOOL_NAME_MAX_CHARS',
  'MCP_LOG_USER_AGENT_MAX_CHARS',
  'MCP_LOG_CLIENT_META',
  'MCP_LOG_CLIENT_META_MAX_BYTES',
];

/** Set one of the MCP limits for the current test (the typed config is cached). */
function setMcpEnv(name: string, value: string) {
  process.env[name] = value;
  reloadConfig();
}

afterEach(() => {
  vi.unstubAllGlobals();
  mcpSandboxRunner.current = null;
  for (const name of MCP_ENV_NAMES) delete process.env[name];
  reloadConfig();
});

// ═══════════════════════════════════════════════════════════════════════════
// OpenAPI tools
// ═══════════════════════════════════════════════════════════════════════════

describe('OpenAPI tools — arguments land only where the tool describes', () => {
  it('forwards a normal call to the described operation with the stored credential', async () => {
    const server = await openApiServer('Normal Call');
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '42', name: 'Ada' }));

    const { result } = await executeMcpToolLocal(server, 'getProfile', { id: '42', limit: 5 });

    expect(result).toEqual({ id: '42', name: 'Ada' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = sentRequest();
    expect(sent.url).toBe('https://api.example.com/v1/users/42/profile?limit=5');
    expect(sent.method).toBe('GET');
    expect(sent.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ['..'],
    ['.'],
    ['../../x'],
    ['%2e%2e'],
    ['a/../../b'],
    ['..\\x'],
  ])('refuses a path argument made of relative path segments: %j', async (id) => {
    const server = await openApiServer('Relative Segments Refused');
    await expect(executeMcpToolLocal(server, 'getProfile', { id })).rejects.toThrow(McpToolInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses relative segments spread over several parameters, for GET and DELETE tools', async () => {
    const server = await openApiServer('Two Parameters');
    for (const name of ['getItem', 'deleteItem']) {
      await expect(executeMcpToolLocal(server, name, { category: '..', id: 'x' }))
        .rejects.toThrow(McpToolInputError);
      await expect(executeMcpToolLocal(server, name, { category: 'books', id: '..' }))
        .rejects.toThrow(McpToolInputError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still serves a multi-parameter call', async () => {
    const server = await openApiServer('Two Parameters Ok');
    await executeMcpToolLocal(server, 'deleteItem', { category: 'books', id: 'a b' });
    const sent = sentRequest();
    expect(sent.method).toBe('DELETE');
    expect(sent.url).toBe('https://api.example.com/v1/items/books/a%20b');
  });

  it('refuses a missing path parameter instead of sending the placeholder', async () => {
    const server = await openApiServer('Missing Parameter');
    await expect(executeMcpToolLocal(server, 'getProfile', { limit: 3 })).rejects.toThrow(/path parameter "id"/i);
    await expect(executeMcpToolLocal(server, 'getProfile', { id: '' })).rejects.toThrow(McpToolInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops arguments the tool does not declare — they are neither sent nor echoed', async () => {
    const server = await openApiServer('Undeclared Arguments');
    await executeMcpToolLocal(server, 'getProfile', {
      id: '42',
      limit: 5,
      role: 'x',
      debug: '1',
      include_deleted: 'true',
      api_key: 'x',
    });
    const sent = sentRequest();
    expect(sent.url).toBe('https://api.example.com/v1/users/42/profile?limit=5');
    expect(sent.url).not.toMatch(/role|debug|include_deleted|api_key/);
  });

  it('forwards a request body only to a tool that declares one', async () => {
    const server = await openApiServer('Body Argument');
    await executeMcpToolLocal(server, 'createProject', { body: { name: 'Apollo' }, extra: 1 });
    expect(sentRequest().method).toBe('POST');
    expect(JSON.parse(sentRequest().body as string)).toEqual({ name: 'Apollo' });

    fetchMock.mockClear();
    await executeMcpToolLocal(server, 'listProjects', { body: { name: 'ignored' } });
    expect(sentRequest().body).toBeUndefined();
  });

  it('never fills a placeholder in the stored base URL from an argument', async () => {
    const server = await openApiServer('Templated Base', { type: 'token', token: TOKEN }, {
      upstreamBaseUrl: 'https://{region}.example.com/v1',
    });
    await expect(executeMcpToolLocal(server, 'getProfile', { id: '1', region: 'other' }))
      .rejects.toThrow(/base url/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not record a refused call as a server fault', async () => {
    setMcpEnv('MCP_LAST_ERROR_THROTTLE_MS', '0');
    const server = await openApiServer('Not A Server Fault');
    await expect(executeMcpToolLocal(server, 'getProfile', { id: '..' })).rejects.toThrow(McpToolInputError);
    await expect(executeMcpToolLocal(server, 'nope', {})).rejects.toThrow(McpToolInputError);
    await tick();
    expect(await storedLastError(server)).toBeNull();
  });

  it('keeps a redirect from carrying the configured API-key header to another origin', async () => {
    const server = await openApiServer('Header Auth Redirect', {
      type: 'header',
      headerName: 'X-Api-Key',
      headerValue: 'header-credential-value',
    });
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://mcp.example.com/landing' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await executeMcpToolLocal(server, 'getProfile', { id: '1' }, { 'x-tenant-token': 'runtime-header-value' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = sentRequest(0);
    expect(first.headers.get('x-api-key')).toBe('header-credential-value');
    expect(first.headers.get('x-tenant-token')).toBe('runtime-header-value');
    const second = sentRequest(1);
    expect(second.url).toBe('https://mcp.example.com/landing');
    expect(second.headers.get('x-api-key')).toBeNull();
    expect(second.headers.get('x-tenant-token')).toBeNull();
  });
});

describe('OpenAPI tools — specs from the importers keep working', () => {
  const POSTMAN = JSON.stringify({
    info: {
      name: 'Imported',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [{ key: 'baseUrl', value: 'https://api.example.com/v1' }],
    item: ['Get user', 'Get user (second copy)'].map((name) => ({
      name,
      request: {
        method: 'GET',
        url: {
          raw: '{{baseUrl}}/users/:id?expand=orders',
          host: ['{{baseUrl}}'],
          path: ['users', ':id'],
          query: [{ key: 'expand', value: 'orders' }],
          variable: [{ key: 'id', value: '1' }],
        },
      },
    })),
  });

  it('serves a Postman import, including a second request on the same path', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Postman Import',
      openApiSpec: POSTMAN,
      specFormat: 'postman',
      upstreamAuth: { type: 'none' },
    });
    expect(server.tools).toHaveLength(2);

    for (const imported of server.tools) {
      fetchMock.mockClear();
      await executeMcpToolLocal(server, imported.name, { id: '5', expand: 'orders', ignored: 'x' });
      // A fragment never reaches the wire; what the upstream sees is the same call.
      const sent = new URL(sentRequest().url);
      sent.hash = '';
      expect(sent.toString(), imported.httpPath).toBe('https://api.example.com/v1/users/5?expand=orders');
    }
  });
});

describe('OpenAPI tools — parameters declared by reference or on the path item', () => {
  it('are forwarded; names the spec does not declare are still dropped', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Referenced Parameters',
      upstreamAuth: { type: 'none' },
      openApiSpec: JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Upstream', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com/v1' }],
        components: {
          parameters: {
            PerPage: { name: 'per_page', in: 'query', schema: { type: 'integer' } },
            Owner: { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          },
        },
        paths: {
          '/repos/{owner}/issues': {
            parameters: [{ $ref: '#/components/parameters/Owner' }],
            get: {
              operationId: 'listIssues',
              parameters: [{ $ref: '#/components/parameters/PerPage' }],
            },
          },
        },
      }),
    });

    await executeMcpToolLocal(server, 'listIssues', { owner: 'acme', per_page: 50, unlisted: 'x' });
    expect(sentRequest().url).toBe('https://api.example.com/v1/repos/acme/issues?per_page=50');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// tools/call targets only advertised tools
// ═══════════════════════════════════════════════════════════════════════════

describe('tools/call — only tools the server advertises', () => {
  it('remote: a name that is not in the stored tool list never reaches the upstream', async () => {
    const server = await insertServer({
      name: 'Remote Allow List',
      key: 'remote-allow-list',
      sourceType: 'remote',
      remoteConfig: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' },
      tools: [tool('listed_tool')],
    });
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'UPSTREAM EXECUTED' }] },
    }));

    await expect(executeMcpToolLocal(server, 'unlisted_tool', {})).rejects.toThrow(McpToolInputError);
    await expect(executeMcpToolLocal(server, 'unlisted_tool', {})).rejects.toThrow('Unknown tool');
    expect(fetchMock).not.toHaveBeenCalled();

    const { result } = await executeMcpToolLocal(server, 'listed_tool', { q: 1 });
    expect(result).toBe('UPSTREAM EXECUTED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sentRequest().body as string).params.name).toBe('listed_tool');
  });

  it('rejects names that merely look like object keys', async () => {
    const server = await insertServer({
      name: 'Remote Prototype Names',
      key: 'remote-prototype-names',
      sourceType: 'remote',
      remoteConfig: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' },
      tools: [tool('listed_tool')],
    });
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', ' listed_tool']) {
      await expect(executeMcpToolLocal(server, name, {}), JSON.stringify(name)).rejects.toThrow(McpToolInputError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remote: a disabled tool is still refused as disabled, before the upstream', async () => {
    const server = await insertServer({
      name: 'Remote Disabled',
      key: 'remote-disabled',
      sourceType: 'remote',
      remoteConfig: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' },
      tools: [tool('a_tool'), tool('b_tool')],
      metadata: { disabledTools: ['b_tool'] },
    });
    await expect(executeMcpToolLocal(server, 'b_tool', {})).rejects.toThrow(/disabled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a renamed tool is callable under its exposed name and its real name', async () => {
    const server = await insertServer({
      name: 'Remote Renamed',
      key: 'remote-renamed',
      sourceType: 'remote',
      remoteConfig: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' },
      tools: [tool('real_name')],
      metadata: { toolNames: { real_name: 'friendly_name' } },
    });
    fetchMock.mockImplementation(async () => jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'done' }] },
    }));

    await executeMcpToolLocal(server, 'friendly_name', {});
    expect(JSON.parse(sentRequest(0).body as string).params.name).toBe('real_name');
    await executeMcpToolLocal(server, 'real_name', {});
    expect(JSON.parse(sentRequest(1).body as string).params.name).toBe('real_name');
    await expect(executeMcpToolLocal(server, 'friendly_name_2', {})).rejects.toThrow('Unknown tool');
  });

  it('stdio (subprocess): an unlisted name never starts the process', async () => {
    const server = await insertServer({
      name: 'Stdio Allow List',
      key: 'stdio-allow-list',
      sourceType: 'stdio',
      stdioConfig: { runtime: 'npx', packageName: 'some-mcp-package', executionMode: 'subprocess' },
      tools: [tool('listed_tool')],
    });
    await expect(executeMcpToolLocal(server, 'unlisted_tool', {})).rejects.toThrow('Unknown tool');
    expect(stdioCallTool).not.toHaveBeenCalled();

    await executeMcpToolLocal(server, 'listed_tool', {});
    expect(stdioCallTool).toHaveBeenCalledTimes(1);
  });

  it('stdio (sandbox): an unlisted name never reaches the sandbox runner', async () => {
    const runner = {
      ensureRunning: vi.fn(async () => ({ instanceId: 'inst-1' })),
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ result: { ran: true }, latencyMs: 1 })),
      status: vi.fn(),
      release: vi.fn(),
    };
    mcpSandboxRunner.current = runner as never;
    const server = await insertServer({
      name: 'Sandbox Allow List',
      key: 'sandbox-allow-list',
      sourceType: 'stdio',
      stdioConfig: { runtime: 'npx', packageName: 'some-mcp-package', executionMode: 'sandbox' },
      tools: [tool('listed_tool')],
    });

    await expect(executeMcpToolLocal(server, 'unlisted_tool', {})).rejects.toThrow('Unknown tool');
    expect(runner.ensureRunning).not.toHaveBeenCalled();
    expect(runner.callTool).not.toHaveBeenCalled();

    await executeMcpToolLocal(server, 'listed_tool', {});
    expect(runner.callTool).toHaveBeenCalledTimes(1);
  });

  it('a server whose tool list was never discovered calls nothing until it is refreshed', async () => {
    const server = await insertServer({
      name: 'Empty Snapshot',
      key: 'empty-snapshot',
      sourceType: 'remote',
      remoteConfig: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' },
      tools: [],
    });
    await expect(executeMcpToolLocal(server, 'anything', {})).rejects.toThrow('Unknown tool');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('internal: an unlisted name is refused before the provider runs', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Internal Allow List',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
    });
    await expect(executeMcpToolLocal(server, 'drop_everything', {})).rejects.toThrow(McpToolInputError);
    const { result } = await executeMcpToolLocal(server, 'list_agents', {});
    expect(result).toBeDefined();
  });

  it('internal: a missing required argument is a refused call, not a server fault', async () => {
    setMcpEnv('MCP_LAST_ERROR_THROTTLE_MS', '0');
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Internal Missing Argument',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
    });
    await expect(executeMcpToolLocal(server, 'get_session_detail', {})).rejects.toThrow(McpToolInputError);
    await expect(executeMcpToolLocal(server, 'get_session_detail', {})).rejects.toThrow('"sessionId" is required');
    await tick();
    expect(await storedLastError(server)).toBeNull();
  });

  it('openapi: an unlisted name is refused with the same error', async () => {
    const server = await openApiServer('OpenApi Allow List');
    await expect(executeMcpToolLocal(server, 'deleteEverything', {})).rejects.toThrow('Unknown tool');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Secrets the server holds do not leave in errors, lastError or results
// ═══════════════════════════════════════════════════════════════════════════

describe('secret values in errors, lastError and results', () => {
  it('masks the bearer token in the error thrown for an upstream failure', async () => {
    const server = await openApiServer('Echo Bearer');
    fetchMock.mockResolvedValueOnce(textResponse(`{"error":"rejected credential ${TOKEN}"}`, 401));

    const error = await executeMcpToolLocal(server, 'getProfile', { id: '1' }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    // Callers that must not show the upstream's text still get its status.
    expect(error).toBeInstanceOf(McpUpstreamError);
    expect((error as McpUpstreamError).status).toBe(401);
    expect((error as Error).message).toContain('Upstream API error (401)');
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).stack ?? '').not.toContain(TOKEN);
  });

  it('masks a basic credential in every spelling an upstream might print', async () => {
    const server = await openApiServer('Echo Basic', { type: 'basic', username: 'service-user', password: 'pa55-word-9x' });
    const wire = Buffer.from('service-user:pa55-word-9x').toString('base64');
    fetchMock.mockResolvedValueOnce(
      textResponse(`user service-user:pa55-word-9x sent Basic ${wire} (password pa55-word-9x)`, 403),
    );

    const error = await executeMcpToolLocal(server, 'getProfile', { id: '1' }).catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).not.toContain('pa55-word-9x');
    expect(message).not.toContain(wire);
    expect(message).toContain('[REDACTED]');
  });

  it('masks a custom auth header value and a caller runtime header value', async () => {
    const server = await openApiServer('Echo Header', {
      type: 'header',
      headerName: 'X-Api-Key',
      headerValue: 'header-credential-value',
    });
    fetchMock.mockResolvedValueOnce(
      textResponse('X-Api-Key: header-credential-value / X-User-Token: caller-token-value', 500),
    );

    const error = await executeMcpToolLocal(
      server,
      'getProfile',
      { id: '1' },
      { 'x-user-token': 'caller-token-value' },
    ).catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).not.toContain('header-credential-value');
    expect(message).not.toContain('caller-token-value');
  });

  it('masks the credential in the error of a remote upstream', async () => {
    const server = await insertServer({
      name: 'Remote Echo',
      key: 'remote-echo',
      sourceType: 'remote',
      remoteConfig: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' },
      upstreamAuth: sealAuthConfig({ type: 'token', token: TOKEN }),
      tools: [tool('listed_tool')],
    });
    fetchMock.mockResolvedValueOnce(textResponse(`invalid bearer ${TOKEN}`, 401));

    const error = await executeMcpToolLocal(server, 'listed_tool', {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(McpUpstreamError);
    expect((error as McpUpstreamError).status).toBe(401);
    expect((error as Error).message).toContain('MCP server responded with 401');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('masks stdio environment values in an error (a stderr tail)', async () => {
    const envSecret = 'CRM-API-KEY-VALUE-998877';
    const server = await insertServer({
      name: 'Stdio Env Echo',
      key: 'stdio-env-echo',
      sourceType: 'stdio',
      stdioConfig: sealStdioEnv({
        runtime: 'npx',
        packageName: 'some-mcp-package',
        executionMode: 'subprocess',
        env: { CRM_KEY: envSecret },
      }),
      tools: [tool('listed_tool')],
    });
    vi.mocked(stdioCallTool).mockRejectedValueOnce(
      new Error(`Stdio MCP server exited (code 1) before responding — stderr: CRM_KEY=${envSecret}`),
    );

    const error = await executeMcpToolLocal(server, 'listed_tool', {}).catch((e: Error) => e);
    expect((error as Error).message).toContain('Stdio MCP server exited');
    expect((error as Error).message).not.toContain(envSecret);
    expect((error as Error).message).toContain('CRM_KEY=[REDACTED]');
  });

  it('includes stdio environment values in the list handed to the request log', async () => {
    const envSecret = 'CRM-API-KEY-VALUE-554433';
    const server = await insertServer({
      name: 'Stdio Env Log',
      key: 'stdio-env-log',
      sourceType: 'stdio',
      stdioConfig: sealStdioEnv({
        runtime: 'npx',
        packageName: 'some-mcp-package',
        executionMode: 'subprocess',
        env: { CRM_KEY: envSecret },
      }),
      tools: [tool('listed_tool')],
    });
    expect(mcpRequestSecretValues(server)).toContain(envSecret);

    await logMcpRequest(TENANT_DB_NAME, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      serverId: String(server._id),
      serverKey: server.key,
      toolName: 'listed_tool',
      status: 'success',
      requestPayload: { tool: 'listed_tool', arguments: {} },
      responsePayload: { stderr: `CRM_KEY=${envSecret}` },
      callerType: 'public',
      transport: 'jsonrpc',
      sourceType: 'stdio',
    }, mcpRequestSecretValues(server));
    const rows = await listMcpRequestLogs(TENANT_DB_NAME, server, { limit: 5 });
    expect(JSON.stringify(rows[0].responsePayload)).not.toContain(envSecret);
    expect(JSON.stringify(rows[0].responsePayload)).toContain(LOG_SECRET_MASK);
  });

  it('masks a credential embedded in the remote URL', async () => {
    const urlSecret = 'url-embedded-secret-4242';
    const server = await insertServer({
      name: 'Remote Url Secret',
      key: 'remote-url-secret',
      sourceType: 'remote',
      remoteConfig: { url: `https://mcp.example.com/mcp?access=${urlSecret}`, transport: 'streamable-http' },
      tools: [tool('listed_tool')],
    });
    fetchMock.mockRejectedValueOnce(new Error(`Too many redirects fetching https://mcp.example.com/mcp?access=${urlSecret}`));

    const error = await executeMcpToolLocal(server, 'listed_tool', {}).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(urlSecret);
  });

  it('collects every value a server holds, and none it does not', async () => {
    const server = await insertServer({
      name: 'Secret Inventory',
      key: 'secret-inventory',
      sourceType: 'remote',
      remoteConfig: { url: 'https://user:url-password-77@mcp.example.com/mcp?access=url-token-88&mode=sse', transport: 'streamable-http' },
      upstreamAuth: sealAuthConfig({ type: 'basic', username: 'svc', password: 'basic-password-99' }),
      tools: [tool('listed_tool')],
    });
    const values = mcpRequestSecretValues(server, { 'x-caller': 'caller-value-11' });
    for (const expected of [
      'caller-value-11',
      'basic-password-99',
      Buffer.from('svc:basic-password-99').toString('base64'),
      'svc:basic-password-99',
      'url-password-77',
      'url-token-88',
    ]) {
      expect(values, expected).toContain(expected);
    }
    // Names and other non-secret parts of the configuration are not on the list.
    expect(values).not.toContain('svc');
    expect(values).not.toContain('mcp.example.com');
  });

  it('masks the credential when the upstream echoes it in a successful result', async () => {
    const server = await openApiServer('Echo Success');
    fetchMock.mockResolvedValueOnce(jsonResponse({
      received: { authorization: `Bearer ${TOKEN}` },
      list: [`x ${TOKEN} y`],
      keep: 'untouched',
    }));
    const { result } = await executeMcpToolLocal(server, 'getProfile', { id: '1' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result).toEqual({
      received: { authorization: 'Bearer [REDACTED]' },
      list: ['x [REDACTED] y'],
      keep: 'untouched',
    });
  });

  it('leaves a result alone when the server holds no credential', async () => {
    const server = await openApiServer('No Credential', { type: 'none' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ text: TOKEN }));
    const { result } = await executeMcpToolLocal(server, 'getProfile', { id: '1' });
    expect(result).toEqual({ text: TOKEN });
  });

  it('stores a masked lastError, not the raw upstream text', async () => {
    const server = await openApiServer('Last Error Scrub');
    fetchMock.mockResolvedValueOnce(textResponse(`rejected credential ${TOKEN} for this call`, 500));

    await expect(executeMcpToolLocal(server, 'getProfile', { id: '1' })).rejects.toThrow();
    await vi.waitFor(async () => expect(await storedLastError(server)).not.toBeNull());

    const stored = (await storedLastError(server))!;
    expect(stored.message).toContain('Upstream API error (500)');
    expect(stored.message).toContain('[REDACTED]');
    expect(stored.message).not.toContain(TOKEN);
  });

  it('bounds lastError at 2 KiB by default', async () => {
    const server = await openApiServer('Last Error Bound');
    fetchMock.mockResolvedValueOnce(textResponse('e'.repeat(10_000), 500));

    await expect(executeMcpToolLocal(server, 'getProfile', { id: '1' })).rejects.toThrow();
    await vi.waitFor(async () => expect(await storedLastError(server)).not.toBeNull());
    expect((await storedLastError(server))!.message.length).toBeLessThanOrEqual(2048);
  });

  it('cuts lastError after masking, so no part of the credential survives the cut', async () => {
    setMcpEnv('MCP_LAST_ERROR_MAX_CHARS', '100');
    const server = await openApiServer('Last Error Cut');
    // The credential straddles character 100 of the message.
    fetchMock.mockResolvedValueOnce(textResponse(`${'x'.repeat(60)}${TOKEN}${'y'.repeat(60)}`, 500));

    await expect(executeMcpToolLocal(server, 'getProfile', { id: '1' })).rejects.toThrow();
    await vi.waitFor(async () => expect(await storedLastError(server)).not.toBeNull());
    const stored = (await storedLastError(server))!;
    expect(stored.message.length).toBeLessThanOrEqual(100);
    expect(stored.message).not.toContain(TOKEN.slice(0, 8));
  });

  it('bounds the error message handed to the caller', async () => {
    const server = await openApiServer('Error Cap');
    fetchMock.mockResolvedValueOnce(textResponse('e'.repeat(40_000), 500));
    const error = await executeMcpToolLocal(server, 'getProfile', { id: '1' }).catch((e: Error) => e);
    expect((error as Error).message.length).toBeLessThanOrEqual(8192);
  });

  it('honours the length env settings', async () => {
    setMcpEnv('MCP_ERROR_MESSAGE_MAX_CHARS', '300');
    setMcpEnv('MCP_LAST_ERROR_MAX_CHARS', '100');
    const server = await openApiServer('Env Caps');
    // The credential straddles the 300-character cut of the thrown message.
    fetchMock.mockResolvedValueOnce(textResponse(`${'e'.repeat(270)}${TOKEN}${'e'.repeat(500)}`, 500));
    const error = await executeMcpToolLocal(server, 'getProfile', { id: '1' }).catch((e: Error) => e);
    expect((error as Error).message.length).toBeLessThanOrEqual(300);
    expect((error as Error).message).not.toContain(TOKEN.slice(0, 8));
    await vi.waitFor(async () => expect(await storedLastError(server)).not.toBeNull());
    expect((await storedLastError(server))!.message.length).toBeLessThanOrEqual(100);
  });
});

describe('lastError writes', () => {
  async function failOnce(server: IMcpServer, status = 500, text = 'upstream exploded') {
    fetchMock.mockResolvedValueOnce(textResponse(text, status));
    await expect(executeMcpToolLocal(server, 'getProfile', { id: '1' })).rejects.toThrow();
    await tick();
  }

  it('writes an identical failure once within the window, and a different one again', async () => {
    const server = await openApiServer('Throttled');
    const db = await tenantDb();
    const spy = vi.spyOn(db, 'updateMcpServer');
    const lastErrorWrites = () => spy.mock.calls.filter(([, data]) => (data as { lastError?: unknown }).lastError).length;

    await failOnce(server);
    await failOnce(server);
    await failOnce(server);
    expect(lastErrorWrites()).toBe(1);

    await failOnce(server, 502, 'a different failure');
    expect(lastErrorWrites()).toBe(2);
    expect((await storedLastError(server))!.message).toContain('a different failure');
    spy.mockRestore();
  });

  it('writes every time when the window is 0', async () => {
    setMcpEnv('MCP_LAST_ERROR_THROTTLE_MS', '0');
    const server = await openApiServer('Not Throttled');
    const db = await tenantDb();
    const spy = vi.spyOn(db, 'updateMcpServer');
    await failOnce(server);
    await failOnce(server);
    expect(spy.mock.calls.filter(([, data]) => (data as { lastError?: unknown }).lastError).length).toBe(2);
    spy.mockRestore();
  });

  it('records the same failure again after a refresh cleared it', async () => {
    const server = await openApiServer('Cleared And Repeated');
    const db = await tenantDb();
    const spy = vi.spyOn(db, 'updateMcpServer');
    const lastErrorWrites = () => spy.mock.calls.filter(([, data]) => (data as { lastError?: unknown }).lastError).length;

    await failOnce(server);
    expect(lastErrorWrites()).toBe(1);

    await refreshMcpServerTools(TENANT_DB_NAME, String(server._id), USER_ID);
    expect(await storedLastError(server)).toBeNull();

    await failOnce(server);
    expect((await storedLastError(server))?.message).toContain('upstream exploded');
    spy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Request-log rows
// ═══════════════════════════════════════════════════════════════════════════

describe('logMcpRequest — what the caller chose is bounded', () => {
  const SESSION_ID = '3f2b8c1e-5d4a-4b7e-9c60-1a2b3c4d5e6f';
  let server: IMcpServer;

  beforeAll(async () => {
    server = await openApiServer('Log Bounds');
  });

  function entry(overrides: Record<string, unknown> = {}) {
    return {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      serverId: String(server._id),
      serverKey: server.key,
      toolName: 'getProfile',
      status: 'success' as const,
      requestPayload: { tool: 'getProfile', arguments: { id: '1' } },
      responsePayload: { ok: true },
      callerType: 'public' as const,
      transport: 'jsonrpc' as const,
      sourceType: 'openapi' as const,
      ...overrides,
    };
  }

  async function latestLog() {
    const rows = await listMcpRequestLogs(TENANT_DB_NAME, server, { limit: 1 });
    return rows[0];
  }

  // Rows are ordered by a millisecond timestamp: leave a gap so "the latest"
  // is the row just written.
  async function write(...args: Parameters<typeof logMcpRequest> extends [string, ...infer Rest] ? Rest : never) {
    await tick(4);
    await logMcpRequest(TENANT_DB_NAME, ...args);
  }

  it('returns the id of the row it wrote, which is what a caller can be given to quote', async () => {
    await tick(4);
    const id = await logMcpRequest(TENANT_DB_NAME, entry());
    expect(id).toBeTruthy();
    expect(id).toBe(String((await latestLog())._id));
  });

  it('caps the tool name at 200 characters by default', async () => {
    await write(entry({ toolName: 'n'.repeat(5_000) }));
    expect((await latestLog()).toolName).toHaveLength(200);
  });

  it('honours MCP_LOG_TOOL_NAME_MAX_CHARS', async () => {
    setMcpEnv('MCP_LOG_TOOL_NAME_MAX_CHARS', '32');
    await write(entry({ toolName: 'n'.repeat(500) }));
    expect((await latestLog()).toolName).toHaveLength(32);
  });

  it('keeps a session id this gateway issued, and drops any other', async () => {
    await write(entry({ sessionId: SESSION_ID }));
    expect((await latestLog()).sessionId).toBe(SESSION_ID);

    for (const sessionId of ['not-a-uuid', 'x'.repeat(10_000), `${SESSION_ID}-extra`, '../../etc/passwd', '']) {
      await write(entry({ sessionId }));
      expect((await latestLog()).sessionId ?? null, sessionId.slice(0, 20)).toBeNull();
    }
  });

  it('keeps the default payload cap, and takes a smaller one per call', async () => {
    const arguments_ = { blob: 'x'.repeat(5_000) };
    await write(entry({ requestPayload: { tool: 't', arguments: arguments_ } }));
    expect(((await latestLog()).requestPayload as { arguments: { blob: string } }).arguments.blob).toHaveLength(5_000);

    await write(
      entry({ requestPayload: { tool: 't', arguments: arguments_ }, responsePayload: { blob: 'y'.repeat(5_000) } }),
      undefined,
      { payloadLimitBytes: 1_000 },
    );
    const row = await latestLog();
    expect((row.requestPayload as Record<string, unknown>)._truncated).toBe(true);
    expect((row.responsePayload as Record<string, unknown>)._truncated).toBe(true);
    expect(JSON.stringify(row.requestPayload).length).toBeLessThan(1_000);
  });

  it('bounds the error text with the same per-call cap', async () => {
    await write(
      entry({ status: 'error', errorMessage: 'e'.repeat(6_000) }),
      undefined,
      { payloadLimitBytes: 500 },
    );
    expect((await latestLog()).errorMessage!.length).toBeLessThan(600);
  });

  it('stores who called next to the request, bounded and cleaned', async () => {
    await write(entry(), undefined, {
      client: { ip: '203.0.113.9', userAgent: `agent/1.0\r\nX-Extra: 1 ${'u'.repeat(1_000)}` },
    });
    const row = await latestLog();
    const client = (row.requestPayload as { _client: { ip: string; userAgent: string } })._client;
    expect(client.ip).toBe('203.0.113.9');
    expect(client.userAgent.length).toBeLessThanOrEqual(300);
    expect(client.userAgent).not.toMatch(/[\r\n]/);
    // The tool and arguments are still there.
    expect((row.requestPayload as { tool: string }).tool).toBe('getProfile');
  });

  it('honours MCP_LOG_USER_AGENT_MAX_CHARS', async () => {
    setMcpEnv('MCP_LOG_USER_AGENT_MAX_CHARS', '24');
    await write(entry(), undefined, { client: { userAgent: 'u'.repeat(500) } });
    const client = ((await latestLog()).requestPayload as { _client: { userAgent: string } })._client;
    expect(client.userAgent).toHaveLength(24);
  });

  it('keeps the caller identity even when the payload itself is replaced by a marker', async () => {
    await write(
      entry({ requestPayload: { tool: 't', arguments: { blob: 'x'.repeat(5_000) } } }),
      undefined,
      { payloadLimitBytes: 300, client: { ip: '198.51.100.7' } },
    );
    const payload = (await latestLog()).requestPayload as Record<string, unknown>;
    expect(payload._truncated).toBe(true);
    expect((payload._client as { ip: string }).ip).toBe('198.51.100.7');
  });

  it('adds nothing when no caller info is given', async () => {
    await write(entry());
    expect((await latestLog()).requestPayload).not.toHaveProperty('_client');
  });

  describe('the host\'s _meta', () => {
    const HOST_META = {
      progressToken: 'p-1',
      'openai/subject': 'v1/abc123',
      'openai/locale': 'en-US',
      'openai/userLocation': { city: 'Istanbul', latitude: 41.0082, longitude: 28.9784 },
      note: `a\r\nb ${'n'.repeat(1_000)}`,
    };

    async function storedClient() {
      return ((await latestLog()).requestPayload as { _client?: Record<string, unknown> })._client;
    }

    it('is stored sanitized as _client.meta, next to who called', async () => {
      await write(entry(), undefined, { client: { ip: '203.0.113.9', meta: HOST_META } });
      const client = (await storedClient())!;
      expect(client.ip).toBe('203.0.113.9');
      const meta = client.meta as Record<string, unknown>;
      expect(meta).not.toHaveProperty('progressToken');
      expect(meta['openai/subject']).toBe('v1/abc123');
      expect(meta['openai/userLocation']).toEqual({
        city: 'Istanbul',
        latitude: '[redacted]',
        longitude: '[redacted]',
      });
      expect(meta.note as string).not.toMatch(/[\r\n]/);
      expect((meta.note as string).length).toBeLessThanOrEqual(256);
    });

    it('is stored on its own when there is no address or user agent', async () => {
      await write(entry(), undefined, { client: { meta: { 'openai/session': 's-1' } } });
      expect(await storedClient()).toEqual({ meta: { 'openai/session': 's-1' } });
    });

    it('goes through the same scrub as the payload: sensitive keys and echoed secrets are masked', async () => {
      await write(entry(), ['sk-live-0123456789abcdef'], {
        client: { meta: { token: 'plain', ref: 'echo sk-live-0123456789abcdef', ok: 'kept' } },
      });
      const meta = (await storedClient())!.meta as Record<string, string>;
      expect(meta.token).not.toBe('plain');
      expect(meta.ref).not.toContain('sk-live-0123456789abcdef');
      expect(meta.ok).toBe('kept');
    });

    it('is omitted when it is not an object, or empty once cleaned', async () => {
      for (const meta of ['text', 5, [1], { progressToken: 'p-1' }]) {
        await write(entry(), undefined, { client: { meta } });
        expect((await latestLog()).requestPayload, JSON.stringify(meta)).not.toHaveProperty('_client');
      }
    });

    it('honours MCP_LOG_CLIENT_META_MAX_BYTES', async () => {
      setMcpEnv('MCP_LOG_CLIENT_META_MAX_BYTES', '300');
      const meta = Object.fromEntries(Array.from({ length: 20 }, (_v, i) => [`k${i}`, 'v'.repeat(60)]));
      await write(entry(), undefined, { client: { meta } });
      const stored = (await storedClient())!.meta as Record<string, unknown>;
      expect(stored._truncated).toBe(true);
      expect(JSON.stringify(stored).length).toBeLessThanOrEqual(300);
    });

    it('keeps MCP_LOG_CLIENT_META_MAX_BYTES after the scrub has masked short values', async () => {
      setMcpEnv('MCP_LOG_CLIENT_META_MAX_BYTES', '300');
      // Sensitive key names are matched whole, so vary the case to get distinct ones.
      const names = ['token', 'jwt', 'secret', 'password', 'cookie', 'bearer', 'pwd', 'passwd'];
      const meta = Object.fromEntries(
        names.flatMap((name) => [name, name.toUpperCase(), `${name[0].toUpperCase()}${name.slice(1)}`]).map((key) => [key, 'x']),
      );
      // Unmasked, all of it fits; masked, each value is 18 bytes.
      expect(Buffer.byteLength(JSON.stringify(meta), 'utf8')).toBeLessThan(300);
      await write(entry(), undefined, { client: { meta } });
      const stored = (await storedClient())!.meta as Record<string, unknown>;
      expect(stored._truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(stored), 'utf8')).toBeLessThanOrEqual(300);
    });

    it('is not stored at all when MCP_LOG_CLIENT_META is false', async () => {
      setMcpEnv('MCP_LOG_CLIENT_META', 'false');
      await write(entry(), undefined, { client: { ip: '203.0.113.9', meta: HOST_META } });
      const client = (await storedClient())!;
      expect(client.ip).toBe('203.0.113.9');
      expect(client).not.toHaveProperty('meta');

      await write(entry(), undefined, { client: { meta: HOST_META } });
      expect((await latestLog()).requestPayload).not.toHaveProperty('_client');
    });
  });

  it('writes the row, with who called, when an argument is nested too deeply to serialize', async () => {
    // Built in a loop; only the serialized result is ever inspected.
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 100_000; level += 1) deep = { a: deep };

    // Control: handed the structure itself, the store cannot write the row.
    const db = await tenantDb();
    const direct = await db
      .createMcpRequestLog({ ...entry(), requestPayload: { tool: 't', arguments: deep } })
      .then(() => 'written', (error: unknown) => (error instanceof RangeError ? 'rejected' : 'failed otherwise'));
    expect(direct).toBe('rejected');

    await tick(4);
    const id = await logMcpRequest(
      TENANT_DB_NAME,
      entry({ requestPayload: { tool: 't', arguments: deep }, responsePayload: { content: deep } }),
      undefined,
      { client: { ip: '198.51.100.7', userAgent: 'agent/1.0' } },
    );

    expect(id).toBeTruthy();
    const row = await latestLog();
    expect(String(row._id)).toBe(id);
    expect(row.toolName).toBe('getProfile');
    expect(row.callerType).toBe('public');
    // The top of the payload is kept; what lies below the stored depth is cut.
    expect(row.requestPayload).toMatchObject({
      tool: 't',
      _client: { ip: '198.51.100.7', userAgent: 'agent/1.0' },
    });
    expect(JSON.stringify(row.requestPayload)).toContain('[nested too deep]');
    expect(JSON.stringify(row.responsePayload)).toContain('[nested too deep]');
  });

  it('scrubs an argument made of repeated look-alike segments in bounded time, and caps the row as usual', async () => {
    // About 315 KB that never completes a data URL, in the shapes a request can carry.
    const segments = 'data:x/y;'.repeat(35_000);
    const started = performance.now();
    await write(
      entry({ requestPayload: { tool: 't', arguments: { query: segments, tail: `${segments};base64,!` } } }),
      undefined,
      { payloadLimitBytes: 16 * 1024, client: { ip: '198.51.100.7' } },
    );
    expect(performance.now() - started).toBeLessThan(3_000);

    const payload = (await latestLog()).requestPayload as Record<string, unknown>;
    expect(payload._truncated).toBe(true);
    expect((payload._client as { ip: string }).ip).toBe('198.51.100.7');
  });
});

describe('tool names stay addressable after the allow-list', () => {
  it('a rename done through updateMcpServer is callable under the new name', async () => {
    const server = await openApiServer('Rename Flow');
    const renamed = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolNames: { getProfile: 'fetch_profile' },
    });
    await executeMcpToolLocal(renamed!, 'fetch_profile', { id: '9' });
    expect(sentRequest().url).toBe('https://api.example.com/v1/users/9/profile');
  });
});
