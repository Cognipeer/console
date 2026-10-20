/**
 * browser_screenshot as a ToolOutput, against a real Chromium.
 *
 * The agent tool must hand the model the image itself (not just a download
 * URL), report real dimensions, and treat saving as opt-in.
 * Backed by a real SQLiteProvider in a temp directory.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-browser-shot-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'browser_shot_main';
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'false';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { browserManager } from '@/lib/services/browser/browserManager';
import { createBrowser } from '@/lib/services/browser/browserProfileService';
import {
  closeBrowserSession,
  createBrowserSession,
  runBrowserAction,
} from '@/lib/services/browser/browserSessionService';
import { buildBrowserAgentTools } from '@/lib/services/browser/agentTools';
import { isToolOutput } from '@/lib/services/tools/toolOutput';
import { sniffMedia } from '@/lib/services/tools/mediaSniff';
import { chromiumAvailable } from '../helpers/browserAvailability';

const TENANT_DB_NAME = 'browser_shot_tenant';
const TENANT_ID = 'tenant-browser-shot';
const ACTOR = 'tester@example.com';
const ctx = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: 'proj-1' };
const VIEWPORT = { width: 640, height: 480 };

const PAGE = `<!doctype html><html><body style="margin:0">
  <h1 id="title" style="background:#c33;color:#fff;width:300px;height:60px;margin:0">Hello</h1>
  <div style="height:1500px"></div>
</body></html>`;

let server: Server;
let baseUrl = '';
let sessionKey = '';

async function callScreenshot(input: Record<string, unknown> = {}): Promise<unknown> {
  const tool = buildBrowserAgentTools({
    ...ctx,
    sessionKey,
    createdBy: ACTOR,
  }).find((t) => t.name === 'browser_screenshot');
  if (!tool?.invoke) throw new Error('browser_screenshot not found');
  return tool.invoke(input);
}

describe.skipIf(!chromiumAvailable())('browser_screenshot media output', () => {
  beforeAll(async () => {
    reloadConfig();
    const db = await getDatabase();
    await db.connect();
    await db.switchToTenant(TENANT_DB_NAME);

    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const browser = await createBrowser(ctx, {
      name: 'Shot Test Browser',
      createdBy: ACTOR,
      defaultSessionConfig: {
        headless: true,
        viewport: VIEWPORT,
        actionTimeoutMs: 8_000,
        navigationTimeoutMs: 15_000,
      },
    });
    const session = await createBrowserSession(ctx, { browserId: browser.id, name: 'shot', createdBy: ACTOR });
    sessionKey = session.sessionKey;
    await runBrowserAction(ctx, sessionKey, { type: 'goto', url: baseUrl });
  }, 120_000);

  afterAll(async () => {
    if (sessionKey) await closeBrowserSession(ctx, sessionKey).catch(() => undefined);
    await browserManager.shutdown().catch(() => undefined);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await disconnectDatabase().catch(() => undefined);
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it('returns a ToolOutput with a real PNG at the viewport size', async () => {
    const out = await callScreenshot();
    expect(isToolOutput(out)).toBe(true);
    const output = out as { content: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown> };
    const image = output.content.find((b) => b.type === 'image') as
      | { data: string; mimeType: string; width: number; height: number }
      | undefined;
    expect(image).toBeDefined();
    expect(image!.mimeType).toBe('image/png');
    expect(sniffMedia(Buffer.from(image!.data, 'base64').subarray(0, 32)).kind).toBe('image');
    expect(image!.width).toBe(VIEWPORT.width);
    expect(image!.height).toBe(VIEWPORT.height);
    expect(output.structuredContent).toMatchObject({ width: VIEWPORT.width, height: VIEWPORT.height, fullPage: false });
    expect(String(output.structuredContent?.url)).toContain('127.0.0.1');
  }, 60_000);

  it('notes, rather than fails, when persist is asked for and there is no bucket', async () => {
    const out = (await callScreenshot({ persist: true })) as {
      content: Array<{ type: string; text?: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(isToolOutput(out)).toBe(true);
    expect(out.content.find((b) => b.type === 'text')?.text).toContain('not saved');
    expect(out.content.some((b) => b.type === 'image')).toBe(true);
    expect(out.structuredContent.artifact).toBeUndefined();
  }, 60_000);

  it('captures one element at its own size', async () => {
    const out = (await callScreenshot({ selector: '#title' })) as {
      content: Array<{ type: string; width?: number; height?: number }>;
    };
    const image = out.content.find((b) => b.type === 'image');
    expect(image?.width).toBe(300);
    expect(image?.height).toBe(60);
  }, 60_000);

  it('full page is taller than the viewport', async () => {
    const out = (await callScreenshot({ fullPage: true })) as {
      content: Array<{ type: string; height?: number; text?: string }>;
    };
    expect(out.content.find((b) => b.type === 'image')?.height).toBeGreaterThan(VIEWPORT.height);
    expect(out.content[0].text).toContain('full page');
  }, 60_000);
});
