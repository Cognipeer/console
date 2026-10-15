/**
 * Which condition modes this deployment and tenant can use.
 *
 * `threshold` and `absence` are core. `baseline` and `slo_burn` are provided by
 * the enterprise overlay through the alert extension seam and also need an
 * active enterprise licence: without the provider the build lacks them
 * (`not_enterprise_build`), without the licence the tenant does (`license_required`).
 * The licence lookup is memoised per gate, i.e. once per evaluation sweep.
 */

import type { AlertConditionMode } from '@/lib/database';
import { getEntityBaselineProvider, getSloBurnEvaluator } from '@/enterprise/alert-extensions';
import { isTenantEnterpriseLicensed } from '@/lib/license/tenantLicense';

export type ModeAvailability =
  | { available: true }
  | { available: false; reason: 'not_enterprise_build' | 'license_required' };

export interface ModeGate {
  check(mode: AlertConditionMode): Promise<ModeAvailability>;
}

export function createModeGate(tenantId: string): ModeGate {
  let licensed: Promise<boolean> | null = null;
  const isLicensed = () => {
    licensed ??= isTenantEnterpriseLicensed(tenantId);
    return licensed;
  };

  return {
    async check(mode) {
      if (mode === 'threshold' || mode === 'absence') return { available: true };
      const registered = mode === 'baseline' ? getEntityBaselineProvider() !== null : getSloBurnEvaluator() !== null;
      if (!registered) return { available: false, reason: 'not_enterprise_build' };
      if (!(await isLicensed())) return { available: false, reason: 'license_required' };
      return { available: true };
    },
  };
}

/** Availability of every mode, as served in the rules `meta`. */
export async function getModeAvailability(tenantId: string): Promise<Record<AlertConditionMode, ModeAvailability>> {
  const gate = createModeGate(tenantId);
  const [threshold, baseline, absence, sloBurn] = await Promise.all([
    gate.check('threshold'),
    gate.check('baseline'),
    gate.check('absence'),
    gate.check('slo_burn'),
  ]);
  return { threshold, baseline, absence, slo_burn: sloBurn };
}
