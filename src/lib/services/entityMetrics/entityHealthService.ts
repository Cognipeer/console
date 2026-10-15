/**
 * Entity health read service: scoreboard summaries, per-entity series and
 * active-entity lookups over `entity_metrics`.
 *
 * Every function issues a bounded number of aggregate queries (never one per
 * entity) and clamps the requested range to the retention window.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import {
  ENTITY_METRIC_BUCKET_MS,
  type EntityMetricType,
  type IEntityMetricAggregate,
  type EntityMetricCounters,
} from '@/lib/database/provider/types.base';
import { emptyCounters, mergeCounters } from './latencyHistogram';
import { deriveMetrics, pickBucketMs, toCounters, type DerivedMetrics } from './entityMetricsQuery';

const log = createLogger('entity-health');

const DAY_MS = 86_400_000;
const MAX_KEYS = 500;
const AGGREGATE_LIMIT = 50_000;
const DEFAULT_SPARK_POINTS = 24;
const MAX_SPARK_POINTS = 96;
const DEFAULT_ACTIVE_LIMIT = 50;
const MAX_ACTIVE_LIMIT = 500;
/** Picker keystrokes re-read the same 30-day totals; keep them briefly and filter `q` in memory. */
const ACTIVE_TOTALS_TTL_MS = 60_000;
const ACTIVE_TOTALS_MAX_ENTRIES = 200;

type ActiveTotals = Array<{ key: string; requests: number }>;
const activeTotalsCache = new Map<string, { expiresAt: number; rows: ActiveTotals }>();
const activeTotalsInflight = new Map<string, Promise<ActiveTotals>>();

/** Test hook: the active-totals cache is module-level state. */
export function __resetEntityHealthCachesForTests(): void {
  activeTotalsCache.clear();
  activeTotalsInflight.clear();
}

/** Aggregate rows come back oldest-bucket-first, so hitting the cap silently drops the newest data: say so. */
function warnIfTruncated(rows: unknown[], operation: string, context: Record<string, unknown>): void {
  if (rows.length >= AGGREGATE_LIMIT) {
    log.warn('Entity metrics aggregate hit the row limit; the newest buckets may be missing', {
      operation,
      limit: AGGREGATE_LIMIT,
      ...context,
    });
  }
}

export interface EntityHealthScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}

export interface EntityHealthSpark {
  requests: number[];
  errorRate: (number | null)[];
  p95Ms: (number | null)[];
}

export interface EntityHealthSummary {
  entityKey: string;
  totals: DerivedMetrics;
  previous: DerivedMetrics | null;
  spark: EntityHealthSpark;
}

export interface EntitySummariesInput extends EntityHealthScope {
  entityType: EntityMetricType;
  fromMs: number;
  toMs: number;
  /** Restrict to these keys (entities without data are returned with zero totals). */
  keys?: string[];
  sparkPoints?: number;
  withPrevious?: boolean;
}

export interface EntitySeriesInput extends EntityHealthScope {
  entityType: EntityMetricType;
  entityKey: string;
  fromMs: number;
  toMs: number;
  bucketMs?: number;
}

export interface EntitySeries {
  range: { fromMs: number; toMs: number; bucketMs: number };
  buckets: Array<{ t: number } & DerivedMetrics>;
  totals: DerivedMetrics;
  previous: DerivedMetrics | null;
}

export interface ActiveEntityKeysInput extends EntityHealthScope {
  entityType: EntityMetricType;
  fromMs: number;
  toMs: number;
  q?: string;
  limit?: number;
}

export interface ActiveEntityKey {
  key: string;
  requests: number;
  lastBucketMs: number;
}

/** Floor to the rollup bucket so the current partial bucket is included. */
function floorBucket(ms: number): number {
  return ms - (ms % ENTITY_METRIC_BUCKET_MS);
}

/** Align the range to rollup buckets and clamp it to the retention window. */
function clampRange(fromMs: number, toMs: number): { fromMs: number; toMs: number } | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const retentionFloor = Date.now() - getConfig().health.entityMetricsRetentionDays * DAY_MS;
  const from = floorBucket(Math.max(fromMs, retentionFloor));
  const to = Math.max(toMs, from);
  if (to <= from) return null;
  return { fromMs: from, toMs: to };
}

/**
 * The previous period [from - span, from] is only comparable when retention still
 * covers all of it; a partially retained window would understate the previous
 * totals and fake growth, so it counts as "no previous data".
 */
function previousWindowRetained(previousFromMs: number): boolean {
  const retentionFloor = floorBucket(Date.now() - getConfig().health.entityMetricsRetentionDays * DAY_MS);
  return previousFromMs >= retentionFloor;
}

function sparkBucketSize(fromMs: number, toMs: number, points: number): number {
  const raw = (toMs - fromMs) / Math.max(points, 1);
  return Math.max(ENTITY_METRIC_BUCKET_MS, Math.ceil(raw / ENTITY_METRIC_BUCKET_MS) * ENTITY_METRIC_BUCKET_MS);
}

/** Entity health scoreboard: totals, previous-period totals and a sparkline per entity. */
export async function getEntitySummaries(input: EntitySummariesInput): Promise<EntityHealthSummary[]> {
  const range = clampRange(input.fromMs, input.toMs);
  if (!range) return [];
  if (input.keys && input.keys.length === 0) return [];
  const keys = input.keys?.slice(0, MAX_KEYS);
  const points = Math.min(Math.max(Math.floor(input.sparkPoints ?? DEFAULT_SPARK_POINTS), 1), MAX_SPARK_POINTS);
  const span = range.toMs - range.fromMs;
  const previousRange = { fromMs: range.fromMs - span, toMs: range.fromMs };
  const withPrevious = (input.withPrevious ?? true) && previousWindowRetained(previousRange.fromMs);

  const size = sparkBucketSize(range.fromMs, range.toMs, points);
  const firstBucket = Math.floor(range.fromMs / size) * size;
  const bucketCount = Math.floor((range.toMs - 1 - firstBucket) / size) + 1;

  const base = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    entityType: input.entityType,
    ...(keys ? { entityKeys: keys } : {}),
    limit: AGGREGATE_LIMIT,
  };

  const [currentRows, previousRows] = await runWithTenantScope(input.tenantDbName, (db) =>
    Promise.all([
      db.aggregateEntityMetrics({ ...base, fromMs: range.fromMs, toMs: range.toMs, groupBy: ['entityKey'], bucketMs: size }),
      withPrevious
        ? db.aggregateEntityMetrics({ ...base, fromMs: previousRange.fromMs, toMs: previousRange.toMs, groupBy: ['entityKey'] })
        : Promise.resolve([] as IEntityMetricAggregate[]),
    ]),
  );

  warnIfTruncated(currentRows, 'getEntitySummaries', { entityType: input.entityType, bucketMs: size });
  warnIfTruncated(previousRows, 'getEntitySummaries.previous', { entityType: input.entityType });

  const byKey = new Map<string, { totals: EntityMetricCounters; buckets: Map<number, EntityMetricCounters> }>();
  for (const row of currentRows) {
    if (!row.entityKey) continue;
    let entry = byKey.get(row.entityKey);
    if (!entry) {
      entry = { totals: emptyCounters(), buckets: new Map() };
      byKey.set(row.entityKey, entry);
    }
    const counters = toCounters(row);
    entry.totals = mergeCounters(entry.totals, counters);
    const index = Math.floor(((row.bucketMs ?? firstBucket) - firstBucket) / size);
    const existing = entry.buckets.get(index);
    entry.buckets.set(index, existing ? mergeCounters(existing, counters) : counters);
  }

  const previousByKey = new Map<string, EntityMetricCounters>();
  for (const row of previousRows) {
    if (!row.entityKey) continue;
    const existing = previousByKey.get(row.entityKey);
    previousByKey.set(row.entityKey, existing ? mergeCounters(existing, toCounters(row)) : toCounters(row));
  }

  // An entity that went silent (data only in the previous period, or an explicitly requested key) still gets a row.
  const allKeys = new Set<string>([...byKey.keys(), ...previousByKey.keys(), ...(keys ?? [])]);

  const summaries: EntityHealthSummary[] = [];
  for (const entityKey of allKeys) {
    const entry = byKey.get(entityKey);
    const totals = deriveMetrics(entry?.totals ?? emptyCounters(), input.entityType);
    const spark: EntityHealthSpark = { requests: [], errorRate: [], p95Ms: [] };
    for (let i = 0; i < bucketCount; i += 1) {
      const derived = deriveMetrics(entry?.buckets.get(i) ?? emptyCounters(), input.entityType);
      spark.requests.push(derived.requests);
      spark.errorRate.push(derived.errorRate);
      spark.p95Ms.push(derived.p95Ms);
    }
    const previousCounters = previousByKey.get(entityKey);
    summaries.push({
      entityKey,
      totals,
      previous: withPrevious && previousCounters ? deriveMetrics(previousCounters, input.entityType) : null,
      spark,
    });
  }

  summaries.sort((a, b) => b.totals.requests - a.totals.requests || a.entityKey.localeCompare(b.entityKey));
  return summaries;
}

/** Zero-filled time series for one entity, plus range totals and previous-period totals. */
export async function getEntitySeries(input: EntitySeriesInput): Promise<EntitySeries> {
  const range = clampRange(input.fromMs, input.toMs) ?? {
    fromMs: floorBucket(input.fromMs),
    toMs: floorBucket(input.fromMs) + ENTITY_METRIC_BUCKET_MS,
  };
  const requested = input.bucketMs !== undefined && input.bucketMs >= ENTITY_METRIC_BUCKET_MS
    ? Math.round(input.bucketMs / ENTITY_METRIC_BUCKET_MS) * ENTITY_METRIC_BUCKET_MS
    : pickBucketMs(range.fromMs, range.toMs);
  // Never produce more than a few thousand points whatever the caller asked for.
  const bucketMs = Math.max(requested, Math.ceil((range.toMs - range.fromMs) / 2000 / ENTITY_METRIC_BUCKET_MS) * ENTITY_METRIC_BUCKET_MS);

  const span = range.toMs - range.fromMs;
  const withPrevious = previousWindowRetained(range.fromMs - span);
  const base = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    entityType: input.entityType,
    entityKeys: [input.entityKey],
    limit: AGGREGATE_LIMIT,
  };

  const [rows, previousRows] = await runWithTenantScope(input.tenantDbName, (db) =>
    Promise.all([
      db.aggregateEntityMetrics({ ...base, fromMs: range.fromMs, toMs: range.toMs, groupBy: [], bucketMs }),
      withPrevious
        ? db.aggregateEntityMetrics({ ...base, fromMs: range.fromMs - span, toMs: range.fromMs, groupBy: [] })
        : Promise.resolve([] as IEntityMetricAggregate[]),
    ]),
  );

  warnIfTruncated(rows, 'getEntitySeries', { entityType: input.entityType, bucketMs });

  const byBucket = new Map<number, EntityMetricCounters>();
  let totals = emptyCounters();
  for (const row of rows) {
    const counters = toCounters(row);
    totals = mergeCounters(totals, counters);
    const t = row.bucketMs ?? 0;
    const existing = byBucket.get(t);
    byBucket.set(t, existing ? mergeCounters(existing, counters) : counters);
  }

  const firstBucket = Math.floor(range.fromMs / bucketMs) * bucketMs;
  const buckets: Array<{ t: number } & DerivedMetrics> = [];
  for (let t = firstBucket; t < range.toMs; t += bucketMs) {
    buckets.push({ t, ...deriveMetrics(byBucket.get(t) ?? emptyCounters(), input.entityType) });
  }

  let previousTotals: EntityMetricCounters | null = null;
  for (const row of previousRows) {
    previousTotals = previousTotals ? mergeCounters(previousTotals, toCounters(row)) : toCounters(row);
  }

  return {
    range: { fromMs: range.fromMs, toMs: range.toMs, bucketMs },
    buckets,
    totals: deriveMetrics(totals, input.entityType),
    previous: previousTotals ? deriveMetrics(previousTotals, input.entityType) : null,
  };
}

/**
 * Entities with data in the range, busiest first. Used by entity pickers and
 * as absence-alert candidates. `lastBucketMs` has the granularity of the
 * range's bucket size (5 min up to 6 h, then hourly, then daily).
 */
export async function listActiveEntityKeys(input: ActiveEntityKeysInput): Promise<ActiveEntityKey[]> {
  const range = clampRange(input.fromMs, input.toMs);
  if (!range) return [];
  const limit = Math.min(Math.max(Math.floor(input.limit ?? DEFAULT_ACTIVE_LIMIT), 1), MAX_ACTIVE_LIMIT);
  const bucketMs = pickBucketMs(range.fromMs, range.toMs);
  const scope = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    entityType: input.entityType,
    fromMs: range.fromMs,
    toMs: range.toMs,
    limit: AGGREGATE_LIMIT,
  };

  // Unbucketed totals: one row per key, so the cap cannot truncate by time. Cached per
  // (tenant, project, type, range) so typing in a picker does not rescan the rollup.
  const cacheKey = JSON.stringify([
    input.tenantDbName, input.tenantId, input.projectId, input.entityType, range.fromMs, floorBucket(range.toMs),
  ]);
  const cached = activeTotalsCache.get(cacheKey);
  let totals: ActiveTotals;
  if (cached && cached.expiresAt > Date.now()) {
    totals = cached.rows;
  } else {
    let pending = activeTotalsInflight.get(cacheKey);
    if (!pending) {
      pending = runWithTenantScope(input.tenantDbName, (db) =>
        db.aggregateEntityMetrics({ ...scope, groupBy: ['entityKey'] }),
      )
        .then((totalRows) => {
          warnIfTruncated(totalRows, 'listActiveEntityKeys', { entityType: input.entityType });
          const rows: ActiveTotals = [];
          for (const row of totalRows) {
            if (row.entityKey) rows.push({ key: row.entityKey, requests: Number(row.requests) || 0 });
          }
          if (activeTotalsCache.size >= ACTIVE_TOTALS_MAX_ENTRIES) {
            const oldest = activeTotalsCache.keys().next().value;
            if (oldest !== undefined) activeTotalsCache.delete(oldest);
          }
          activeTotalsCache.set(cacheKey, { expiresAt: Date.now() + ACTIVE_TOTALS_TTL_MS, rows });
          return rows;
        })
        .finally(() => {
          activeTotalsInflight.delete(cacheKey);
        });
      activeTotalsInflight.set(cacheKey, pending);
    }
    totals = await pending;
  }

  const needle = input.q?.trim().toLowerCase();
  const ranked: Array<{ key: string; requests: number }> = [];
  for (const row of totals) {
    if (needle && !row.key.toLowerCase().includes(needle)) continue;
    ranked.push(row);
  }
  ranked.sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
  const top = ranked.slice(0, limit);
  if (top.length === 0) return [];

  // Bucketed query only for the returned keys (<= MAX_ACTIVE_LIMIT x bucket count rows) to find each key's last bucket.
  const bucketRows = await runWithTenantScope(input.tenantDbName, (db) =>
    db.aggregateEntityMetrics({ ...scope, entityKeys: top.map((t) => t.key), groupBy: ['entityKey'], bucketMs }),
  );
  warnIfTruncated(bucketRows, 'listActiveEntityKeys.lastBucket', { entityType: input.entityType, bucketMs });

  const lastBucket = new Map<string, number>();
  for (const row of bucketRows) {
    if (!row.entityKey) continue;
    const bucket = row.bucketMs ?? 0;
    if (bucket > (lastBucket.get(row.entityKey) ?? 0)) lastBucket.set(row.entityKey, bucket);
  }

  return top.map((t) => ({ key: t.key, requests: t.requests, lastBucketMs: lastBucket.get(t.key) ?? 0 }));
}
