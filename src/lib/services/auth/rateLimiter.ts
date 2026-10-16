/**
 * In-memory rate limiter for auth endpoints.
 * Uses a sliding-window counter per key (IP or email).
 *
 * This is intentionally kept simple — no external dependencies.
 * For distributed deployments, swap for Redis-backed implementation.
 *
 * Memory use is bounded whatever keys are presented:
 *  - the address part of a client key goes through `clientRateLimitKey`, so
 *    only a real IP address gets a bucket of its own;
 *  - a key that is still long is stored as a fixed-size digest;
 *  - the number of live counters is capped (`RATE_LIMIT_MAX_TRACKED_KEYS`):
 *    when the store is full, counters whose window has ended go first, then the
 *    ones counted least recently.
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('rate-limit-auth');

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Counters by key, least recently counted first: a key moves to the end each
 * time it is counted (see `checkRateLimit`), so the front of the store holds the
 * keys that have been idle longest.
 */
const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ── Keys ──────────────────────────────────────────────────────────────────

/** Keys longer than this are stored as a fixed-size digest instead. */
const MAX_KEY_LENGTH = 256;

/** Bucket shared by every client address that is not a valid IP address. */
const INVALID_ADDRESS = 'invalid';

/** Longest textual IP address: eight IPv6 groups, or an IPv4-mapped form. */
const MAX_ADDRESS_LENGTH = 45;
/** The same, written as `[address]:port`. */
const MAX_ADDRESS_FIELD_LENGTH = MAX_ADDRESS_LENGTH + '[]:65535'.length;

// 203.0.113.9:51234
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
// [2001:db8::1] and [2001:db8::1]:443
const BRACKETED_IPV6 = /^\[([^\]]+)\](?::\d{1,5})?$/;

/**
 * The address part of a client rate-limit key.
 *
 * Only a syntactically valid IPv4/IPv6 address keeps a bucket of its own. It
 * may carry a port (`ip:port`, `[ip6]:port`), which some gateways append when
 * forwarding; the port is dropped so one client stays one bucket. Anything
 * else — a missing value, free text, an over-long header — shares the single
 * `invalid` bucket: still limited, but it cannot add entries.
 */
export function normalizeClientAddress(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ADDRESS_FIELD_LENGTH) {
    return INVALID_ADDRESS;
  }
  const address = IPV4_WITH_PORT.exec(value)?.[1] ?? BRACKETED_IPV6.exec(value)?.[1] ?? value;
  // `isIP` also accepts an IPv6 zone suffix of any length, hence the length check.
  return address.length <= MAX_ADDRESS_LENGTH && isIP(address) !== 0 ? address : INVALID_ADDRESS;
}

/**
 * Rate-limit key for a request: `scope` plus the normalised client address,
 * e.g. `login:203.0.113.9`.
 */
export function clientRateLimitKey(scope: string, address: string | null | undefined): string {
  return `${scope}:${normalizeClientAddress(address)}`;
}

function boundedKey(key: string): string {
  return key.length <= MAX_KEY_LENGTH
    ? key
    : `sha256:${createHash('sha256').update(key).digest('base64url')}`;
}

// ── Store bound ───────────────────────────────────────────────────────────

/** The bound on `store` when the configured one cannot be read (`RATE_LIMIT_MAX_TRACKED_KEYS`). */
const DEFAULT_MAX_TRACKED_KEYS = 100_000;
/** When the store is full, counters whose window has ended are swept out at most this often. */
const FULL_STORE_SWEEP_INTERVAL_MS = 1000;
let lastFullStoreSweepAt = 0;
/** Dropping counters that have not ended is reported this often at most. */
const DROP_WARNING_INTERVAL_MS = 60_000;
let lastDropWarningAt = 0;

function maxTrackedKeys(): number {
  const configured = getConfig().rateLimit?.maxTrackedKeys;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_MAX_TRACKED_KEYS;
}

function sweepExpired(now: number): void {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

/**
 * Keep `store` within its bound before a new key is added. When it is full,
 * counters whose window has ended are dropped first; if it is still full, the
 * tenth that was counted least recently goes too, so keys that are counted all
 * the time are kept however many one-off keys arrive. Each pass frees room for
 * many keys, so the cost per added key stays small however fast new keys arrive.
 */
function makeRoomForNewKey(now: number): void {
  const max = maxTrackedKeys();
  if (store.size < max) return;

  if (now - lastFullStoreSweepAt >= FULL_STORE_SWEEP_INTERVAL_MS) {
    lastFullStoreSweepAt = now;
    sweepExpired(now);
    if (store.size < max) return;
  }

  if (now - lastDropWarningAt >= DROP_WARNING_INTERVAL_MS) {
    lastDropWarningAt = now;
    logger.warn('Rate limiter store is full of live counters; dropping the least recently counted', {
      maxTrackedKeys: max,
    });
  }
  let excess = Math.ceil(max / 10);
  for (const key of store.keys()) {
    if (excess-- <= 0) break;
    store.delete(key);
  }
}

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => sweepExpired(Date.now()), CLEANUP_INTERVAL_MS);
  // Allow Node to exit even if the timer is active
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

export interface RateLimitConfig {
  /** Maximum number of attempts in the window */
  maxAttempts: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

/**
 * Check and increment the rate limit counter for a given key.
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): RateLimitResult {
  ensureCleanup();

  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;
  const storeKey = boundedKey(key);

  let entry = store.get(storeKey);

  // If no entry or window expired, create a new one
  if (!entry || entry.resetAt <= now) {
    // A key seen for the first time first makes room if the store is full; one
    // whose window ended is replaced, and either way it goes to the end.
    if (entry) store.delete(storeKey);
    else makeRoomForNewKey(now);
    entry = { count: 1, resetAt: now + windowMs };
    store.set(storeKey, entry);
    return {
      allowed: true,
      remaining: config.maxAttempts - 1,
      resetAt: new Date(entry.resetAt),
      retryAfterSeconds: 0,
    };
  }

  // Increment count, and move the key to the end of the store.
  entry.count++;
  store.delete(storeKey);
  store.set(storeKey, entry);

  const allowed = entry.count <= config.maxAttempts;
  const remaining = Math.max(0, config.maxAttempts - entry.count);
  const retryAfterSeconds = allowed ? 0 : Math.ceil((entry.resetAt - now) / 1000);

  if (!allowed) {
    // One warning when a key first goes over its limit; the attempts that
    // follow in the same window are logged at debug, so a flood of refused
    // requests does not become a flood of log lines. The key is logged as it is
    // stored, so a long one appears as its digest.
    const details = { key: storeKey, count: entry.count, maxAttempts: config.maxAttempts };
    if (entry.count === config.maxAttempts + 1) logger.warn('Rate limit exceeded', details);
    else logger.debug('Rate limit exceeded', details);
  }

  return {
    allowed,
    remaining,
    resetAt: new Date(entry.resetAt),
    retryAfterSeconds,
  };
}

/** Login rate limit: 10 attempts per 15 minutes per IP */
export const LOGIN_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 10,
  windowSeconds: 15 * 60,
};

/** Registration rate limit: 5 attempts per hour per IP */
export const REGISTER_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 5,
  windowSeconds: 60 * 60,
};

/** Password reset request rate limit: 3 per 15 minutes per IP */
export const PASSWORD_RESET_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 3,
  windowSeconds: 15 * 60,
};

/**
 * Session-issuance rate limit: 20 per 15 minutes per IP.
 *
 * Guards `issueSessionForAuthenticatedUser` itself, not just the local
 * `/auth/login` entry point that used to be its only caller — every
 * authenticator that reaches it (local password, LDAP, OIDC/SSO ticket
 * exchange) shares this one limiter, so a new external-auth callback can't
 * ship unthrottled just because it forgot its own rate-limit check.
 * Slightly more generous than LOGIN_RATE_LIMIT since it also covers
 * already-authenticated traffic (e.g. several tenants/tabs via SSO).
 */
export const SESSION_ISSUANCE_RATE_LIMIT: RateLimitConfig = {
  maxAttempts: 20,
  windowSeconds: 15 * 60,
};

export function resetRateLimitStore(): void {
  store.clear();
  lastFullStoreSweepAt = 0;
  lastDropWarningAt = 0;
}

/** Number of keys currently tracked (diagnostics and tests). */
export function getRateLimitStoreSize(): number {
  return store.size;
}

/** Length of the longest key currently stored (diagnostics and tests). */
export function getRateLimitLongestKeyLength(): number {
  let longest = 0;
  for (const key of store.keys()) longest = Math.max(longest, key.length);
  return longest;
}
