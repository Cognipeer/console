/**
 * Pure helpers of the bulk actions on a page of people or tokens: how a result
 * is summarised ("12 will change, 3 skipped: 2 already disabled, 1 yourself"),
 * when a typed confirmation is asked for, and how a selection is split into
 * requests the server accepts.
 */

import { chunkIds, mergeBulkResults, type BulkItemResult, type BulkResult } from './directoryApi';

/** Above this many targets a bulk action asks for a typed confirmation. */
export const TYPED_CONFIRMATION_ABOVE = 20;

export function needsTypedConfirmation(count: number): boolean {
  return count > TYPED_CONFIRMATION_ABOVE;
}

/** Counts of the skipped / failed items per reason code (`already_in_state`, `self_not_allowed`...). */
export function reasonCounts(results: readonly BulkItemResult[], outcome: 'skipped' | 'failed'): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of results) {
    if (item.outcome !== outcome) continue;
    const code = item.code ?? 'failed';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** Items that did not go through (skipped or failed), for the result list. */
export function problems(result: BulkResult): BulkItemResult[] {
  return result.results.filter((r) => r.outcome !== 'ok');
}

/** Runs one request per chunk of `ids` (at most 100 each), sequentially, and folds the answers into one. */
export async function runChunked(
  ids: readonly string[],
  send: (chunk: string[]) => Promise<BulkResult>,
): Promise<BulkResult> {
  const parts: BulkResult[] = [];
  for (const chunk of chunkIds(ids)) parts.push(await send(chunk));
  return mergeBulkResults(parts);
}

/** The ids of the selected rows, in page order, without duplicates. */
export function selectedIds<T>(rows: readonly T[], selected: ReadonlySet<string>, keyOf: (row: T) => string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (selected.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
