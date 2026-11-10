/**
 * Effective plan-limit mode. Hosted (saas) deployments only: on an onprem
 * deployment every check is `off`, whatever PLAN_LIMITS_MODE says, so a
 * self-hosted install never measures or refuses anything here.
 */
import { getConfig } from '@/lib/core/config';
import type { PlanEnforcement } from '@/lib/license/planClaim';
import type { PlanLimitsMode } from './types';

const RANK: Record<PlanLimitsMode, number> = { off: 0, shadow: 1, on: 2 };

/** The deployment-wide ceiling: off on onprem, else PLAN_LIMITS_MODE. */
export function deploymentPlanLimitsMode(): PlanLimitsMode {
  const cfg = getConfig();
  if (cfg.deployment.mode !== 'saas') return 'off';
  return cfg.planLimits.mode;
}

/** True when plan limits are measured at all on this deployment. */
export function planLimitsActive(): boolean {
  return deploymentPlanLimitsMode() !== 'off';
}

/**
 * The mode one tenant runs in: the deployment ceiling, lowered by the tenant's
 * own enforcement (license `plan.enforcement`, else PLAN_LIMITS_DEFAULT_ENFORCEMENT).
 * The tenant can never raise it above the deployment.
 */
export function effectivePlanLimitsMode(tenantEnforcement?: PlanEnforcement): PlanLimitsMode {
  const deployment = deploymentPlanLimitsMode();
  const tenant: PlanLimitsMode = tenantEnforcement ?? getConfig().planLimits.defaultEnforcement;
  return RANK[tenant] < RANK[deployment] ? tenant : deployment;
}
