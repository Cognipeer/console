/**
 * Stored-bytes limit. The byte sum is the tenant-wide file record sum
 * (`sumFileRecordBytes()` without a project filter) plus the metered size of the
 * vector indexes on platform providers (`sumVectorIndexStoredBytes()`). Both read
 * the TENANT db: call this inside the caller's tenant scope (upload routes are).
 */
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { decideLimit } from './decide';
import { PlanLimitError } from './errors';
import { outcomeEventFor } from './events';
import { resolveTenantPlan } from './tenantLimits';
import type { PlanLimitDecision, PlanLimitSource } from './types';

const log = createLogger('limits:storage');

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 10_000;

const cache = new Map<string, { at: number; bytes: number }>();

function setCached(tenantId: string, bytes: number): void {
  if (cache.has(tenantId)) cache.delete(tenantId);
  cache.set(tenantId, { at: Date.now(), bytes });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Bytes of writes that passed the check and have not finished yet (per process). A check counts them on top of the
 * stored sum, so concurrent writes cannot all pass against the same sum.
 * shortcut: per process only; several server processes can each pass a write at the limit, upgrade to a shared counter when hosted runs more than one.
 */
const reserved = new Map<string, number>();
/** Bumped whenever the stored sum changes: a sum read while it changed is read again, not cached. */
const generation = new Map<string, number>();

function changed(tenantId: string): void {
  generation.set(tenantId, (generation.get(tenantId) ?? 0) + 1);
}

function hold(tenantId: string, bytes: number): void {
  const next = (reserved.get(tenantId) ?? 0) + bytes;
  if (next > 0) reserved.set(tenantId, next);
  else reserved.delete(tenantId);
}

/** Stored bytes of the tenant: files and vectors (cached 60 s). Throws when the sum cannot be read. */
export async function getStoredBytes(tenantId: string): Promise<number> {
  for (let attempt = 0; ; attempt += 1) {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bytes;
    const seen = generation.get(tenantId);
    const db = await getDatabase();
    const [fileBytes, vectorBytes] = await Promise.all([db.sumFileRecordBytes(), db.sumVectorIndexStoredBytes()]);
    const bytes = fileBytes + vectorBytes;
    if (generation.get(tenantId) === seen) {
      setCached(tenantId, bytes);
      return bytes;
    }
    if (attempt >= 2) return bytes;
  }
}

export async function checkStorageStock(input: {
  tenantId: string;
  incomingBytes: number;
  source?: PlanLimitSource;
}): Promise<PlanLimitDecision> {
  return (await decideStorage(input, false)).decision;
}

/** The check; with `reserve`, an allowed amount is held in the same synchronous step as the decision. */
async function decideStorage(
  input: { tenantId: string; incomingBytes: number; source?: PlanLimitSource },
  reserve: boolean,
): Promise<{ decision: PlanLimitDecision; held: number }> {
  const { tenantId } = input;
  const plan = await resolveTenantPlan(tenantId);
  const limit = plan.limits?.storageBytes;
  if (plan.mode === 'off' || limit === undefined) {
    return { decision: { allowed: true, outcome: 'allowed', kind: 'storage', dimension: 'storage', limit }, held: 0 };
  }
  let used: number;
  try {
    used = await getStoredBytes(tenantId);
  } catch (error) {
    log.warn('Stored bytes could not be read, failing open', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { decision: { allowed: true, outcome: 'allowed', kind: 'storage', dimension: 'storage', limit }, held: 0 };
  }
  const amount = Math.max(0, input.incomingBytes);
  const decision = decideLimit({
    kind: 'storage',
    dimension: 'storage',
    mode: plan.mode,
    limit,
    used: used + (reserved.get(tenantId) ?? 0),
    amount,
  });
  if (decision.outcome !== 'allowed') {
    outcomeEventFor(decision, { tenantId, source: input.source });
  }
  const held = reserve && decision.allowed ? amount : 0;
  if (held > 0) hold(tenantId, held);
  return { decision, held };
}

function gb(bytes: number | undefined): string {
  return String(Math.round(((bytes ?? 0) / 1e9) * 100) / 100);
}

function storageFullError(decision: PlanLimitDecision): PlanLimitError {
  return new PlanLimitError({
    code: 'storage_quota_exceeded',
    message: `Storage is full (${gb(decision.used)} of ${gb(decision.limit)} GB).`,
    kind: 'storage',
    dimension: 'storage',
    limit: decision.limit,
    used: decision.used,
  });
}

export async function assertStorageStock(input: {
  tenantId: string;
  incomingBytes: number;
  source?: PlanLimitSource;
}): Promise<void> {
  const decision = await checkStorageStock(input);
  if (!decision.allowed) throw storageFullError(decision);
}

/**
 * Checks a write of `incomingBytes` (what it adds: an overwrite passes the difference) and holds them while `write`
 * runs, so concurrent writes see each other. When it settles, either way, the hold goes and the cached sum is read
 * again: the write's own records are the count from then on. Refuses with 413 `storage_quota_exceeded`.
 */
export async function withStorageReservation<T>(
  input: { tenantId: string; incomingBytes: number; source?: PlanLimitSource },
  write: () => Promise<T>,
): Promise<T> {
  // A write that adds nothing (an overwrite with fewer bytes) is never refused, not even over the limit.
  const { decision, held } = input.incomingBytes > 0
    ? await decideStorage(input, true)
    : { decision: { allowed: true } as PlanLimitDecision, held: 0 };
  if (!decision.allowed) throw storageFullError(decision);
  try {
    return await write();
  } finally {
    if (held > 0) hold(input.tenantId, -held);
    forgetStoredBytes(input.tenantId);
  }
}

/** Drops the cached sum (after a delete or a write): the next check reads it again. */
export function forgetStoredBytes(tenantId: string): void {
  cache.delete(tenantId);
  changed(tenantId);
}

/** Adjusts the cached sum after a successful write (negative for deletes). */
export function noteStoredBytes(tenantId: string, delta: number): void {
  const hit = cache.get(tenantId);
  if (!hit || !Number.isFinite(delta)) return;
  hit.bytes = Math.max(0, hit.bytes + delta);
  changed(tenantId);
}

export function clearStorageCacheForTests(): void {
  cache.clear();
  reserved.clear();
  generation.clear();
}
