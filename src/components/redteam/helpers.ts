/**
 * Pure helpers shared by the red-team screens (no React, no fetching), so the
 * rules that matter — which attempts can be reviewed, what an inconclusive run
 * says, how a new attempt id is picked — are testable on their own.
 */

import { attemptKeyOf } from '@/lib/services/redteam/attemptKey';
import { ATTEMPT_ID_PATTERN } from '@/lib/services/redteam/limits';
import type {
  RedTeamAggregateView,
  RedTeamAttemptView,
  RedTeamInconclusiveReason,
  RedTeamOutcome,
  RedTeamRunStatus,
  RedTeamRunView,
} from './types';

/** A rate as a percentage; `—` when the run had nothing to measure (null) or none was recorded. */
export function pct(value?: number | null): string {
  return value === undefined || value === null || !Number.isFinite(value) ? '—' : `${Math.round(value * 100)}%`;
}

export function effectiveOutcome(a: Pick<RedTeamAttemptView, 'outcome' | 'review'>): RedTeamOutcome {
  return a.review?.outcome ?? a.outcome;
}

/** The row key of an attempt; a payload from before keys were stored falls back to probe + id. */
export function attemptKeyFor(a: Pick<RedTeamAttemptView, 'attemptKey' | 'probeKey' | 'attemptId'>): string {
  return a.attemptKey || attemptKeyOf(a);
}

/** The target failed before any turn completed: nothing was judged. */
export function isFailedAttempt(a: Pick<RedTeamAttemptView, 'error' | 'partial'>): boolean {
  return Boolean(a.error) && !a.partial;
}

export function isFinishedStatus(status: RedTeamRunStatus | string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isActiveStatus(status: RedTeamRunStatus | string | undefined): boolean {
  return status === 'pending' || status === 'running';
}

export type ReviewBlock = 'run-active' | 'restricted' | 'failed';

/** Why an attempt cannot be reviewed now, or null when it can. */
export function reviewBlockedReason(run: Pick<RedTeamRunView, 'status'>, a: RedTeamAttemptView): ReviewBlock | null {
  if (!isFinishedStatus(run.status)) return 'run-active';
  if (a.restricted) return 'restricted';
  if (isFailedAttempt(a)) return 'failed';
  return null;
}

export const REVIEW_BLOCK_HINT: Record<ReviewBlock, string> = {
  'run-active': 'Review is available once the scan has finished.',
  restricted: 'This attempt used knowledge base documents you cannot read, so it cannot be reviewed.',
  failed: 'The target failed before answering, so there is nothing to review.',
};

export const INCONCLUSIVE_REASON_TEXT: Record<RedTeamInconclusiveReason, string> = {
  'no-completed-attempts': 'No attempt completed, so there is nothing to measure.',
  'target-errors': 'Too many attempts ended in a target error.',
  'judge-errors': 'Too many judge calls failed, so verdicts that needed a judge are unreliable.',
};

/**
 * The reasons a run's rates should not be trusted, in order; empty when the run
 * is conclusive. A run stored before reasons existed that is flagged
 * inconclusive was flagged for judge errors.
 */
export function inconclusiveReasons(
  aggregate?: Pick<RedTeamAggregateView, 'inconclusive' | 'inconclusiveReasons'> | null,
): RedTeamInconclusiveReason[] {
  if (!aggregate) return [];
  if (aggregate.inconclusiveReasons && aggregate.inconclusiveReasons.length > 0) return aggregate.inconclusiveReasons;
  return aggregate.inconclusive ? ['judge-errors'] : [];
}

/** The tag for a partial attempt, e.g. `partial — target error after 2 turns`. */
export function partialLabel(a: Pick<RedTeamAttemptView, 'transcript'>): string {
  const turns = a.transcript?.length ?? 0;
  return `partial — target error after ${turns} turn${turns === 1 ? '' : 's'}`;
}

/**
 * The id for a new attempt of a custom probe: the largest numeric suffix among
 * the ids in use + 1, so an id that was removed earlier is never handed out
 * again (a stored run refers to attempts by id). Ids without a numeric suffix
 * count as 0.
 */
export function nextAttemptId(existing: string[], prefix = 'attempt-', floor = 0): string {
  return `${prefix}${highestAttemptSuffix(existing, floor) + 1}`;
}

/** The largest numeric suffix among the ids (or `floor` when that is larger); ids without a suffix count as 0. */
export function highestAttemptSuffix(ids: string[], floor = 0): number {
  let max = floor;
  for (const id of ids) {
    const m = /(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return max;
}

/** Why an attempt id cannot be saved, or null. `others` are the ids of the other attempts in the probe. */
export function attemptIdError(id: string, others: string[]): string | null {
  if (!id.trim()) return 'An attempt id is required.';
  if (!ATTEMPT_ID_PATTERN.test(id)) return 'Use letters, digits, ".", "_" or "-" (up to 64 characters).';
  if (others.includes(id)) return 'Another attempt already uses this id.';
  return null;
}

/** Splits a textarea of forbidden patterns: one per line, blank lines dropped. */
export function splitPatternLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Selected probe keys that no longer match a probe in the catalog. Keys of a
 * disabled custom probe are not counted: they still exist, they are just skipped.
 */
export function missingProbeKeys(selected: string[], catalogKeys: string[], disabledKeys: string[] = []): string[] {
  const known = new Set([...catalogKeys, ...disabledKeys]);
  return selected.filter((k) => !known.has(k));
}

/** The selected probes that exist but are disabled, with their names. */
export function selectedDisabledProbes(
  selected: string[],
  disabled: Array<{ key: string; name: string }> = [],
): Array<{ key: string; name: string }> {
  const chosen = new Set(selected);
  return disabled.filter((d) => chosen.has(d.key));
}

/**
 * Merges a freshly polled first page into the rows already loaded: rows that
 * are new come first, rows that are already loaded are replaced in place, and
 * the loaded tail is kept.
 */
export function mergePolledPage<T extends { id: string }>(prev: T[], page: T[], limit?: number): T[] {
  // A page shorter than its limit is the whole list, so it replaces the rows (a deleted run disappears).
  if (limit !== undefined && page.length < limit) return page;
  const fresh = new Map(page.map((r) => [r.id, r]));
  const known = new Set(prev.map((r) => r.id));
  const added = page.filter((r) => !known.has(r.id));
  return [...added, ...prev.map((r) => fresh.get(r.id) ?? r)];
}

/** Appends a "Load more" page, dropping rows whose id is already loaded (offset paging can repeat one). */
export function appendPage<T extends { id: string }>(prev: T[], page: T[]): T[] {
  const known = new Set(prev.map((r) => r.id));
  const out: T[] = [];
  for (const r of page) {
    if (known.has(r.id)) continue;
    known.add(r.id);
    out.push(r);
  }
  return [...prev, ...out];
}

/** The largest page the runs endpoint returns; polling asks for no more than this. */
export const POLL_PAGE_LIMIT = 100;
