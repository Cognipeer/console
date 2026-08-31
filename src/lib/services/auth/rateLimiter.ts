/**
 * Rate limiter for auth endpoints (login, register, password reset).
 * Uses a sliding-window counter per key (IP or email), backed by the shared
 * cache provider (`CACHE_PROVIDER`).
 *
 * Unlike a process-local `Map`, this is safe for horizontally scaled
 * deployments: when `CACHE_PROVIDER=redis` every node shares the same
 * counters, so an attacker distributing login attempts across replicas
 * behind a load balancer can no longer multiply their effective attempt
 * budget by the number of instances. `CACHE_PROVIDER=memory` keeps the old
 * single-node behavior for local/dev use; `CACHE_PROVIDER=none` disables
 * rate limiting entirely (matches the cache module's documented "none = all
 * operations are no-ops" contract) and should not be used in production.
 */

import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('rate-limit-auth');

const KEY_PREFIX = 'auth-rate-limit:';

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
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const cache = await getCache();
  const { count, resetAt } = await cache.incrementCounter(
    `${KEY_PREFIX}${key}`,
    config.windowSeconds,
    1,
  );

  const allowed = count <= config.maxAttempts;
  const remaining = Math.max(0, config.maxAttempts - count);
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / 1000));

  if (!allowed) {
    logger.warn('Rate limit exceeded', { key, count, maxAttempts: config.maxAttempts });
  }

  return {
    allowed,
    remaining,
    resetAt,
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
 * Test/dev helper: clears all cached counters (and everything else in the
 * shared cache). Not for production use.
 */
export async function resetRateLimitStore(): Promise<void> {
  const cache = await getCache();
  await cache.clear();
}
