/**
 * A Tools-module MCP tool speaks to its server through the shared MCP client:
 * it says it accepts a streamed answer (servers that require it refused the
 * plain `application/json` request with 406), reads that stream, and follows
 * every `tools/list` page.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));

import type { ITool } from '@/lib/database';
import { discoverMcpTools, executeToolAction } from '@/lib/services/tools/toolService';

function sse(...messages: unknown[]): Response {
  const body = messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function json(message: unknown): Response {
  return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sentBody(call: number): { id: number; method: string; params?: { cursor?: string } } {
  return JSON.parse((hoisted.safeFetch.mock.calls[call]![1] as RequestInit).body as string);
}

beforeEach(() => vi.clearAllMocks());

describe('Tools-module MCP transport', () => {
  it('reads a streamed tools/list answer and follows its pages', async () => {
    hoisted.safeFetch
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        const { id } = JSON.parse(init.body as string);
        return sse(
          { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } },
          { jsonrpc: '2.0', id, result: { tools: [{ name: 'lookup' }], nextCursor: 'p2' } },
        );
      })
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        const { id } = JSON.parse(init.body as string);
        return json({ jsonrpc: '2.0', id, result: { tools: [{ name: 'create', description: 'Create one' }] } });
      });

    const actions = await discoverMcpTools('https://mcp.example.com/mcp', 'streamable-http');

    expect(actions.map((action) => [action.name, action.description])).toEqual([['lookup', 'lookup'], ['create', 'Create one']]);
    expect(sentBody(1).params).toEqual({ cursor: 'p2' });
    const headers = (hoisted.safeFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json, text/event-stream');
  });

  it('reads a streamed tools/call answer', async () => {
    hoisted.safeFetch.mockImplementationOnce(async (_url, init: RequestInit) => {
      const { id } = JSON.parse(init.body as string);
      return sse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'found 2' }] } });
    });
    const tool = {
      key: 'mcp-tool',
      name: 'MCP tool',
      type: 'mcp',
      mcpEndpoint: 'https://mcp.example.com/mcp',
      actions: [{ key: 'lookup', name: 'lookup', executionType: 'mcp_call', mcpToolName: 'lookup' }],
    } as unknown as ITool;

    const out = await executeToolAction(tool, 'lookup', { q: 'x' });

    expect(out.result).toBe('found 2');
    expect(sentBody(0)).toMatchObject({ method: 'tools/call', params: { name: 'lookup', arguments: { q: 'x' } } });
  });
});
