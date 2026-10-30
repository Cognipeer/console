/**
 * Regression test for a live incident: on a network that requires an egress
 * proxy (HTTP(S)_PROXY set, matching what stdioRunner.ts already forwards to
 * MCP subprocesses), the crawler's axios engine worked while both the
 * interactive Browser feature and the crawler's Playwright engine could not
 * reach ANY external site — not just a blocked one, not even the simplest
 * page — because chromium.launch() never received the proxy Chromium itself
 * does not read from the environment. The only visible symptom was every
 * page.goto() eventually hitting Playwright's own 30s timeout.
 *
 * The routing helpers below decide, for the browser's egress guard, whether a
 * request goes through that proxy or straight out; they must read the bypass
 * rules exactly the way Chromium does (the end-to-end proof against a real
 * Chromium is in integration/browser-egress-proxy.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  browserProxyRouting,
  explainProxyNetworkError,
  isProxiedUrl,
  resolveBrowserProxyConfig,
  safeProxyHost,
  toChromiumBypassList,
} from '@/lib/core/browserProxyConfig';

const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'HTTPS_Proxy', 'No_proxy'];

function clearProxyEnv(): void {
  for (const key of PROXY_VARS) delete process.env[key];
}

describe('resolveBrowserProxyConfig', () => {
  afterEach(() => {
    clearProxyEnv();
  });

  it('returns undefined when no proxy env var is set — unchanged default for every existing deployment', () => {
    clearProxyEnv();
    expect(resolveBrowserProxyConfig()).toBeUndefined();
  });

  it('prefers HTTPS_PROXY over HTTP_PROXY when both are set', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://https-proxy.internal:8080';
    process.env.HTTP_PROXY = 'http://http-proxy.internal:8080';
    expect(resolveBrowserProxyConfig()).toEqual({ server: 'http://https-proxy.internal:8080' });
  });

  it('falls back to HTTP_PROXY when HTTPS_PROXY is not set', () => {
    clearProxyEnv();
    process.env.HTTP_PROXY = 'http://proxy.internal:3128';
    expect(resolveBrowserProxyConfig()).toEqual({ server: 'http://proxy.internal:3128' });
  });

  it('honours the lowercase variants some environments set instead', () => {
    clearProxyEnv();
    process.env.https_proxy = 'http://lower-case-proxy.internal:8080';
    expect(resolveBrowserProxyConfig()).toEqual({ server: 'http://lower-case-proxy.internal:8080' });
  });

  it('honours a mixed-case spelling (HTTPS_Proxy, No_proxy) that only Python tooling would otherwise read', () => {
    clearProxyEnv();
    process.env.HTTPS_Proxy = 'http://proxy.corp.example:8080';
    process.env.No_proxy = 'corp.example';
    expect(resolveBrowserProxyConfig()).toEqual({
      server: 'http://proxy.corp.example:8080',
      bypass: 'corp.example,*.corp.example',
    });
  });

  it('turns NO_PROXY into Chromium bypass rules when a proxy is configured', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://proxy.internal:8080';
    process.env.NO_PROXY = 'localhost,.internal,10.0.0.0/8';
    expect(resolveBrowserProxyConfig()).toEqual({
      server: 'http://proxy.internal:8080',
      bypass: 'localhost,*.localhost,*.internal,10.0.0.0/8',
    });
  });

  it('omits bypass entirely when NO_PROXY is not set', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://proxy.internal:8080';
    const result = resolveBrowserProxyConfig();
    expect(result).toEqual({ server: 'http://proxy.internal:8080' });
    expect(result).not.toHaveProperty('bypass');
  });

  it('splits embedded basic-auth credentials out of the server URL — Chromium ignores them in --proxy-server', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://svc%40corp:p%3Ass@proxy.internal:3128';
    expect(resolveBrowserProxyConfig()).toEqual({
      server: 'http://proxy.internal:3128',
      username: 'svc@corp',
      password: 'p:ss',
    });
  });

  it('passes a scheme-less host:port through untouched', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'proxy.internal:3128';
    expect(resolveBrowserProxyConfig()).toEqual({ server: 'proxy.internal:3128' });
  });
});

describe('toChromiumBypassList', () => {
  it('extends a plain domain entry to its subdomains, as curl and Go read NO_PROXY', () => {
    expect(toChromiumBypassList('corp.example')).toBe('corp.example,*.corp.example');
    expect(toChromiumBypassList('corp.example:8443')).toBe('corp.example:8443,*.corp.example:8443');
  });

  it('keeps a leading-dot or wildcard entry to subdomains only', () => {
    expect(toChromiumBypassList('.corp.example')).toBe('*.corp.example');
    expect(toChromiumBypassList('*.corp.example')).toBe('*.corp.example');
  });

  it('passes addresses and CIDR ranges through, bracketing a bare IPv6 address', () => {
    expect(toChromiumBypassList('127.0.0.1,10.0.0.0/8,10.1.2.3:8080')).toBe('127.0.0.1,10.0.0.0/8,10.1.2.3:8080');
    expect(toChromiumBypassList('::1,fd00::/8,[::1]:8080')).toBe('[::1],fd00::/8,[::1]:8080');
  });

  it('keeps Chromium syntax it does not need to translate', () => {
    expect(toChromiumBypassList('<local>,https://x.example,intra*.example')).toBe('<local>,https://x.example,intra*.example');
  });

  it('accepts whitespace and semicolons as separators, drops duplicates and empties', () => {
    expect(toChromiumBypassList(' a.example ; a.example,, b.example ')).toBe('a.example,*.a.example,b.example,*.b.example');
    expect(toChromiumBypassList(' , ')).toBeUndefined();
  });

  it('reads a lone * as bypass everything', () => {
    expect(toChromiumBypassList('localhost,*')).toBe('*');
  });
});

describe('isProxiedUrl', () => {
  const proxied = (url: string, bypass?: string) =>
    isProxiedUrl(new URL(url), { server: 'http://proxy.corp.example:3128', ...(bypass ? { bypass } : {}) });

  it('sends everything through the proxy when nothing bypasses it, and nothing when there is no proxy', () => {
    expect(proxied('https://www.example.com/')).toBe(true);
    expect(isProxiedUrl(new URL('https://www.example.com/'), undefined)).toBe(false);
  });

  it('matches host names exactly unless the rule has a wildcard, as Chromium does', () => {
    const bypass = 'corp.example,*.svc.cluster.local,.intra.example';
    expect(proxied('http://corp.example/', bypass)).toBe(false);
    expect(proxied('http://app.corp.example/', bypass)).toBe(true);
    expect(proxied('http://api.ns.svc.cluster.local:8080/', bypass)).toBe(false);
    expect(proxied('http://svc.cluster.local/', bypass)).toBe(true);
    expect(proxied('http://wiki.intra.example/', bypass)).toBe(false);
    expect(proxied('http://CORP.EXAMPLE./', bypass)).toBe(false);
  });

  it('honours a port or a scheme in the rule', () => {
    expect(proxied('http://corp.example:8080/', 'corp.example:8080')).toBe(false);
    expect(proxied('http://corp.example/', 'corp.example:8080')).toBe(true);
    expect(proxied('https://corp.example/', 'corp.example:443')).toBe(false);
    expect(proxied('http://corp.example/', 'https://corp.example')).toBe(true);
    expect(proxied('https://corp.example/', 'https://corp.example')).toBe(false);
  });

  it('matches address and CIDR rules against address literals only', () => {
    const bypass = '10.0.0.0/8,192.168.1.5,[::1],fd00::/8';
    expect(proxied('http://10.20.30.40/', bypass)).toBe(false);
    expect(proxied('http://11.0.0.1/', bypass)).toBe(true);
    expect(proxied('http://192.168.1.5:9000/', bypass)).toBe(false);
    expect(proxied('http://[::1]:3000/', bypass)).toBe(false);
    expect(proxied('http://[fd12::1]/', bypass)).toBe(false);
    expect(proxied('http://ten.example/', bypass)).toBe(true);
  });

  it('understands <local> and *, and ignores <-loopback>', () => {
    expect(proxied('http://intranet/', '<local>')).toBe(false);
    expect(proxied('http://intranet.example/', '<local>')).toBe(true);
    expect(proxied('http://anything.example/', '*')).toBe(false);
    expect(proxied('http://anything.example/', '<-loopback>')).toBe(true);
  });

  it('agrees with what toChromiumBypassList emits for NO_PROXY', () => {
    const bypass = toChromiumBypassList('corp.example,.svc.cluster.local,10.0.0.0/8');
    expect(proxied('http://corp.example/', bypass)).toBe(false);
    expect(proxied('http://app.corp.example/', bypass)).toBe(false);
    expect(proxied('http://notcorp.example/', bypass)).toBe(true);
    expect(proxied('http://x.ns.svc.cluster.local/', bypass)).toBe(false);
    expect(proxied('http://10.1.1.1/', bypass)).toBe(false);
  });
});

describe('browserProxyRouting', () => {
  const env = { server: 'http://proxy.corp.example:3128', bypass: 'localhost' };

  it('is the env-derived proxy when no Chromium flag overrides it', () => {
    expect(browserProxyRouting(env, ['--disable-gpu'])).toEqual(env);
    expect(browserProxyRouting(undefined, [])).toBeUndefined();
  });

  it('lets BROWSER_CHROMIUM_EXTRA_ARGS override the proxy and the bypass list', () => {
    expect(browserProxyRouting(env, ['--proxy-bypass-list=*.corp.example;localhost'])).toEqual({
      server: env.server,
      bypass: '*.corp.example;localhost',
    });
    expect(browserProxyRouting(undefined, ['--proxy-server=http://other:8080'])).toEqual({ server: 'http://other:8080' });
  });

  it('reports direct routing when the flags turn the proxy off or hand it to a PAC script', () => {
    expect(browserProxyRouting(env, ['--no-proxy-server'])).toBeUndefined();
    expect(browserProxyRouting(env, ['--proxy-pac-url=http://wpad/proxy.pac'])).toBeUndefined();
  });
});

describe('explainProxyNetworkError', () => {
  const routing = { server: 'http://user:secret@proxy.corp.example:3128' };

  it('names the proxy without its credentials when the browser cannot reach it', () => {
    const hint = explainProxyNetworkError('page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://x/', routing);
    expect(hint).toContain('proxy.corp.example:3128');
    expect(hint).not.toContain('secret');
  });

  it('explains a refused tunnel and a certificate re-signed by an inspecting proxy', () => {
    expect(explainProxyNetworkError('net::ERR_TUNNEL_CONNECTION_FAILED', routing)).toMatch(/refused the connection/);
    expect(explainProxyNetworkError('net::ERR_CERT_AUTHORITY_INVALID', routing)).toMatch(/BROWSER_IGNORE_CERTIFICATE_ERRORS/);
  });

  it('says nothing without a proxy, or for an error that is not about one', () => {
    expect(explainProxyNetworkError('net::ERR_TUNNEL_CONNECTION_FAILED', undefined)).toBeUndefined();
    expect(explainProxyNetworkError('net::ERR_NAME_NOT_RESOLVED', routing)).toBeUndefined();
  });
});

describe('safeProxyHost', () => {
  it('keeps host and port only, with or without a scheme', () => {
    expect(safeProxyHost('http://user:pass@proxy.corp.example:3128')).toBe('proxy.corp.example:3128');
    expect(safeProxyHost('proxy.corp.example:3128')).toBe('proxy.corp.example:3128');
  });
});
