/**
 * "Does not apply to this item" results. A skipped score is neither a pass nor
 * a failure: it carries `score: 0` / `passed: false` only so the shape stays
 * valid, and the runner's combine ignores it (an item where EVERY scorer is
 * skipped is itself skipped).
 */

import type { ScorerType, ScoreResult } from '../types';

export function skippedScore(scorerType: ScorerType, weight: number, reason: string): ScoreResult {
  return { scorerType, score: 0, passed: false, weight, skipped: true, detail: { reason } };
}

/** True when the item carries a usable gold answer. */
export function hasReference(reference: unknown): reference is string {
  return typeof reference === 'string' && reference.trim().length > 0;
}
