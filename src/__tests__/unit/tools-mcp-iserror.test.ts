import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));

import type { ITool } from '@/lib/database';
import { executeToolAction } from '@/lib/services/tools/toolService';

const tool = {
  key: 'mcp-tool',
  name: 'MCP tool',
  type: 'mcp',
  mcpEndpoint: 'https://mcp.example.com/mcp',
  actions: [{ key: 'do', name: 'do', executionType: 'mcp_call', mcpToolName: 'do' }],
} as unknown as ITool;

const reply = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });

beforeEach(() => vi.clearAllMocks());

describe('MCP tool results flagged isError', () => {
  it('are reported as errors and keep the text for the model', async () => {
    hoisted.safeFetch.mockResolvedValue(reply({ isError: true, content: [{ type: 'text', text: 'ticket not found' }] }));
    const out = await executeToolAction(tool, 'do', {});
    expect(out.isError).toBe(true);
    expect(out.result).toBe('ticket not found');
  });

  it('a normal result carries no isError', async () => {
    hoisted.safeFetch.mockResolvedValue(reply({ content: [{ type: 'text', text: 'ok' }] }));
    const out = await executeToolAction(tool, 'do', {});
    expect(out.isError).toBeUndefined();
  });
});
