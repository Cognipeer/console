import { getPendingShadowEventCount } from './aggregate';
import { getTenantShadowMetrics, shadowMetrics, type TenantShadowMetrics } from './metrics';
import { getShadowQueueDepth } from './queue';
import type { ShadowEventCategory } from './types';

export interface ShadowStats {
  /** Observations accepted into the evaluation queue since process start. */
  enqueued: number;
  /** Observations shed because the queue was full. */
  queueDrops: number;
  /** Observations fully evaluated. */
  evaluated: number;
  /** Evaluations that threw (swallowed; never visible to requests). */
  evaluationFailures: number;
  /** Managed engine vs rbac.ts disagreements. Must be 0. */
  parityMismatches: number;
  /** Disagreements caused by tenant custom policies (not bugs). */
  customPolicyDiffs: number;
  /** Events recorded per category since process start. */
  events: Record<ShadowEventCategory, number>;
  droppedEvents: number;
  droppedKeys: number;
  flushes: number;
  flushFailures: number;
  /** Events buffered in memory, not flushed yet. */
  pendingEvents: number;
  queue: { queued: number; running: number; maxQueue: number; concurrency: number };
  uptimeMs: number;
}

export function getShadowStats(): ShadowStats {
  return {
    enqueued: shadowMetrics.enqueued,
    queueDrops: shadowMetrics.queueDrops,
    evaluated: shadowMetrics.evaluated,
    evaluationFailures: shadowMetrics.evaluationFailures,
    parityMismatches: shadowMetrics.parityMismatches,
    customPolicyDiffs: shadowMetrics.customPolicyDiffs,
    events: { ...shadowMetrics.events },
    droppedEvents: shadowMetrics.droppedEvents,
    droppedKeys: shadowMetrics.droppedKeys,
    flushes: shadowMetrics.flushes,
    flushFailures: shadowMetrics.flushFailures,
    pendingEvents: getPendingShadowEventCount(),
    queue: getShadowQueueDepth(),
    uptimeMs: Date.now() - shadowMetrics.startedAt,
  };
}

export function getTenantShadowStats(tenantDbName: string): TenantShadowMetrics {
  return getTenantShadowMetrics(tenantDbName);
}
