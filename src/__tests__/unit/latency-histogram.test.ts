import { describe, expect, it } from 'vitest';
import {
  addLatency,
  bucketIndex,
  countAbove,
  emptyCounters,
  mergeCounters,
  quantileFromCounters,
} from '@/lib/services/entityMetrics/latencyHistogram';
import {
  ENTITY_LATENCY_BUCKET_FIELDS,
  ENTITY_LATENCY_BUCKET_UPPER_MS,
  ENTITY_METRIC_COUNTER_FIELDS,
} from '@/lib/database/provider/types.base';

describe('bucketIndex', () => {
  it('puts a value on a bucket bound into that bucket (bounds are inclusive)', () => {
    ENTITY_LATENCY_BUCKET_UPPER_MS.forEach((bound, index) => {
      expect(bucketIndex(bound)).toBe(index);
    });
  });

  it('moves one millisecond past a bound into the next bucket', () => {
    ENTITY_LATENCY_BUCKET_UPPER_MS.forEach((bound, index) => {
      expect(bucketIndex(bound + 1)).toBe(index + 1);
    });
  });

  it('sends overflow to the last bucket and junk to the first', () => {
    expect(bucketIndex(600_001)).toBe(14);
    expect(bucketIndex(10 ** 9)).toBe(14);
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(-5)).toBe(0);
    expect(bucketIndex(Number.NaN)).toBe(0);
    expect(bucketIndex(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('emptyCounters / addLatency / mergeCounters', () => {
  it('starts from zero for every counter field', () => {
    const c = emptyCounters();
    for (const field of ENTITY_METRIC_COUNTER_FIELDS) expect(c[field]).toBe(0);
    expect(c.latencyMsMax).toBe(0);
  });

  it('records sum, count, max and the histogram bucket', () => {
    const c = emptyCounters();
    addLatency(c, 80);
    addLatency(c, 900);
    addLatency(c, 700_000);
    expect(c.latencyCount).toBe(3);
    expect(c.latencyMsSum).toBe(700_980);
    expect(c.latencyMsMax).toBe(700_000);
    expect(c.lat0).toBe(1);
    expect(c.lat3).toBe(1);
    expect(c.lat14).toBe(1);
  });

  it('ignores negative and non-finite latencies', () => {
    const c = emptyCounters();
    addLatency(c, -1);
    addLatency(c, Number.NaN);
    expect(c.latencyCount).toBe(0);
  });

  it('merges by summing counters and taking the max of latencyMsMax', () => {
    const a = emptyCounters();
    const b = emptyCounters();
    a.requests = 2; addLatency(a, 100);
    b.requests = 3; addLatency(b, 5000);
    const merged = mergeCounters(a, b);
    expect(merged.requests).toBe(5);
    expect(merged.latencyCount).toBe(2);
    expect(merged.latencyMsMax).toBe(5000);
    expect(a.requests).toBe(2);
  });
});

describe('quantileFromCounters', () => {
  it('is null without latency samples', () => {
    expect(quantileFromCounters(emptyCounters(), 0.95)).toBeNull();
  });

  it('interpolates linearly inside a bucket', () => {
    const c = emptyCounters();
    // 10 samples in (500, 1000]
    for (let i = 0; i < 10; i += 1) addLatency(c, 800);
    expect(quantileFromCounters(c, 0.5)).toBeCloseTo(750, 5);
    expect(quantileFromCounters(c, 1)).toBeCloseTo(1000, 5);
    expect(quantileFromCounters(c, 0)).toBeCloseTo(500, 5);
  });

  it('walks the cumulative counts across buckets', () => {
    const c = emptyCounters();
    for (let i = 0; i < 90; i += 1) addLatency(c, 50); // bucket 0 (0,100]
    for (let i = 0; i < 10; i += 1) addLatency(c, 1500); // bucket 4 (1000,2000]
    expect(quantileFromCounters(c, 0.5)).toBeCloseTo((50 / 90) * 100, 5);
    expect(quantileFromCounters(c, 0.95)).toBeCloseTo(1500, 5);
    const p99 = quantileFromCounters(c, 0.99)!;
    expect(p99).toBeGreaterThan(1000);
    expect(p99).toBeLessThanOrEqual(2000);
  });

  it('reports the lower bound of the overflow bucket', () => {
    const c = emptyCounters();
    addLatency(c, 900_000);
    expect(quantileFromCounters(c, 0.99)).toBe(600_000);
  });

  it('clamps q into 0..1', () => {
    const c = emptyCounters();
    addLatency(c, 50);
    expect(quantileFromCounters(c, 5)).toBe(quantileFromCounters(c, 1));
    expect(quantileFromCounters(c, -1)).toBe(quantileFromCounters(c, 0));
  });
});

describe('countAbove', () => {
  it('counts samples in buckets above a bucket bound', () => {
    const c = emptyCounters();
    addLatency(c, 50);
    addLatency(c, 900);
    addLatency(c, 1000); // bucket 3, on the 1000 bound: not above
    addLatency(c, 1001);
    addLatency(c, 70_000);
    addLatency(c, 900_000);
    expect(countAbove(c, 1000)).toBe(3);
    expect(countAbove(c, 600_000)).toBe(1);
    expect(countAbove(c, 100)).toBe(5);
  });

  it('throws for a threshold that is not a bucket bound', () => {
    expect(() => countAbove(emptyCounters(), 1500)).toThrow(/thresholdMs/);
    expect(() => countAbove(emptyCounters(), 0)).toThrow();
  });

  it('uses every histogram field', () => {
    expect(ENTITY_LATENCY_BUCKET_FIELDS).toHaveLength(ENTITY_LATENCY_BUCKET_UPPER_MS.length + 1);
  });
});
