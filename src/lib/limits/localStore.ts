/**
 * In-process counters used when the cache provider is not redis (or redis
 * failed): a GCRA map for requests per minute and lease sets for concurrency.
 * Same semantics as the redis scripts; counts are per pod.
 */
import type { LeaseAcquireResult, RateTakeResult } from '@/lib/core/cache/cacheProvider.interface';

const WINDOW_MS = 60_000;
const RATE_MAX_KEYS = 100_000;

const tats = new Map<string, { tat: number; expiresAt: number }>();
const leases = new Map<string, Map<string, number>>();

function pruneRates(now: number): void {
  for (const [key, entry] of tats) {
    if (entry.expiresAt <= now) tats.delete(key);
    if (tats.size <= RATE_MAX_KEYS * 0.9) break;
  }
  while (tats.size > RATE_MAX_KEYS) {
    const oldest = tats.keys().next().value;
    if (oldest === undefined) break;
    tats.delete(oldest);
  }
}

export function localRateTake(key: string, limitPerMinute: number, nowMs: number = Date.now()): RateTakeResult {
  const interval = WINDOW_MS / limitPerMinute;
  const stored = tats.get(key);
  const tat = stored && stored.tat > nowMs ? stored.tat : nowMs;
  const next = tat + interval;
  const diff = next - nowMs;
  if (diff > WINDOW_MS) {
    return {
      allowed: false,
      retryAfterMs: Math.ceil(diff - WINDOW_MS),
      remaining: 0,
      resetAfterMs: Math.ceil(Math.max(0, tat - nowMs)),
    };
  }
  if (tats.has(key)) tats.delete(key);
  tats.set(key, { tat: next, expiresAt: nowMs + 2 * WINDOW_MS });
  if (tats.size > RATE_MAX_KEYS) pruneRates(nowMs);
  return {
    allowed: true,
    retryAfterMs: 0,
    remaining: Math.floor((WINDOW_MS - diff) / interval),
    resetAfterMs: Math.ceil(diff),
  };
}

function liveSet(key: string, nowMs: number): Map<string, number> | undefined {
  const set = leases.get(key);
  if (!set) return undefined;
  for (const [member, expiry] of set) {
    if (expiry <= nowMs) set.delete(member);
  }
  if (set.size === 0) {
    leases.delete(key);
    return undefined;
  }
  return set;
}

export function localLeaseAcquire(
  key: string,
  member: string,
  limit: number | null,
  ttlMs: number,
  nowMs: number = Date.now(),
): LeaseAcquireResult {
  const existing = liveSet(key, nowMs);
  if (existing?.has(member)) {
    existing.set(member, nowMs + ttlMs);
    return { acquired: true, count: existing.size };
  }
  const count = existing?.size ?? 0;
  if (limit !== null && count >= limit) return { acquired: false, count };
  const set = existing ?? new Map<string, number>();
  set.set(member, nowMs + ttlMs);
  leases.set(key, set);
  return { acquired: true, count: set.size };
}

export function localLeaseRenew(key: string, member: string, ttlMs: number, nowMs: number = Date.now()): boolean {
  const set = liveSet(key, nowMs);
  if (!set?.has(member)) return false;
  set.set(member, nowMs + ttlMs);
  return true;
}

export function localLeaseRelease(key: string, member: string): void {
  const set = leases.get(key);
  if (!set) return;
  set.delete(member);
  if (set.size === 0) leases.delete(key);
}

export function localLeaseCount(key: string, nowMs: number = Date.now()): number {
  return liveSet(key, nowMs)?.size ?? 0;
}

/** The stored theoretical arrival time of a rate bucket (read only), or undefined when it has no state. */
export function localRatePeek(key: string, nowMs: number = Date.now()): number | undefined {
  const stored = tats.get(key);
  if (!stored || stored.expiresAt <= nowMs) return undefined;
  return stored.tat;
}

export function clearLocalStoreForTests(): void {
  tats.clear();
  leases.clear();
}
