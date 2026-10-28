/**
 * Bounds on what an MCP upstream (OpenAPI server or remote MCP server) can
 * make us read: a body larger than `mcp.upstream.maxResponseBytes` and a call
 * that takes longer than `mcp.upstream.timeoutMs` both fail the call.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK = 'false';
process.env.MCP_UPSTREAM_MAX_RESPONSE_BYTES = String(64 * 1024);
process.env.MCP_UPSTREAM_TIMEOUT_MS = '1000';

import { readResponseText, ResponseTooLargeError } from '@/lib/security/outboundFetch';
import { remoteCallTool } from '@/lib/services/mcp/remoteMcpClient';
import { executeOpenApiTool } from '@/lib/services/mcp/mcpService';
import { isMcpUpstreamError } from '@/lib/services/mcp/errors';
import type { IMcpServer } from '@/lib/database';

const CAP = 64 * 1024;

function streamOf(chunks: Uint8Array[], onCancel?: () => void): Response {
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() { onCancel?.(); },
  }));
}

describe('readResponseText', () => {
  it('returns a body under the cap', async () => {
    const enc = new TextEncoder();
    const text = await readResponseText(streamOf([enc.encode('héllo '), enc.encode('world')]), { maxBytes: 100 });
    expect(text).toBe('héllo world');
  });

  it('returns an empty string for a null body', async () => {
    expect(await readResponseText(new Response(null, { status: 204 }), { maxBytes: 10 })).toBe('');
  });

  it('throws and cancels the reader when the cap is exceeded', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(40);
    const res = streamOf([chunk, chunk, chunk], () => { cancelled = true; });
    await expect(readResponseText(res, { maxBytes: 100 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
  });

  it('rejects when the signal aborts a body that never ends', async () => {
    let cancelled = false;
    const res = new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    }));
    const controller = new AbortController();
    const pending = readResponseText(res, { maxBytes: 100, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop')), 20);
    await expect(pending).rejects.toThrow('stop');
    expect(cancelled).toBe(true);
  });
});

describe('upstream limits end to end', () => {
  let server: Server;
  let base = '';
  let mode = 'ok';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (mode === 'big-json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ blob: 'x'.repeat(CAP * 2) }));
      } else if (mode === 'big-sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${'x'.repeat(CAP * 2)}`); // no event boundary yet
      } else if (mode === 'drip') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"jsonrpc":"2.0",');
        const t = setInterval(() => res.write(' '), 100);
        res.on('close', () => clearInterval(t));
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });

  const openApi = () => ({
    upstreamBaseUrl: base,
    tools: [{ name: 't', httpPath: '/x', httpMethod: 'GET', inputSchema: { type: 'object', properties: {} } }],
  }) as unknown as IMcpServer;

  it('OpenAPI: a response over the cap fails as an upstream error', async () => {
    mode = 'big-json';
    const err = await executeOpenApiTool(openApi(), 't', {}).then(() => new Error('did not fail'), (e: unknown) => e as Error);
    expect(isMcpUpstreamError(err)).toBe(true);
    expect(err.message).toBe(`Upstream response exceeded ${CAP} bytes`);
  });

  it('OpenAPI: a body that drips past the total timeout fails as an upstream error', async () => {
    mode = 'drip';
    const err = await executeOpenApiTool(openApi(), 't', {}).then(() => new Error('did not fail'), (e: unknown) => e as Error);
    expect(isMcpUpstreamError(err)).toBe(true);
    expect(err.message).toBe('Upstream did not answer within 1000 ms');
  });

  it('remote MCP: JSON body over the cap fails', async () => {
    mode = 'big-json';
    const err = await remoteCallTool({ url: base }, 'x', {}).then(() => new Error('did not fail'), (e: unknown) => e as Error);
    expect(isMcpUpstreamError(err)).toBe(true);
    expect(err.message).toBe(`Upstream response exceeded ${CAP} bytes`);
  });

  it('remote MCP: an SSE event that never ends stops at the cap', async () => {
    mode = 'big-sse';
    const err = await remoteCallTool({ url: base }, 'x', {}).then(() => new Error('did not fail'), (e: unknown) => e as Error);
    expect(isMcpUpstreamError(err)).toBe(true);
    expect(err.message).toBe(`Upstream response exceeded ${CAP} bytes`);
  });

  it('remote MCP: a slow body hits the total timeout', async () => {
    mode = 'drip';
    const err = await remoteCallTool({ url: base }, 'x', {}).then(() => new Error('did not fail'), (e: unknown) => e as Error);
    expect(isMcpUpstreamError(err)).toBe(true);
    expect(err.message).toBe('Upstream did not answer within 1000 ms');
  });

  it('a normal response still works', async () => {
    mode = 'ok';
    await expect(remoteCallTool({ url: base }, 'x', {})).resolves.toBeTruthy();
  });
});
