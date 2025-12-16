import planLimits from '@/config/plan-limits.json';
import type { LicenseType } from '@/lib/license/license-manager';
import type { PlanLimitsConfig, PlanQuotaLimits } from './types';

const config = planLimits as PlanLimitsConfig;

export function getPlanQuotaLimits(licenseType: LicenseType): PlanQuotaLimits {
  return config.plans[licenseType] ?? {};
}
