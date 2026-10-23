/**
 * The browser's egress policy where a route handler cannot see, against a real Chromium.
 *
 * Playwright calls a route handler for the first URL of a redirect chain only,
 * and never for a WebSocket, so a page on an allowed address could reach a
 * blocked one through a redirect or a socket. Here `public.test` is the
 * allowed address — the policy's lookup answers a public IP for it while
 * Chromium maps the name to the fixture server — and 127.0.0.1 is the blocked
 * one.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

// Read when the manager first loads its config, so set before any session opens.
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'true';
process.env.BROWSER_CHROMIUM_EXTRA_ARGS = '--host-resolver-rules=MAP public.test 127.0.0.1';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }),
}));

import { browserManager } from '@/lib/services/browser/browserManager';
import { chromiumAvailable } from '../helpers/browserAvailability';

const SECRET = 'INTERNAL-ONLY-CONTENT';

/** A page whose #state shows what became of a WebSocket to `url`. */
const socketPage = (url: string) => `<!doctype html><html><body><p id="state">pending</p><script>
  var socket = new WebSocket(${JSON.stringify(url)});
  var state = document.getElementById('state');
  socket.onopen = function () { socket.send('ping'); };
  socket.onmessage = function (event) { state.textContent = 'echo ' + event.data; };
  socket.onclose = function (event) { if (state.textContent === 'pending') state.textContent = 'closed ' + event.code; };
</script></body></html>`;

let allowed: Server;
let blocked: Server;
let allowedBase = '';
let blockedBase = '';
/** What reached the blocked server: the requests a redirect or socket got through with. */
let blockedHits: string[] = [];
let openSessions: string[] = [];

const echo = new WebSocketServer({ noServer: true });
echo.on('connection', (socket) => socket.on('message', (data) => socket.send(String(data))));

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function open(): Promise<string> {
  const { sessionKey } = await browserManager.openSession({
    tenantId: 'test-tenant',
    config: { headless: true, actionTimeoutMs: 8_000, navigationTimeoutMs: 15_000 },
  });
  openSessions.push(sessionKey);
  return sessionKey;
}

async function socketState(key: string): Promise<string> {
  let state = 'pending';
  for (let i = 0; i < 50 && state === 'pending'; i += 1) {
    const read = await browserManager.extract(key, { selector: '#state' });
    state = read.values[0] ?? 'pending';
    if (state === 'pending') await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state;
}

beforeAll(async () => {
  blocked = createServer((req, res) => {
    blockedHits.push(`http ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>${SECRET}</title></head><body><h1>${SECRET}</h1></body></html>`);
  });
  blocked.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    blockedHits.push(`ws ${req.url}`);
    echo.handleUpgrade(req, socket, head, (ws) => echo.emit('connection', ws, req));
  });
  const blockedPort = await listen(blocked);
  blockedBase = `http://127.0.0.1:${blockedPort}`;

  allowed = createServer((req, res) => {
    const redirect = (location: string) => res.writeHead(302, { location }).end();
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    switch (req.url) {
      case '/to-blocked': return redirect(`${blockedBase}/secret`);
      case '/to-allowed': return redirect(`${allowedBase}/landing`);
      case '/landing': return html('<!doctype html><html><body><h1>Landing</h1></body></html>');
      case '/image-to-blocked': return redirect(`${blockedBase}/pixel.png`);
      case '/image-page': return html('<!doctype html><html><body><h1>Gallery</h1><img src="/image-to-blocked"></body></html>');
      case '/socket-to-blocked': return html(socketPage(`ws://127.0.0.1:${blockedPort}/socket`));
      case '/socket-to-allowed': return html(socketPage(`${allowedBase.replace('http', 'ws')}/echo`));
      default: return res.writeHead(404).end();
    }
  });
  allowed.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    echo.handleUpgrade(req, socket, head, (ws) => echo.emit('connection', ws, req));
  });
  allowedBase = `http://public.test:${await listen(allowed)}`;
}, 60_000);

afterEach(async () => {
  const keys = openSessions;
  openSessions = [];
  blockedHits = [];
  await Promise.all(keys.map((key) => browserManager.closeSession(key, 'test').catch(() => undefined)));
});

afterAll(async () => {
  await browserManager.shutdown().catch(() => undefined);
  echo.close();
  await new Promise<void>((resolve) => allowed.close(() => resolve()));
  await new Promise<void>((resolve) => blocked.close(() => resolve()));
  delete process.env.BROWSER_CHROMIUM_EXTRA_ARGS;
});

describe.skipIf(!chromiumAvailable())('browser egress: redirects', () => {
  it('refuses a blocked address given directly', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'goto', url: `${blockedBase}/secret` });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/private-network egress is blocked/);
    expect(blockedHits).toEqual([]);
  }, 60_000);

  it('closes the session when a redirect reaches a blocked address, and returns nothing it loaded there', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'goto', url: `${allowedBase}/to-blocked` });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/egress is blocked \(reached through a redirect\); the session was closed/);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(browserManager.hasSession(key)).toBe(false);
    await expect(browserManager.screenshot(key)).rejects.toThrow(/not found or already closed/);
  }, 60_000);

  it('follows a redirect between allowed addresses', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'goto', url: `${allowedBase}/to-allowed` });

    expect(result.ok).toBe(true);
    expect(result.url).toBe(`${allowedBase}/landing`);
    expect(result.ariaSnapshot).toContain('Landing');
  }, 60_000);

  it('closes the session when a subresource is redirected to a blocked address', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'goto', url: `${allowedBase}/image-page` });

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/reached through a redirect/);
    expect(browserManager.hasSession(key)).toBe(false);
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('browser egress: WebSockets', () => {
  it('refuses a WebSocket to a blocked address before it connects', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'goto', url: `${allowedBase}/socket-to-blocked` });
    expect(result.ok).toBe(true);

    expect(await socketState(key)).toBe('closed 1008');
    expect(blockedHits).toEqual([]);
  }, 60_000);

  it('keeps a WebSocket to an allowed address working', async () => {
    const key = await open();
    const result = await browserManager.runAction(key, { type: 'goto', url: `${allowedBase}/socket-to-allowed` });
    expect(result.ok).toBe(true);

    expect(await socketState(key)).toBe('echo ping');
  }, 60_000);
});
