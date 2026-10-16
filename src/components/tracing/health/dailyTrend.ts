/** Shaping of the tracing overview's daily analytics into chart rows. Pure. */

import { formatDayAxisLabel } from './healthFormat';

export interface DailyAnalyticsRow {
  date: string;
  sessionsCount?: number | null;
  totalEvents?: number | null;
  totalTokens?: number | null;
}

export interface DailyTrendRow {
  date: string;
  /** X axis label (a local calendar day). */
  day: string;
  sessions: number;
  tokens: number;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** One row per day, oldest first; a repeated day keeps its first row. */
export function buildDailyTrendRows(daily: DailyAnalyticsRow[] | undefined, locale?: string): DailyTrendRow[] {
  if (!Array.isArray(daily)) return [];
  const seen = new Set<string>();
  const rows: DailyTrendRow[] = [];
  for (const entry of daily) {
    if (!entry || typeof entry.date !== 'string' || seen.has(entry.date)) continue;
    seen.add(entry.date);
    rows.push({
      date: entry.date,
      day: formatDayAxisLabel(entry.date, locale),
      sessions: count(entry.sessionsCount),
      tokens: count(entry.totalTokens),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
