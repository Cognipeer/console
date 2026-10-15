/**
 * Shaping of the entity health series payload (`GET /tracing/agents/:name/health`, and the same shape the
 * Enterprise health page gets for models, knowledge bases, MCP servers and tools) into chart rows, KPI tiles
 * and marker lines. Pure and free of agent-only assumptions: a metric an entity does not have (tool calls,
 * abandoned runs, cost, a baseline) is reported as absent so the views can leave it out.
 */

import type { DerivedMetrics } from '@/lib/services/entityMetrics/entityMetricsQuery';

export type HealthMetricValues = Partial<DerivedMetrics>;

export interface HealthRange {
  fromMs: number;
  toMs: number;
  bucketMs: number;
}

export interface HealthBandPoint {
  t: number;
  median: number | null;
  lower: number | null;
  upper: number | null;
}

export interface HealthMarker {
  t: number;
  type: 'version' | 'incident';
  label: string;
  href?: string;
}

export interface EntityHealthSeriesPayload {
  range: HealthRange;
  buckets: Array<{ t: number } & HealthMetricValues>;
  totals: HealthMetricValues;
  previous?: HealthMetricValues | null;
  baseline?: { errorRate?: HealthBandPoint[]; p95Ms?: HealthBandPoint[] } | null;
  markers?: HealthMarker[];
  /** True when earlier markers may be missing (the version read behind them was bounded). */
  markersPartial?: boolean;
  alerts?: { firing: number; pending: number } | null;
}

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numOrNull = (value: unknown): number | null => (isNum(value) ? value : null);

/* ---------------------------------------------------------------------------------------------- */
/* Chart rows                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export interface HealthChartRow {
  t: number;
  /** X axis value (unique per row; chart categories and marker lines key on it). */
  label: string;
  requests: number;
  errors: number;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  toolErrorRate: number | null;
  abandonedRate: number | null;
  costUsd: number | null;
  /** Normal range of the error rate (percent): stack base and height for the band, plus its raw ends. */
  errorBandBase: number | null;
  errorBandRange: number | null;
  errorBandLower: number | null;
  errorBandUpper: number | null;
  /** Normal range of the p95 duration (ms). */
  p95BandBase: number | null;
  p95BandRange: number | null;
  p95BandLower: number | null;
  p95BandUpper: number | null;
}

/**
 * X axis label of a bucket: time only for sub-hour buckets inside half a day, date and time for hours,
 * date for days. Local time, since the buckets are instants.
 */
export function formatBucketLabel(t: number, bucketMs: number, spanMs: number, locale?: string): string {
  const date = new Date(t);
  if (!Number.isFinite(date.getTime())) return '';
  if (bucketMs >= 86_400_000) {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  }
  if (bucketMs < 3_600_000 && spanMs <= 12 * 3_600_000) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

type BandKey = 'errorBand' | 'p95Band';

function bandIndex(points: HealthBandPoint[] | undefined): HealthBandPoint[] {
  return Array.isArray(points) ? points.filter((p) => isNum(p?.t)) : [];
}

function pickBandPoint(
  byT: Map<number, HealthBandPoint>,
  points: HealthBandPoint[],
  t: number,
  bucketMs: number,
): HealthBandPoint | null {
  const exact = byT.get(t);
  if (exact) return exact;
  let best: HealthBandPoint | null = null;
  let bestDistance = bucketMs / 2;
  for (const point of points) {
    const distance = Math.abs(point.t - t);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

function applyBand(
  rows: HealthChartRow[],
  points: HealthBandPoint[] | undefined,
  key: BandKey,
  bucketMs: number,
  ceiling: number | null,
): void {
  const list = bandIndex(points);
  if (list.length === 0) return;
  const byT = new Map(list.map((p) => [p.t, p]));
  for (const row of rows) {
    const point = pickBandPoint(byT, list, row.t, bucketMs);
    if (!point || !isNum(point.lower) || !isNum(point.upper)) continue;
    const lower = Math.max(0, Math.min(point.lower, point.upper));
    let upper = Math.max(point.lower, point.upper);
    if (ceiling !== null) upper = Math.min(upper, ceiling);
    if (upper < lower) continue;
    row[`${key}Base`] = lower;
    row[`${key}Range`] = upper - lower;
    row[`${key}Lower`] = lower;
    row[`${key}Upper`] = upper;
  }
}

/** One chart row per bucket (empty buckets keep null metrics, so lines break instead of drawing zeros). */
export function buildChartRows(payload: EntityHealthSeriesPayload, locale?: string): HealthChartRow[] {
  const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
  const bucketMs = payload.range?.bucketMs ?? 0;
  const spanMs = (payload.range?.toMs ?? 0) - (payload.range?.fromMs ?? 0);
  const seen = new Map<string, number>();
  const rows: HealthChartRow[] = buckets.map((bucket) => {
    const requests = isNum(bucket.requests) ? bucket.requests : 0;
    const base = formatBucketLabel(bucket.t, bucketMs, spanMs, locale);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const hasTraffic = requests > 0;
    return {
      t: bucket.t,
      // A repeated label (the clock going back an hour) would merge two buckets into one category.
      label: occurrence === 1 ? base : `${base} (${occurrence})`,
      requests,
      errors: isNum(bucket.errors) ? bucket.errors : 0,
      errorRate: hasTraffic ? numOrNull(bucket.errorRate) : null,
      p50Ms: numOrNull(bucket.p50Ms),
      p95Ms: numOrNull(bucket.p95Ms),
      toolErrorRate: numOrNull(bucket.toolErrorRate),
      abandonedRate: hasTraffic ? numOrNull(bucket.abandonedRate) : null,
      costUsd: isNum(bucket.costUsd) && bucket.costUsd > 0 ? bucket.costUsd : null,
      errorBandBase: null,
      errorBandRange: null,
      errorBandLower: null,
      errorBandUpper: null,
      p95BandBase: null,
      p95BandRange: null,
      p95BandLower: null,
      p95BandUpper: null,
    };
  });
  applyBand(rows, payload.baseline?.errorRate, 'errorBand', bucketMs, 100);
  applyBand(rows, payload.baseline?.p95Ms, 'p95Band', bucketMs, null);
  return rows;
}

/* ---------------------------------------------------------------------------------------------- */
/* What the entity has                                                                             */
/* ---------------------------------------------------------------------------------------------- */

export interface HealthAvailability {
  /** Any request in the range. */
  hasTraffic: boolean;
  errorRate: boolean;
  latency: boolean;
  toolErrors: boolean;
  abandoned: boolean;
  cost: boolean;
  errorBand: boolean;
  latencyBand: boolean;
}

function hasBand(points: HealthBandPoint[] | undefined): boolean {
  return bandIndex(points).some((p) => isNum(p.lower) && isNum(p.upper));
}

export function detectAvailability(payload: EntityHealthSeriesPayload, rows?: HealthChartRow[]): HealthAvailability {
  const list = rows ?? buildChartRows(payload);
  const totals = payload.totals ?? {};
  const traffic = (isNum(totals.requests) ? totals.requests : 0) > 0 || list.some((row) => row.requests > 0);
  return {
    hasTraffic: traffic,
    errorRate: traffic && (isNum(totals.errorRate) || list.some((row) => row.errorRate !== null)),
    latency: isNum(totals.p95Ms) || list.some((row) => row.p95Ms !== null || row.p50Ms !== null),
    toolErrors: (isNum(totals.toolCalls) ? totals.toolCalls : 0) > 0 || list.some((row) => row.toolErrorRate !== null),
    abandoned:
      (isNum(totals.abandoned) ? totals.abandoned : 0) > 0 || list.some((row) => (row.abandonedRate ?? 0) > 0),
    cost: (isNum(totals.costUsd) ? totals.costUsd : 0) > 0,
    errorBand: hasBand(payload.baseline?.errorRate),
    latencyBand: hasBand(payload.baseline?.p95Ms),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Markers                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export interface ChartMarker {
  key: string;
  /** Category of the row the marker sits on (the reference line's x). */
  x: string;
  t: number;
  type: HealthMarker['type'];
  label: string;
  href?: string;
}

/**
 * Markers at the bucket they fall into, one per bucket and type (a second one in the same bucket is counted
 * into the first's label). Markers outside the series are dropped; at most `limit` newest are kept.
 */
export function snapMarkers(
  markers: HealthMarker[] | undefined,
  rows: HealthChartRow[],
  bucketMs: number,
  limit = 16,
): ChartMarker[] {
  if (!Array.isArray(markers) || rows.length === 0 || !(bucketMs > 0)) return [];
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const merged = new Map<string, ChartMarker & { extra: number }>();
  const ordered = [...markers].filter((m) => isNum(m?.t)).sort((a, b) => a.t - b.t);
  for (const marker of ordered) {
    if (marker.t < first.t || marker.t >= last.t + bucketMs) continue;
    let row = first;
    for (const candidate of rows) {
      if (candidate.t <= marker.t) row = candidate;
      else break;
    }
    const key = `${row.t}|${marker.type}`;
    const known = merged.get(key);
    if (known) {
      known.extra += 1;
      continue;
    }
    merged.set(key, {
      key,
      x: row.label,
      t: marker.t,
      type: marker.type,
      label: marker.label,
      href: marker.href,
      extra: 0,
    });
  }
  const out = [...merged.values()].map(({ extra, ...marker }) => (extra > 0 ? { ...marker, label: `${marker.label} +${extra}` } : marker));
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/* ---------------------------------------------------------------------------------------------- */
/* KPI tiles                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export type KpiId = 'requests' | 'errorRate' | 'p95Ms' | 'toolErrorRate' | 'costUsd' | 'abandoned';
export type KpiKind = 'count' | 'percent' | 'ms' | 'usd';
export type DeltaTone = 'good' | 'bad' | 'neutral';

export interface KpiDelta {
  direction: 'up' | 'down' | 'flat';
  /** Percent change (`pct`), percentage-point change (`pp`), or null for `new` (nothing before). */
  magnitude: number | null;
  unit: 'pct' | 'pp' | 'new';
  tone: DeltaTone;
}

const FLAT_RELATIVE_PCT = 5;
const FLAT_POINTS = 0.5;

/**
 * Change against the previous period. Rates compare in percentage points, everything else in percent.
 * `good` says which direction is an improvement (`none`: neither, e.g. traffic volume). Small moves are flat.
 */
export function computeDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  kind: KpiKind,
  good: 'up' | 'down' | 'none',
): KpiDelta | null {
  if (!isNum(current) || !isNum(previous)) return null;
  const toneOf = (direction: 'up' | 'down' | 'flat'): DeltaTone =>
    direction === 'flat' || good === 'none' ? 'neutral' : direction === good ? 'good' : 'bad';

  if (kind === 'percent') {
    const diff = current - previous;
    const direction = Math.abs(diff) < FLAT_POINTS ? 'flat' : diff > 0 ? 'up' : 'down';
    return { direction, magnitude: Math.abs(diff), unit: 'pp', tone: toneOf(direction) };
  }
  if (previous === 0) {
    if (current === 0) return { direction: 'flat', magnitude: 0, unit: 'pct', tone: 'neutral' };
    return { direction: 'up', magnitude: null, unit: 'new', tone: toneOf('up') };
  }
  const relative = ((current - previous) / Math.abs(previous)) * 100;
  const direction = Math.abs(relative) < FLAT_RELATIVE_PCT ? 'flat' : relative > 0 ? 'up' : 'down';
  return { direction, magnitude: Math.abs(relative), unit: 'pct', tone: toneOf(direction) };
}

/** "+12%", "-3.4 pp", or the caller's word for a metric that had nothing before. */
export function deltaText(delta: KpiDelta, newLabel: string, locale?: string): string {
  if (delta.unit === 'new' || delta.magnitude === null) return newLabel;
  const sign = delta.direction === 'up' ? '+' : delta.direction === 'down' ? '-' : '';
  const digits = delta.magnitude < 10 && delta.magnitude !== 0 ? 1 : 0;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(delta.magnitude);
  return delta.unit === 'pp' ? `${sign}${number} pp` : `${sign}${number}%`;
}

export interface KpiSpec {
  id: KpiId;
  kind: KpiKind;
  value: number | null;
  previousValue: number | null;
  delta: KpiDelta | null;
  /** Sparkline values (only for metrics without gaps). */
  spark?: number[];
}

function pick(values: HealthMetricValues | null | undefined, key: keyof DerivedMetrics): number | null {
  return values ? numOrNull(values[key]) : null;
}

/** The tiles to show: traffic always, the rest only when the entity has that metric. */
export function buildKpiSpecs(
  payload: EntityHealthSeriesPayload,
  availability: HealthAvailability,
  rows: HealthChartRow[],
): KpiSpec[] {
  const { totals, previous } = payload;
  const make = (
    id: KpiId,
    kind: KpiKind,
    key: keyof DerivedMetrics,
    good: 'up' | 'down' | 'none',
    spark?: number[],
  ): KpiSpec => {
    const value = pick(totals, key);
    const previousValue = pick(previous, key);
    return { id, kind, value, previousValue, delta: computeDelta(value, previousValue, kind, good), spark };
  };

  const specs: KpiSpec[] = [
    make('requests', 'count', 'requests', 'none', rows.length > 1 ? rows.map((row) => row.requests) : undefined),
  ];
  if (availability.errorRate) specs.push(make('errorRate', 'percent', 'errorRate', 'down'));
  if (availability.latency) specs.push(make('p95Ms', 'ms', 'p95Ms', 'down'));
  if (availability.toolErrors) specs.push(make('toolErrorRate', 'percent', 'toolErrorRate', 'down'));
  if (availability.cost) {
    specs.push(
      make('costUsd', 'usd', 'costUsd', 'down', rows.length > 1 ? rows.map((row) => row.costUsd ?? 0) : undefined),
    );
  }
  if (availability.abandoned) specs.push(make('abandoned', 'count', 'abandoned', 'down'));
  return specs;
}
