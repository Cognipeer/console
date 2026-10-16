/**
 * Entity metric formulas (computeEntityMetric for every entity metric id),
 * bucket selection, and the health read service (summaries, series, active
 * keys) over a fake aggregate source.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityMetricCounters, IEntityMetricAggregate, EntityMetricsAggregateQuery } from '@/lib/database/provider/types.base';

const aggregate = vi.hoisted(() => ({
  calls: [] as unknown[],
  handler: (async () => []) as (q: unknown) => Promise<unknown[]>,
}));

vi.mock('@/lib/database', () => ({
  runWithTenantScope: async (_name: string, fn: (db: unknown) => unknown) =>
    fn({
      aggregateEntityMetrics: async (q: unknown) => {
        aggregate.calls.push(q);
        return aggregate.handler(q);
      },
    }),
}));

import { addLatency, emptyCounters } from '@/lib/services/entityMetrics/latencyHistogram';
import { computeEntityMetric, deriveMetrics, pickBucketMs, toCounters } from '@/lib/services/entityMetrics/entityMetricsQuery';
import {
  getEntitySeries,
  getEntitySummaries,
  listActiveEntityKeys,
  __resetEntityHealthCachesForTests,
} from '@/lib/services/entityMetrics/entityHealthService';
import { ALERT_METRIC_CATALOG } from '@/lib/services/alerts/metricCatalog';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const FIVE = 300_000;

function counters(partial: Partial<EntityMetricCounters> = {}, latencies: number[] = []): EntityMetricCounters {
  const c = emptyCounters();
  Object.assign(c, partial);
  for (const ms of latencies) addLatency(c, ms);
  return c;
}

describe('computeEntityMetric', () => {
  const data = counters(
    {
      requests: 100, errors: 10, cancelled: 20, errorEvents: 7,
      toolCalls: 50, toolErrors: 5, aiCalls: 40, aiErrors: 4,
      abandoned: 8, emptyResults: 9, inputTokens: 3000, outputTokens: 1000, costUsd: 2.5,
    },
    [100, 100, 500, 500, 2000, 2000, 2000, 2000, 2000, 2000],
  );

  const expected: Record<string, { value: number | null; sampleCount: number }> = {
    agent_sessions: { value: 100, sampleCount: 100 },
    agent_error_rate: { value: 10, sampleCount: 100 },
    agent_error_events: { value: 7, sampleCount: 190 },
    agent_tool_error_rate: { value: 10, sampleCount: 50 },
    agent_ai_error_rate: { value: 10, sampleCount: 40 },
    agent_abandoned_rate: { value: 8, sampleCount: 100 },
    agent_cost: { value: 2.5, sampleCount: 140 },
    agent_tokens_per_session: { value: 40, sampleCount: 100 },
    model_requests: { value: 100, sampleCount: 100 },
    // cancelled requests are not failures: 10 / (100 - 20)
    model_error_rate: { value: 12.5, sampleCount: 80 },
    model_cost: { value: 2.5, sampleCount: 100 },
    kb_queries: { value: 100, sampleCount: 100 },
    kb_error_rate: { value: 10, sampleCount: 100 },
    // 9 / (100 - 10)
    kb_empty_result_rate: { value: 10, sampleCount: 90 },
    mcp_server_requests: { value: 100, sampleCount: 100 },
    mcp_server_error_rate: { value: 10, sampleCount: 100 },
    tool_calls: { value: 100, sampleCount: 100 },
    tool_error_rate: { value: 10, sampleCount: 100 },
  };

  const averageMetrics = ['agent_avg_duration_ms', 'model_avg_latency_ms', 'kb_avg_latency_ms'];
  const p95Metrics = [
    'agent_p95_duration_ms', 'model_p95_latency_ms', 'kb_p95_latency_ms',
    'mcp_server_p95_latency_ms', 'tool_p95_latency_ms',
  ];

  const entityMetrics = ALERT_METRIC_CATALOG.filter((def) => def.source === 'entity');

  it('has a formula for every entity metric of the catalog', () => {
    const covered = new Set([...Object.keys(expected), ...averageMetrics, ...p95Metrics]);
    expect(entityMetrics.map((d) => d.id).filter((id) => !covered.has(id))).toEqual([]);
    expect([...covered].filter((id) => !entityMetrics.some((d) => d.id === id))).toEqual([]);
  });

  for (const [metric, want] of Object.entries(expected)) {
    it(`${metric}`, () => {
      const got = computeEntityMetric(metric as never, data);
      expect(got.value).toBeCloseTo(want.value as number, 9);
      expect(got.sampleCount).toBe(want.sampleCount);
    });
  }

  it.each(averageMetrics)('%s is latencyMsSum / latencyCount', (metric) => {
    const got = computeEntityMetric(metric as never, data);
    expect(got.value).toBeCloseTo((200 + 1000 + 12000) / 10, 9);
    expect(got.sampleCount).toBe(10);
  });

  it.each(p95Metrics)('%s is the histogram p95', (metric) => {
    const got = computeEntityMetric(metric as never, data);
    // 10 samples: 2 in (0,100], 2 in (250,500], 6 in (1000,2000]; p95 = 9.5th sample -> 1000 + 1000 * (9.5-4)/6
    expect(got.value).toBeCloseTo(1000 + (1000 * 5.5) / 6, 6);
    expect(got.sampleCount).toBe(10);
  });

  it('yields null (never NaN or Infinity) when the denominator is empty', () => {
    const empty = emptyCounters();
    for (const def of entityMetrics) {
      const got = computeEntityMetric(def.id, empty);
      expect(got.sampleCount).toBe(0);
      if (def.zeroWhenEmpty) expect(got.value).toBe(0);
      else expect(got.value).toBeNull();
    }
  });

  it('caps rates at 100 percent (late corrections can outnumber requests in a window)', () => {
    const got = computeEntityMetric('agent_error_rate', counters({ requests: 2, errors: 5 }));
    expect(got.value).toBe(100);
  });

  it('returns no value for metrics that are not entity metrics', () => {
    expect(computeEntityMetric('error_rate', data)).toEqual({ value: null, sampleCount: 0 });
  });
});

describe('deriveMetrics', () => {
  it('derives percentages, quantiles and averages from counters', () => {
    const d = deriveMetrics(counters({ requests: 10, errors: 1, toolCalls: 4, toolErrors: 1, abandoned: 2, costUsd: 1.5 }, [100, 300]));
    expect(d.errorRate).toBe(10);
    expect(d.toolErrorRate).toBe(25);
    expect(d.abandonedRate).toBe(20);
    expect(d.aiErrorRate).toBeNull();
    expect(d.avgMs).toBe(200);
    expect(d.maxMs).toBe(300);
    expect(d.p50Ms).not.toBeNull();
    expect(d.costUsd).toBe(1.5);
  });

  it('uses the same error-rate denominator as the alert formulas (cancelled-aware only for models)', () => {
    const c = counters({ requests: 10, errors: 5, cancelled: 5 });
    expect(deriveMetrics(c, 'kb').errorRate).toBe(50);
    expect(deriveMetrics(c, 'kb').errorRate).toBe(computeEntityMetric('kb_error_rate', c).value);
    expect(deriveMetrics(c).errorRate).toBe(50);
    expect(deriveMetrics(c, 'model').errorRate).toBe(100);
    expect(deriveMetrics(c, 'model').errorRate).toBe(computeEntityMetric('model_error_rate', c).value);
  });

  it('is all-null for rates and latency when there is no data', () => {
    const d = deriveMetrics(emptyCounters());
    expect(d).toMatchObject({ requests: 0, errorRate: null, p95Ms: null, avgMs: null, maxMs: null, emptyResultRate: null });
  });

  it('toCounters fills missing fields with zero', () => {
    const c = toCounters({ requests: 3 });
    expect(c.requests).toBe(3);
    expect(c.lat4).toBe(0);
    expect(toCounters(null).requests).toBe(0);
  });
});

describe('pickBucketMs', () => {
  it('uses 5 minutes up to 6 hours, hourly up to 48 hours, daily beyond', () => {
    expect(pickBucketMs(0, 6 * HOUR)).toBe(FIVE);
    expect(pickBucketMs(0, 6 * HOUR + 1)).toBe(HOUR);
    expect(pickBucketMs(0, 48 * HOUR)).toBe(HOUR);
    expect(pickBucketMs(0, 48 * HOUR + 1)).toBe(DAY);
    expect(pickBucketMs(0, 30 * DAY)).toBe(DAY);
  });
});

type Row = Partial<IEntityMetricAggregate> & Partial<EntityMetricCounters>;
function row(r: Row): IEntityMetricAggregate {
  return { ...emptyCounters(), ...r } as IEntityMetricAggregate;
}

const scope = { tenantDbName: 'tenant_db', tenantId: 't-1', projectId: 'p-1' };

beforeEach(() => {
  aggregate.calls = [];
  aggregate.handler = async () => [];
});

beforeEach(() => {
  __resetEntityHealthCachesForTests();
  aggregate.calls.length = 0;
});

describe('getEntitySummaries', () => {
  it('has no previous period when retention covers only part of it (a 30-day range with 45-day retention)', async () => {
    const now = Date.now();
    const toMs = now - (now % HOUR);
    aggregate.handler = async () => [row({ entityKey: 'a', requests: 10 })];

    const thirty = await getEntitySummaries({ ...scope, entityType: 'agent', fromMs: toMs - 30 * DAY, toMs });
    expect(aggregate.calls).toHaveLength(1);
    expect(thirty[0]!.previous).toBeNull();

    aggregate.calls.length = 0;
    const seven = await getEntitySummaries({ ...scope, entityType: 'agent', fromMs: toMs - 7 * DAY, toMs });
    expect(aggregate.calls).toHaveLength(2);
    expect(seven[0]!.previous?.requests).toBe(10);
  });

  it('issues at most two aggregate queries and builds totals, previous and spark per entity', async () => {
    const now = Date.now();
    const toMs = now - (now % HOUR);
    const fromMs = toMs - 6 * HOUR;
    aggregate.handler = async (q) => {
      const query = q as EntityMetricsAggregateQuery;
      if (query.bucketMs !== undefined) {
        return [
          row({ ...counters({}, [100]), entityKey: 'a', bucketMs: fromMs, requests: 10, errors: 1 }),
          row({ entityKey: 'a', bucketMs: fromMs + 2 * HOUR, requests: 30, errors: 3 }),
          row({ entityKey: 'b', bucketMs: fromMs + HOUR, requests: 5 }),
        ];
      }
      return [
        row({ entityKey: 'a', requests: 20, errors: 1 }),
        row({ entityKey: 'gone', requests: 7, errors: 7 }),
      ];
    };

    const summaries = await getEntitySummaries({ ...scope, entityType: 'agent', fromMs, toMs, sparkPoints: 6 });

    expect(aggregate.calls).toHaveLength(2);
    const [current, previous] = aggregate.calls as EntityMetricsAggregateQuery[];
    expect(current).toMatchObject({ tenantId: 't-1', projectId: 'p-1', entityType: 'agent', groupBy: ['entityKey'], fromMs, toMs });
    expect(current.bucketMs).toBe(HOUR);
    expect(previous).toMatchObject({ fromMs: fromMs - 6 * HOUR, toMs: fromMs, groupBy: ['entityKey'] });
    expect(previous.bucketMs).toBeUndefined();

    expect(summaries.map((s) => s.entityKey)).toEqual(['a', 'b', 'gone']);
    const a = summaries[0]!;
    expect(a.totals.requests).toBe(40);
    expect(a.totals.errors).toBe(4);
    expect(a.totals.errorRate).toBe(10);
    expect(a.previous?.requests).toBe(20);
    expect(a.spark.requests).toHaveLength(6);
    expect(a.spark.requests[0]).toBe(10);
    expect(a.spark.requests[2]).toBe(30);
    expect(a.spark.requests[1]).toBe(0);
    expect(a.spark.errorRate[1]).toBeNull();
    expect(a.spark.errorRate[0]).toBe(10);

    // an entity that went silent still shows up, with zero totals and its previous period
    const gone = summaries[2]!;
    expect(gone.totals.requests).toBe(0);
    expect(gone.previous?.requests).toBe(7);
    // an entity without previous data has no previous
    expect(summaries[1]!.previous).toBeNull();
  });

  it('skips the previous query when withPrevious is false and passes keys through', async () => {
    const toMs = Date.now();
    await getEntitySummaries({ ...scope, entityType: 'model', fromMs: toMs - HOUR, toMs, keys: ['m1'], withPrevious: false });
    expect(aggregate.calls).toHaveLength(1);
    expect((aggregate.calls[0] as EntityMetricsAggregateQuery).entityKeys).toEqual(['m1']);
  });

  it('returns a zero summary for a requested key without data', async () => {
    const toMs = Date.now();
    const out = await getEntitySummaries({ ...scope, entityType: 'kb', fromMs: toMs - HOUR, toMs, keys: ['empty-kb'] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ entityKey: 'empty-kb', previous: null });
    expect(out[0]!.totals.requests).toBe(0);
  });

  it('returns nothing for an empty key list or an inverted range, without querying', async () => {
    const now = Date.now();
    expect(await getEntitySummaries({ ...scope, entityType: 'agent', fromMs: now - HOUR, toMs: now, keys: [] })).toEqual([]);
    expect(await getEntitySummaries({ ...scope, entityType: 'agent', fromMs: now, toMs: now - HOUR })).toEqual([]);
    expect(aggregate.calls).toHaveLength(0);
  });

  it('clamps the range to the retention window', async () => {
    const now = Date.now();
    await getEntitySummaries({ ...scope, entityType: 'agent', fromMs: now - 400 * DAY, toMs: now, withPrevious: false });
    const query = aggregate.calls[0] as EntityMetricsAggregateQuery;
    expect(query.fromMs).toBeGreaterThanOrEqual(now - 45 * DAY - FIVE);
  });
});

describe('getEntitySeries previous period retention', () => {
  it('skips the previous-period query when it is not fully retained', async () => {
    const now = Date.now();
    const toMs = now - (now % HOUR);
    aggregate.handler = async () => [row({ requests: 4 })];

    const thirty = await getEntitySeries({ ...scope, entityType: 'agent', entityKey: 'a', fromMs: toMs - 30 * DAY, toMs });
    expect(thirty.previous).toBeNull();
    expect(aggregate.calls).toHaveLength(1);

    aggregate.calls.length = 0;
    const day = await getEntitySeries({ ...scope, entityType: 'agent', entityKey: 'a', fromMs: toMs - DAY, toMs });
    expect(aggregate.calls).toHaveLength(2);
    expect(day.previous?.requests).toBe(4);
  });
});

describe('getEntitySeries', () => {
  it('zero-fills empty buckets and reports totals and previous totals', async () => {
    const now = Date.now();
    const toMs = now - (now % HOUR);
    const fromMs = toMs - 3 * HOUR;
    aggregate.handler = async (q) => {
      const query = q as EntityMetricsAggregateQuery;
      if (query.bucketMs !== undefined) {
        return [
          row({ ...counters({}, [100, 200]), bucketMs: fromMs, requests: 10, errors: 2 }),
          row({ bucketMs: fromMs + 2 * HOUR, requests: 5 }),
        ];
      }
      return [row({ requests: 9, errors: 9 })];
    };

    const series = await getEntitySeries({ ...scope, entityType: 'agent', entityKey: 'a', fromMs, toMs });

    // 3h span => 5-minute buckets, zero-filled
    expect(series.range.bucketMs).toBe(FIVE);
    expect(series.buckets).toHaveLength((3 * HOUR) / FIVE);
    expect(series.buckets[0]).toMatchObject({ t: fromMs, requests: 10, errorRate: 20 });
    expect(series.buckets[1]).toMatchObject({ t: fromMs + FIVE, requests: 0, errorRate: null, p95Ms: null });
    expect(series.buckets[(2 * HOUR) / FIVE]).toMatchObject({ requests: 5 });
    expect(series.buckets.filter((b) => b.requests > 0)).toHaveLength(2);
    expect(series.totals.requests).toBe(15);
    expect(series.previous?.requests).toBe(9);
    expect(aggregate.calls).toHaveLength(2);
    expect(aggregate.calls[0]).toMatchObject({ entityKeys: ['a'], groupBy: [], bucketMs: FIVE });
  });

  it('selects the bucket size from the span and places rows into their buckets', async () => {
    const now = Date.now();
    const toMs = now - (now % DAY);
    const fromMs = toMs - 10 * DAY;
    aggregate.handler = async (q) => {
      const query = q as EntityMetricsAggregateQuery;
      if (query.bucketMs !== undefined) {
        return [
          row({ bucketMs: fromMs, requests: 4, errors: 1 }),
          row({ bucketMs: fromMs + 3 * DAY, requests: 6 }),
        ];
      }
      return [];
    };
    const series = await getEntitySeries({ ...scope, entityType: 'agent', entityKey: 'a', fromMs, toMs });
    expect(series.range.bucketMs).toBe(DAY);
    expect(series.buckets).toHaveLength(10);
    expect(series.buckets[0]).toMatchObject({ t: fromMs, requests: 4, errorRate: 25 });
    expect(series.buckets[1]!.requests).toBe(0);
    expect(series.buckets[3]!.requests).toBe(6);
    expect(series.totals.requests).toBe(10);
    expect(series.previous).toBeNull();
  });

  it('honours an explicit bucket size (rounded to a multiple of 5 minutes)', async () => {
    const now = Date.now();
    const toMs = now - (now % HOUR);
    const series = await getEntitySeries({
      ...scope, entityType: 'tool', entityKey: 't', fromMs: toMs - 2 * HOUR, toMs, bucketMs: 20 * 60_000,
    });
    expect(series.range.bucketMs).toBe(20 * 60_000);
    expect(series.buckets).toHaveLength(6);
  });
});

describe('listActiveEntityKeys', () => {
  it('sums requests per key, tracks the last bucket, filters by q and sorts busiest first', async () => {
    const now = Date.now();
    const toMs = now - (now % HOUR);
    const fromMs = toMs - 24 * HOUR;
    aggregate.handler = async (q) => {
      if ((q as EntityMetricsAggregateQuery).bucketMs === undefined) {
        return [
          row({ entityKey: 'Pulse Main', requests: 7 }),
          row({ entityKey: 'pulse-lite', requests: 20 }),
          row({ entityKey: 'other', requests: 99 }),
        ];
      }
      return [
        row({ entityKey: 'Pulse Main', bucketMs: fromMs, requests: 3 }),
        row({ entityKey: 'Pulse Main', bucketMs: fromMs + 5 * HOUR, requests: 4 }),
        row({ entityKey: 'pulse-lite', bucketMs: fromMs + HOUR, requests: 20 }),
        row({ entityKey: 'other', bucketMs: fromMs + HOUR, requests: 99 }),
      ];
    };
    const all = await listActiveEntityKeys({ ...scope, entityType: 'agent', fromMs, toMs });
    expect(all.map((k) => k.key)).toEqual(['other', 'pulse-lite', 'Pulse Main']);
    expect(all[2]).toEqual({ key: 'Pulse Main', requests: 7, lastBucketMs: fromMs + 5 * HOUR });

    const filtered = await listActiveEntityKeys({ ...scope, entityType: 'agent', fromMs, toMs, q: ' PULSE ', limit: 1 });
    expect(filtered.map((k) => k.key)).toEqual(['pulse-lite']);
  });

  it('does not depend on bucketed rows for the ranking, and restricts the bucketed query to the returned keys', async () => {
    const now = Date.now();
    const toMs = now - (now % HOUR);
    const fromMs = toMs - 24 * HOUR;
    aggregate.calls.length = 0;
    aggregate.handler = async (q) => {
      const query = q as EntityMetricsAggregateQuery;
      if (query.bucketMs === undefined) {
        return [row({ entityKey: 'a', requests: 50 }), row({ entityKey: 'b', requests: 5 })];
      }
      return [row({ entityKey: 'a', bucketMs: toMs - HOUR, requests: 1 })];
    };
    const out = await listActiveEntityKeys({ ...scope, entityType: 'agent', fromMs, toMs, limit: 1 });
    expect(out).toEqual([{ key: 'a', requests: 50, lastBucketMs: toMs - HOUR }]);
    const bucketed = aggregate.calls.find((c) => (c as EntityMetricsAggregateQuery).bucketMs !== undefined) as EntityMetricsAggregateQuery;
    expect(bucketed.entityKeys).toEqual(['a']);
  });

  it('serves repeat picker lookups from a short cache and filters q in memory', async () => {
    const now = Date.now();
    const toMs = now - (now % HOUR);
    const fromMs = toMs - 24 * HOUR;
    aggregate.handler = async (q) => {
      const query = q as EntityMetricsAggregateQuery;
      if (query.bucketMs === undefined) {
        return [row({ entityKey: 'alpha', requests: 5 }), row({ entityKey: 'beta', requests: 9 })];
      }
      return [row({ entityKey: 'beta', bucketMs: toMs - HOUR, requests: 9 })];
    };
    const first = await listActiveEntityKeys({ ...scope, entityType: 'agent', fromMs, toMs, q: 'b' });
    const second = await listActiveEntityKeys({ ...scope, entityType: 'agent', fromMs, toMs, q: 'be' });
    expect(first.map((k) => k.key)).toEqual(['beta']);
    expect(second.map((k) => k.key)).toEqual(['beta']);
    const totalReads = aggregate.calls.filter((c) => (c as EntityMetricsAggregateQuery).bucketMs === undefined);
    expect(totalReads).toHaveLength(1);

    // a different type is a different cache entry
    await listActiveEntityKeys({ ...scope, entityType: 'model', fromMs, toMs });
    expect(aggregate.calls.filter((c) => (c as EntityMetricsAggregateQuery).bucketMs === undefined)).toHaveLength(2);
  });
});
