/**
 * End-to-end check of the egress proxy the way the browser runtime uses it.
 * Run it where the console runs (inside its container or pod), with the URLs
 * the browser cannot reach:
 *
 *   node --import tsx scripts/diagnose-egress-proxy.ts https://www.example.com [more URLs]
 *   npm run diagnose:egress-proxy -- https://www.example.com --timeout 45000
 *
 * For each URL, in order: which proxy variables this process has, whether the
 * URL goes through the proxy or bypasses it (NO_PROXY), what the local
 * resolver answers, whether the proxy itself opens a connection to the host
 * (with the credentials from the proxy URL), and finally a real browser
 * session navigating there, egress guard included, with every request that
 * failed or never finished. Exits with 1 when a URL could not be loaded.
 */
import { loadEnvConfig } from '@next/env';
import { lookup } from 'node:dns/promises';
import { connect, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

const PROBE_TIMEOUT_MS = 15_000;

interface ProxyServer {
  server: string;
  username?: string;
  password?: string;
}

function parseArgs(argv: string[]): { urls: URL[]; timeoutMs: number } {
  const urls: URL[] = [];
  let timeoutMs = 30_000;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--timeout') {
      timeoutMs = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout expects milliseconds');
      i += 1;
    } else {
      urls.push(new URL(arg));
    }
  }
  if (urls.length === 0) {
    throw new Error('Usage: diagnose-egress-proxy.ts <url> [<url> ...] [--timeout <ms>]');
  }
  return { urls, timeoutMs };
}

/** The first line the proxy answers a CONNECT (https) or an absolute-form HEAD (http) with. */
function probeProxy(target: URL, proxy: ProxyServer): Promise<string> {
  const proxyUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy.server) ? proxy.server : `http://${proxy.server}`);
  const tls = proxyUrl.protocol === 'https:';
  const proxyPort = Number(proxyUrl.port) || (tls ? 443 : 80);
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const auth = proxy.username !== undefined
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`
    : '';
  const request = target.protocol === 'https:'
    ? `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n${auth}\r\n`
    : `HEAD ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\n${auth}Connection: close\r\n\r\n`;

  return new Promise((resolve) => {
    let answer = '';
    const socket: Socket = tls
      ? connectTls({ host: proxyUrl.hostname, port: proxyPort, servername: proxyUrl.hostname })
      : connect(proxyPort, proxyUrl.hostname);
    const done = (line: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(line);
    };
    const timer = setTimeout(() => done(`no answer within ${PROBE_TIMEOUT_MS} ms`), PROBE_TIMEOUT_MS);
    socket.once(tls ? 'secureConnect' : 'connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('latin1');
      const end = answer.indexOf('\r\n');
      if (end >= 0) done(answer.slice(0, end));
    });
    socket.on('error', (error) => done(`could not connect to the proxy: ${error.message}`));
  });
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - startedAt };
}

async function main(): Promise<void> {
  const { urls, timeoutMs } = parseArgs(process.argv.slice(2));
  const { normalizeProxyEnv, readEgressProxyEnv } = await import('@/lib/core/proxyEnv');
  const {
    browserProxyRouting,
    isProxiedUrl,
    resolveBrowserProxyConfig,
    safeProxyHost,
  } = await import('@/lib/core/browserProxyConfig');
  const { getConfig } = await import('@/lib/core/config');

  console.log('== Proxy configuration');
  for (const { variable, adoptedAs } of normalizeProxyEnv()) {
    console.log(`WARN ${variable} is not a standard name; read as ${adoptedAs}. Rename it: most tools ignore it.`);
  }
  const { proxy, noProxy } = readEgressProxyEnv();
  const browserProxy = resolveBrowserProxyConfig();
  const cfg = getConfig().browser;
  const routing = browserProxyRouting(browserProxy, cfg.chromiumExtraArgs);
  if (!proxy) {
    console.log('INFO No HTTPS_PROXY / HTTP_PROXY: every request goes direct.');
  } else {
    console.log(`INFO Proxy ${safeProxyHost(proxy.value)} from ${proxy.variable}`
      + `${browserProxy?.username !== undefined ? ', with credentials' : ''}`);
    if (/^https:\/\//i.test(proxy.value)) {
      console.log('WARN The proxy URL is https://: the browser speaks TLS to the proxy itself. Most corporate proxies take http:// (CONNECT tunnels HTTPS).');
    }
    console.log(`INFO NO_PROXY ${noProxy ? `${noProxy.value} (from ${noProxy.variable})` : 'not set'}`);
    console.log(`INFO Browser bypass rules: ${browserProxy?.bypass ?? '(none)'}`);
  }
  if (routing?.server !== browserProxy?.server || routing?.bypass !== browserProxy?.bypass) {
    console.log(`INFO BROWSER_CHROMIUM_EXTRA_ARGS change the routing: ${routing ? `${safeProxyHost(routing.server)}, bypass ${routing.bypass ?? '(none)'}` : 'direct'}`);
  }
  console.log(`INFO BROWSER_BLOCK_PRIVATE_NETWORK=${cfg.blockPrivateNetwork} BROWSER_IGNORE_CERTIFICATE_ERRORS=${cfg.ignoreCertificateErrors}`);

  const { browserManager } = await import('@/lib/services/browser/browserManager');
  let failures = 0;
  try {
    for (const url of urls) {
      console.log(`\n== ${url.href}`);
      const proxied = isProxiedUrl(url, routing);
      console.log(`INFO Route: ${proxied ? `through the proxy ${safeProxyHost(routing?.server ?? '')}` : 'direct (no proxy, or NO_PROXY matches)'}`);

      const dns = await timed(() => lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
        .then((records) => records.map((record) => record.address).join(', '))
        .catch((error: NodeJS.ErrnoException) => `no answer (${error.code ?? error.message})`));
      console.log(`INFO Local DNS: ${dns.value} [${dns.ms} ms]${proxied ? ' (the proxy resolves the name for the browser)' : ''}`);

      if (proxied && browserProxy) {
        const probe = await timed(() => probeProxy(url, browserProxy));
        const okProbe = /^HTTP\/1\.[01] [23]\d\d/.test(probe.value);
        console.log(`${okProbe ? 'OK  ' : 'FAIL'} Proxy answered: ${probe.value} [${probe.ms} ms]`);
        if (/ 407 /.test(probe.value)) console.log('     The proxy wants credentials: http://user:password@host:port in HTTPS_PROXY.');
        if (/ 403 /.test(probe.value)) console.log('     The proxy refuses this host: its policy (firewall rule) must allow it.');
      }

      const { sessionKey } = await browserManager.openSession({
        tenantId: 'egress-proxy-diagnostics',
        config: { navigationTimeoutMs: timeoutMs },
      });
      try {
        const navigation = await timed(() => browserManager.runAction(sessionKey, { type: 'goto', url: url.href }));
        const result = navigation.value;
        if (result.ok) {
          console.log(`OK   Browser loaded ${result.url} "${result.pageTitle ?? ''}" [${navigation.ms} ms]`);
        } else {
          failures += 1;
          console.log(`FAIL Browser: ${(result.errorMessage ?? 'failed').split('\n')[0]} [${navigation.ms} ms]`);
        }
        let failed: Array<{ url: string; failure?: string }> = [];
        try {
          failed = browserManager.getObservations(sessionKey).networkFailures;
        } catch {
          // The session was closed by the egress guard; the error above says why.
        }
        const byHost = new Map<string, string>();
        for (const entry of failed) {
          const host = new URL(entry.url).host;
          if (!byHost.has(host)) byHost.set(host, entry.failure ?? 'failed');
        }
        for (const [host, failure] of [...byHost].slice(0, 15)) {
          console.log(`     request to ${host} failed: ${failure}`);
        }
      } finally {
        await browserManager.closeSession(sessionKey, 'diagnostics').catch(() => undefined);
      }
    }
  } finally {
    await browserManager.shutdown();
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
