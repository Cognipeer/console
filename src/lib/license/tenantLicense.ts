/**
 * The live license of a tenant, for code that runs outside a request.
 *
 * The API guard reads the license from the session, but an agent run can be
 * triggered by the client API, a schedule, A2A or the job queue — none of
 * which carry a dashboard session. This resolves the tenant's CURRENT license
 * from the main database, behind the same short-TTL cache the API guard uses
 * (the license admin endpoints invalidate it), so a downgrade takes effect on
 * the next run, not the next login.
 */

import { getDatabase } from '@/lib/database';
import { LicenseManager } from '@/lib/license/license-manager';
import {
  getCachedEnterpriseLicense,
  setCachedEnterpriseLicense,
} from '@/lib/license/enterprise-license-cache';

export async function resolveLiveLicenseForTenant(
  tenantId: string,
): Promise<{ licenseType: string; licenseExpiresAt?: string }> {
  const cached = await getCachedEnterpriseLicense(tenantId);
  if (cached) {
    return cached;
  }

  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId);
  const effective = LicenseManager.getEffectiveLicenseForTenant(tenant);
  const resolved = {
    licenseExpiresAt: effective.expiresAt?.toISOString(),
    licenseType: effective.licenseType,
  };
  await setCachedEnterpriseLicense(tenantId, resolved);
  return resolved;
}

/** True when the tenant holds an active (or in-grace) ENTERPRISE license. */
export async function isTenantEnterpriseLicensed(tenantId: string): Promise<boolean> {
  try {
    const license = await resolveLiveLicenseForTenant(tenantId);
    return LicenseManager.isEnterpriseActive(license.licenseType, license.licenseExpiresAt);
  } catch {
    // Fail closed: an unreadable license never unlocks an enterprise module.
    return false;
  }
}
