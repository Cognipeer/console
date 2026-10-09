/** Shadow mode (C2) public surface. SERVER ONLY. */
export * from './types';
export * from './mode';
export {
  FLUSH_EVENTS,
  FLUSH_INTERVAL_MS,
  MAX_KEYS_PER_TENANT,
  MAX_SAMPLES,
  clearPolicyMonitorStats,
  foldPolicyMonitorEntries,
  getPolicyMonitorTotals,
  flushShadowEvents,
  getPendingShadowEventCount,
  resetShadowBufferForTests,
  listShadowEntries,
  recordShadowEvent,
  resetShadowEntries,
  summarizeShadowEntries,
  type CategorySummary,
  type PolicyMonitorTotals,
  type ServiceSummary,
  type ShadowSummary,
} from './aggregate';
export { monitorDirection, recordPolicyMonitor, type PolicyMonitorSubject } from './policyMonitor';
export { observeGateDecision, observeUnmappedPath } from './observer';
export { getShadowStats, getTenantShadowStats, type ShadowStats } from './stats';
export { type TenantShadowMetrics } from './metrics';
export { canonicalRoute, maskPath } from './routePattern';
export { engineSelfTest } from './selfTest';
export { drainShadowQueue, getShadowQueueDepth, MAX_QUEUE, CONCURRENCY } from './queue';
