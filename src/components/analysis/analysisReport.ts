/**
 * Reporting helpers for an analysis run — turn the per-item results into
 * something a human reads: a CSV export (one row per conversation, one column
 * per extracted field) and a field-value distribution ("of 120 conversations,
 * 80 were intent=billing"). Pure functions, no React.
 */

import type { AnalysisRunItemView } from './types';

/** Stable union of all extracted field keys across a run's items, in first-seen order. */
export function collectFieldKeys(items: AnalysisRunItemView[]): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item.extractedFields ?? {})) {
      if (!set.has(key)) { set.add(key); seen.push(key); }
    }
  }
  return seen;
}

function cellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** RFC-4180-ish CSV escaping. */
function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Build a CSV string: status/judge/accuracy columns + one column per field. */
export function itemsToCsv(items: AnalysisRunItemView[]): string {
  const fieldKeys = collectFieldKeys(items);
  const header = ['conversation', 'result', 'missing', 'judge_score', 'accuracy_score', ...fieldKeys];
  const rows = items.map((i) => {
    const result = i.error ? 'error' : i.passed ? 'pass' : 'fail';
    const cols = [
      i.conversationKey,
      result,
      (i.missing ?? []).join(' '),
      i.judge && !i.judge.error ? String(i.judge.score) : '',
      i.accuracy && i.accuracy.comparedCount > 0 ? String(i.accuracy.score) : '',
      ...fieldKeys.map((k) => cellValue(i.extractedFields?.[k])),
    ];
    return cols.map((c) => csvEscape(c)).join(',');
  });
  return [header.map(csvEscape).join(','), ...rows].join('\n');
}

export interface FieldDistribution {
  key: string;
  /** value → count, sorted desc by count. */
  buckets: Array<{ value: string; count: number }>;
  /** items where this field was null/empty. */
  emptyCount: number;
  total: number;
}

/** Per-field value frequency across the run (skips errored items). */
export function fieldDistributions(items: AnalysisRunItemView[]): FieldDistribution[] {
  const ok = items.filter((i) => !i.error);
  const fieldKeys = collectFieldKeys(ok);
  return fieldKeys.map((key) => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const item of ok) {
      const v = item.extractedFields?.[key];
      if (v === null || v === undefined || v === '') { emptyCount += 1; continue; }
      const label = cellValue(v);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const buckets = Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);
    return { key, buckets, emptyCount, total: ok.length };
  });
}

/** Trigger a client-side download of `content` as a file. */
export function downloadFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
