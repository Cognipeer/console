/**
 * API requests per minute per tenant: GCRA with a 1-minute burst. Cluster-wide
 * through redis when it is the cache provider (one Lua script), else per pod.
 */
import { getCache } from '@/lib/core/cache';
import type { RateTakeResult } from '@/lib/core/cache/cacheProvider.interface';
import { createLogger } from '@/lib/core/logger';
import { decideLimit } from './decide';
import { PlanLimitError } from './errors';
import { outcomeEventFor } from './events';
import { localRateTake } from './localStore';
import { notePeak } from './peaks';
import { resolveTenantPlan } from './tenantLimits';
import type { PlanLimitDecision, PlanLimitSource } from './types';

const log = createLogger('limits:rpm');

const LOG_EVERY_MS = 30_000;
let lastRedisFailureLogAt = 0;

/** Exported for tests: how many takes fell back to the in-process store because redis failed. */
export const rpmCounters = { failOpen: 0 };

/**
 * Which per-minute bucket a request counts against. Requests to public entry points
 * (webhooks, public A2A agents, public MCP endpoints, channels) arrive without the
 * tenant's credentials, so they get their own bucket with the same limit: anyone who
 * knows a public URL could otherwise use up the minute and refuse the tenant's own
 * authenticated API traffic.
 */
export type RpmBucket = 'api' | 'public';

const PUBLIC_SOURCE_TYPES: ReadonlySet<PlanLimitSource['type']> = new Set(['webhook', 'a2a', 'mcp', 'channel']);

export function rpmBucketFor(source: PlanLimitSource): RpmBucket {
  return PUBLIC_SOURCE_TYPES.has(source.type) ? 'public' : 'api';
}

export function rpmKey(tenantId: string, bucket: RpmBucket = 'api'): string {
  return bucket === 'public' ? `plim:rpm:${tenantId}:public` : `plim:rpm:${tenantId}`;
}

/** Takes one request from the tenant's bucket. */
export async function takeRequest(
  tenantId: string,
  limitPerMinute: number,
  bucket: RpmBucket = 'api',
): Promise<RateTakeResult> {
  const key = rpmKey(tenantId, bucket);
  try {
    const cache = await getCache();
    if (cache.name === 'redis' && typeof cache.rateTake === 'function') {
      return await cache.rateTake(key, limitPerMinute, Date.now());
    }
  } catch (error) {
    rpmCounters.failOpen += 1;
    const now = Date.now();
    if (now - lastRedisFailureLogAt >= LOG_EVERY_MS) {
      lastRedisFailureLogAt = now;
      log.warn('Rate limit store failed, using the in-process counter', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return localRateTake(key, limitPerMinute, Date.now());
}

export interface ApiRequestRateResult {
  decision: PlanLimitDecision;
  headers: Record<string, string>;
}

export async function enforceApiRequestRate(input: {
  tenantId: string;
  source: PlanLimitSource;
}): Promise<ApiRequestRateResult> {
  const { tenantId, source } = input;
  const plan = await resolveTenantPlan(tenantId);
  const limit = plan.limits?.apiRpm;
  if (plan.mode === 'off' || limit === undefined) {
    return {
      decision: { allowed: true, outcome: 'allowed', kind: 'api_rpm', dimension: 'apiRpm', limit },
      headers: {},
    };
  }

  const bucket = rpmBucketFor(source);
  // A limit of 0 admits nothing; the bucket cannot express it.
  const take: RateTakeResult = limit <= 0
    ? { allowed: false, retryAfterMs: 60_000, remaining: 0, resetAfterMs: 0 }
    : await takeRequest(tenantId, limit, bucket);

  const usedBefore = take.allowed ? Math.max(0, limit - take.remaining - 1) : limit;
  const decision = decideLimit({
    kind: 'api_rpm',
    dimension: 'apiRpm',
    mode: plan.mode,
    limit,
    used: usedBefore,
    retryAfterMs: take.allowed ? undefined : take.retryAfterMs,
  });
  // Shown value: this minute's count including this request.
  decision.used = take.allowed ? Math.min(limit, limit - take.remaining) : limit;
  notePeak(tenantId, bucket === 'public' ? 'publicRpm' : 'apiRpm', decision.used);

  if (decision.outcome !== 'allowed') {
    outcomeEventFor(decision, { tenantId, source });
  }

  const headers: Record<string, string> = {};
  if (take.allowed) {
    headers['X-RateLimit-Limit'] = String(limit);
    headers['X-RateLimit-Remaining'] = String(take.remaining);
    headers['X-RateLimit-Reset'] = String(Math.max(1, Math.ceil(take.resetAfterMs / 1000)));
  }
  return { decision, headers };
}

export async function assertApiRequestRate(input: {
  tenantId: string;
  source: PlanLimitSource;
}): Promise<Record<string, string>> {
  const { decision, headers } = await enforceApiRequestRate(input);
  if (decision.allowed) return headers;
  const seconds = Math.max(1, Math.ceil((decision.retryAfterMs ?? 0) / 1000));
  throw new PlanLimitError({
    code: 'tenant_rate_limited',
    message: `Tenant API limit reached: ${decision.limit} requests per minute. Retry after ${seconds} seconds.`,
    kind: 'api_rpm',
    dimension: 'apiRpm',
    limit: decision.limit,
    used: decision.used,
    retryAfterMs: decision.retryAfterMs,
  });
}

export function clearRpmStateForTests(): void {
  rpmCounters.failOpen = 0;
  lastRedisFailureLogAt = 0;
}
