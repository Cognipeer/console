/**
 * MCP tool results that carry images: a stdio server (a real child process),
 * a remote server and a plain-HTTP MCP tool all hand the caller a ToolOutput
 * with the image intact, while text-only results keep their legacy shape.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMcpStdioConfig } from '@/lib/database';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const state = vi.hoisted(() => ({ script: '', fetchBody: null as unknown }));

// The runner always launches `npx <package>`; run our tiny server script with this node instead.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_cmd: string, _args: string[], options: Record<string, unknown>) =>
      actual.spawn(process.execPath, [state.script], options as never),
  };
});

vi.mock('@/lib/security/outboundFetch', () => ({
  safeFetch: vi.fn(async () => new Response(JSON.stringify(state.fetchBody), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })),
}));

const SERVER_JS = `
const rl = require('readline').createInterface({ input: process.stdin });
const mode = process.env.MEDIA_MODE;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result = {};
  if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '1' } };
  if (msg.method === 'tools/call') {
    result = mode === 'image'
      ? { content: [{ type: 'text', text: 'here' }, { type: 'image', data: '${PNG_B64}', mimeType: 'image/png' }] }
      : { content: [{ type: 'text', text: '{"a":1}' }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`;

let dir = '';

function stdioConfig(mode: 'image' | 'text'): IMcpStdioConfig {
  return {
    runtime: 'npx',
    packageName: 'media-test-server',
    executionMode: 'subprocess',
    env: { MEDIA_MODE: mode },
  } as IMcpStdioConfig;
}

async function loadRunner() {
  vi.resetModules();
  const config = await import('@/lib/core/config');
  config.setConfigSource({ name: 'test', get: (key) => (key === 'MCP_STDIO_ENABLED' ? 'true' : undefined) });
  return import('@/lib/services/mcp/stdioRunner');
}

describe('MCP media content', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-media-'));
    state.script = join(dir, 'server.js');
    writeFileSync(state.script, SERVER_JS);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { state.fetchBody = null; });

  it('stdio: an image result becomes a ToolOutput with the image block', async () => {
    const { stdioCallTool } = await loadRunner();
    const out = await stdioCallTool(stdioConfig('image'), 'shot', {});
    expect(out).toMatchObject({
      kind: 'tool_output',
      content: [
        { type: 'text', text: 'here' },
        { type: 'image', mimeType: 'image/png', data: PNG_B64 },
      ],
    });
  }, 20_000);

  it('stdio: a text-only result is unwrapped exactly as before', async () => {
    const { stdioCallTool } = await loadRunner();
    expect(await stdioCallTool(stdioConfig('text'), 'echo', {})).toEqual({ a: 1 });
  }, 20_000);

  it('remote: an image result becomes a ToolOutput, text-only stays legacy', async () => {
    const { remoteCallTool } = await import('@/lib/services/mcp/remoteMcpClient');
    const target = { url: 'https://mcp.example.test/mcp' } as never;
    state.fetchBody = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] } };
    expect(await remoteCallTool(target, 'shot', {})).toMatchObject({
      kind: 'tool_output',
      content: [{ type: 'image', mimeType: 'image/png', data: PNG_B64 }],
    });
    state.fetchBody = { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hi' }] } };
    expect(await remoteCallTool(target, 'echo', {})).toBe('hi');
  });

  it('remote: an error result still throws even when it carries an image', async () => {
    const { remoteCallTool } = await import('@/lib/services/mcp/remoteMcpClient');
    state.fetchBody = { jsonrpc: '2.0', id: 3, result: { isError: true, content: [{ type: 'text', text: 'boom' }, { type: 'image', data: PNG_B64, mimeType: 'image/png' }] } };
    await expect(remoteCallTool({ url: 'https://mcp.example.test/mcp' } as never, 'x', {})).rejects.toThrow('boom');
  });

  it('a 2024-11-05 endpoint receives audio as text', async () => {
    const { toMcpCallResult } = await import('@/lib/services/tools/toolOutput');
    const result = toMcpCallResult({
      kind: 'tool_output',
      content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'audio', mimeType: 'audio/wav', data: 'BBBB' }],
    }, '2024-11-05');
    expect(result.content).toEqual([
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: '[audio: audio/wav]' },
    ]);
  });
});
