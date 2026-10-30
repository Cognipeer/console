/**
 * The browser runtime and the crawler's Playwright engine behind an egress
 * proxy, against a real Chromium and a real forward proxy.
 *
 * The network modelled here is the one on-prem installations run in: no
 * direct route out, the internet reachable only through a corporate proxy
 * named by HTTPS_PROXY / NO_PROXY that wants credentials and lets through
 * only the hosts the firewall team opened, and a local resolver that cannot
 * answer for public names (the proxy resolves them). The proxy below sends
 * the `*.corp-e2e.test` names to local fixture servers; nothing else can
 * reach those servers by name.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
const savedEnv = Object.fromEntries(PROXY_VARIABLES.map((name) => [name, process.env[name]]));
for (const name of PROXY_VARIABLES) delete process.env[name];

// Read when the runtime first loads its config, so set before any session opens.
process.env.BROWSER_BLOCK_PRIVATE_NETWORK = 'true';
// Only a connection that bypasses the proxy resolves these names, and it
// lands on the fixture that answers "DIRECT CONNECTION".
process.env.BROWSER_CHROMIUM_EXTRA_ARGS = '--host-resolver-rules=MAP *bypass.corp-e2e.test 127.0.0.1';

/** What the runtime's own resolver answers: a public address, a private one, nothing, or never. */
const dns = vi.hoisted(() => ({
  answers: new Map<string, string>([
    ['intranet.corp-e2e.test', '10.20.30.40'],
    ['bypass.corp-e2e.test', '203.0.113.10'],
    ['app.bypass.corp-e2e.test', '203.0.113.10'],
    ['slow-dns.corp-e2e.test', 'hang'],
  ]),
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const answer = dns.answers.get(host);
    if (answer === 'hang') return new Promise(() => undefined);
    if (answer) return [{ address: answer, family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }),
}));

import { browserManager } from '@/lib/services/browser/browserManager';
import { PlaywrightSession } from '@/lib/services/crawler/engine/playwrightFetcher';
import { chromiumAvailable } from '../helpers/browserAvailability';

const PROXY_USER = 'svc@corp';
const PROXY_PASSWORD = 'p:ss w0rd';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString('base64')}`;

// Enough text that the crawler does not take the page for an unrendered
// JavaScript shell and reload it, waiting, until it gives up.
const FILLER = `<p>${'Fixture content, served on the far side of the egress proxy. '.repeat(5)}</p>`;
const page = (body: string, head = '') =>
  `<!doctype html><html><head><title>fixture</title>${head}</head><body>${body}${FILLER}</body></html>`;

/** What the proxy saw: the method, the host it was asked for, and whether the caller authenticated. */
let proxyHits: Array<{ method: string; host: string; authorized: boolean }> = [];
let proxy: Server;
let site: Server;
let direct: Server;
let secure: ReturnType<typeof createHttpsServer>;
let directPort = 0;
let certDir = '';
const tunnels = new Set<Socket>();
let openSessions: string[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Which local server the proxy forwards a public name to, `'hang'` for a firewall that drops it, or nothing (403). */
function upstreamFor(hostname: string, tls: boolean): number | 'hang' | undefined {
  if (hostname === 'cdn.blackhole-e2e.test') return 'hang';
  if (!hostname.endsWith('.corp-e2e.test')) return undefined;
  return ((tls ? secure : site).address() as AddressInfo).port;
}

async function open(config: Record<string, unknown> = {}): Promise<string> {
  const { sessionKey } = await browserManager.openSession({
    tenantId: 'test-tenant',
    config: { headless: true, actionTimeoutMs: 8_000, navigationTimeoutMs: 15_000, ...config },
  });
  openSessions.push(sessionKey);
  return sessionKey;
}

async function goto(key: string, url: string) {
  return browserManager.runAction(key, { type: 'goto', url });
}

async function heading(key: string): Promise<string | undefined> {
  const read = await browserManager.extract(key, { selector: 'h1' });
  return read.values[0];
}

const hitsFor = (host: string) => proxyHits.filter((hit) => hit.host === host);

beforeAll(async () => {
  site = createHttpServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    res.writeHead(200, { 'content-type': 'text/html' });
    if (host === 'intranet.corp-e2e.test') return res.end(page('<h1>INTERNAL SECRET</h1>'));
    if (host.endsWith('bypass.corp-e2e.test')) return res.end(page('<h1>PROXIED</h1>'));
    if (req.url === '/hanging-cdn') {
      // A parser-blocking script from a host the firewall silently drops:
      // DOMContentLoaded waits for it, so the navigation can only time out.
      return res.end(page('<h1>never parsed</h1>', '<script src="http://cdn.blackhole-e2e.test/app.js"></script>'));
    }
    if (req.url === '/denied-cdn') {
      return res.end(page('<h1>LOADED DESPITE A DENIED CDN</h1>', '<script src="http://cdn.denied-e2e.test/app.js"></script>'));
    }
    return res.end(page('<h1>PUBLIC SITE</h1>'));
  });
  direct = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('<h1>DIRECT CONNECTION</h1>'));
  });

  certDir = mkdtempSync(join(tmpdir(), 'browser-proxy-test-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=secure.corp-e2e.test',
    '-addext', 'subjectAltName=DNS:secure.corp-e2e.test',
  ], { stdio: 'ignore' });
  secure = createHttpsServer({
    key: readFileSync(join(certDir, 'key.pem')),
    cert: readFileSync(join(certDir, 'cert.pem')),
  }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('<h1>SECURE SITE</h1>'));
  });

  proxy = createHttpServer((req, res) => {
    const target = new URL(req.url ?? '/');
    const authorized = req.headers['proxy-authorization'] === EXPECTED_AUTH;
    proxyHits.push({ method: req.method ?? 'GET', host: target.hostname, authorized });
    if (!authorized) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="corp-e2e"', 'content-length': '0' });
      return res.end();
    }
    const upstream = upstreamFor(target.hostname, false);
    if (upstream === 'hang') return; // never answered, never closed
    if (!upstream) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Blocked by the egress policy');
    }
    const forward = httpRequest({
      host: '127.0.0.1',
      port: upstream,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...req.headers, host: target.host },
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forward.on('error', () => res.destroy());
    req.pipe(forward);
  });
  proxy.on('connect', (req, client: Socket, head: Buffer) => {
    tunnels.add(client);
    client.on('close', () => tunnels.delete(client));
    client.on('error', () => undefined);
    const [hostname] = (req.url ?? '').split(':');
    const authorized = req.headers['proxy-authorization'] === EXPECTED_AUTH;
    proxyHits.push({ method: 'CONNECT', host: hostname, authorized });
    if (!authorized) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp-e2e"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = upstreamFor(hostname, true);
    if (upstream === 'hang') return;
    if (!upstream) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const server = connect(upstream, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      server.write(head);
      server.pipe(client);
      client.pipe(server);
    });
    tunnels.add(server);
    server.on('close', () => tunnels.delete(server));
    server.on('error', () => client.destroy());
  });

  await listen(site);
  await listen(secure as unknown as Server);
  directPort = await listen(direct);
  const proxyPort = await listen(proxy);

  // Credentials embedded the way corporate proxy URLs carry them, encoded.
  process.env.HTTPS_PROXY = `http://${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASSWORD)}@127.0.0.1:${proxyPort}`;
  // curl's meaning: `bypass.corp-e2e.test` covers its subdomains too.
  process.env.NO_PROXY = 'localhost,127.0.0.1,bypass.corp-e2e.test,.direct-only.test';
}, 60_000);

beforeEach(() => {
  proxyHits = [];
});

afterEach(async () => {
  const keys = openSessions;
  openSessions = [];
  await Promise.all(keys.map((key) => browserManager.closeSession(key, 'test').catch(() => undefined)));
});

afterAll(async () => {
  await browserManager.shutdown().catch(() => undefined);
  for (const socket of tunnels) socket.destroy();
  for (const server of [proxy, site, direct, secure as unknown as Server]) {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
  if (certDir) rmSync(certDir, { recursive: true, force: true });
  for (const name of PROXY_VARIABLES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
}, 30_000);

describe.skipIf(!chromiumAvailable())('browser runtime behind an egress proxy', () => {
  it('reaches a public site whose name only the proxy can resolve, authenticating to the proxy', async () => {
    const key = await open();
    const result = await goto(key, 'http://www.corp-e2e.test/');

    expect(result.errorMessage).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(await heading(key)).toBe('PUBLIC SITE');
    expect(hitsFor('www.corp-e2e.test').some((hit) => hit.authorized)).toBe(true);
  }, 60_000);

  it('tunnels HTTPS through CONNECT with the proxy credentials', async () => {
    const key = await open({ ignoreHTTPSErrors: true });
    const result = await goto(key, 'https://secure.corp-e2e.test/');

    expect(result.errorMessage).toBeUndefined();
    expect(await heading(key)).toBe('SECURE SITE');
    expect(hitsFor('secure.corp-e2e.test')).toContainEqual({ method: 'CONNECT', host: 'secure.corp-e2e.test', authorized: true });
  }, 60_000);

  it('does not wait on a resolver that never answers', async () => {
    const key = await open();
    const startedAt = Date.now();
    const result = await Promise.race([
      goto(key, 'http://slow-dns.corp-e2e.test/'),
      new Promise<{ ok: false; errorMessage: string }>((resolve) => {
        setTimeout(() => resolve({ ok: false, errorMessage: 'still waiting on DNS after 20s' }), 20_000);
      }),
    ]);

    expect(result.errorMessage).toBeUndefined();
    expect(await heading(key)).toBe('PUBLIC SITE');
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 60_000);

  it('still refuses a name that resolves to a private address, even though the proxy would fetch it', async () => {
    const key = await open();
    const result = await goto(key, 'http://intranet.corp-e2e.test/');

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/private-network egress is blocked/i);
    expect(hitsFor('intranet.corp-e2e.test')).toEqual([]);
  }, 60_000);

  it('still refuses a single-label name it cannot resolve: no public site has one', async () => {
    const key = await open();
    const result = await goto(key, 'http://intranet/');

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/private-network egress is blocked/i);
    expect(proxyHits).toEqual([]);
  }, 60_000);

  it('fails closed for a host that bypasses the proxy and cannot be resolved', async () => {
    const key = await open();
    const result = await goto(key, 'http://nodns.direct-only.test/');

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/private-network egress is blocked/i);
  }, 60_000);

  it('reads NO_PROXY the way curl does: a domain entry covers the domain and its subdomains', async () => {
    const key = await open();

    for (const host of ['bypass.corp-e2e.test', 'app.bypass.corp-e2e.test']) {
      const result = await goto(key, `http://${host}:${directPort}/`);
      expect(result.errorMessage).toBeUndefined();
      expect(await heading(key)).toBe('DIRECT CONNECTION');
      expect(hitsFor(host)).toEqual([]);
    }
  }, 60_000);

  it('lets a page load when the proxy refuses one of its resources', async () => {
    const key = await open();
    const result = await goto(key, 'http://www.corp-e2e.test/denied-cdn');

    expect(result.errorMessage).toBeUndefined();
    expect(await heading(key)).toBe('LOADED DESPITE A DENIED CDN');
    expect(hitsFor('cdn.denied-e2e.test').length).toBeGreaterThan(0);
  }, 60_000);

  it('names the hosts the page was still waiting on when the navigation timed out', async () => {
    const key = await open({ navigationTimeoutMs: 3_000 });
    const result = await goto(key, 'http://www.corp-e2e.test/hanging-cdn');

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/Timeout/);
    expect(result.errorMessage).toContain('cdn.blackhole-e2e.test');
    expect(result.errorMessage).not.toContain('/app.js');
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('crawler Playwright engine behind an egress proxy', () => {
  it('fetches a page through the authenticated proxy', async () => {
    const session = new PlaywrightSession({ timeoutMs: 15_000 }, []);
    try {
      const result = await session.fetch('http://www.corp-e2e.test/');
      expect(result.httpStatus).toBe(200);
      expect(result.html).toContain('PUBLIC SITE');
      expect(hitsFor('www.corp-e2e.test').some((hit) => hit.authorized)).toBe(true);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('reads NO_PROXY the way curl does', async () => {
    const session = new PlaywrightSession({ timeoutMs: 15_000 }, []);
    try {
      const result = await session.fetch(`http://app.bypass.corp-e2e.test:${directPort}/`);
      expect(result.html).toContain('DIRECT CONNECTION');
      expect(hitsFor('app.bypass.corp-e2e.test')).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);
});
