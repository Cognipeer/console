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

/** Stored bytes of the tenant: files and vectors (cached 60 s). Throws when the sum cannot be read. */
export async function getStoredBytes(tenantId: string): Promise<number> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bytes;
  const db = await getDatabase();
  const [fileBytes, vectorBytes] = await Promise.all([db.sumFileRecordBytes(), db.sumVectorIndexStoredBytes()]);
  const bytes = fileBytes + vectorBytes;
  setCached(tenantId, bytes);
  return bytes;
}

export async function checkStorageStock(input: {
  tenantId: string;
  incomingBytes: number;
  source?: PlanLimitSource;
}): Promise<PlanLimitDecision> {
  const { tenantId } = input;
  const plan = await resolveTenantPlan(tenantId);
  const limit = plan.limits?.storageBytes;
  if (plan.mode === 'off' || limit === undefined) {
    return { allowed: true, outcome: 'allowed', kind: 'storage', dimension: 'storage', limit };
  }
  let used: number;
  try {
    used = await getStoredBytes(tenantId);
  } catch (error) {
    log.warn('Stored bytes could not be read, failing open', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true, outcome: 'allowed', kind: 'storage', dimension: 'storage', limit };
  }
  const decision = decideLimit({
    kind: 'storage',
    dimension: 'storage',
    mode: plan.mode,
    limit,
    used,
    amount: Math.max(0, input.incomingBytes),
  });
  if (decision.outcome !== 'allowed') {
    outcomeEventFor(decision, { tenantId, mode: plan.mode === 'on' ? 'on' : 'shadow', source: input.source });
  }
  return decision;
}

function gb(bytes: number | undefined): string {
  return String(Math.round(((bytes ?? 0) / 1e9) * 100) / 100);
}

export async function assertStorageStock(input: {
  tenantId: string;
  incomingBytes: number;
  source?: PlanLimitSource;
}): Promise<void> {
  const decision = await checkStorageStock(input);
  if (decision.allowed) return;
  throw new PlanLimitError({
    code: 'storage_quota_exceeded',
    message: `Storage is full (${gb(decision.used)} of ${gb(decision.limit)} GB).`,
    kind: 'storage',
    dimension: 'storage',
    limit: decision.limit,
    used: decision.used,
  });
}

/** Adjusts the cached sum after a successful write (negative for deletes). */
export function noteStoredBytes(tenantId: string, delta: number): void {
  const hit = cache.get(tenantId);
  if (!hit || !Number.isFinite(delta)) return;
  hit.bytes = Math.max(0, hit.bytes + delta);
}

export function clearStorageCacheForTests(): void {
  cache.clear();
}
