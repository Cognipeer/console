/**
 * A browser published through the MCP module, end to end: an internal MCP
 * server with provider "browser" is created like any other, and its tools are
 * called through `executeMcpTool` — the choke point every MCP surface uses —
 * against a real Chromium and a real SQLiteProvider.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + temp dir need to be configured BEFORE getDatabase() is ever called.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-browser-mcp-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'browser_mcp_main';
// 127.0.0.1 is private address space; the fixture server lives there.
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'false';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type IMcpServer } from '@/lib/database';
import { browserManager } from '@/lib/services/browser/browserManager';
import { createBrowser } from '@/lib/services/browser/browserProfileService';
import { createBrowserSession, getBrowserSessionByKey } from '@/lib/services/browser/browserSessionService';
import { McpToolInputError } from '@/lib/services/mcp/errors';
import { createMcpServer, executeMcpTool } from '@/lib/services/mcp/mcpService';
import { chromiumAvailable } from '../helpers/browserAvailability';

const TENANT_DB_NAME = 'browser_mcp_tenant';
const PROJECT_ID = 'proj-1';
const ACTOR = 'tester@example.com';

const PAGE = '<!doctype html><html><body><h1>Order Desk</h1><button type="button">Place order</button></body></html>';

let server: Server;
let baseUrl = '';
let tenantId = '';
let browserId = '';
let mcpServer: IMcpServer;

const ctx = () => ({ tenantDbName: TENANT_DB_NAME, tenantId, projectId: PROJECT_ID });
const call = async (tool: string, args: Record<string, unknown> = {}) =>
  (await executeMcpTool(mcpServer, tool, args)).result as Record<string, unknown>;

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.connect();
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-browser-mcp', dbName: TENANT_DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);

  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  const browser = await createBrowser(ctx(), {
    name: 'Order Desk',
    createdBy: ACTOR,
    defaultSessionConfig: { headless: true, actionTimeoutMs: 8_000, navigationTimeoutMs: 15_000 },
  });
  browserId = browser.id;

  mcpServer = await createMcpServer(TENANT_DB_NAME, tenantId, 'owner-1', PROJECT_ID, {
    name: 'Order Desk browser',
    sourceType: 'internal',
    upstreamAuth: { type: 'none' },
    internalConfig: { provider: 'browser', instanceKey: browser.key, config: {} },
  });
}, 120_000);

afterAll(async () => {
  await browserManager.shutdown().catch(() => undefined);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await disconnectDatabase().catch(() => undefined);
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('a browser published as an internal MCP server', () => {
  it('stores the browser tool list on the server', () => {
    const names = (mcpServer.tools ?? []).map((tool) => tool.name);
    expect(names[0]).toBe('browser_open_session');
    expect(names).toEqual(expect.arrayContaining(['browser_navigate', 'browser_snapshot', 'browser_run_flow', 'browser_close']));
  });

  it.skipIf(!chromiumAvailable())('opens a session, drives the page, and closes it', async () => {
    const opened = await call('browser_open_session');
    expect(opened.ok).toBe(true);
    const sessionKey = String(opened.sessionKey);

    const row = await getBrowserSessionByKey(ctx(), sessionKey);
    expect(row).toMatchObject({ browserId, metadata: { source: 'browser-mcp', mcpServerKey: mcpServer.key } });

    expect(await call('browser_navigate', { sessionKey, url: baseUrl })).toMatchObject({ ok: true });
    const snapshot = await call('browser_snapshot', { sessionKey });
    expect(JSON.stringify(snapshot)).toContain('Order Desk');

    await call('browser_close', { sessionKey });
    await expect(call('browser_snapshot', { sessionKey })).rejects.toBeInstanceOf(McpToolInputError);
  }, 60_000);

  it.skipIf(!chromiumAvailable())('will not drive a session that was opened outside this server', async () => {
    const foreign = await createBrowserSession(ctx(), { browserId, createdBy: ACTOR });
    try {
      const error = await call('browser_snapshot', { sessionKey: foreign.sessionKey }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpToolInputError);
      expect((error as Error).message).toBe(`Browser session "${foreign.sessionKey}" not found`);
    } finally {
      await browserManager.closeSession(foreign.sessionKey, 'manual').catch(() => undefined);
    }
  }, 60_000);

  it('refuses a page tool without a sessionKey', async () => {
    await expect(call('browser_navigate', { url: baseUrl })).rejects.toBeInstanceOf(McpToolInputError);
  });
});
