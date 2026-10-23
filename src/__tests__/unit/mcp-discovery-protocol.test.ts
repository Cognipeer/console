/**
 * What discovery and calls read from an upstream MCP server: the response to
 * OUR request inside an SSE stream that also carries notifications and server
 * requests, every `tools/list` page, and the `instructions` of `initialize` —
 * over HTTP (a local server) and over stdio (a real child process).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMcpStdioConfig } from '@/lib/database';

process.env.OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK = 'false';

const state = vi.hoisted(() => ({ script: '' }));

// The runner always launches `npx <package>`; run our tiny server script with this node instead.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_cmd: string, _args: string[], options: Record<string, unknown>) =>
      actual.spawn(process.execPath, [state.script], options as never),
  };
});

import { remoteCallTool, remoteDiscover, remoteListTools } from '@/lib/services/mcp/remoteMcpClient';

// ── HTTP upstream ─────────────────────────────────────────────────────────

interface Rpc {
  id: number;
  method: string;
  params?: { cursor?: string; name?: string };
}

let mode = 'normal';
const listCursors: Array<string | undefined> = [];
let server: Server;
let url = '';

/** Write SSE events and leave the stream OPEN — the client must not wait for it to close. */
function sseOpen(res: ServerResponse, events: unknown[], crlf = false) {
  const nl = crlf ? '\r\n' : '\n';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) {
    // Multi-line data: one JSON value spread over several `data:` lines.
    const lines = JSON.stringify(event, null, 1).split('\n');
    res.write(`event: message${nl}${lines.map((l) => `data: ${l}`).join(nl)}${nl}${nl}`);
  }
}

function json(res: ServerResponse, body: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const msg = JSON.parse(body) as Rpc;
      if (msg.method === 'initialize') {
        if (mode === 'no-initialize') {
          json(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
          return;
        }
        sseOpen(res, [
          { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'booting' } },
          {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 't', version: '1' },
              instructions: '  Call search before fetch.  ',
            },
          },
        ], true);
        return;
      }
      if (msg.method === 'tools/list') {
        listCursors.push(msg.params?.cursor);
        if (mode === 'loop') {
          json(res, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'again' }], nextCursor: 'same' } });
          return;
        }
        const page = msg.params?.cursor === 'p2'
          ? { tools: [{ name: 'fetch', title: 'Fetch a document' }] }
          : { tools: [{ name: 'search', inputSchema: { type: 'object' } }], nextCursor: 'p2' };
        json(res, { jsonrpc: '2.0', id: msg.id, result: page });
        return;
      }
      if (msg.method === 'tools/call') {
        sseOpen(res, [
          { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } },
          // A server request whose id is a string — must not be taken for our response.
          { jsonrpc: '2.0', id: String(msg.id + 1000), method: 'elicitation/create', params: {} },
          { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'done' }] } },
        ]);
        return;
      }
      res.statusCode = 400;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'object' && address) url = `http://127.0.0.1:${address.port}/mcp`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mode = 'normal';
  listCursors.length = 0;
});

describe('remote MCP client', () => {
  it('reads the response to its own request from an SSE stream that carries other messages first', async () => {
    await expect(remoteCallTool({ url }, 'search', {})).resolves.toBe('done');
  });

  it('follows tools/list pages and keeps each tool\'s title', async () => {
    const tools = await remoteListTools({ url });
    expect(tools.map((t) => t.name)).toEqual(['search', 'fetch']);
    expect(tools[1].title).toBe('Fetch a document');
    expect(listCursors).toEqual([undefined, 'p2']);
  });

  it('stops following a cursor the server already handed out', async () => {
    mode = 'loop';
    const tools = await remoteListTools({ url });
    expect(tools).toHaveLength(2);
    expect(listCursors).toEqual([undefined, 'same']);
  });

  it('discovers the instructions of initialize, trimmed', async () => {
    const discovered = await remoteDiscover({ url });
    expect(discovered.instructions).toBe('Call search before fetch.');
    expect(discovered.tools).toHaveLength(2);
  });

  it('leaves the instructions unknown, not empty, when initialize fails — and still lists tools', async () => {
    mode = 'no-initialize';
    const discovered = await remoteDiscover({ url });
    expect(discovered.instructions).toBeUndefined();
    expect(discovered.tools.map((t) => t.name)).toEqual(['search', 'fetch']);
  });
});

// ── stdio upstream ────────────────────────────────────────────────────────

const SERVER_JS = `
const rl = require('readline').createInterface({ input: process.stdin });
const mode = process.env.LIST_MODE;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  // A log notification before every response: not a response, must be skipped.
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'x' } }) + '\\n');
  let result = {};
  if (msg.method === 'initialize') {
    result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 't', version: '1' } };
    if (mode !== 'bare') result.instructions = 'Open a session first.';
  }
  if (msg.method === 'tools/list') {
    const cursor = msg.params && msg.params.cursor;
    if (mode === 'loop') result = { tools: [{ name: 'again' }], nextCursor: 'same' };
    else if (cursor === 'c2') result = { tools: [{ name: 'second', title: 'Second tool' }] };
    else result = { tools: [{ name: 'first' }], nextCursor: 'c2' };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`;

let dir = '';

function stdioConfig(listMode: 'pages' | 'loop' | 'bare'): IMcpStdioConfig {
  return {
    runtime: 'npx',
    packageName: 'discovery-test-server',
    executionMode: 'subprocess',
    env: { LIST_MODE: listMode },
  } as IMcpStdioConfig;
}

async function loadRunner() {
  vi.resetModules();
  const config = await import('@/lib/core/config');
  config.setConfigSource({ name: 'test', get: (key) => (key === 'MCP_STDIO_ENABLED' ? 'true' : undefined) });
  return import('@/lib/services/mcp/stdioRunner');
}

describe('stdio MCP discovery', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-discovery-'));
    state.script = join(dir, 'server.js');
    writeFileSync(state.script, SERVER_JS);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('follows tools/list pages in the same process and reads the instructions', async () => {
    const { stdioDiscover } = await loadRunner();
    const discovered = await stdioDiscover(stdioConfig('pages'));
    expect(discovered.tools.map((t) => t.name)).toEqual(['first', 'second']);
    expect(discovered.tools[1].title).toBe('Second tool');
    expect(discovered.instructions).toBe('Open a session first.');
  }, 20_000);

  it('stops at a repeated cursor', async () => {
    const { stdioDiscover } = await loadRunner();
    const discovered = await stdioDiscover(stdioConfig('loop'));
    expect(discovered.tools).toHaveLength(2);
  }, 20_000);

  it('reports no instructions as null when initialize carried none', async () => {
    const { stdioDiscover } = await loadRunner();
    expect((await stdioDiscover(stdioConfig('bare'))).instructions).toBeNull();
  }, 20_000);
});
