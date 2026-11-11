/**
 * Pure helpers for the evaluation run screens (workspace list, run detail,
 * suite detail, compare). Kept free of React so the outcome rules are unit
 * testable. Older runs lack the newer aggregate fields; every helper treats
 * absent and null the same.
 */

import type {
  EvalComparisonStatus,
  EvalRunAggregateView,
  EvalRunItemView,
  EvalRunView,
  EvalScoreView,
} from './types';

export const RUN_PAGE_SIZE = 50;

export const PASS_RATE_HINT =
  'Pass rate counts passed items out of the items that were scored. Errored and skipped items are left out, so read it together with the error rate.';

export function isRunActive(status: string | undefined | null): boolean {
  return status === 'pending' || status === 'running';
}

/** `errorRate` when the server sent it, else failed / total (older runs). */
export function deriveErrorRate(agg: Pick<EvalRunAggregateView, 'total' | 'failed' | 'errorRate'> | null | undefined): number {
  if (!agg) return 0;
  if (typeof agg.errorRate === 'number' && Number.isFinite(agg.errorRate)) return agg.errorRate;
  return agg.total > 0 ? agg.failed / agg.total : 0;
}

/** Items the pass rate is computed over: completed minus skipped (older runs: completed). */
export function scoredCount(agg: Pick<EvalRunAggregateView, 'completed' | 'skipped'>): number {
  return Math.max(0, agg.completed - (agg.skipped ?? 0));
}

export type ItemOutcome = 'error' | 'skipped' | 'pass' | 'fail';

export function itemOutcome(item: Pick<EvalRunItemView, 'error' | 'skipped' | 'passed'>): ItemOutcome {
  if (item.error) return 'error';
  if (item.skipped) return 'skipped';
  return item.passed ? 'pass' : 'fail';
}

export function scoreOutcome(score: Pick<EvalScoreView, 'error' | 'skipped' | 'passed'>): ItemOutcome {
  if (score.error) return 'error';
  if (score.skipped) return 'skipped';
  return score.passed ? 'pass' : 'fail';
}

export const OUTCOME_BADGE: Record<ItemOutcome, string> = {
  error: 'ds-badge-err',
  skipped: 'ds-badge',
  pass: 'ds-badge-teal',
  fail: 'ds-badge-warn',
};

/**
 * Merge a freshly fetched first page into the runs already shown (which may
 * include further pages loaded earlier): fresh rows win and come first, other
 * rows keep their order.
 */
export function mergeRunPages(existing: EvalRunView[], firstPage: EvalRunView[]): EvalRunView[] {
  const seen = new Set(firstPage.map((r) => r.id));
  return [...firstPage, ...existing.filter((r) => !seen.has(r.id))];
}

/** The most rows GET /api/evaluation/runs returns in one call. */
export const RUN_LIST_MAX = 200;

/** How many rows a refresh asks for: every row already on screen (up to the server's cap), at least one page. */
export function runRefreshLimit(loaded: number): number {
  return Math.min(Math.max(loaded, RUN_PAGE_SIZE), RUN_LIST_MAX);
}

/**
 * Apply a refresh of the newest `limit` rows. When it covers everything on screen it REPLACES the list, so
 * rows from later pages get their new status and deleted runs disappear; past the cap the tail is kept.
 */
export function refreshRunList(existing: EvalRunView[], refreshed: EvalRunView[], limit: number): EvalRunView[] {
  return existing.length <= limit ? refreshed : mergeRunPages(existing, refreshed);
}

/** Append a later page, skipping rows already present (new runs shift the offsets). */
export function appendRunPage(existing: EvalRunView[], nextPage: EvalRunView[]): EvalRunView[] {
  const seen = new Set(existing.map((r) => r.id));
  return [...existing, ...nextPage.filter((r) => !seen.has(r.id))];
}

/** A non-blank message for a failed fetch, preferring the server's own error text. */
export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  } catch {
    // Non-JSON body (a proxy 502 page, for instance): fall through.
  }
  return `${fallback} (HTTP ${res.status})`;
}

/** Warn when two runs did not use the same dataset or suite: their per-item diff is then mostly noise. */
export function compareMismatchWarning(
  baseline: Pick<EvalRunView, 'datasetKey' | 'suiteKey'> | undefined,
  current: Pick<EvalRunView, 'datasetKey' | 'suiteKey'>,
): string | null {
  if (!baseline) return null;
  if (baseline.datasetKey && current.datasetKey && baseline.datasetKey !== current.datasetKey) {
    return `The baseline used dataset "${baseline.datasetKey}" but this run used "${current.datasetKey}". Most items will show as new or removed.`;
  }
  return null;
}

export const COMPARE_STATUS_LABEL: Record<EvalComparisonStatus, string> = {
  regressed: 'regressed',
  fixed: 'fixed',
  unchanged: 'unchanged',
  added: 'new',
  removed: 'removed',
  not_comparable: 'not comparable',
};

/** Older servers omit `not_comparable` from the compare summary; read counts defensively. */
export function summaryCount(summary: Partial<Record<EvalComparisonStatus, number>> | undefined, status: EvalComparisonStatus): number {
  const v = summary?.[status];
  return typeof v === 'number' ? v : 0;
}
