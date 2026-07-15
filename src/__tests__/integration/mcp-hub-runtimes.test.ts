/**
 * Integration tests — MCP Hub runtimes.
 *
 * 1. Remote MCP proxy: spins a minimal JSON-RPC MCP server on localhost and
 *    drives discovery + tool calls through remoteMcpClient (with the SSRF
 *    guard relaxed for loopback).
 * 2. Stdio runner: launches a real npx MCP server package
 *    (@modelcontextprotocol/server-everything) and runs tools/list +
 *    tools/call end to end. Requires network/npm cache; generous timeout.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-hub-tests';

import { remoteCallTool, remoteListTools, buildUpstreamAuthHeaders } from '@/lib/services/mcp/remoteMcpClient';
import { stdioListTools, stdioCallTool, stdioRuntimeAvailable } from '@/lib/services/mcp/stdioRunner';

describe('remoteMcpClient against a local MCP server', () => {
  let server: Server;
  let url = '';
  let lastAuthHeader: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        lastAuthHeader = req.headers.authorization;
        const message = JSON.parse(body || '{}');
        const respond = (result: unknown) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        };
        if (message.method === 'initialize') {
          respond({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '0.0.1' } });
        } else if (message.method === 'tools/list') {
          respond({
            tools: [
              { name: 'echo', description: 'Echoes input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
            ],
          });
        } else if (message.method === 'tools/call') {
          const text = message.params?.arguments?.text ?? '';
          respond({ content: [{ type: 'text', text: `echo:${text}` }], isError: false });
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'object' && address) {
      url = `http://127.0.0.1:${address.port}/mcp`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('discovers tools over JSON-RPC', async () => {
    const tools = await remoteListTools({ url, transport: 'streamable-http' });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('echo');
    expect(tools[0].inputSchema).toMatchObject({ type: 'object' });
  });

  it('calls a tool and unwraps text content', async () => {
    const result = await remoteCallTool({ url }, 'echo', { text: 'merhaba' });
    expect(result).toBe('echo:merhaba');
  });

  it('injects upstream auth headers', async () => {
    await remoteListTools({
      url,
      auth: { type: 'token', token: 'tok-123' },
    });
    expect(lastAuthHeader).toBe('Bearer tok-123');

    const headers = buildUpstreamAuthHeaders({ type: 'basic', username: 'u', password: 'p' });
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });
});

describe('stdioRunner with a real npx MCP server', () => {
  it('probes runtime availability', async () => {
    const available = await stdioRuntimeAvailable('npx');
    expect(available).toBe(true);
  });

  it('lists and calls tools on @modelcontextprotocol/server-everything', async () => {
    const config = {
      runtime: 'npx' as const,
      packageName: '@modelcontextprotocol/server-everything',
      executionMode: 'subprocess' as const,
    };

    const tools = await stdioListTools(config);
    expect(tools.length).toBeGreaterThan(0);
    const echo = tools.find((t) => t.name === 'echo');
    expect(echo).toBeTruthy();

    const result = await stdioCallTool(config, 'echo', { message: 'selam' });
    expect(String(result)).toContain('selam');
  }, 180_000);
});
