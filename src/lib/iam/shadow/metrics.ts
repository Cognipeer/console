/**
 * In-memory counters of the shadow-mode machinery (per process). Exposed by the
 * engine stats report next to the engine's own decision/latency numbers.
 * Dependency-free so the request gate can touch it without loading the engine.
 */

import type { ShadowEventCategory } from './types';

export interface ShadowMetrics {
  /** Gate observations accepted into the queue. */
  enqueued: number;
  /** Observations dropped because the queue was full (overload shedding). */
  queueDrops: number;
  /** Observations whose evaluation finished. */
  evaluated: number;
  /** Observations whose evaluation threw (never surfaced to the request). */
  evaluationFailures: number;
  /** Managed engine disagreed with rbac.ts. Must stay 0. */
  parityMismatches: number;
  /** Disagreements explained by the tenant's own custom policies (not parity bugs). */
  customPolicyDiffs: number;
  /** Events recorded per category since process start. */
  events: Record<ShadowEventCategory, number>;
  /** Events discarded because a key/tenant cap was hit. */
  droppedEvents: number;
  /** Distinct keys refused because the per-tenant key cap was reached. */
  droppedKeys: number;
  flushes: number;
  flushFailures: number;
  startedAt: number;
}

export const shadowMetrics: ShadowMetrics = {
  enqueued: 0,
  queueDrops: 0,
  evaluated: 0,
  evaluationFailures: 0,
  parityMismatches: 0,
  customPolicyDiffs: 0,
  events: { 'parity-mismatch': 0, 'token-groups': 0, 'project-narrowing': 0, 'unmapped-path': 0, 'policy-monitor': 0 },
  droppedEvents: 0,
  droppedKeys: 0,
  flushes: 0,
  flushFailures: 0,
  startedAt: Date.now(),
};

/**
 * Per-tenant slice of the counters above. In a multi-tenant (SaaS) process the
 * process-wide numbers describe other tenants' traffic, so the report API only
 * ever returns this slice there.
 */
export interface TenantShadowMetrics {
  enqueued: number;
  evaluated: number;
  queueDrops: number;
  evaluationFailures: number;
  parityMismatches: number;
  droppedEvents: number;
  droppedKeys: number;
}

const MAX_TENANT_METRICS = 2_000;
const tenantMetrics = new Map<string, TenantShadowMetrics>();

const emptyTenantMetrics = (): TenantShadowMetrics => ({
  enqueued: 0,
  evaluated: 0,
  queueDrops: 0,
  evaluationFailures: 0,
  parityMismatches: 0,
  droppedEvents: 0,
  droppedKeys: 0,
});

/** Bounded (oldest tenant is forgotten first); never throws. */
export function bumpTenantMetric(tenantDbName: string, field: keyof TenantShadowMetrics, by = 1): void {
  try {
    let m = tenantMetrics.get(tenantDbName);
    if (!m) {
      if (tenantMetrics.size >= MAX_TENANT_METRICS) {
        const oldest = tenantMetrics.keys().next().value as string | undefined;
        if (oldest !== undefined) tenantMetrics.delete(oldest);
      }
      m = emptyTenantMetrics();
      tenantMetrics.set(tenantDbName, m);
    }
    m[field] += by;
  } catch {
    // counters must never affect callers
  }
}

export function getTenantShadowMetrics(tenantDbName: string): TenantShadowMetrics {
  return { ...(tenantMetrics.get(tenantDbName) ?? emptyTenantMetrics()) };
}

export function resetShadowMetricsForTests(): void {
  tenantMetrics.clear();
  shadowMetrics.enqueued = 0;
  shadowMetrics.queueDrops = 0;
  shadowMetrics.evaluated = 0;
  shadowMetrics.evaluationFailures = 0;
  shadowMetrics.parityMismatches = 0;
  shadowMetrics.customPolicyDiffs = 0;
  shadowMetrics.events = { 'parity-mismatch': 0, 'token-groups': 0, 'project-narrowing': 0, 'unmapped-path': 0, 'policy-monitor': 0 };
  shadowMetrics.droppedEvents = 0;
  shadowMetrics.droppedKeys = 0;
  shadowMetrics.flushes = 0;
  shadowMetrics.flushFailures = 0;
  shadowMetrics.startedAt = Date.now();
}
