/**
 * The Tools service's OpenAPI executor: where the arguments of an action call
 * may land in the upstream request. The same rules as for OpenAPI-sourced MCP
 * tools (`buildOpenApiRequest`): placeholders are filled in the action's path
 * template only, only declared arguments are sent, a path parameter cannot read
 * as a relative path segment, and the request stays on the configured origin.
 * `safeFetch` is replaced so every request is observable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock('@/lib/security/outboundFetch', () => ({
  safeFetch: hoisted.safeFetch,
  // The MCP client reads an answer through these; the responses here are plain
  // `Response` objects, so `text()` stands in for the capped reader.
  readResponseText: vi.fn(async (response: { text: () => Promise<string> }) => response.text()),
  ResponseTooLargeError: class ResponseTooLargeError extends Error {},
}));
// The tool service asks whether the tools service is on; with no database in a
// unit test that lookup would try to reach one on every call.
vi.mock('@/lib/services/availability/serviceAvailability', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/availability/serviceAvailability')>()),
  assertServiceEnabled: async () => undefined,
}));

import type { ITool, IToolAction } from '@/lib/database';
import { McpToolInputError } from '@/lib/services/mcp/errors';
import { resetSpecParameterCache } from '@/lib/services/mcp/openApiSpecParameters';
import { discoverMcpTools, executeToolAction, parseOpenApiToActions } from '@/lib/services/tools/toolService';

const BASE = 'https://api.example.com/v1';
const API_KEY = 'tool-api-key-123456';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Upstream', version: '1.0.0' },
  servers: [{ url: BASE }],
  components: {
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
  },
  paths: {
    '/users/{id}/profile': {
      parameters: [{ name: 'tenant', in: 'query', schema: { type: 'string' } }],
      get: {
        operationId: 'getProfile',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'expand', in: 'query', schema: { type: 'string' } },
          { $ref: '#/components/parameters/Limit' },
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

function buildTool(overrides: Partial<ITool> = {}): ITool {
  const parsed = parseOpenApiToActions(SPEC);
  return {
    _id: 'tool-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    key: 'upstream',
    name: 'Upstream',
    type: 'openapi',
    status: 'active',
    actions: parsed.actions,
    openApiSpec: parsed.normalizedSpec,
    upstreamBaseUrl: BASE,
    upstreamAuth: { type: 'header', headerName: 'X-Api-Key', headerValue: API_KEY },
    createdBy: 'user-1',
    updatedAt: new Date('2030-01-01T00:00:00Z'),
    ...overrides,
  } as ITool;
}

function actionKey(tool: ITool, name: string): string {
  const action = tool.actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`no action ${name}`);
  return action.key;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sent(call = 0) {
  const [url, init, options] = hoisted.safeFetch.mock.calls[call] as [
    string,
    RequestInit,
    { sensitiveHeaders?: string[] } | undefined,
  ];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body as string | undefined,
    sensitiveHeaders: options?.sensitiveHeaders,
  };
}

async function run(tool: ITool, name: string, args: Record<string, unknown>, runtimeHeaders?: Record<string, string>) {
  return executeToolAction(tool, actionKey(tool, name), args, runtimeHeaders);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSpecParameterCache();
  hoisted.safeFetch.mockImplementation(async () => jsonResponse({ ok: true }));
});

describe('OpenAPI tool actions — arguments land only where the action describes', () => {
  it('sends a normal call to the described operation with the stored credential', async () => {
    const tool = buildTool();
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({ id: '42' }));

    const { result } = await run(tool, 'getProfile', { id: '42', expand: 'orders' });

    expect(result).toEqual({ id: '42' });
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
    const request = sent();
    expect(request.url).toBe(`${BASE}/users/42/profile?expand=orders`);
    expect(request.method).toBe('GET');
    expect(request.headers['X-Api-Key']).toBe(API_KEY);
  });

  it.each([
    ['..'],
    ['.'],
    ['%2e%2e'],
    ['%2E%2E'],
    ['../x'],
    ['../../x'],
    ['a/../../b'],
    ['..\\x'],
    ['/..'],
  ])('refuses a path argument made of relative path segments: %j', async (id) => {
    await expect(run(buildTool(), 'getProfile', { id })).rejects.toThrow(McpToolInputError);
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('refuses relative segments spread over several parameters, for GET and DELETE actions', async () => {
    const tool = buildTool();
    for (const name of ['getItem', 'deleteItem']) {
      await expect(run(tool, name, { category: '..', id: 'admin' })).rejects.toThrow(McpToolInputError);
      await expect(run(tool, name, { category: 'books', id: '..' })).rejects.toThrow(McpToolInputError);
      await expect(run(tool, name, { category: '%2e%2e', id: 'x' })).rejects.toThrow(McpToolInputError);
    }
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('still serves a multi-parameter call, and encodes the values', async () => {
    const tool = buildTool();
    await run(tool, 'deleteItem', { category: 'books', id: 'a b/c' });
    const request = sent();
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe(`${BASE}/items/books/a%20b%2Fc`);
  });

  it('refuses a missing path parameter instead of sending the placeholder', async () => {
    const tool = buildTool();
    await expect(run(tool, 'getProfile', { expand: 'x' })).rejects.toThrow(/path parameter "id"/i);
    await expect(run(tool, 'getProfile', { id: '' })).rejects.toThrow(McpToolInputError);
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('treats arguments that are not an object as none', async () => {
    const tool = buildTool();
    for (const args of [null, 'text', 5, ['id']]) {
      await expect(run(tool, 'getProfile', args as never), JSON.stringify(args)).rejects.toThrow(McpToolInputError);
    }
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('drops arguments the action does not declare — they are not sent', async () => {
    const tool = buildTool();
    await run(tool, 'getProfile', { id: '42', expand: 'orders', role: 'admin', debug: '1', include_deleted: 'true' });
    const request = sent();
    expect(request.url).toBe(`${BASE}/users/42/profile?expand=orders`);
    expect(request.url).not.toMatch(/role|debug|include_deleted/);
  });

  it('forwards parameters the spec declares by reference or on the path item', async () => {
    const tool = buildTool();
    await run(tool, 'getProfile', { id: '42', limit: 5, tenant: 'acme', other: 'x' });
    expect(sent().url).toBe(`${BASE}/users/42/profile?limit=5&tenant=acme`);
  });

  it('forwards a request body only to an action that declares one', async () => {
    const tool = buildTool();
    await run(tool, 'createProject', { body: { name: 'Apollo' }, extra: 1 });
    expect(sent().method).toBe('POST');
    expect(JSON.parse(sent().body as string)).toEqual({ name: 'Apollo' });
    expect(sent().url).toBe(`${BASE}/projects`);

    hoisted.safeFetch.mockClear();
    await run(tool, 'listProjects', { body: { name: 'ignored' } });
    expect(sent().body).toBeUndefined();
  });

  it('never fills a placeholder in the stored base URL from an argument', async () => {
    const tool = buildTool({ upstreamBaseUrl: 'https://{region}.example.com/v1' });
    await expect(run(tool, 'getProfile', { id: '1', region: 'other' })).rejects.toThrow(/base url/i);
    expect(hoisted.safeFetch).not.toHaveBeenCalled();

    const bare = buildTool({ upstreamBaseUrl: '{host}' });
    await expect(run(bare, 'getProfile', { id: '1', host: 'https://elsewhere.example.net' })).rejects.toThrow(/base url/i);
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('reports a missing or unusable base URL as a configuration problem, not a bad argument', async () => {
    const missing = buildTool({ upstreamBaseUrl: undefined });
    await expect(run(missing, 'getProfile', { id: '1' })).rejects.toThrow(/no upstream base url/i);

    const broken = buildTool({ upstreamBaseUrl: 'not a url' });
    const error = await run(broken, 'getProfile', { id: '1' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(McpToolInputError);
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('reports an action without a path as a configuration problem', async () => {
    const tool = buildTool();
    const action = tool.actions[0] as IToolAction;
    tool.actions = [{ ...action, httpPath: undefined }];
    const error = await executeToolAction(tool, action.key, { id: '1' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no HTTP path/);
    expect(error).not.toBeInstanceOf(McpToolInputError);
  });

  it('keeps reporting an upstream failure with its status and text', async () => {
    const tool = buildTool();
    hoisted.safeFetch.mockResolvedValueOnce(new Response('no such user', { status: 404 }));
    await expect(run(tool, 'getProfile', { id: '9' })).rejects.toThrow('Upstream API error (404): no such user');
  });
});

describe('OpenAPI tool actions — credentials do not follow a redirect to another origin', () => {
  it('names the configured auth header and the runtime headers as sensitive', async () => {
    const tool = buildTool();
    await run(tool, 'getProfile', { id: '1' }, { 'x-caller-note': 'caller-note-value' });
    const request = sent();
    expect(request.headers['x-caller-note']).toBe('caller-note-value');
    expect(request.sensitiveHeaders).toEqual(['X-Api-Key', 'x-caller-note']);
  });

  it('names nothing for bearer and basic credentials, which travel in Authorization', async () => {
    const bearer = buildTool({ upstreamAuth: { type: 'token', token: 'bearer-token-123456' } });
    await run(bearer, 'getProfile', { id: '1' });
    expect(sent(0).headers.Authorization).toBe('Bearer bearer-token-123456');
    expect(sent(0).sensitiveHeaders).toEqual([]);

    const basic = buildTool({ upstreamAuth: { type: 'basic', username: 'ada', password: 'secret-pass-123' } });
    await run(basic, 'getProfile', { id: '1' });
    expect(sent(1).sensitiveHeaders).toEqual([]);
  });

  it('applies to the discovery of an MCP tool\'s actions too', async () => {
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({
      result: { tools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object', properties: {} } }] },
    }));

    const actions = await discoverMcpTools('https://mcp.example.com/rpc', 'streamable-http', {
      type: 'header',
      headerName: 'X-Api-Key',
      headerValue: API_KEY,
    });

    expect(actions.map((action) => action.name)).toEqual(['lookup']);
    expect(sent().headers['X-Api-Key']).toBe(API_KEY);
    expect(sent().sensitiveHeaders).toEqual(['X-Api-Key']);
  });

  it('applies to the actions of an MCP tool too', async () => {
    const tool = buildTool({
      type: 'mcp',
      mcpEndpoint: 'https://mcp.example.com/rpc',
      upstreamBaseUrl: undefined,
      actions: [{
        key: 'lookup',
        name: 'lookup',
        description: 'Look up',
        inputSchema: { type: 'object', properties: {} },
        executionType: 'mcp_call',
        mcpToolName: 'lookup',
      }],
    });
    hoisted.safeFetch.mockResolvedValueOnce(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'found' }] },
    }));

    const { result } = await executeToolAction(tool, 'lookup', { q: 'x' }, { 'x-caller-note': 'note-value' });

    expect(result).toBe('found');
    expect(sent().url).toBe('https://mcp.example.com/rpc');
    expect(sent().sensitiveHeaders).toEqual(['X-Api-Key', 'x-caller-note']);
  });
});
