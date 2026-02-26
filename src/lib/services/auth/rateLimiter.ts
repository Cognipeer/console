/**
 * In-memory rate limiter for auth endpoints.
 * Uses a sliding-window counter per key (IP or email).
 *
 * This is intentionally kept simple — no external dependencies.
 * For distributed deployments, swap for Redis-backed implementation.
 */

import { createLogger } from '@/lib/core/logger';

const logger = createLogger('rate-limit-auth');

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, CLEANUP_INTERVAL_MS);
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

  let entry = store.get(key);

  // If no entry or window expired, create a new one
  if (!entry || entry.resetAt <= now) {
    entry = { count: 1, resetAt: now + windowMs };
    store.set(key, entry);
    return {
      allowed: true,
      remaining: config.maxAttempts - 1,
      resetAt: new Date(entry.resetAt),
      retryAfterSeconds: 0,
    };
  }

  // Increment count
  entry.count++;

  const allowed = entry.count <= config.maxAttempts;
  const remaining = Math.max(0, config.maxAttempts - entry.count);
  const retryAfterSeconds = allowed ? 0 : Math.ceil((entry.resetAt - now) / 1000);

  if (!allowed) {
    logger.warn('Rate limit exceeded', { key, count: entry.count, maxAttempts: config.maxAttempts });
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
