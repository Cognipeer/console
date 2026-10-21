/**
 * The token-authenticated MCP routes (/api/client/v1/mcp/...): what a message
 * body may be, how a rejected call is reported next to a failed one, and that a
 * token caller still sees the detail of a failure — with secret values masked.
 */

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
  updateMcpServer: vi.fn(),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase, type IMcpServer } from '@/lib/database';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { executeMcpTool, getMcpServerByKey, logMcpRequest, McpServerConfigError, McpToolInputError, McpUnknownToolError, McpUpstreamError, updateMcpServer } from '@/lib/services/mcp';
import { clientMcpApiPlugin } from '@/server/api/plugins/client-mcp';
import { clientMcpConsoleApiPlugin } from '@/server/api/plugins/client-mcp-console';
import { createMockDb } from '../helpers/db.mock';
import { buildMcpTestApp } from '../helpers/mcp-http';

const originalSource = getConfigSource();
const SECRET = 'sk-live-0123456789abcdef';

const plugins: FastifyPluginAsync = async (app) => {
  await app.register(clientMcpConsoleApiPlugin);
  await app.register(clientMcpApiPlugin);
};

function server(): IMcpServer {
  return {
    _id: 'srv-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'crm',
    name: 'CRM',
    status: 'active',
    sourceType: 'stdio',
    stdioConfig: { runtime: 'npx', packageName: 'crm-mcp', executionMode: 'subprocess', env: { CRM_API_KEY: SECRET } },
    exposure: { protocols: ['streamable-http', 'sse'], accessMode: 'token' },
    tools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object', properties: {} } }],
  } as unknown as IMcpServer;
}

interface Rpc {
  error?: { code: number; message: string };
  result?: { isError?: boolean; content?: Array<{ text: string }> };
}

describe('token MCP routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetAllMocks();
    setConfigSource({ name: 'test', get: () => undefined });
    const db = createMockDb();
    vi.mocked(getDatabase).mockResolvedValue(db as never);
    vi.mocked(requireApiTokenFromHeader).mockResolvedValue({
      token: 'raw',
      tokenRecord: { _id: 'tok-1', userId: 'user-1', servicePermissions: null },
      tenant: { licenseType: 'ENTERPRISE' },
      tenantId: 'tenant-1',
      tenantSlug: 'acme',
      tenantDbName: 'tenant_acme',
      projectId: 'proj-1',
      user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
    } as never);
    vi.mocked(getMcpServerByKey).mockResolvedValue(server());
    vi.mocked(executeMcpTool).mockResolvedValue({ result: { found: 1 }, latencyMs: 4 });
    app = await buildMcpTestApp(plugins);
  });

  afterEach(async () => {
    await app.close();
    setConfigSource(originalSource);
  });

  const headers = { authorization: 'Bearer raw', 'content-type': 'application/json' };
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const callTool = (name = 'lookup') => ({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: {} } });

  describe.each([
    ['an ordinary server', '/api/client/v1/mcp/crm/message'],
    ['the console server', '/api/client/v1/mcp/console/message'],
  ])('the message endpoint of %s', (_label, url) => {
    it.each([
      ['null', 'null'],
      ['an array', '[]'],
      ['a number', '5'],
      ['a string', '"hello"'],
    ])('answers a body that is %s with 400 and -32600, not 500', async (_name, body) => {
      const response = await post(url, body);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toEqual({ code: -32600, message: 'Invalid Request' });
    });

    it('answers text that is not JSON with 400 and -32700', async () => {
      const response = await post(url, '{');
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe(-32700);
    });

    it('answers a request without a usable method with 400 and -32600', async () => {
      for (const body of [{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, method: { a: 1 } }]) {
        const response = await post(url, body);
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).error.code).toBe(-32600);
      }
    });

    it('answers a message that names an unknown session with 404, not with an inline result', async () => {
      const response = await post(`${url}?sessionId=00000000-0000-4000-8000-000000000001`, { jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toEqual({ code: -32001, message: 'Session not found' });
    });

    it('does not echo a long method name back', async () => {
      const response = await post(url, { jsonrpc: '2.0', id: 1, method: 'm'.repeat(5000) });
      expect(JSON.parse(response.body).error.message.length).toBeLessThan(200);
    });
  });

  describe('instructions', () => {
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

    it('carries the operator\'s text over the one the source supplied', async () => {
      vi.mocked(getMcpServerByKey).mockResolvedValue({
        ...server(),
        metadata: { instructions: 'Operator text', discoveredInstructions: 'Upstream text' },
      } as IMcpServer);
      const body = JSON.parse((await post('/api/client/v1/mcp/crm/message', initialize)).body);
      expect(body.result.instructions).toBe('Operator text');
    });

    it('falls back to the source\'s text, and leaves the field out when there is none', async () => {
      vi.mocked(getMcpServerByKey).mockResolvedValueOnce({
        ...server(),
        metadata: { discoveredInstructions: 'Upstream text' },
      } as IMcpServer);
      const withSource = JSON.parse((await post('/api/client/v1/mcp/crm/message', initialize)).body);
      expect(withSource.result.instructions).toBe('Upstream text');

      const without = JSON.parse((await post('/api/client/v1/mcp/crm/message', initialize)).body);
      expect(without.result).not.toHaveProperty('instructions');
    });

    it('answers initialize in the revision the client asked for when it is one we speak', async () => {
      for (const url of ['/api/client/v1/mcp/crm/message', '/api/client/v1/mcp/console/message']) {
        const asked = JSON.parse((await post(url, { ...initialize, params: { protocolVersion: '2025-06-18' } })).body);
        expect(asked.result.protocolVersion).toBe('2025-06-18');
        const unknown = JSON.parse((await post(url, { ...initialize, params: { protocolVersion: '2099-01-01' } })).body);
        expect(unknown.result.protocolVersion).toBe('2025-11-25');
      }
    });

    it('gives the console server its own text', async () => {
      const body = JSON.parse((await post('/api/client/v1/mcp/console/message', initialize)).body);
      expect(body.result.instructions).toContain('get_session');
    });

    it('turns down instructions that are not text, or too long, with 400', async () => {
      for (const instructions of [42, 'x'.repeat(8001)]) {
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/client/v1/mcp/crm',
          headers,
          payload: JSON.stringify({ instructions }),
        });
        expect(response.statusCode).toBe(400);
      }
      expect(updateMcpServer).not.toHaveBeenCalled();
    });
  });

  describe('updating a server', () => {
    it('answers settings the server cannot take with 400, not 500', async () => {
      vi.mocked(updateMcpServer).mockRejectedValue(new McpServerConfigError('Console identity is available for remote MCP and OpenAPI servers only'));
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/client/v1/mcp/crm',
        headers,
        payload: JSON.stringify({ upstreamAuth: { type: 'console_identity' } }),
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe('Console identity is available for remote MCP and OpenAPI servers only');
    });
  });

  describe('the REST execute endpoints', () => {
    it.each([
      ['an ordinary server', '/api/client/v1/mcp/crm/execute'],
      ['the console server', '/api/client/v1/mcp/console/execute'],
    ])('answer a body that is not a JSON object on %s with 400', async (_label, url) => {
      for (const body of ['null', '[]', '7', '"x"', '{', '']) {
        const response = await post(url, body);
        expect(response.statusCode, body).toBe(400);
        expect(JSON.parse(response.body).error, body).toBe('A JSON object body is required');
      }
    });

    it('report a rejected call as a bad request and a failed one as a bad gateway', async () => {
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new McpToolInputError('Unknown tool'));
      const rejected = await post('/api/client/v1/mcp/crm/execute', { tool: 'nope', arguments: {} });
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body)).toEqual({ error: 'Unknown tool' });

      vi.mocked(executeMcpTool).mockRejectedValueOnce(new McpUpstreamError('Upstream API error (500): crm is down', 500));
      const failed = await post('/api/client/v1/mcp/crm/execute', { tool: 'lookup', arguments: {} });
      expect(failed.statusCode).toBe(502);
      expect(JSON.parse(failed.body)).toEqual({ error: 'Upstream API error (500): crm is down' });
    });

    it('keep the server-wide body limit, which the public endpoints\' smaller one does not apply to', async () => {
      const response = await post('/api/client/v1/mcp/crm/execute', {
        tool: 'lookup',
        arguments: { text: 'x'.repeat(2 * 1024 * 1024) },
      });
      expect(response.statusCode).toBe(200);
    });

    it('still answer a successful call', async () => {
      const response = await post('/api/client/v1/mcp/crm/execute', { tool: 'lookup', arguments: { id: 1 } });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).result).toEqual({ found: 1 });
    });
  });

  describe('a failed call, as the token caller sees it', () => {
    it('keeps the detail of the failure', async () => {
      vi.mocked(executeMcpTool).mockRejectedValueOnce(
        new McpUpstreamError('Upstream API error (404): {"detail":"customer 42 not found"}', 404),
      );
      const response = await post('/api/client/v1/mcp/crm/message', callTool());
      const body = JSON.parse(response.body) as Rpc;
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0].text).toBe('Upstream API error (404): {"detail":"customer 42 not found"}');
    });

    it('masks the values the server holds, even in an error that did not pass through an executor', async () => {
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error(`login rejected for key ${SECRET}`));
      const rpc = JSON.parse((await post('/api/client/v1/mcp/crm/message', callTool())).body) as Rpc;
      expect(rpc.result?.content?.[0].text).toBe('login rejected for key [REDACTED]');

      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error(`login rejected for key ${SECRET}`));
      const rest = await post('/api/client/v1/mcp/crm/execute', { tool: 'lookup' });
      expect(JSON.parse(rest.body).error).toBe('login rejected for key [REDACTED]');
    });

    it('bounds the message to MCP_ERROR_MESSAGE_MAX_CHARS', async () => {
      setConfigSource({ name: 'test', get: (key) => (key === 'MCP_ERROR_MESSAGE_MAX_CHARS' ? '300' : undefined) });
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error(`${SECRET} ${'z'.repeat(5000)}`));
      const rpc = JSON.parse((await post('/api/client/v1/mcp/crm/message', callTool())).body) as Rpc;
      const text = rpc.result?.content?.[0].text ?? '';
      expect(text.length).toBeLessThanOrEqual(300);
      expect(text).not.toContain(SECRET);
    });

    it('reports an unknown tool as invalid params (-32602), not as a failed call', async () => {
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new McpUnknownToolError());
      const response = await post('/api/client/v1/mcp/crm/message', callTool('nope'));
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as Rpc & { id: number };
      expect(body.error).toEqual({ code: -32602, message: 'Unknown tool' });
      expect(body.id).toBe(9);
    });

    it('returns a bad argument as a tool result with isError, so the model can correct it', async () => {
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new McpToolInputError('Missing required path parameter "id"'));
      const body = JSON.parse((await post('/api/client/v1/mcp/crm/message', callTool())).body) as Rpc;
      expect(body.error).toBeUndefined();
      expect(body.result).toEqual({
        content: [{ type: 'text', text: 'Missing required path parameter "id"' }],
        isError: true,
      });
    });

    it('logs the failure with its full text', async () => {
      vi.mocked(executeMcpTool).mockRejectedValueOnce(new Error('boom: details'));
      await post('/api/client/v1/mcp/crm/message', callTool());
      const [, entry] = vi.mocked(logMcpRequest).mock.calls[0];
      expect(entry).toMatchObject({ status: 'error', errorMessage: 'boom: details', callerType: 'api' });
    });
  });

  describe('media tool results', () => {
    const image = {
      kind: 'tool_output',
      content: [
        { type: 'text', text: 'shot' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'audio', mimeType: 'audio/wav', data: 'BBBB' },
      ],
    };

    it('sends a ToolOutput as native MCP image and audio blocks', async () => {
      vi.mocked(executeMcpTool).mockResolvedValue({ result: image, latencyMs: 4 } as never);
      const response = await post('/api/client/v1/mcp/crm/message', callTool());
      const content = JSON.parse(response.body).result.content;
      expect(content).toEqual([
        { type: 'text', text: 'shot' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'audio', data: 'BBBB', mimeType: 'audio/wav' },
      ]);
    });

    it('hands a structured result its JSON object only when the client speaks 2025-06-18 or later', async () => {
      const structured = { kind: 'tool_output', content: [{ type: 'text', text: '1 found' }], structuredContent: { found: 1 } };
      vi.mocked(executeMcpTool).mockResolvedValue({ result: structured, latencyMs: 4 } as never);

      const legacy = JSON.parse((await post('/api/client/v1/mcp/crm/message', callTool())).body).result;
      expect(legacy).toEqual({ content: [{ type: 'text', text: '1 found' }] });

      const current = JSON.parse((await app.inject({
        method: 'POST',
        url: '/api/client/v1/mcp/crm/message',
        headers: { ...headers, 'mcp-protocol-version': '2025-06-18' },
        payload: JSON.stringify(callTool()),
      })).body).result;
      expect(current).toEqual({ content: [{ type: 'text', text: '1 found' }], structuredContent: { found: 1 } });

      // REST callers keep getting the object, as they always did for a structured result.
      const rest = await app.inject({
        method: 'POST',
        url: '/api/client/v1/mcp/crm/execute',
        headers,
        payload: JSON.stringify({ tool: 'lookup', arguments: {} }),
      });
      expect(JSON.parse(rest.body).result).toEqual({ found: 1 });
    });

    it('keeps a text-only result as one text block', async () => {
      const response = await post('/api/client/v1/mcp/crm/message', callTool());
      const result = JSON.parse(response.body).result as Rpc['result'];
      expect(result?.content).toEqual([{ type: 'text', text: '{"found":1}' }]);
      expect(result?.isError).toBe(false);
    });
  });
});
