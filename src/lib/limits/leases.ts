/**
 * Concurrency limits as leases: a holder takes a slot in a per-tenant, per-pool
 * set and keeps it alive until it releases. A crashed process stops renewing,
 * so its slots expire on their own (TTL 30 s).
 */
import { getCache } from '@/lib/core/cache';
import type { CacheProvider } from '@/lib/core/cache/cacheProvider.interface';
import { createLogger } from '@/lib/core/logger';
import { decideLimit } from './decide';
import { outcomeEventFor, recordLimitEvent } from './events';
import {
  localLeaseAcquire,
  localLeaseCount,
  localLeaseRelease,
  localLeaseRenew,
} from './localStore';
import { notePeak } from './peaks';
import { resolveTenantPlan } from './tenantLimits';
import type { ConcurrencyPool, PlanLimitDecision, PlanLimitSource } from './types';

const log = createLogger('limits:leases');

const LEASE_TTL_MS = 30_000;
const KEEPER_EVERY_MS = 10_000;
const REFUSED_RETRY_MS = 5_000;
const LOG_EVERY_MS = 30_000;

export interface PlanLease {
  tenantId: string;
  pool: ConcurrencyPool;
  holderId: string;
  release(): Promise<void>;
}

export interface AcquirePlanLeaseInput {
  tenantId: string;
  pool: ConcurrencyPool;
  holderId: string;
  source?: PlanLimitSource;
}

export interface AcquirePlanLeaseResult {
  decision: PlanLimitDecision;
  lease: PlanLease | null;
}

interface HeldLease {
  key: string;
  member: string;
  store: 'redis' | 'local';
}

const held = new Map<string, HeldLease>();
let keeper: ReturnType<typeof setInterval> | null = null;
let lastRedisFailureLogAt = 0;

export function leaseKey(tenantId: string, pool: ConcurrencyPool): string {
  return `plim:lease:${tenantId}:${pool}`;
}

function logRedisFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastRedisFailureLogAt < LOG_EVERY_MS) return;
  lastRedisFailureLogAt = now;
  log.warn('Lease store failed, using the in-process store', {
    error: error instanceof Error ? error.message : String(error),
  });
}

async function redisCache(): Promise<CacheProvider | null> {
  try {
    const cache = await getCache();
    return cache.name === 'redis' && typeof cache.leaseAcquire === 'function' ? cache : null;
  } catch {
    return null;
  }
}

async function keeperTick(): Promise<void> {
  const cache = await redisCache();
  for (const lease of [...held.values()]) {
    try {
      if (lease.store === 'redis' && cache?.leaseRenew && cache.leaseAcquire) {
        const renewed = await cache.leaseRenew(lease.key, lease.member, LEASE_TTL_MS);
        // Expired between ticks (a stall): take the slot again without a limit so the holder keeps running.
        // Released while the renew was in flight: do not bring the member back.
        if (!renewed && held.has(`${lease.key}|${lease.member}`)) {
          await cache.leaseAcquire(lease.key, lease.member, null, LEASE_TTL_MS);
        }
      } else if (lease.store === 'local') {
        if (!localLeaseRenew(lease.key, lease.member, LEASE_TTL_MS) && held.has(`${lease.key}|${lease.member}`)) {
          localLeaseAcquire(lease.key, lease.member, null, LEASE_TTL_MS);
        }
      }
    } catch (error) {
      logRedisFailure(error);
    }
  }
}

function startKeeper(): void {
  if (keeper) return;
  keeper = setInterval(() => {
    void keeperTick();
  }, KEEPER_EVERY_MS);
  keeper.unref?.();
}

function stopKeeperIfIdle(): void {
  if (keeper && held.size === 0) {
    clearInterval(keeper);
    keeper = null;
  }
}

/** Number of leases this process currently holds (tests, diagnostics). */
export function heldLeaseCount(): number {
  return held.size;
}

async function storeAcquire(
  key: string,
  member: string,
  limit: number | null,
): Promise<{ acquired: boolean; count: number; store: 'redis' | 'local' }> {
  const cache = await redisCache();
  if (cache?.leaseAcquire) {
    try {
      const result = await cache.leaseAcquire(key, member, limit, LEASE_TTL_MS, Date.now());
      return { ...result, store: 'redis' };
    } catch (error) {
      logRedisFailure(error);
    }
  }
  return { ...localLeaseAcquire(key, member, limit, LEASE_TTL_MS), store: 'local' };
}

function makeLease(input: AcquirePlanLeaseInput, key: string, store: 'redis' | 'local'): PlanLease {
  const heldKey = `${key}|${input.holderId}`;
  held.set(heldKey, { key, member: input.holderId, store });
  startKeeper();
  let released = false;
  return {
    tenantId: input.tenantId,
    pool: input.pool,
    holderId: input.holderId,
    async release() {
      if (released) return;
      released = true;
      held.delete(heldKey);
      stopKeeperIfIdle();
      try {
        if (store === 'redis') {
          const cache = await redisCache();
          await cache?.leaseRelease?.(key, input.holderId);
        } else {
          localLeaseRelease(key, input.holderId);
        }
      } catch (error) {
        logRedisFailure(error);
      }
    },
  };
}

async function tryAcquire(input: AcquirePlanLeaseInput, record: boolean): Promise<AcquirePlanLeaseResult> {
  const { tenantId, pool } = input;
  const plan = await resolveTenantPlan(tenantId);
  if (plan.mode === 'off') {
    return { decision: { allowed: true, outcome: 'allowed', kind: 'concurrency', dimension: pool }, lease: null };
  }
  const limit = plan.limits?.concurrency[pool];
  const key = leaseKey(tenantId, pool);
  const enforce = plan.mode === 'on' && limit !== undefined;
  const result = await storeAcquire(key, input.holderId, enforce ? limit : null);

  if (!result.acquired) {
    const decision = decideLimit({
      kind: 'concurrency',
      dimension: pool,
      mode: plan.mode,
      limit,
      used: result.count,
      retryAfterMs: REFUSED_RETRY_MS,
    });
    notePeak(tenantId, pool, result.count);
    if (record) outcomeEventFor(decision, { tenantId, mode: 'on', source: input.source });
    return { decision, lease: null };
  }

  // Count before this holder joined (an already-held member does not add one).
  const decision = decideLimit({
    kind: 'concurrency',
    dimension: pool,
    mode: plan.mode,
    limit,
    used: Math.max(0, result.count - 1),
  });
  decision.used = result.count;
  notePeak(tenantId, pool, result.count);
  if (record) {
    outcomeEventFor(decision, {
      tenantId,
      mode: plan.mode === 'on' ? 'on' : 'shadow',
      source: input.source,
    });
  }
  return { decision, lease: makeLease(input, key, result.store) };
}

export function acquirePlanLease(input: AcquirePlanLeaseInput): Promise<AcquirePlanLeaseResult> {
  return tryAcquire(input, true);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForPlanLease(
  input: AcquirePlanLeaseInput & {
    maxWaitMs: number;
    pollMs?: number;
    onQueued?: (info: { limit: number; active: number; retryInMs: number }) => void;
    signal?: AbortSignal;
  },
): Promise<AcquirePlanLeaseResult> {
  const pollMs = Math.max(1, input.pollMs ?? 500);
  const startedAt = Date.now();
  let queued = false;
  let last = await tryAcquire(input, false);
  for (;;) {
    if (last.decision.allowed) {
      if (queued) {
        recordLimitEvent({
          tenantId: input.tenantId,
          kind: 'concurrency',
          dimension: input.pool,
          outcome: 'waited',
          mode: 'on',
          limit: last.decision.limit,
          used: last.decision.used,
          waitMs: Date.now() - startedAt,
          source: input.source,
        });
      }
      // Shadow measurement: tryAcquire was called without recording, so write the would-refuse hit here.
      if (!queued && last.decision.outcome === 'would_refuse') {
        outcomeEventFor(last.decision, { tenantId: input.tenantId, mode: 'shadow', source: input.source });
      }
      return last;
    }
    const elapsed = Date.now() - startedAt;
    if (!queued) {
      queued = true;
      try {
        input.onQueued?.({
          limit: last.decision.limit ?? 0,
          active: last.decision.used ?? 0,
          // How long the wait may still last before it gives up (the UI counts down from it).
          retryInMs: Math.max(0, input.maxWaitMs - elapsed),
        });
      } catch {
        /* a callback must not break the wait */
      }
    }
    if (elapsed >= input.maxWaitMs || input.signal?.aborted) {
      outcomeEventFor(last.decision, {
        tenantId: input.tenantId,
        mode: 'on',
        source: input.source,
        waitMs: elapsed,
      });
      return last;
    }
    await sleep(Math.min(pollMs, Math.max(1, input.maxWaitMs - elapsed)), input.signal);
    last = await tryAcquire(input, false);
  }
}

export async function countPlanLeases(tenantId: string, pool: ConcurrencyPool): Promise<number> {
  const key = leaseKey(tenantId, pool);
  const cache = await redisCache();
  if (cache?.leaseCount) {
    try {
      return await cache.leaseCount(key);
    } catch (error) {
      logRedisFailure(error);
    }
  }
  return localLeaseCount(key);
}

export function clearLeaseStateForTests(): void {
  held.clear();
  if (keeper) {
    clearInterval(keeper);
    keeper = null;
  }
  lastRedisFailureLogAt = 0;
}

/** Test hook: run one keeper pass now. */
export const runLeaseKeeperForTests = keeperTick;
