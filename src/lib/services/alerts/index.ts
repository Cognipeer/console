/**
 * Alerts module — public API surface.
 */

export { AlertService, VALID_METRICS, VALID_WINDOWS, VALID_MODULES, MODULE_METRICS } from './alertService';
export { evaluateTenantAlerts } from './alertEvaluator';
export { startAlertScheduler, stopAlertScheduler } from './alertScheduler';
export type { CreateAlertRuleInput } from './alertService';
export type { EvaluationContext } from './alertEvaluator';
