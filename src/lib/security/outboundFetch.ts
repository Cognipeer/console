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
import { Agent, buildConnector } from 'undici';

import { getConfig } from '@/lib/core/config';

const HOST_CACHE_TTL_MS = 30_000;
const MAX_REDIRECTS = 5;

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

const hostPrivacyCache = new Map<string, { privateNetwork: boolean; addresses: ResolvedAddress[]; expiresAt: number }>();

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
    const groups = expandIpv6(ip);
    if (!groups) return true;
    const zero = (from: number, to: number): boolean => groups.slice(from, to).every((g) => g === 0);
    const embeddedV4 = (hi: number, lo: number): string =>
      `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

    // ::ffff:a.b.c.d — IPv4-mapped, in BOTH spellings (`::ffff:7f00:1` is the
    // hex form of `::ffff:127.0.0.1`; the old prefix check only understood the
    // dotted one). The verdict is the embedded address's.
    if (zero(0, 5) && groups[5] === 0xffff) return isPrivateIpAddress(embeddedV4(groups[6], groups[7]));
    // :: and ::1, plus the deprecated IPv4-compatible `::a.b.c.d`.
    if (zero(0, 6)) {
      if (groups[6] === 0 && groups[7] <= 1) return true;
      return isPrivateIpAddress(embeddedV4(groups[6], groups[7]));
    }
    // 64:ff9b::/96 — NAT64. The last 32 bits are an IPv4 address reached
    // through a translator, so it is that address that decides.
    if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) {
      return isPrivateIpAddress(embeddedV4(groups[6], groups[7]));
    }
    // 2002::/16 — 6to4. Bits 16..47 carry the IPv4 relay/host address.
    if (groups[0] === 0x2002) return isPrivateIpAddress(embeddedV4(groups[1], groups[2]));

    const first = groups[0];
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated, still routed internally)
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast — as the IPv4 side blocks 224+
    return false;
  }

  // Not a literal IP — caller should DNS-resolve instead.
  return true;
}

/**
 * The eight 16-bit groups of an IPv6 literal, or null when it cannot be read.
 * `isIP` has already accepted the string, so this is parsing, not validation:
 * brackets and a zone id are dropped, `::` is expanded, and an embedded dotted
 * IPv4 tail (`::ffff:10.0.0.1`, `64:ff9b::10.0.0.1`) becomes its two groups so
 * every special prefix below is tested on numbers rather than on spellings.
 */
function expandIpv6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parts = tail.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [...head, ...new Array<string>(missing).fill('0'), ...rest].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return null;
  return groups;
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

/**
 * Exact-hostname or `.suffix` match against `OUTBOUND_HTTP_ALLOWED_HOSTS`.
 * Exported so save-time validators (e.g. the AI App Gateway upstream URL
 * schema) can accept exactly the hosts the runtime guard will accept.
 */
export function isAllowlistedHost(host: string, allowedHosts: string[]): boolean {
  const h = host.toLowerCase();
  return allowedHosts.some((entry) => {
    const e = entry.toLowerCase();
    if (!e) return false;
    if (e.startsWith('.')) return h === e.slice(1) || h.endsWith(e);
    return h === e;
  });
}

/**
 * Resolves a hostname and reports both the private/public verdict and the
 * addresses that verdict was based on. Cached per the guard's existing TTL —
 * the addresses are cached alongside the verdict, not re-resolved
 * separately, but `assertPublicUrl` always does its own connection-time
 * `dns.lookup()` for the pin (see `resolvePinnedAddresses`) rather than trust
 * this cache for that: a stale-but-still-public cache entry is fine for the
 * policy question "is this host allowed at all", but pinning specifically
 * exists to close the gap between "resolved" and "connected", which a cache
 * up to 30s old would reopen.
 */
async function resolvesToPrivateNetwork(host: string): Promise<{ privateNetwork: boolean; addresses: ResolvedAddress[] }> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isLocalHostname(bare)) return { privateNetwork: true, addresses: [] };
  if (isIP(bare)) {
    const family = isIP(bare) as 4 | 6;
    return { privateNetwork: isPrivateIpAddress(bare), addresses: [{ address: bare, family }] };
  }

  const cached = hostPrivacyCache.get(bare);
  if (cached && cached.expiresAt > Date.now()) {
    return { privateNetwork: cached.privateNetwork, addresses: cached.addresses };
  }

  let privateNetwork = true;
  let addresses: ResolvedAddress[] = [];
  try {
    const records = await lookup(bare, { all: true, verbatim: true });
    addresses = records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
    privateNetwork = records.length === 0
      || records.some((record) => isPrivateIpAddress(record.address));
  } catch {
    privateNetwork = true;
  }

  hostPrivacyCache.set(bare, { privateNetwork, addresses, expiresAt: Date.now() + HOST_CACHE_TTL_MS });
  return { privateNetwork, addresses };
}

/**
 * Connection-time resolution used to pin the socket `fetch` opens to the
 * exact address the SSRF guard just validated. Deliberately NOT the cached
 * lookup above: this runs immediately before the connection it protects, so
 * an attacker controlling DNS cannot answer differently between "checked"
 * and "connected" — there is no gap left to rebind into. Returns null for a
 * hostname that fails to resolve here (the caller falls back to plain
 * `fetch`, which will fail with its own DNS error) or resolves to a private
 * address on this fresh lookup (caller re-runs the guard, which will reject
 * it the normal way).
 */
async function resolvePinnedAddresses(host: string): Promise<ResolvedAddress[]> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return []; // nothing to pin -- the destination already is the address
  try {
    const records = await lookup(bare, { all: true, verbatim: true });
    return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
  } catch {
    return [];
  }
}

/**
 * An undici dispatcher whose connector resolves ONLY to `pinned`, regardless
 * of what DNS says for the hostname in the request URL. Built fresh per
 * fetch call (never shared/cached) so it can never be reused for an
 * unrelated request.
 *
 * ALL validated addresses are handed to the connector, not just the first:
 * every one of them was checked as public a moment ago, and pinning to a
 * single record would silently drop the dual-stack failover a normal
 * `fetch` has — a host whose first DNS answer is an AAAA record this
 * container cannot route would go from "works" to "always fails".
 *
 * Keep-alive is turned down to the minimum because this dispatcher serves
 * exactly ONE request and is then dropped: undici's default would hold the
 * socket open for another request that, by construction, never comes — one
 * leaked file descriptor per outbound call, which a crawl run reaches the
 * process FD limit with.
 */
function pinnedDispatcher(pinned: ResolvedAddress[]): Agent {
  return new Agent({
    connect: buildConnector({
      lookup: (_hostname, _options, callback) => {
        callback(null, pinned.map(({ address, family }) => ({ address, family })));
      },
    }),
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });
}

/**
 * Close a per-request dispatcher once nothing will read from it again.
 * `destroy()` (not `close()`) because a redirect hop's response body is
 * deliberately abandoned unread — `close()` waits for in-flight requests to
 * drain, which for an unread body means waiting forever.
 */
function discardDispatcher(dispatcher: Agent | undefined): void {
  if (!dispatcher) return;
  void dispatcher.destroy().catch(() => {
    /* the socket is going away regardless; nothing to recover here */
  });
}

export interface OutboundGuardOptions {
  /** Skip the private-network check entirely (trusted, operator-configured targets). */
  allowPrivate?: boolean;
  /**
   * Run the private-network check REGARDLESS of `OUTBOUND_HTTP_BLOCK_PRIVATE_
   * NETWORK`, `OUTBOUND_HTTP_ALLOWED_HOSTS` and `allowPrivate`.
   *
   * The deployment switches answer "may THIS PROCESS reach in-network
   * services" — a self-hosted console whose rerankers live on 10.x turns the
   * block off. A tenant's `denyPrivateNetworks` tool policy answers a different
   * question — "may this TOOL reach them" — and must not be disarmed by an
   * operator's egress allowance without anyone seeing it. Policy checks pass
   * this; transport calls do not.
   */
  forceBlock?: boolean;
}

/**
 * Throws `OutboundNetworkError` when the URL is not a public http(s) target.
 * DNS-resolves hostnames, so names pointing at private IPs are also rejected.
 */
export async function assertPublicUrl(rawUrl: string, options?: OutboundGuardOptions): Promise<URL> {
  return (await checkPublicUrl(rawUrl, options)).url;
}

/**
 * Same validation as `assertPublicUrl`, plus the address that validation
 * decided was public — used by `safeFetch` to pin the actual connection to
 * it. Kept separate from `assertPublicUrl` so callers that only need the
 * policy check (e.g. the tool-access guardrail) are unaffected.
 */
async function checkPublicUrl(
  rawUrl: string,
  options?: OutboundGuardOptions,
): Promise<{ url: URL; pinned: ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundNetworkError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundNetworkError(`Unsupported protocol for outbound request: ${url.protocol}`);
  }

  if (!options?.forceBlock) {
    const { blockPrivateNetwork, allowedHosts } = getConfig().outboundHttp;
    if (!blockPrivateNetwork || options?.allowPrivate) return { url, pinned: [] };
    if (isAllowlistedHost(url.hostname, allowedHosts)) return { url, pinned: [] };
  }

  const { privateNetwork } = await resolvesToPrivateNetwork(url.hostname);
  if (privateNetwork) {
    throw new OutboundNetworkError(
      `Refusing outbound request to private/loopback host: ${url.hostname}`,
    );
  }

  // Fresh, connection-time resolution for the pin (see resolvePinnedAddresses)
  // -- re-checked for privacy in case DNS answers differently on this second
  // lookup than it did a moment ago on the cached/policy one above. EVERY
  // returned address must be public: handing the connector a list where only
  // the first was checked would let a second, private record be the one it
  // actually connects to.
  const pinned = await resolvePinnedAddresses(url.hostname);
  if (pinned.some((record) => isPrivateIpAddress(record.address))) {
    throw new OutboundNetworkError(
      `Refusing outbound request to private/loopback host: ${url.hostname}`,
    );
  }
  return { url, pinned };
}

export interface SafeFetchOptions extends OutboundGuardOptions {
  /** Abort the request after this many ms (default `OUTBOUND_HTTP_DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/**
 * Headers that must not follow a redirect to ANOTHER origin. Native `fetch`
 * with `redirect: 'follow'` strips `Authorization` on a cross-origin hop for
 * exactly this reason; the manual loop below has to do it itself, and it also
 * covers the request signature the guardrail webhook family sets
 * (`x-cognipeer-signature`, an HMAC over the body) — a signed body re-sent to
 * a collector is a replayable, provably-genuine copy of the tenant's content.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

function isStrippedOnCrossOrigin(name: string): boolean {
  const lower = name.toLowerCase();
  return CROSS_ORIGIN_STRIPPED_HEADERS.has(lower) || lower.startsWith('x-cognipeer-signature');
}

/** `init.headers` in any of its three shapes, minus the credentials above. */
function stripCrossOriginHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    if (!isStrippedOnCrossOrigin(name)) out[name] = value;
  });
  return out;
}

/**
 * `fetch` with SSRF protection and a timeout. Redirects are followed manually
 * (up to 5 hops) so each hop is re-validated against the private-network
 * guard, and a hop that changes origin drops the credential headers.
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

  // The dispatcher belonging to the response this function ultimately
  // RETURNS must outlive the call: the caller has not read the body yet.
  // Every other one (each redirect hop, and any hop that threw) is finished
  // the moment we stop using it, and is destroyed below.
  let liveDispatcher: Agent | undefined;

  try {
    let currentUrl = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const { url, pinned } = await checkPublicUrl(currentUrl, options);
      // Pins the socket to the exact addresses just validated instead of
      // letting undici re-resolve DNS itself at connect time -- otherwise
      // an attacker controlling DNS for this host can answer differently
      // between the check above and the connection below (TOCTOU / DNS
      // rebinding). Absent (plain fetch) when there was nothing to pin:
      // a literal-IP URL, or the private-network guard was bypassed
      // (allowlisted host / allowPrivate / blocking disabled).
      const dispatcher = pinned.length > 0 ? pinnedDispatcher(pinned) : undefined;
      discardDispatcher(liveDispatcher); // previous hop's, now unread
      liveDispatcher = dispatcher;

      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: controller.signal,
          redirect: 'manual',
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
      } catch (error) {
        discardDispatcher(dispatcher);
        liveDispatcher = undefined;
        throw error;
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          // Returned to the caller as-is: its body is theirs to read, so the
          // dispatcher stays alive with it.
          liveDispatcher = undefined;
          return response;
        }
        if (hop === MAX_REDIRECTS) {
          throw new OutboundNetworkError(`Too many redirects fetching ${rawUrl}`);
        }
        const nextUrl = new URL(location, url);
        if (nextUrl.origin !== url.origin) {
          // Cross-origin: the bearer token, cookies and the body signature
          // were meant for the host the tenant configured, not for wherever
          // it points next.
          init = { ...init, headers: stripCrossOriginHeaders(init?.headers) };
        }
        currentUrl = nextUrl.toString();
        // Per fetch semantics, drop the body when a redirect downgrades to GET.
        if (response.status === 303 && init?.method && init.method !== 'GET' && init.method !== 'HEAD') {
          init = { ...init, method: 'GET', body: undefined };
        }
        continue;
      }

      liveDispatcher = undefined; // handed to the caller together with the body
      return response;
    }
    throw new OutboundNetworkError(`Too many redirects fetching ${rawUrl}`);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    // Anything still held here belongs to a hop nobody will read (the redirect
    // cap threw, or the loop fell through) -- releasing it is what keeps a
    // redirect chain from leaking one socket per hop.
    discardDispatcher(liveDispatcher);
  }
}
