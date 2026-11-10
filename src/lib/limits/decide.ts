/**
 * The one comparison every plan-limit check goes through. Pure: no I/O, no clock.
 */
import type { PlanLimitDecision, PlanLimitKind, PlanLimitsMode } from './types';

export interface DecideLimitInput {
  kind: PlanLimitKind;
  dimension?: string;
  mode: PlanLimitsMode;
  /** undefined = no limit. 0 = none allowed. */
  limit?: number;
  used: number;
  /** What this request adds (default 1). */
  amount?: number;
  retryAfterMs?: number;
  resetAt?: Date;
}

export function decideLimit(input: DecideLimitInput): PlanLimitDecision {
  const amount = input.amount ?? 1;
  const over = input.limit !== undefined && input.used + amount > input.limit;
  const decision: PlanLimitDecision = {
    allowed: true,
    outcome: 'allowed',
    kind: input.kind,
    dimension: input.dimension,
    limit: input.limit,
    used: input.used,
  };
  if (input.mode === 'off' || !over) return decision;
  decision.retryAfterMs = input.retryAfterMs;
  decision.resetAt = input.resetAt;
  if (input.mode === 'shadow') {
    decision.outcome = 'would_refuse';
    return decision;
  }
  decision.allowed = false;
  decision.outcome = 'refused';
  return decision;
}
