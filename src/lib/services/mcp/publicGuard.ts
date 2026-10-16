/**
 * Limits on the public (unauthenticated) MCP endpoints, /api/public/mcp/...
 * (docs/guide/configuration.md, "MCP Gateway"):
 *
 *  - a request rate per client address and endpoint;
 *  - a request rate per endpoint, all callers together, which holds whatever
 *    address the callers appear to come from (the address is only as reliable
 *    as the proxy settings, see TRUSTED_PROXIES);
 *  - a coarser request rate per client address across all public endpoints,
 *    cheap enough to run before any database lookup;
 *  - a cap on the tool calls one tenant has running at once.
 *
 * A counter's key is built from the ids of the stored record (tenant and
 * server), not from the URL: the slug is not written to logs or to Redis, and
 * the different spellings of an id that a URL can carry share one count.
 *
 * Counters are process-local (the in-memory limiter the auth endpoints use).
 * When RATE_LIMIT_PROVIDER=redis they are also kept in Redis, so the per-endpoint
 * limits hold across replicas. The database provider keeps no expiring counters,
 * and a record per client address would only accumulate there, so it is not used.
 */

import { isIP } from 'node:net';
import { getCache } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import type { IMcpServer } from '@/lib/database';
import { checkRateLimit } from '@/lib/services/auth/rateLimiter';

const logger = createLogger('mcp-public-guard');

/** The shared counter failing is logged this often at most, not once per request. */
const SHARED_COUNTER_WARNING_INTERVAL_MS = 30_000;
let lastSharedCounterWarningAt = 0;
/** After the shared counter fails it is not asked again for this long; the local counters apply meanwhile. */
const SHARED_COUNTER_RETRY_MS = 10_000;
let sharedCounterRetryAt = 0;

export interface PublicLimitDecision {
  allowed: boolean;
  /** Seconds until a refused caller may retry. */
  retryAfterSeconds: number;
}

const ALLOWED: PublicLimitDecision = { allowed: true, retryAfterSeconds: 0 };
const WINDOW_SECONDS = 60;
/** The address-wide limit is this many times the per-endpoint one. */
const ADDRESS_LIMIT_FACTOR = 10;

// ── Client address ────────────────────────────────────────────────────────

/** `0:0:0:0:0:ffff:7f00:1`-style groups from an IPv6 literal, or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  // A trailing dotted quad stands for the last two groups.
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (quad) {
    const octets = quad.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, quad.index)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const parsed = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  return parsed.length === 8 && parsed.every((g) => !Number.isNaN(g)) ? parsed : null;
}

/**
 * The key a client address is counted under. IPv4 addresses (and IPv4-mapped
 * IPv6 ones) as they are; any other IPv6 address as its /64, because one
 * subscriber is handed a whole /64 and would otherwise count as 2^64 callers.
 */
export function clientAddressBucket(address: string | undefined): string {
  let text = (address ?? '').trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text) return 'unknown';

  const family = isIP(text);
  if (family === 4) return text;
  if (family === 6) {
    const groups = ipv6Groups(text);
    if (!groups) return text.slice(0, 64);
    const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    if (mapped) {
      return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
    }
    return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
  }
  return text.slice(0, 64);
}

// ── Request rate ──────────────────────────────────────────────────────────

function refused(retryAfterSeconds: number): PublicLimitDecision {
  return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
}

/**
 * Per client address, across every public endpoint. Local and synchronous, so
 * it can run before the request body is read or the endpoint is looked up.
 */
export function checkPublicAddressRate(clientAddress: string): PublicLimitDecision {
  const limit = getConfig().mcp.public.rateLimitPerMinute;
  if (limit <= 0) return ALLOWED;
  const result = checkRateLimit(`mcp-public-addr:${clientAddressBucket(clientAddress)}`, {
    maxAttempts: limit * ADDRESS_LIMIT_FACTOR,
    windowSeconds: WINDOW_SECONDS,
  });
  return result.allowed ? ALLOWED : refused(result.retryAfterSeconds);
}

export interface PublicEndpointRateInput {
  /** The endpoint's stored record: counters are keyed on its ids, not on the URL's path parameters. */
  server: Pick<IMcpServer, 'tenantId' | '_id' | 'key'>;
  clientAddress: string;
}

/** The shared (Redis) count for a key, or null when the shared counter is not in use or cannot be reached. */
async function incrementSharedCounter(key: string): Promise<{ count: number; resetAt: Date } | null> {
  if (getConfig().rateLimit.provider !== 'redis') return null;
  const now = Date.now();
  if (now < sharedCounterRetryAt) return null;
  try {
    const cache = await getCache();
    if (cache.name !== 'redis') return null;
    return await cache.incrementCounter(key, WINDOW_SECONDS, 1);
  } catch (error) {
    // The shared counter is unavailable: the local limit still applies.
    sharedCounterRetryAt = now + SHARED_COUNTER_RETRY_MS;
    if (now - lastSharedCounterWarningAt >= SHARED_COUNTER_WARNING_INTERVAL_MS) {
      lastSharedCounterWarningAt = now;
      logger.warn('Shared MCP rate-limit counter unavailable; using the local limit', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

/** Count one request against `key`, locally and (with RATE_LIMIT_PROVIDER=redis) across replicas. */
async function countRequest(key: string, limit: number): Promise<PublicLimitDecision> {
  const local = checkRateLimit(key, { maxAttempts: limit, windowSeconds: WINDOW_SECONDS });
  if (!local.allowed) return refused(local.retryAfterSeconds);

  const shared = await incrementSharedCounter(key);
  if (shared && shared.count > limit) {
    return refused(Math.ceil((shared.resetAt.getTime() - Date.now()) / 1000));
  }
  return ALLOWED;
}

/**
 * Per client address and endpoint, then per endpoint as a whole. Call once the
 * endpoint is known to exist. A caller already over its own rate is turned away
 * without counting against the endpoint as a whole.
 */
export async function checkPublicEndpointRate(input: PublicEndpointRateInput): Promise<PublicLimitDecision> {
  const { rateLimitPerMinute, endpointRateLimitPerMinute } = getConfig().mcp.public;
  const endpoint = `${input.server.tenantId}:${input.server._id ?? input.server.key}`;

  if (rateLimitPerMinute > 0) {
    const decision = await countRequest(
      `mcp-public:${endpoint}:${clientAddressBucket(input.clientAddress)}`,
      rateLimitPerMinute,
    );
    if (!decision.allowed) return decision;
  }
  if (endpointRateLimitPerMinute > 0) {
    return countRequest(`mcp-public-endpoint:${endpoint}`, endpointRateLimitPerMinute);
  }
  return ALLOWED;
}

// ── Concurrent tool calls ─────────────────────────────────────────────────

const inflightByTenant = new Map<string, number>();

/**
 * Take one of the tenant's concurrent public tool-call slots. Returns the
 * function that gives it back, or null when the tenant is at its limit. Call
 * the release exactly when the call ends; calling it more than once is safe.
 */
export function acquirePublicCallSlot(tenantId: string): (() => void) | null {
  const max = getConfig().mcp.public.maxInflightPerTenant;
  if (max <= 0) return () => undefined;

  const current = inflightByTenant.get(tenantId) ?? 0;
  if (current >= max) return null;
  inflightByTenant.set(tenantId, current + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inflightByTenant.get(tenantId) ?? 1) - 1;
    if (left > 0) inflightByTenant.set(tenantId, left);
    else inflightByTenant.delete(tenantId);
  };
}

/** Tool calls the tenant has running through its public endpoints (diagnostics and tests). */
export function publicCallsInFlight(tenantId: string): number {
  return inflightByTenant.get(tenantId) ?? 0;
}

/** For tests: forget the in-flight counts and the shared-counter timers. */
export function resetPublicGuardState(): void {
  inflightByTenant.clear();
  lastSharedCounterWarningAt = 0;
  sharedCounterRetryAt = 0;
}
