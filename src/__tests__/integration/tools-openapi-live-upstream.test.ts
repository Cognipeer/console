/**
 * Integration test — a Tools-service OpenAPI action calling a real HTTP
 * upstream (loopback sockets on OS-assigned ports; the SSRF guard is switched
 * off for the test, as a self-hosted deployment would for an in-network host).
 *
 * The unit test stubs `safeFetch`; this one checks the same behaviour on the
 * wire: what the upstream receives for a normal call, for arguments that are
 * refused or dropped, and for a redirect to another origin.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK = 'false';

// The tool service asks whether the tools service is on; there is no database here to read a license from.
vi.mock('@/lib/services/availability/serviceAvailability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/availability/serviceAvailability')>()),
  assertServiceEnabled: async () => undefined,
}));

import { reloadConfig } from '@/lib/core/config';
import type { ITool } from '@/lib/database';
import { McpToolInputError } from '@/lib/services/mcp/errors';
import { executeToolAction, parseOpenApiToActions } from '@/lib/services/tools/toolService';

const API_KEY = 'live-tool-api-key-5150';

interface Seen {
  method: string;
  url: string;
  apiKey: string | undefined;
  runtimeHeader: string | undefined;
}

let primary: Server;
let secondary: Server;
let primaryBase: string;
let secondaryBase: string;
const seenByPrimary: Seen[] = [];
const seenBySecondary: Seen[] = [];

function record(into: Seen[], request: IncomingMessage) {
  into.push({
    method: request.method ?? '',
    url: request.url ?? '',
    apiKey: request.headers['x-api-key'] as string | undefined,
    runtimeHeader: request.headers['x-caller-note'] as string | undefined,
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

const SPEC = (baseUrl: string) => JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Upstream', version: '1.0.0' },
  servers: [{ url: `${baseUrl}/v1` }],
  paths: {
    '/users/{id}/profile': {
      get: {
        operationId: 'getProfile',
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
    },
    '/moved': { get: { operationId: 'getMoved' } },
  },
});

beforeAll(async () => {
  reloadConfig();

  secondary = createServer((request, response) => {
    record(seenBySecondary, request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ server: 'secondary', jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'moved-ok' }] } }));
  });
  secondaryBase = await listen(secondary);

  primary = createServer((request, response) => {
    record(seenByPrimary, request);
    if (request.url?.startsWith('/v1/moved') || request.url === '/rpc') {
      response.statusCode = 302;
      response.setHeader('location', `${secondaryBase}/landing`);
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ server: 'primary', url: request.url }));
  });
  primaryBase = await listen(primary);
});

afterAll(async () => {
  await new Promise((resolve) => primary.close(resolve));
  await new Promise((resolve) => secondary.close(resolve));
  delete process.env.OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK;
  reloadConfig();
});

beforeEach(() => {
  seenByPrimary.length = 0;
  seenBySecondary.length = 0;
});

function openApiTool(): ITool {
  const parsed = parseOpenApiToActions(SPEC(primaryBase));
  return {
    _id: 'tool-live',
    tenantId: 'tenant-live',
    key: 'live-upstream',
    name: 'Live Upstream',
    type: 'openapi',
    status: 'active',
    actions: parsed.actions,
    openApiSpec: parsed.normalizedSpec,
    upstreamBaseUrl: `${primaryBase}/v1`,
    upstreamAuth: { type: 'header', headerName: 'X-Api-Key', headerValue: API_KEY },
    createdBy: 'user-1',
    updatedAt: new Date('2030-01-01T00:00:00Z'),
  } as ITool;
}

const keyOf = (tool: ITool, name: string) => tool.actions.find((action) => action.name === name)!.key;

describe('OpenAPI tool action against a live upstream', () => {
  it('sends a normal call to the described operation, with the stored key', async () => {
    const tool = openApiTool();
    const { result } = await executeToolAction(tool, keyOf(tool, 'getProfile'), { id: '42', limit: 5, ignored: 'x' });

    expect(result).toEqual({ server: 'primary', url: '/v1/users/42/profile?limit=5' });
    expect(seenByPrimary).toEqual([
      { method: 'GET', url: '/v1/users/42/profile?limit=5', apiKey: API_KEY, runtimeHeader: undefined },
    ]);
  });

  it('puts nothing on the wire for a path argument made of relative segments', async () => {
    const tool = openApiTool();
    for (const id of ['..', '.', '../../x', '%2e%2e', 'a/../../b']) {
      await expect(executeToolAction(tool, keyOf(tool, 'getProfile'), { id }), id).rejects.toThrow(McpToolInputError);
    }
    await expect(executeToolAction(tool, keyOf(tool, 'getProfile'), {})).rejects.toThrow(McpToolInputError);
    for (const [category, id] of [['..', 'admin'], ['books', '..'], ['%2e%2e', 'admin']]) {
      await expect(executeToolAction(tool, keyOf(tool, 'getItem'), { category, id }), `${category}/${id}`).rejects.toThrow(McpToolInputError);
    }
    expect(seenByPrimary).toEqual([]);
  });

  it('percent-encodes a value that contains separators and keeps it inside the operation', async () => {
    const tool = openApiTool();
    await executeToolAction(tool, keyOf(tool, 'getProfile'), { id: 'a/b c' });
    expect(seenByPrimary.map((seen) => seen.url)).toEqual(['/v1/users/a%2Fb%20c/profile']);
  });

  it('does not send an argument the action does not declare', async () => {
    const tool = openApiTool();
    await executeToolAction(tool, keyOf(tool, 'getProfile'), { id: '7', role: 'admin', debug: '1' });
    expect(seenByPrimary.map((seen) => seen.url)).toEqual(['/v1/users/7/profile']);
  });

  it('drops the configured key and the runtime header when the upstream redirects to another origin', async () => {
    const tool = openApiTool();
    const { result } = await executeToolAction(tool, keyOf(tool, 'getMoved'), {}, { 'x-caller-note': 'caller-note-value' });

    expect((result as { server: string }).server).toBe('secondary');
    expect(seenByPrimary).toEqual([
      { method: 'GET', url: '/v1/moved', apiKey: API_KEY, runtimeHeader: 'caller-note-value' },
    ]);
    expect(seenBySecondary).toEqual([
      { method: 'GET', url: '/landing', apiKey: undefined, runtimeHeader: undefined },
    ]);
  });

  it('does the same for the actions of an MCP tool', async () => {
    const tool = {
      ...openApiTool(),
      type: 'mcp',
      mcpEndpoint: `${primaryBase}/rpc`,
      actions: [{
        key: 'lookup',
        name: 'lookup',
        description: 'Look up',
        inputSchema: { type: 'object', properties: {} },
        executionType: 'mcp_call',
        mcpToolName: 'lookup',
      }],
    } as ITool;

    await executeToolAction(tool, 'lookup', {}, { 'x-caller-note': 'caller-note-value' });

    expect(seenByPrimary).toEqual([
      { method: 'POST', url: '/rpc', apiKey: API_KEY, runtimeHeader: 'caller-note-value' },
    ]);
    // The redirect is followed with the body dropped (POST -> GET); what matters here is the headers.
    expect(seenBySecondary.map((seen) => ({ apiKey: seen.apiKey, runtimeHeader: seen.runtimeHeader }))).toEqual([
      { apiKey: undefined, runtimeHeader: undefined },
    ]);
  });
});
