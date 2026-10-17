/**
 * A per-minute request count that holds across replicas when it can: the
 * in-memory limiter (`rateLimiter.ts`) always, plus a Redis counter when
 * RATE_LIMIT_PROVIDER=redis. Without Redis (or while it cannot be reached) the
 * count is per node. Used by the public, unauthenticated endpoints (public MCP,
 * incoming trigger webhooks), which key their counters on stored record ids.
 */

import { getCache } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { checkRateLimit } from './rateLimiter';

const logger = createLogger('shared-rate-counter');

/** The shared counter failing is logged this often at most, not once per request. */
const SHARED_COUNTER_WARNING_INTERVAL_MS = 30_000;
let lastSharedCounterWarningAt = 0;
/** After the shared counter fails it is not asked again for this long; the local counters apply meanwhile. */
const SHARED_COUNTER_RETRY_MS = 10_000;
let sharedCounterRetryAt = 0;

export const RATE_WINDOW_SECONDS = 60;

export interface RateDecision {
  allowed: boolean;
  /** Seconds until a refused caller may retry. */
  retryAfterSeconds: number;
}

export const RATE_ALLOWED: RateDecision = { allowed: true, retryAfterSeconds: 0 };

export function rateRefused(retryAfterSeconds: number): RateDecision {
  return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
}

/** The shared (Redis) count for a key, or null when the shared counter is not in use or cannot be reached. */
export async function incrementSharedCounter(key: string): Promise<{ count: number; resetAt: Date } | null> {
  if (getConfig().rateLimit.provider !== 'redis') return null;
  const now = Date.now();
  if (now < sharedCounterRetryAt) return null;
  try {
    const cache = await getCache();
    if (cache.name !== 'redis') return null;
    return await cache.incrementCounter(key, RATE_WINDOW_SECONDS, 1);
  } catch (error) {
    // The shared counter is unavailable: the local limit still applies.
    sharedCounterRetryAt = now + SHARED_COUNTER_RETRY_MS;
    if (now - lastSharedCounterWarningAt >= SHARED_COUNTER_WARNING_INTERVAL_MS) {
      lastSharedCounterWarningAt = now;
      logger.warn('Shared rate-limit counter unavailable; using the local limit', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

/** Count one request against `key`, locally and (with RATE_LIMIT_PROVIDER=redis) across replicas. */
export async function countRequest(key: string, limit: number): Promise<RateDecision> {
  const local = checkRateLimit(key, { maxAttempts: limit, windowSeconds: RATE_WINDOW_SECONDS });
  if (!local.allowed) return rateRefused(local.retryAfterSeconds);

  const shared = await incrementSharedCounter(key);
  if (shared && shared.count > limit) {
    return rateRefused(Math.ceil((shared.resetAt.getTime() - Date.now()) / 1000));
  }
  return RATE_ALLOWED;
}

/** For tests: forget the shared-counter timers. */
export function resetSharedCounterState(): void {
  lastSharedCounterWarningAt = 0;
  sharedCounterRetryAt = 0;
}
