/**
 * Alerts module — public API surface.
 */

export {
  AlertService,
  ALERT_CHANNEL_TYPES,
  VALID_METRICS,
  VALID_WINDOWS,
  VALID_MODULES,
  MODULE_METRICS,
  validateRuleInput,
} from './alertService';
export { AlertApiError, isAlertApiError } from './alertApiError';
export { IncidentService, deriveSeverity } from './incidentService';
export { evaluateTenantAlerts } from './alertEvaluator';
export { startAlertScheduler, stopAlertScheduler } from './alertScheduler';
export type { CreateAlertRuleInput, UpdateAlertRuleInput, ValidatedRule } from './alertService';
export type { CreateIncidentInput } from './incidentService';
export type { EvaluationContext } from './alertEvaluator';
