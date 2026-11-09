/**
 * Network policy for crawler requests.
 *
 * Crawl targets, redirect hops, browser sub-requests and webhook URLs follow
 * the shared outbound policy (`security/outboundFetch`): hostnames are
 * resolved and refused when any address is private, loopback, link-local,
 * CGNAT or metadata space, unless the host is on `OUTBOUND_HTTP_ALLOWED_HOSTS`.
 *
 * A crawler's `http.allowPrivateNetwork` flag only takes effect where the
 * deployment allows it (`CRAWLER_ALLOW_PRIVATE_NETWORK_OPT_IN`; default on for
 * self-hosted installs, off for hosted ones).
 *
 * `CRAWLER_RESOLVED_PRIVATE_POLICY` decides what happens to a host NAME that
 * resolves to such an address, or that is an internal-only name: `refuse`
 * blocks it, `warn` allows it and logs a rate-limited warning per host.
 * Literal addresses and `localhost` are refused under either value.
 *
 * Requests that travel through the configured egress proxy (HTTP(S)_PROXY)
 * are resolved by that proxy, which enforces egress policy for them; only the
 * literal pre-check applies in-process.
 *
 * `assertSafeUrl` is the cheap synchronous pre-check (literal addresses and
 * internal-only names); `assertResolvedUrl` additionally resolves DNS.
 */

import { isIP } from 'node:net';
import { getConfig } from '@/lib/core/config';
import {
  browserProxyRouting,
  isProxiedUrl,
  resolveBrowserProxyConfig,
  type BrowserProxyRouting,
} from '@/lib/core/browserProxyConfig';
import { createLogger } from '@/lib/core/logger';
import {
  assertPublicUrl,
  isPrivateIpAddress,
  privateNetworkBlockApplies,
  type OutboundGuardOptions,
  type PrivateNetworkAllowance,
} from '@/lib/security/outboundFetch';

const log = createLogger('crawler:network-policy');

const INTERNAL_NAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.svc',
  '.cluster.local',
  '.lan',
  '.home.arpa',
];

let optInWarned = false;

const WARN_INTERVAL_MS = 10 * 60 * 1000;
const WARN_MAX_HOSTS = 1000;
const lastWarnedAt = new Map<string, number>();

function warnResolvedPrivate(host: string): void {
  const now = Date.now();
  const last = lastWarnedAt.get(host);
  if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
  if (lastWarnedAt.size >= WARN_MAX_HOSTS) lastWarnedAt.clear();
  lastWarnedAt.set(host, now);
  log.warn(
    'Crawler request to a private-network host was allowed because CRAWLER_RESOLVED_PRIVATE_POLICY=warn; set it to "refuse" to block these requests',
    { host },
  );
}

/** Whether host names resolving to private addresses are allowed (with a warning) for crawler requests. */
function warnPolicyActive(): boolean {
  return getConfig().outboundHttp.crawlerResolvedPrivatePolicy === 'warn';
}

function isLiteralOrLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return isIP(h) !== 0 || h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0';
}

/**
 * Allowance handed to the shared outbound guard for crawler requests. Under
 * `warn` it lets a host NAME that resolves to a private address through (and
 * has the guard resolve `.local`/`.internal` names instead of refusing them);
 * literal addresses and loopback names stay refused. Under `refuse` it
 * permits nothing, so the guard behaves as without it. The policy is read at
 * call time, so the same object is safe to hold at module scope.
 */
export const crawlerResolvedPrivateAllowance: PrivateNetworkAllowance = Object.freeze({
  get hasRanges(): boolean {
    return warnPolicyActive();
  },
  permits(_address: string, host?: string): boolean {
    if (!warnPolicyActive() || !host || isLiteralOrLoopback(host)) return false;
    warnResolvedPrivate(host.toLowerCase());
    return true;
  },
});

/** Whether the crawler's private-network flag takes effect for this request. */
export function resolveAllowPrivate(requested?: boolean): boolean {
  if (!requested) return false;
  const { crawlerAllowPrivateOptIn } = getConfig().outboundHttp;
  if (crawlerAllowPrivateOptIn && !getConfig().deployment.isOnPrem && !optInWarned) {
    optInWarned = true;
    log.warn(
      'CRAWLER_ALLOW_PRIVATE_NETWORK_OPT_IN is enabled on a hosted deployment: crawlers may opt in to private-network targets',
    );
  }
  return crawlerAllowPrivateOptIn;
}

/** Guard options for the shared outbound helpers. */
export function crawlerGuardOptions(requested?: boolean): OutboundGuardOptions {
  return {
    allowPrivate: resolveAllowPrivate(requested),
    privateNetworks: crawlerResolvedPrivateAllowance,
  };
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h === '0.0.0.0') return true;
  if (h.includes(':') || /^[0-9.]+$/.test(h)) return isPrivateIpAddress(h);
  if (!h.includes('.')) return true; // single-label names only resolve inside a network
  return INTERNAL_NAME_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/** Synchronous check on the literal host. Throws when the target is refused. */
export function assertSafeUrl(rawUrl: string, allowPrivate?: boolean): void {
  const options = crawlerGuardOptions(allowPrivate);
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    // URL parse error: let the fetcher surface it as a fetch failure.
    return;
  }
  if (!privateNetworkBlockApplies(u.hostname, options)) return;
  if (isPrivateHost(u.hostname)) {
    // Internal-only names (not addresses, not localhost) follow the resolved-host policy.
    if (warnPolicyActive() && !isLiteralOrLoopback(u.hostname)) {
      warnResolvedPrivate(u.hostname.toLowerCase());
      return;
    }
    throw new Error(`Refusing to crawl private/loopback host: ${u.hostname}`);
  }
}

/** Routing of the egress proxy configured through HTTP(S)_PROXY / NO_PROXY, if any. */
export function egressProxyRouting(): BrowserProxyRouting | undefined {
  return browserProxyRouting(resolveBrowserProxyConfig());
}

/**
 * Whether `rawUrl` travels through the egress proxy. `routing` is the routing
 * the caller's client actually uses (`null`: direct); omitted, it is the one
 * derived from the proxy environment variables.
 */
export function isProxiedByEgress(rawUrl: string, routing?: BrowserProxyRouting | null): boolean {
  const effective = routing === undefined ? egressProxyRouting() : (routing ?? undefined);
  if (!effective) return false;
  try {
    return isProxiedUrl(new URL(rawUrl), effective);
  } catch {
    return false;
  }
}

/**
 * Resolves the host and refuses non-public targets. A request that goes
 * through the egress proxy is resolved by the proxy, which enforces egress
 * policy for it, so only the literal pre-check runs in-process.
 */
export async function assertResolvedUrl(
  rawUrl: string,
  allowPrivate?: boolean,
  proxyRouting?: BrowserProxyRouting | null,
): Promise<void> {
  if (isProxiedByEgress(rawUrl, proxyRouting)) {
    assertSafeUrl(rawUrl, allowPrivate);
    return;
  }
  await assertPublicUrl(rawUrl, crawlerGuardOptions(allowPrivate));
}
