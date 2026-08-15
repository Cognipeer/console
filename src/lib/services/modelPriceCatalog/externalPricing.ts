/**
 * Effective-dated price resolution for externally-priced models.
 *
 * This lives in the community edition on purpose. It is not part of the Cost &
 * Optimization product surface — it runs on the INGEST path, where trace-derived
 * usage is priced before it is written to the `usage_daily` rollup. That rollup
 * feeds spend reporting, quotas and Model Hub figures, so a community install
 * that never sees the Cost screens still has to be able to resolve a price.
 *
 * The Cost module's aggregation, reporting and pricing-management surfaces are
 * enterprise and live in the overlay; only this resolver stayed behind.
 */

import type {
  IExternalModelPricing,
  IExternalPricingVersion,
  IModelPricing,
} from '@/lib/database';

/**
 * Price effective on `day`: the version with the latest `effectiveFrom` <= day
 * ('' matches every day). Entries created before versioning shipped have no
 * versions — their single `pricing` applies to all days. Returns undefined when
 * every version starts after `day` (price unknown for that day, which is not
 * the same as free).
 */
export function resolveExternalPricingForDay(
  entry: Pick<IExternalModelPricing, 'pricing' | 'versions'>,
  day: string,
): IModelPricing | undefined {
  const versions = entry.versions;
  if (!versions || versions.length === 0) return entry.pricing;
  let match: IExternalPricingVersion | undefined;
  for (const version of versions) {
    if (version.effectiveFrom <= day && (!match || version.effectiveFrom >= match.effectiveFrom)) {
      match = version;
    }
  }
  return match?.pricing;
}
