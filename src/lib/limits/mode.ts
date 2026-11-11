/**
 * Plan-limit mode, decided by the deployment alone: a hosted (saas) deployment
 * always enforces, an onprem deployment never measures or refuses anything here.
 * There is no measure-only mode and no per-tenant or env switch: a license
 * `plan.enforcement` claim written by an older CRM is ignored.
 */
import { getConfig } from '@/lib/core/config';
import type { PlanLimitsMode } from './types';

/** on for saas, off for onprem. */
export function deploymentPlanLimitsMode(): PlanLimitsMode {
  return getConfig().deployment.mode === 'saas' ? 'on' : 'off';
}

/** True when plan limits are measured and enforced on this deployment. */
export function planLimitsActive(): boolean {
  return deploymentPlanLimitsMode() === 'on';
}

/** The mode one tenant runs in: always the deployment's. */
export function effectivePlanLimitsMode(): PlanLimitsMode {
  return deploymentPlanLimitsMode();
}
