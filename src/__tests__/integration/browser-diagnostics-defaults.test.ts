/**
 * Regression tests for two defects found diagnosing a live incident where a
 * page loaded successfully but consistently past any reasonable navigation
 * timeout, and the failed action's result gave no hint the page had loaded
 * at all:
 *
 *  - `goto`'s default `waitUntil` was Playwright's own default, `'load'`,
 *    which waits for every last subresource (trackers, fonts, third-party
 *    widgets) — a single slow or hanging one blocks navigation forever, even
 *    though the DOM the caller actually wants was ready long before. Most
 *    browser-automation tooling (crawl4ai included) defaults to
 *    `'domcontentloaded'` for exactly this reason.
 *  - A failed action's result carried no `ariaSnapshot`/`pageTitle`, even
 *    when the page had rendered fine and the failure was e.g. a target that
 *    never appeared — so the caller had no way to see what was actually on
 *    screen when the action gave up.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// 127.0.0.1 is private address space — set before config is read, or the
// egress guard blocks navigation regardless of the outcome under test.
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'false';

import { browserManager } from '@/lib/services/browser/browserManager';
import { chromiumAvailable } from '../helpers/browserAvailability';

// The image request is accepted but never answered and never closed, so
// Chromium's `load` event (which waits for every subresource to settle)
// never fires — the only way `goto` can return is if it stopped waiting
// after DOMContentLoaded instead.
const PAGE = `<!doctype html>
<html><body>
  <h1>Hanging subresource fixture</h1>
  <button type="button">Does not exist target below is what we click instead</button>
  <img src="/never-responds.png" />
</body></html>`;

let server: Server;
let baseUrl = '';
let openSessions: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/never-responds.png') {
      // Deliberately never call res.end() / res.write() — the request just
      // hangs, the way a slow third-party tracker would.
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}, 30_000);

afterEach(async () => {
  const keys = openSessions;
  openSessions = [];
  await Promise.all(keys.map((key) => browserManager.closeSession(key, 'test').catch(() => undefined)));
});

afterAll(async () => {
  await browserManager.shutdown().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(!chromiumAvailable())('goto — default waitUntil', () => {
  it('resolves without waiting for a subresource that never finishes loading', async () => {
    const { sessionKey } = await browserManager.openSession({
      tenantId: 'test-tenant-diag',
      config: { headless: true, navigationTimeoutMs: 8_000 },
    });
    openSessions.push(sessionKey);

    const start = Date.now();
    // No `waitUntil` — exercising the default.
    const result = await browserManager.runAction(sessionKey, { type: 'goto', url: baseUrl });
    const elapsedMs = Date.now() - start;

    expect(result.ok).toBe(true);
    // Playwright's 'load' default would hang for the full 8s navigation
    // timeout on this fixture; 'domcontentloaded' returns almost instantly.
    expect(elapsedMs).toBeLessThan(4_000);
  }, 15_000);
});

describe.skipIf(!chromiumAvailable())('runAction — best-effort snapshot on failure', () => {
  it('still returns pageTitle and ariaSnapshot when the action itself fails', async () => {
    const { sessionKey } = await browserManager.openSession({
      tenantId: 'test-tenant-diag',
      config: { headless: true, actionTimeoutMs: 1_500, navigationTimeoutMs: 8_000 },
    });
    openSessions.push(sessionKey);
    await browserManager.runAction(sessionKey, { type: 'goto', url: baseUrl });

    const result = await browserManager.runAction(sessionKey, {
      type: 'click',
      role: 'button',
      name: 'This button does not exist on the page',
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBeDefined();
    expect(result.pageTitle).toBeDefined();
    expect(result.ariaSnapshot).toContain('Hanging subresource fixture');
  }, 15_000);
});
