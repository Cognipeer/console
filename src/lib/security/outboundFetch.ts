/**
 * SSRF guard for outbound HTTP requests to tenant-supplied URLs.
 *
 * Services that fetch URLs configured by tenant users (tools, MCP servers,
 * custom rerankers, connected agents, inference pollers) must go through
 * `safeFetch` (or at minimum `assertPublicUrl`) instead of calling `fetch`
 * directly. The guard:
 *
 *  - allows only http/https URLs,
 *  - resolves hostnames via DNS and rejects anything that maps to loopback,
 *    private, link-local, CGNAT, or cloud-metadata address space,
 *  - re-validates every redirect hop (a public host redirecting to a private
 *    one is the classic bypass),
 *  - enforces a timeout via AbortController.
 *
 * Behaviour is controlled by `config.outboundHttp`:
 *  - `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` (default `true`)
 *  - `OUTBOUND_HTTP_ALLOWED_HOSTS` — exact hostnames or `.suffix` entries
 *    exempted from the block (for self-hosted deployments that legitimately
 *    call in-network services)
 *  - `OUTBOUND_HTTP_DEFAULT_TIMEOUT_MS` (default 30s)
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

import { getConfig } from '@/lib/core/config';

const HOST_CACHE_TTL_MS = 30_000;
const MAX_REDIRECTS = 5;

const hostPrivacyCache = new Map<string, { privateNetwork: boolean; expiresAt: number }>();

export class OutboundNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundNetworkError';
  }
}

export function isPrivateIpAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127) // CGNAT
      || (a === 169 && b === 254) // link-local + cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)) // benchmarking
      || a >= 224 // multicast + reserved
    );
  }

  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      return isPrivateIpAddress(normalized.slice('::ffff:'.length));
    }
    if (normalized === '::' || normalized === '::1') return true;
    const firstGroup = normalized.replace(/^\[|\]$/g, '').split(':')[0] || '0';
    // fc00::/7 unique-local, fe80::/10 link-local
    if (firstGroup.startsWith('fc') || firstGroup.startsWith('fd')) return true;
    if (firstGroup.startsWith('fe8') || firstGroup.startsWith('fe9')
      || firstGroup.startsWith('fea') || firstGroup.startsWith('feb')) return true;
    return false;
  }

  // Not a literal IP — caller should DNS-resolve instead.
  return true;
}

function isLocalHostname(host: string): boolean {
  return (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host === 'localhost.localdomain'
    || host.endsWith('.local')
    || host.endsWith('.internal')
  );
}

function isAllowlistedHost(host: string, allowedHosts: string[]): boolean {
  const h = host.toLowerCase();
  return allowedHosts.some((entry) => {
    const e = entry.toLowerCase();
    if (!e) return false;
    if (e.startsWith('.')) return h === e.slice(1) || h.endsWith(e);
    return h === e;
  });
}

async function resolvesToPrivateNetwork(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isLocalHostname(bare)) return true;
  if (isIP(bare)) return isPrivateIpAddress(bare);

  const cached = hostPrivacyCache.get(bare);
  if (cached && cached.expiresAt > Date.now()) return cached.privateNetwork;

  let privateNetwork = true;
  try {
    const records = await lookup(bare, { all: true, verbatim: true });
    privateNetwork = records.length === 0
      || records.some((record) => isPrivateIpAddress(record.address));
  } catch {
    privateNetwork = true;
  }

  hostPrivacyCache.set(bare, { privateNetwork, expiresAt: Date.now() + HOST_CACHE_TTL_MS });
  return privateNetwork;
}

export interface OutboundGuardOptions {
  /** Skip the private-network check entirely (trusted, operator-configured targets). */
  allowPrivate?: boolean;
}

/**
 * Throws `OutboundNetworkError` when the URL is not a public http(s) target.
 * DNS-resolves hostnames, so names pointing at private IPs are also rejected.
 */
export async function assertPublicUrl(rawUrl: string, options?: OutboundGuardOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundNetworkError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundNetworkError(`Unsupported protocol for outbound request: ${url.protocol}`);
  }

  const { blockPrivateNetwork, allowedHosts } = getConfig().outboundHttp;
  if (!blockPrivateNetwork || options?.allowPrivate) return url;
  if (isAllowlistedHost(url.hostname, allowedHosts)) return url;

  if (await resolvesToPrivateNetwork(url.hostname)) {
    throw new OutboundNetworkError(
      `Refusing outbound request to private/loopback host: ${url.hostname}`,
    );
  }
  return url;
}

export interface SafeFetchOptions extends OutboundGuardOptions {
  /** Abort the request after this many ms (default `OUTBOUND_HTTP_DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/**
 * `fetch` with SSRF protection and a timeout. Redirects are followed manually
 * (up to 5 hops) so each hop is re-validated against the private-network
 * guard.
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
  options?: SafeFetchOptions,
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? getConfig().outboundHttp.defaultTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init?.signal;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    let currentUrl = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = await assertPublicUrl(currentUrl, options);
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return response;
        if (hop === MAX_REDIRECTS) {
          throw new OutboundNetworkError(`Too many redirects fetching ${rawUrl}`);
        }
        currentUrl = new URL(location, url).toString();
        // Per fetch semantics, drop the body when a redirect downgrades to GET.
        if (response.status === 303 && init?.method && init.method !== 'GET' && init.method !== 'HEAD') {
          init = { ...init, method: 'GET', body: undefined };
        }
        continue;
      }

      return response;
    }
    throw new OutboundNetworkError(`Too many redirects fetching ${rawUrl}`);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
