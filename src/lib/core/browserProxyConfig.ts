/**
 * Resolves a Playwright `proxy` launch option from the standard
 * HTTP(S)_PROXY / NO_PROXY environment variables -- the same variables
 * `stdioRunner.ts` already forwards to MCP subprocesses for on-prem
 * deployments that egress through a corporate proxy.
 *
 * Chromium cannot be relied on to read these env vars itself: it does so
 * only on Linux and only when launched without a proxy flag, applies
 * `http_proxy` to http:// URLs alone, never sees a `HTTPS_Proxy`, and
 * Playwright cannot answer the proxy's authentication challenge with
 * credentials it was never given. Most Node HTTP clients (axios, undici)
 * honor the variables directly or through a configured agent, so on a
 * network that requires an egress proxy, every OTHER outbound path in the
 * same process keeps working while a headless browser launched without this
 * cannot reach the public internet at all -- not even a single trivial page.
 * The only visible symptom is every `page.goto()` eventually hitting
 * Playwright's default timeout, with nothing that names a proxy as the cause.
 */
import { BlockList, isIP } from 'node:net';
import { readEgressProxyEnv } from './proxyEnv';

export interface BrowserProxyConfig {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

/** Where Chromium sends requests: a proxy and the rules that bypass it. */
export type BrowserProxyRouting = Pick<BrowserProxyConfig, 'server' | 'bypass'>;

export function resolveBrowserProxyConfig(): BrowserProxyConfig | undefined {
  const { proxy, noProxy } = readEgressProxyEnv();
  if (!proxy) return undefined;

  const bypass = noProxy ? toChromiumBypassList(noProxy.value) : undefined;
  const { server, username, password } = splitProxyCredentials(proxy.value);
  return {
    server,
    ...(bypass ? { bypass } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/**
 * NO_PROXY rewritten as Chromium bypass rules, keeping the meaning curl, Go
 * and most HTTP tooling give it.
 *
 * Chromium reads a rule like `corp.example` as that host alone, where
 * NO_PROXY means the domain and everything under it: passed through as-is,
 * `NO_PROXY=corp.example` sent `app.corp.example` to a proxy that cannot
 * reach it -- one more request that only ever surfaced as a navigation
 * timeout. A plain domain entry (optionally with `:port`) therefore becomes
 * the domain plus `*.` its subdomains. `.corp.example` and `*.corp.example`
 * stay subdomains-only, as Go and Chromium read them (curl would add the
 * domain itself). Addresses and CIDR ranges pass through (a bare IPv6 address
 * in brackets, the only form Chromium matches); anything else is assumed to
 * be Chromium's own rule syntax already (`<local>`, a scheme, a mid-name `*`).
 */
export function toChromiumBypassList(noProxy: string): string | undefined {
  const rules: string[] = [];
  for (const entry of noProxy.split(/[\s,;]+/)) {
    if (!entry) continue;
    if (entry === '*') return '*';
    const address = addressRule(entry);
    if (address) {
      rules.push(address);
      continue;
    }
    const domain = DOMAIN_ENTRY.exec(entry);
    if (!domain) {
      rules.push(entry);
      continue;
    }
    const [, subdomainsOnly, name, port = ''] = domain;
    if (!subdomainsOnly) rules.push(`${name}${port}`);
    rules.push(`*.${name}${port}`);
  }
  const unique = [...new Set(rules)];
  return unique.length > 0 ? unique.join(',') : undefined;
}

/** `corp.example`, `.corp.example` or `*.corp.example`, with an optional `:port`. */
const DOMAIN_ENTRY = /^(\*?\.)?((?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)(:\d{1,5})?$/i;

function addressRule(entry: string): string | undefined {
  const slash = entry.indexOf('/');
  if (slash > 0) return isIP(entry.slice(0, slash).replace(/^\[|\]$/g, '')) ? entry : undefined;
  if (isIP(entry) === 6) return `[${entry}]`;
  if (isIP(entry) === 4) return entry;
  const withPort = /^(\[[^\]]+\]|[\d.]+):\d{1,5}$/.exec(entry);
  return withPort && isIP(withPort[1].replace(/^\[|\]$/g, '')) ? entry : undefined;
}

/**
 * The routing Chromium ends up with once BROWSER_CHROMIUM_EXTRA_ARGS are
 * applied on top of the env-derived proxy: Playwright appends them after its
 * own `--proxy-server` / `--proxy-bypass-list`, and the last one wins.
 * Undefined -- every request direct, as far as anything here can tell --
 * when there is no proxy or when only a PAC script would know.
 */
export function browserProxyRouting(
  proxy: BrowserProxyRouting | undefined,
  chromiumArgs: readonly string[] = [],
): BrowserProxyRouting | undefined {
  let server = proxy?.server;
  let bypass = proxy?.bypass;
  for (const arg of chromiumArgs) {
    const [flag, ...value] = arg.split('=');
    if (flag === '--no-proxy-server' || flag === '--proxy-pac-url' || flag === '--proxy-auto-detect') return undefined;
    if (flag === '--proxy-server') server = value.join('=');
    if (flag === '--proxy-bypass-list') bypass = value.join('=');
  }
  if (!server) return undefined;
  return bypass ? { server, bypass } : { server };
}

/**
 * Whether Chromium hands a request for `url` to the proxy rather than
 * connecting itself, by Chromium's bypass rule syntax: the rules
 * `toChromiumBypassList` emits and a browser profile's own proxy carries.
 */
export function isProxiedUrl(url: URL, routing: BrowserProxyRouting | undefined): boolean {
  if (!routing?.server) return false;
  if (!routing.bypass) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const port = Number(url.port) || (scheme === 'https' || scheme === 'wss' ? 443 : 80);
  return !routing.bypass
    .split(/[\s,;]+/)
    .some((rule) => rule !== '' && bypassRuleMatches(rule.toLowerCase(), host, scheme, port));
}

function bypassRuleMatches(rule: string, host: string, scheme: string, port: number): boolean {
  if (rule === '*') return true;
  if (rule === '<local>') return !host.includes('.') && !isIP(host);
  if (rule.startsWith('<')) return false;

  let rest = rule;
  const schemeEnd = rest.indexOf('://');
  if (schemeEnd > 0) {
    if (rest.slice(0, schemeEnd) !== scheme) return false;
    rest = rest.slice(schemeEnd + 3);
  }

  const slash = rest.indexOf('/');
  if (slash > 0) {
    const family = isIP(host);
    const base = rest.slice(0, slash).replace(/^\[|\]$/g, '');
    const prefix = Number(rest.slice(slash + 1));
    if (!family || isIP(base) !== family || !Number.isInteger(prefix)) return false;
    const range = new BlockList();
    try {
      range.addSubnet(base, prefix, family === 6 ? 'ipv6' : 'ipv4');
    } catch {
      return false;
    }
    return range.check(host, family === 6 ? 'ipv6' : 'ipv4');
  }

  let pattern = rest;
  let rulePort: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracketed) {
    pattern = bracketed[1];
    rulePort = bracketed[2] ? Number(bracketed[2]) : undefined;
  } else if (!isIP(rest)) {
    const colon = rest.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
      pattern = rest.slice(0, colon);
      rulePort = Number(rest.slice(colon + 1));
    }
  }
  if (rulePort !== undefined && rulePort !== port) return false;

  if (isIP(pattern)) {
    if (isIP(host) !== isIP(pattern)) return false;
    const single = new BlockList();
    single.addAddress(pattern, isIP(pattern) === 6 ? 'ipv6' : 'ipv4');
    return single.check(host, isIP(host) === 6 ? 'ipv6' : 'ipv4');
  }
  if (pattern.startsWith('.')) pattern = `*${pattern}`;
  const glob = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${glob}$`).test(host);
}

/**
 * What a Chromium network error means when the browser egresses through a
 * proxy, for errors that otherwise read as if the site itself were broken.
 */
export function explainProxyNetworkError(
  message: string,
  routing: BrowserProxyRouting | undefined,
): string | undefined {
  if (!routing?.server) return undefined;
  const proxyHost = safeProxyHost(routing.server) ?? 'the proxy';
  if (message.includes('ERR_PROXY_CONNECTION_FAILED')) {
    return `The browser could not connect to the egress proxy ${proxyHost} (HTTPS_PROXY / HTTP_PROXY): check the address and that this server may reach it.`;
  }
  if (message.includes('ERR_PROXY_AUTH') || message.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
    return `The egress proxy ${proxyHost} refused the connection to this host: its policy (firewall rule) does not allow it, it cannot reach it, or it wants credentials -- put them in the proxy URL (http://user:password@host:port).`;
  }
  if (/ERR_CERT_(AUTHORITY_INVALID|COMMON_NAME_INVALID|INVALID)/.test(message)) {
    return 'A TLS-inspecting proxy re-signs certificates with its own CA, which Chromium does not trust; see BROWSER_IGNORE_CERTIFICATE_ERRORS.';
  }
  return undefined;
}

/** `host:port`, stripped of scheme and any embedded basic-auth credentials — safe to log. */
export function safeProxyHost(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Corporate proxy URLs commonly embed basic-auth credentials
 * (`http://user:pass@host:3128`). Chromium ignores credentials in
 * `--proxy-server`, so Playwright needs them as separate `username` /
 * `password` fields; left in the URL the proxy answers 407 (or the request
 * stalls) and surfaces only as a navigation timeout.
 */
function splitProxyCredentials(raw: string): { server: string; username?: string; password?: string } {
  // Bare `host:port` is valid for Playwright (treated as HTTP) but not for
  // `new URL`, which would read `host` as the scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hasScheme) return { server: raw };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { server: raw };
  }
  if (!parsed.username && !parsed.password) return { server: raw };

  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    username: decode(parsed.username),
    password: decode(parsed.password),
  };
}
