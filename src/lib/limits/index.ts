/** Plan limits: public API. Hosted (saas) deployments only; see mode.ts. */
export * from './types';
export * from './errors';
export * from './mode';
export { decideLimit, type DecideLimitInput } from './decide';
export {
  limitsFromPlanClaim,
  resolveTenantPlan,
  invalidateTenantPlan,
  clearTenantPlanCacheForTests,
} from './tenantLimits';
export { invalidateTenantLicenseState } from './invalidate';
export {
  recordLimitEvent,
  outcomeEventFor,
  listLimitEvents,
  pruneLimitEvents,
  flushLimitEvents,
  type RecordLimitEventInput,
} from './events';
export {
  enforceApiRequestRate,
  assertApiRequestRate,
  takeRequest,
  rpmKey,
  rpmCounters,
  type ApiRequestRateResult,
} from './rpm';
export {
  acquirePlanLease,
  waitForPlanLease,
  countPlanLeases,
  leaseKey,
  type PlanLease,
  type AcquirePlanLeaseInput,
  type AcquirePlanLeaseResult,
} from './leases';
export {
  currentPeriod,
  periodEnd,
  addMonthlyUsage,
  getMonthlyUsage,
  checkMonthlyAllowance,
  assertMonthlyAllowance,
  monthlyLimitFor,
  MONTHLY_METERS,
  type MonthlyUsage,
} from './meters';
export { checkStorageStock, assertStorageStock, noteStoredBytes, getStoredBytes } from './storage';
export { checkSeats, assertSeats, assertSeatForReEnable, countSeats, type SeatKind } from './seats';
export { notePeak, getPeaks24h } from './peaks';
