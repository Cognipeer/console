/**
 * Tools whose credential belongs to a connector: the token comes, for each
 * call, from the resolver the Connectors module registers, and the call fails
 * closed without one. The upstream is a local MCP server that, like many
 * official remote servers, requires a session and answers over SSE.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ITool } from '@/lib/database';

process.env.OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK = 'false';

import { __resetToolCredentialResolverForTests, registerToolCredentialResolver } from '@/enterprise/tool-credentials';
import { createTool, executeToolAction, isManagedTool, serializeTool } from '@/lib/services/tools/toolService';
import { sealAuthConfig } from '@/lib/services/tools/secretVault';

const TOKEN = 'connector-token-for-tests';

interface Seen {
  method: string;
  auth?: string;
  session?: string;
  toolsets?: string;
  caller?: string;
}

const seen: Seen[] = [];
let server: Server;
let url = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body) as { id?: number; method: string };
      const session = req.headers['mcp-session-id'] as string | undefined;
      seen.push({
        method: rpc.method,
        auth: req.headers.authorization,
        session,
        toolsets: req.headers['x-mcp-toolsets'] as string | undefined,
        caller: req.headers['x-caller'] as string | undefined,
      });
      if (rpc.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }));
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      if (session !== 'session-1') {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: Mcp-Session-Id header is required');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const answer = { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'created #12' }] } };
      res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

beforeEach(() => { seen.length = 0; });

function managedTool(): ITool {
  return {
    _id: 'tool-1',
    projectId: 'p1',
    key: 'github-cognipeer',
    name: 'GitHub',
    type: 'mcp',
    status: 'active',
    mcpEndpoint: url,
    mcpTransport: 'streamable-http',
    upstreamAuth: { type: 'connector', connectorId: 'con-1' },
    actions: [{
      key: 'create_issue',
      name: 'create_issue',
      description: 'Create an issue',
      inputSchema: { type: 'object', properties: {} },
      executionType: 'mcp_call',
      mcpToolName: 'create_issue',
    }],
    createdBy: 'u1',
  } as unknown as ITool;
}

describe('connector-managed tools', () => {
  it('fail closed when the Connectors module has registered no resolver', async () => {
    // An enterprise build registers the Connectors resolver when its registry loads: this case is the build without one.
    __resetToolCredentialResolverForTests();
    await expect(executeToolAction(managedTool(), 'create_issue', {})).rejects.toThrow(
      'the Connectors module is not available',
    );
    expect(seen).toHaveLength(0);
  });

  it('call the upstream with the resolved credential and the owner headers, inside a session the server requires', async () => {
    registerToolCredentialResolver(async (tool) => {
      expect(tool.upstreamAuth?.connectorId).toBe('con-1');
      return { auth: { type: 'token', token: TOKEN }, headers: { 'X-MCP-Toolsets': 'repos,issues' } };
    });
    const secrets: string[] = [];

    const out = await executeToolAction(managedTool(), 'create_issue', { title: 'Bug' }, { 'X-Caller': 'agent' }, {
      onSecrets: (values) => secrets.push(...values),
    });

    expect(out.result).toBe('created #12');
    expect(secrets).toEqual([TOKEN]);
    expect(seen.map((s) => s.method)).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
    for (const request of seen) {
      expect(request.auth).toBe(`Bearer ${TOKEN}`);
      expect(request.toolsets).toBe('repos,issues');
      expect(request.caller).toBe('agent');
    }
    expect(seen[3].session).toBe('session-1');
  });

  it('open the session first once the upstream is known to require one', async () => {
    const out = await executeToolAction(managedTool(), 'create_issue', {});
    expect(out.result).toBe('created #12');
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  });

  it('refuse a resolver answer that carries no credential', async () => {
    registerToolCredentialResolver(async () => ({ auth: { type: 'connector', connectorId: 'con-1' } }));
    await expect(executeToolAction(managedTool(), 'create_issue', {})).rejects.toThrow('did not supply a credential');
    expect(seen).toHaveLength(0);
  });

  it('keep the connector id when stored and show who manages them', () => {
    expect(sealAuthConfig({ type: 'connector', connectorId: 'con-1' })).toEqual({ type: 'connector', connectorId: 'con-1' });
    expect(isManagedTool(managedTool())).toBe(true);
    expect(serializeTool(managedTool()).managedBy).toEqual({ kind: 'connector', id: 'con-1' });
  });

  it('cannot be created through the Tools API path', async () => {
    await expect(createTool('tenant_db', 't1', 'u1', 'p1', {
      name: 'Borrowed credential',
      type: 'mcp',
      mcpEndpoint: url,
      upstreamAuth: { type: 'connector', connectorId: 'con-1' },
    } as never)).rejects.toThrow('can only be set by the Connectors module');
    expect(seen).toHaveLength(0);
  });
});
