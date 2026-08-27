/**
 * Short-lived cache for a tenant's LIVE effective license, used by the
 * enterprise API access guard (see `plugin.ts`'s onRequest hook).
 *
 * Session JWTs embed the licenseType/licenseExpiresAt that was true at
 * login time and can live for days. Without this, a license downgrade or
 * removal would only take effect for the acting admin's own re-issued
 * cookie — every other already-logged-in user of the tenant would keep
 * enterprise access until their token naturally expires. Re-fetching the
 * tenant on every gated request would work but adds a DB round-trip to the
 * hot path, so the result is cached briefly and the cache entry is
 * invalidated by the license admin endpoints (`plugins/license.ts`)
 * immediately after a license change is persisted, so both upgrades and
 * downgrades take effect on the very next request instead of waiting out
 * the TTL.
 */
import { getCache } from '@/lib/core/cache';
import type { LicenseType } from './license-manager';

const TTL_SECONDS = 30;

export interface CachedEnterpriseLicense {
  licenseType: LicenseType | string;
  expiresAt?: string;
}

export function enterpriseLicenseCacheKey(tenantId: string): string {
  return `enterprise-license:${tenantId}`;
}

export async function getCachedEnterpriseLicense(
  tenantId: string,
): Promise<CachedEnterpriseLicense | undefined> {
  const cache = await getCache();
  return cache.get<CachedEnterpriseLicense>(enterpriseLicenseCacheKey(tenantId));
}

export async function setCachedEnterpriseLicense(
  tenantId: string,
  value: CachedEnterpriseLicense,
): Promise<void> {
  const cache = await getCache();
  await cache.set(enterpriseLicenseCacheKey(tenantId), value, TTL_SECONDS);
}

/**
 * Bust the cached live license for a tenant. Must be called right after any
 * write that changes a tenant's licenseType/licenseExpiresAt (license
 * apply/reset) so the change is visible on the next gated request instead
 * of only after the TTL expires.
 */
export async function invalidateEnterpriseLicenseCache(tenantId: string): Promise<void> {
  const cache = await getCache();
  await cache.del(enterpriseLicenseCacheKey(tenantId));
}
