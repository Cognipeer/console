/**
 * One call that drops every per-tenant cache derived from the tenant's license:
 * call it right after a license (or plan) change is persisted.
 */
import { createLogger } from '@/lib/core/logger';
import { invalidateEnterpriseLicenseCache } from '@/lib/license/enterprise-license-cache';
import { clearServiceAvailabilityMemo } from '@/lib/services/availability/serviceAvailability';
import { invalidateTenantPlan } from './tenantLimits';

const log = createLogger('limits:invalidate');

// The quota policy cache (quotaGuard) has no per-tenant clear function; it is
// keyed by db name and project and expires on its own short TTL.
export async function invalidateTenantLicenseState(tenantId: string): Promise<void> {
  invalidateTenantPlan(tenantId);
  clearServiceAvailabilityMemo(tenantId);
  try {
    await invalidateEnterpriseLicenseCache(tenantId);
  } catch (error) {
    log.warn('Enterprise license cache invalidation failed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
