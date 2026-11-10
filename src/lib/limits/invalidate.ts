/**
 * One call that drops every per-tenant cache derived from the tenant's license:
 * call it right after a license (or plan) change is persisted.
 */
import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';
import { invalidateEnterpriseLicenseCache } from '@/lib/license/enterprise-license-cache';
import { clearServiceAvailabilityMemo } from '@/lib/services/availability/serviceAvailability';
import { invalidateTenantPlan } from './tenantLimits';

const log = createLogger('limits:invalidate');

/** Outlives the 30 s in-process plan cache, so every replica sees a bump before its own entry expires. */
const PLAN_STATE_VERSION_TTL_SECONDS = 120;

function planStateVersionKey(tenantId: string): string {
  return `plan-state-version:${tenantId}`;
}

/**
 * The tenant's plan-state version in the shared cache: a replica whose cached plan carries another version reloads it.
 * '0' when none was recorded (or it expired), undefined when the cache cannot be read (keep the cached plan: its own
 * TTL bounds the staleness, and a cache outage must not turn every check into a database read). Never throws.
 */
export async function planStateVersion(tenantId: string): Promise<string | undefined> {
  try {
    return (await (await getCache()).get<string>(planStateVersionKey(tenantId))) ?? '0';
  } catch {
    return undefined;
  }
}

// The quota policy cache (quotaGuard) has no per-tenant clear function; it is
// keyed by db name and project and expires on its own short TTL.
export async function invalidateTenantLicenseState(tenantId: string): Promise<void> {
  invalidateTenantPlan(tenantId);
  clearServiceAvailabilityMemo(tenantId);
  try {
    // The other replicas: their in-process plan cache compares this version on every read.
    await (await getCache()).set(planStateVersionKey(tenantId), crypto.randomUUID(), PLAN_STATE_VERSION_TTL_SECONDS);
  } catch (error) {
    log.warn('Plan state version bump failed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await invalidateEnterpriseLicenseCache(tenantId);
  } catch (error) {
    log.warn('Enterprise license cache invalidation failed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
