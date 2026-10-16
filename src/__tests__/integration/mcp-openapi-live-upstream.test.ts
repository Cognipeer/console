/**
 * Integration test — an OpenAPI-sourced MCP server calling a real HTTP
 * upstream (loopback sockets on OS-assigned ports; the SSRF guard is switched
 * off for the test, as a self-hosted deployment would for an in-network host).
 *
 * The unit and integration tests stub `fetch`; this one checks the same
 * behaviour on the wire: what the upstream receives for a normal call, for
 * arguments that are refused or dropped, and for a redirect to another origin.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-live-upstream-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_live_upstream_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-live-upstream-tests';
process.env.OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK = 'false';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase } from '@/lib/database';
import { createMcpServer } from '@/lib/services/mcp';
import { executeMcpToolLocal } from '@/lib/services/mcp/mcpService';
import { McpToolInputError } from '@/lib/services/mcp/errors';

const TENANT_DB_NAME = 'mcp_live_upstream_tenant';
const TENANT_ID = 'tenant-live-upstream';
const USER_ID = 'user-1';
const API_KEY = 'live-upstream-api-key-5150';

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
    '/moved': { get: { operationId: 'getMoved' } },
  },
});

beforeAll(async () => {
  reloadConfig();

  secondary = createServer((request, response) => {
    record(seenBySecondary, request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ server: 'secondary' }));
  });
  secondaryBase = await listen(secondary);

  primary = createServer((request, response) => {
    record(seenByPrimary, request);
    if (request.url?.startsWith('/v1/moved')) {
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
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK;
  reloadConfig();
});

beforeEach(() => {
  seenByPrimary.length = 0;
  seenBySecondary.length = 0;
});

async function headerKeyServer(name: string) {
  return createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, undefined, {
    name,
    openApiSpec: SPEC(primaryBase),
    upstreamAuth: { type: 'header', headerName: 'X-Api-Key', headerValue: API_KEY },
  });
}

describe('OpenAPI MCP server against a live upstream', () => {
  it('sends a normal call to the described operation, with the stored key', async () => {
    const server = await headerKeyServer('Live Normal');
    const { result } = await executeMcpToolLocal(server, 'getProfile', { id: '42', limit: 5, ignored: 'x' });

    expect(result).toEqual({ server: 'primary', url: '/v1/users/42/profile?limit=5' });
    expect(seenByPrimary).toEqual([
      { method: 'GET', url: '/v1/users/42/profile?limit=5', apiKey: API_KEY, runtimeHeader: undefined },
    ]);
  });

  it('puts nothing on the wire for a path argument made of relative segments', async () => {
    const server = await headerKeyServer('Live Refused');
    for (const id of ['..', '.', '../../x', '%2e%2e', 'a/../../b']) {
      await expect(executeMcpToolLocal(server, 'getProfile', { id }), id).rejects.toThrow(McpToolInputError);
    }
    await expect(executeMcpToolLocal(server, 'getProfile', {})).rejects.toThrow(McpToolInputError);
    expect(seenByPrimary).toEqual([]);
  });

  it('percent-encodes a value that contains separators and keeps it inside the operation', async () => {
    const server = await headerKeyServer('Live Encoded');
    await executeMcpToolLocal(server, 'getProfile', { id: 'a/b c' });
    expect(seenByPrimary.map((seen) => seen.url)).toEqual(['/v1/users/a%2Fb%20c/profile']);
  });

  it('drops the configured key and the runtime header when the upstream redirects to another origin', async () => {
    const server = await headerKeyServer('Live Redirect');
    const { result } = await executeMcpToolLocal(server, 'getMoved', {}, { 'x-caller-note': 'caller-note-value' });

    expect(result).toEqual({ server: 'secondary' });
    expect(seenByPrimary).toEqual([
      { method: 'GET', url: '/v1/moved', apiKey: API_KEY, runtimeHeader: 'caller-note-value' },
    ]);
    expect(seenBySecondary).toEqual([
      { method: 'GET', url: '/landing', apiKey: undefined, runtimeHeader: undefined },
    ]);
  });
});
