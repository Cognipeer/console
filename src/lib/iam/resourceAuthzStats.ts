import { RUNTIME_ENFORCED_ACTIONS } from './actions';

/**
 * Counters of the decisions about resources (opening a portal, running an agent
 * through one, answering a pending request, session access - resourceAuthz.ts).
 * A leaf module: the engine reports them next to its own figures
 * (`GET /api/iam/engine/stats` -> `engine.resourceAuthz`) without importing the
 * code that produces them.
 */

export interface ResourceAuthzActionStats {
  allows: number;
  denies: number;
  /** Refused because the engine could not decide. */
  unavailable: number;
}

export interface ResourceAuthzStats {
  decisions: number;
  allows: number;
  denies: number;
  /** Refused with "authorization unavailable" (the engine or the principal could not be loaded). */
  unavailable: number;
  /** Denials whose audit row was not written (throttled repeat of one denial, or the per-workspace ceiling). */
  auditSuppressed: number;
  byAction: Record<string, ResourceAuthzActionStats>;
}

const zero = (): ResourceAuthzStats => ({
  decisions: 0,
  allows: 0,
  denies: 0,
  unavailable: 0,
  auditSuppressed: 0,
  byAction: {},
});

const stats = zero();

/** Actions are a closed list (resourceAuthz.ts validates them: the runtime-enforced ones); anything else is counted as `other`. */
function actionStats(action: string): ResourceAuthzActionStats {
  const key = Object.hasOwn(RUNTIME_ENFORCED_ACTIONS, action) ? action : 'other';
  return (stats.byAction[key] ??= { allows: 0, denies: 0, unavailable: 0 });
}

export function countResourceAuthz(action: string, outcome: 'allow' | 'deny' | 'unavailable'): void {
  stats.decisions++;
  const per = actionStats(action);
  if (outcome === 'allow') {
    stats.allows++;
    per.allows++;
  } else if (outcome === 'deny') {
    stats.denies++;
    per.denies++;
  } else {
    stats.unavailable++;
    per.unavailable++;
  }
}

export function countResourceAuditSuppressed(): void {
  stats.auditSuppressed++;
}

export function getResourceAuthzStats(): ResourceAuthzStats {
  return {
    ...stats,
    byAction: Object.fromEntries(Object.entries(stats.byAction).map(([key, value]) => [key, { ...value }])),
  };
}

export function resetResourceAuthzStatsForTests(): void {
  Object.assign(stats, zero());
}
