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
 * `assertSafeUrl` is the cheap synchronous pre-check (literal addresses and
 * internal-only names); `assertResolvedUrl` additionally resolves DNS.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import {
  assertPublicUrl,
  isPrivateIpAddress,
  privateNetworkBlockApplies,
  type OutboundGuardOptions,
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
  return { allowPrivate: resolveAllowPrivate(requested) };
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
    throw new Error(`Refusing to crawl private/loopback host: ${u.hostname}`);
  }
}

/** Resolves the host and refuses non-public targets. */
export async function assertResolvedUrl(rawUrl: string, allowPrivate?: boolean): Promise<void> {
  await assertPublicUrl(rawUrl, crawlerGuardOptions(allowPrivate));
}
