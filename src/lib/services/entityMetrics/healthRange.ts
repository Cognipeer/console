/**
 * Time range of the entity health endpoints: the core tracing health routes and
 * the enterprise entity health API parse ranges with this one function, so the
 * same query answers the same range everywhere.
 *
 * Pure (no I/O): safe to import from route handlers and from client code.
 */
import { ENTITY_METRIC_BUCKET_MS } from '@/lib/database/provider/types.base';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';

const DAY_MS = 86_400_000;

export type HealthRange = { fromMs: number; toMs: number };

/**
 * An explicit `from`/`to` wins (as in the other tracing handlers), otherwise
 * `period` is resolved by the shared dashboard parser. No (or an unknown) period
 * means the last 24 hours: the parser has no `last_24_hours`, `last_day` is its
 * 24h period. `total` is bounded to 30 days, since health data is a rolling
 * rollup, not all-time history. The start is aligned to the rollup bucket and
 * kept inside retention, so the reported range is the one queried.
 * Returns an error message for an unusable range.
 */
export function resolveHealthRange(
  query: Record<string, string | undefined>,
  retentionDays: number,
  nowMs = Date.now(),
): HealthRange | { error: string } {
  const searchParams = new URLSearchParams(
    Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const rawFrom = searchParams.get('from');
  const rawTo = searchParams.get('to');
  const explicitFrom = rawFrom ? new Date(rawFrom).getTime() : undefined;
  const explicitTo = rawTo ? new Date(rawTo).getTime() : undefined;
  if ((rawFrom && !Number.isFinite(explicitFrom)) || (rawTo && !Number.isFinite(explicitTo))) {
    return { error: '`from` and `to` must be valid dates' };
  }

  let fromMs: number;
  let toMs: number;
  if (explicitFrom !== undefined || explicitTo !== undefined) {
    toMs = Math.min(explicitTo ?? nowMs, nowMs);
    fromMs = explicitFrom ?? toMs - DAY_MS;
  } else {
    const filter = parseDashboardDateFilterFromSearchParams(searchParams);
    toMs = nowMs;
    if (filter.period === 'total') {
      // `total` is also what the parser answers for a missing period: tell the two apart.
      fromMs = searchParams.get('period') === 'total' ? nowMs - 30 * DAY_MS : nowMs - DAY_MS;
    } else {
      fromMs = filter.from?.getTime() ?? nowMs - DAY_MS;
      toMs = Math.min(filter.to?.getTime() ?? nowMs, nowMs);
    }
  }
  if (fromMs >= toMs) return { error: '`from` must be earlier than `to`' };

  const retentionFloor = nowMs - retentionDays * DAY_MS;
  const aligned = Math.max(fromMs, retentionFloor);
  fromMs = aligned - (aligned % ENTITY_METRIC_BUCKET_MS);
  if (toMs <= fromMs) return { error: 'The requested range is outside the retained health data' };
  return { fromMs, toMs };
}

/** Bucket size the summaries use for a sparkline of `points` buckets (kept in step with entityHealthService). */
export function sparkBucketMs(range: HealthRange, points: number): number {
  const raw = (range.toMs - range.fromMs) / Math.max(points, 1);
  return Math.max(ENTITY_METRIC_BUCKET_MS, Math.ceil(raw / ENTITY_METRIC_BUCKET_MS) * ENTITY_METRIC_BUCKET_MS);
}
