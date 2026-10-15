/**
 * Shaping of the entity health series payload (the shape of GET /tracing/agents/:name/health) into chart
 * rows, availability flags, markers and KPI tiles; plus the formatters and links of the health views.
 */
import { describe, expect, it } from 'vitest';
import {
  buildChartRows,
  buildKpiSpecs,
  computeDelta,
  deltaText,
  detectAvailability,
  formatBucketLabel,
  snapMarkers,
  type EntityHealthSeriesPayload,
} from '@/components/tracing/health/healthSeries';
import {
  formatDayAxisLabel,
  formatDayLabel,
  formatHealthCost,
  formatHealthCount,
  formatHealthMs,
  formatHealthPercent,
} from '@/components/tracing/health/healthFormat';
import {
  buildAgentDetailHref,
  buildCreateAgentAlertHref,
  buildCreateAlertHref,
  buildFailingSessionsHref,
} from '@/components/tracing/health/healthLinks';
import { buildDailyTrendRows } from '@/components/tracing/health/dailyTrend';

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 9, 14, 0, 0, 0);

function bucket(i: number, extra: Record<string, unknown> = {}) {
  return { t: FROM + i * HOUR, requests: 0, ...extra } as EntityHealthSeriesPayload['buckets'][number];
}

function payload(over: Partial<EntityHealthSeriesPayload> = {}): EntityHealthSeriesPayload {
  return {
    range: { fromMs: FROM, toMs: FROM + 4 * HOUR, bucketMs: HOUR },
    buckets: [
      bucket(0, { requests: 10, errors: 1, errorRate: 10, p50Ms: 200, p95Ms: 900 }),
      bucket(1), // empty bucket: nulls, not zeros
      bucket(2, { requests: 20, errors: 0, errorRate: 0, p50Ms: 180, p95Ms: 700, toolErrorRate: 5, toolCalls: 4 }),
      bucket(3, { requests: 5, errors: 5, errorRate: 100, p50Ms: 300, p95Ms: 2000 }),
    ],
    totals: { requests: 35, errors: 6, errorRate: 17.1, p95Ms: 1200, toolCalls: 4, toolErrorRate: 5, costUsd: 0, abandoned: 0 },
    previous: { requests: 30, errors: 1, errorRate: 3.3, p95Ms: 900 },
    ...over,
  };
}

function omit<T extends object>(value: T, keys: string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T;
}

describe('buildChartRows', () => {
  it('keeps empty buckets as gaps (null metrics) instead of drawing zeros', () => {
    const rows = buildChartRows(payload(), 'en');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ requests: 0, errorRate: null, p50Ms: null, p95Ms: null, toolErrorRate: null });
    expect(rows[0]).toMatchObject({ requests: 10, errorRate: 10, p95Ms: 900 });
  });

  it('gives every bucket its own x label, even when the clock repeats an hour', () => {
    const t = Date.UTC(2026, 9, 25, 0, 0, 0);
    const rows = buildChartRows(
      {
        range: { fromMs: t, toMs: t + 2 * HOUR, bucketMs: HOUR },
        buckets: [
          { t, requests: 1 },
          // Same wall-clock label as the first one in a time zone that falls back.
          { t: t + 24 * HOUR, requests: 1 },
        ],
        totals: {},
      },
      'en',
    );
    expect(new Set(rows.map((row) => row.label)).size).toBe(2);
  });

  it('turns a baseline band into stacked base + range and clamps the error rate band to 100', () => {
    const rows = buildChartRows(
      payload({
        baseline: {
          errorRate: [{ t: FROM, median: 2, lower: 0.5, upper: 140 }],
          p95Ms: [
            { t: FROM, median: 800, lower: 500, upper: 1100 },
            { t: FROM + 2 * HOUR, median: 700, lower: null, upper: null },
          ],
        },
      }),
      'en',
    );
    expect(rows[0]).toMatchObject({ errorBandBase: 0.5, errorBandRange: 99.5, errorBandUpper: 100 });
    expect(rows[0]).toMatchObject({ p95BandBase: 500, p95BandRange: 600, p95BandLower: 500, p95BandUpper: 1100 });
    // A point without both ends leaves the band out for that bucket.
    expect(rows[2]!.p95BandBase).toBeNull();
    expect(rows[3]!.p95BandBase).toBeNull();
  });

  it('matches a band point to the nearest bucket within half a bucket', () => {
    const rows = buildChartRows(
      payload({ baseline: { p95Ms: [{ t: FROM + 10 * 60_000, median: 800, lower: 500, upper: 1100 }] } }),
      'en',
    );
    expect(rows[0]!.p95BandBase).toBe(500);
    expect(rows[1]!.p95BandBase).toBeNull();
  });

  it('survives an empty payload', () => {
    expect(buildChartRows({ range: { fromMs: 0, toMs: 0, bucketMs: 0 }, buckets: [], totals: {} })).toEqual([]);
  });
});

describe('formatBucketLabel', () => {
  it('uses time only for short ranges of sub-hour buckets, date and time for hours, the date for days', () => {
    const t = Date.UTC(2026, 9, 14, 13, 5);
    const day = formatBucketLabel(t, 86_400_000, 30 * 86_400_000, 'en');
    expect(day).toMatch(/Oct/);
    expect(day).not.toMatch(/:/);
    expect(formatBucketLabel(t, 300_000, 6 * HOUR, 'en')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatBucketLabel(t, HOUR, 48 * HOUR, 'en')).toMatch(/Oct.*\d{2}:\d{2}/);
  });
});

describe('detectAvailability: only what the entity has', () => {
  it('reports tool errors, abandoned runs and cost as absent for a plain entity', () => {
    const plain = payload({
      totals: { requests: 35, errors: 6, errorRate: 17.1, p95Ms: 1200 },
      buckets: payload().buckets.map((bucket) => omit(bucket, ['toolErrorRate'])),
    });
    expect(detectAvailability(plain)).toMatchObject({
      hasTraffic: true,
      errorRate: true,
      latency: true,
      toolErrors: false,
      abandoned: false,
      cost: false,
      errorBand: false,
      latencyBand: false,
    });
  });

  it('turns the optional metrics on when the numbers exist', () => {
    const full = payload({
      totals: { requests: 35, errors: 6, errorRate: 17.1, p95Ms: 1200, toolCalls: 4, toolErrorRate: 5, costUsd: 1.2, abandoned: 2 },
      baseline: { errorRate: [{ t: FROM, median: 1, lower: 0, upper: 3 }], p95Ms: [{ t: FROM, median: 1, lower: 0, upper: 3 }] },
    });
    expect(detectAvailability(full)).toMatchObject({ toolErrors: true, abandoned: true, cost: true, errorBand: true, latencyBand: true });
  });

  it('has no traffic for an empty range', () => {
    const empty = payload({ totals: {}, buckets: [bucket(0), bucket(1)] });
    expect(detectAvailability(empty)).toMatchObject({ hasTraffic: false, errorRate: false, latency: false });
  });
});

describe('snapMarkers', () => {
  const rows = buildChartRows(payload(), 'en');

  it('places a marker on the bucket it falls into and merges a second one of the same type', () => {
    const markers = snapMarkers(
      [
        { t: FROM + 2 * HOUR + 600_000, type: 'version', label: 'v2', href: '/x' },
        { t: FROM + 2 * HOUR + 900_000, type: 'version', label: 'v3' },
        { t: FROM + 2 * HOUR + 700_000, type: 'incident', label: 'Error spike' },
      ],
      rows,
      HOUR,
    );
    expect(markers).toHaveLength(2);
    const version = markers.find((m) => m.type === 'version')!;
    expect(version.x).toBe(rows[2]!.label);
    expect(version.label).toBe('v2 +1');
    expect(version.href).toBe('/x');
    expect(markers.find((m) => m.type === 'incident')!.x).toBe(rows[2]!.label);
  });

  it('drops markers outside the series and tolerates no markers', () => {
    expect(snapMarkers([{ t: FROM - HOUR, type: 'version', label: 'old' }, { t: FROM + 9 * HOUR, type: 'version', label: 'new' }], rows, HOUR)).toEqual([]);
    expect(snapMarkers(undefined, rows, HOUR)).toEqual([]);
    expect(snapMarkers([{ t: FROM, type: 'version', label: 'v1' }], [], HOUR)).toEqual([]);
  });

  it('keeps the newest markers when there are more than the limit', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ t: FROM + i * 10 * 60_000, type: 'version' as const, label: `v${i}` }));
    const single = snapMarkers(many, rows, HOUR, 10);
    // Six markers in the same bucket collapse into one.
    expect(single).toHaveLength(1);
    expect(single[0]!.label).toBe('v0 +5');
  });
});

describe('computeDelta: good and bad depend on the metric, small moves are flat', () => {
  it('compares rates in percentage points', () => {
    expect(computeDelta(10, 4, 'percent', 'down')).toEqual({ direction: 'up', magnitude: 6, unit: 'pp', tone: 'bad' });
    expect(computeDelta(2, 4, 'percent', 'down')).toEqual({ direction: 'down', magnitude: 2, unit: 'pp', tone: 'good' });
    expect(computeDelta(4.2, 4, 'percent', 'down')).toMatchObject({ direction: 'flat', tone: 'neutral' });
  });

  it('compares everything else in percent', () => {
    expect(computeDelta(1500, 1000, 'ms', 'down')).toEqual({ direction: 'up', magnitude: 50, unit: 'pct', tone: 'bad' });
    expect(computeDelta(500, 1000, 'ms', 'down')).toEqual({ direction: 'down', magnitude: 50, unit: 'pct', tone: 'good' });
    expect(computeDelta(102, 100, 'count', 'none')).toMatchObject({ direction: 'flat' });
  });

  it('never colors traffic volume', () => {
    expect(computeDelta(200, 100, 'count', 'none')?.tone).toBe('neutral');
  });

  it('says "new" for a metric that had nothing before and flat for nothing at all', () => {
    expect(computeDelta(3, 0, 'count', 'down')).toEqual({ direction: 'up', magnitude: null, unit: 'new', tone: 'bad' });
    expect(computeDelta(0, 0, 'count', 'down')).toMatchObject({ direction: 'flat', tone: 'neutral' });
  });

  it('has no delta without both numbers', () => {
    expect(computeDelta(null, 3, 'count', 'down')).toBeNull();
    expect(computeDelta(3, undefined, 'count', 'down')).toBeNull();
  });

  it('writes the delta with its sign and unit', () => {
    expect(deltaText({ direction: 'up', magnitude: 12.4, unit: 'pct', tone: 'bad' }, 'new', 'en')).toBe('+12%');
    expect(deltaText({ direction: 'down', magnitude: 3.4, unit: 'pp', tone: 'good' }, 'new', 'en')).toBe('-3.4 pp');
    expect(deltaText({ direction: 'up', magnitude: null, unit: 'new', tone: 'bad' }, 'new', 'en')).toBe('new');
  });
});

describe('buildKpiSpecs', () => {
  it('always shows traffic and leaves out the metrics the entity does not have', () => {
    const p = payload({
      totals: { requests: 35, errors: 6, errorRate: 17.1, p95Ms: 1200 },
      buckets: payload().buckets.map((bucket) => omit(bucket, ['toolErrorRate', 'toolCalls'])),
    });
    const rows = buildChartRows(p, 'en');
    const ids = buildKpiSpecs(p, detectAvailability(p, rows), rows).map((spec) => spec.id);
    expect(ids).toEqual(['requests', 'errorRate', 'p95Ms']);
  });

  it('adds tool errors, cost and abandoned runs when present, with deltas colored by direction', () => {
    const p = payload({
      totals: { requests: 35, errors: 6, errorRate: 17.1, p95Ms: 1200, toolCalls: 4, toolErrorRate: 5, costUsd: 2, abandoned: 3 },
      previous: { requests: 30, errorRate: 3.3, p95Ms: 900, toolErrorRate: 5, costUsd: 1, abandoned: 0 },
    });
    const rows = buildChartRows(p, 'en');
    const specs = buildKpiSpecs(p, detectAvailability(p, rows), rows);
    expect(specs.map((s) => s.id)).toEqual(['requests', 'errorRate', 'p95Ms', 'toolErrorRate', 'costUsd', 'abandoned']);
    const byId = Object.fromEntries(specs.map((s) => [s.id, s]));
    expect(byId.errorRate!.delta).toMatchObject({ direction: 'up', tone: 'bad', unit: 'pp' });
    expect(byId.p95Ms!.delta).toMatchObject({ direction: 'up', tone: 'bad' });
    expect(byId.toolErrorRate!.delta).toMatchObject({ direction: 'flat', tone: 'neutral' });
    expect(byId.costUsd!.delta).toMatchObject({ direction: 'up', tone: 'bad', magnitude: 100 });
    expect(byId.abandoned!.delta).toMatchObject({ unit: 'new', tone: 'bad' });
    expect(byId.requests!.delta?.tone).toBe('neutral');
    // Traffic has a sparkline over its buckets.
    expect(byId.requests!.spark).toEqual([10, 0, 20, 5]);
  });

  it('has no delta when there is no previous period', () => {
    const p = payload({ previous: null });
    const rows = buildChartRows(p, 'en');
    expect(buildKpiSpecs(p, detectAvailability(p, rows), rows).every((s) => s.delta === null)).toBe(true);
  });
});

describe('formatters', () => {
  it('formats percentages, durations, cost and counts, and shows a dash for no value', () => {
    expect(formatHealthPercent(0, 'en')).toBe('0%');
    expect(formatHealthPercent(3.456, 'en')).toBe('3.5%');
    expect(formatHealthPercent(42.4, 'en')).toBe('42%');
    expect(formatHealthPercent(null)).toBe('—');
    expect(formatHealthMs(250.4, 'en')).toBe('250 ms');
    expect(formatHealthMs(1500, 'en')).toBe('1.5 s');
    expect(formatHealthMs(125_000, 'en')).toBe('2.1 min');
    expect(formatHealthMs(undefined)).toBe('—');
    expect(formatHealthCost(0.0042, 'en')).toBe('$0.0042');
    expect(formatHealthCost(12.5, 'en')).toBe('$12.50');
    expect(formatHealthCost(1234.5, 'en')).toBe('$1,235');
    expect(formatHealthCount(12345, 'en')).toBe('12,345');
    expect(formatHealthCount(null)).toBe('—');
  });

  it('reads a calendar day as that day, whatever the time zone', () => {
    expect(formatDayLabel('2026-10-14', 'en')).toBe('Oct 14, 2026');
    expect(formatDayAxisLabel('2026-10-01', 'en')).toBe('Oct 1');
    expect(formatDayLabel('not a day', 'en')).toBe('not a day');
  });
});

describe('links', () => {
  it('builds the create-alert deep link of an agent with the entity prefilled', () => {
    const href = buildCreateAgentAlertHref('Pulse Main');
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/dashboard/alerts');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      create: '1',
      module: 'agents',
      metric: 'agent_error_rate',
      entityType: 'agent',
      entityKey: 'Pulse Main',
    });
    expect(buildCreateAlertHref({ module: 'models', metric: 'model_error_rate', entityType: 'model', entityKey: 'gpt-5' })).toContain('entityType=model');
  });

  it('builds the failing-sessions link with status and range, and without a range', () => {
    const url = new URL(buildFailingSessionsHref('50%off', { fromMs: FROM, toMs: FROM + HOUR }), 'http://x');
    expect(url.pathname).toBe('/dashboard/tracing/sessions');
    expect(url.searchParams.get('agent')).toBe('50%off');
    expect(url.searchParams.get('status')).toBe('error');
    expect(url.searchParams.get('from')).toBe(new Date(FROM).toISOString());
    expect(url.searchParams.get('to')).toBe(new Date(FROM + HOUR).toISOString());
    expect(new URL(buildFailingSessionsHref('a'), 'http://x').searchParams.has('from')).toBe(false);
  });

  it('encodes the agent name once and carries the period to the agent page', () => {
    expect(buildAgentDetailHref('50%off')).toBe('/dashboard/tracing/agents/50%25off');
    expect(buildAgentDetailHref('a b', { period: 'last_day', dateRange: [null, null] })).toBe('/dashboard/tracing/agents/a%20b?period=last_day');
    // The list's default is never in its URL, so an explicit "total" is written out too.
    expect(buildAgentDetailHref('a', { period: 'total', dateRange: [null, null] })).toBe('/dashboard/tracing/agents/a?period=total');
    const custom = buildAgentDetailHref('a', { period: 'custom', dateRange: [new Date(2026, 9, 1), new Date(2026, 9, 3)] });
    expect(custom).toContain('period=custom');
    expect(custom).toContain('from=2026-10-01');
  });
});

describe('buildDailyTrendRows', () => {
  it('sorts the days, drops repeats and reads missing counts as zero', () => {
    const rows = buildDailyTrendRows(
      [
        { date: '2026-10-02', sessionsCount: 4, totalTokens: 100 },
        { date: '2026-10-01', sessionsCount: 2 },
        { date: '2026-10-02', sessionsCount: 99 },
      ],
      'en',
    );
    expect(rows.map((r) => [r.date, r.sessions, r.tokens, r.day])).toEqual([
      ['2026-10-01', 2, 0, 'Oct 1'],
      ['2026-10-02', 4, 100, 'Oct 2'],
    ]);
    expect(buildDailyTrendRows(undefined)).toEqual([]);
  });
});
