/**
 * The health range parser shared by the core tracing health routes and the
 * enterprise entity health API.
 */
import { describe, expect, it } from 'vitest';
import { resolveHealthRange, sparkBucketMs } from '@/lib/services/entityMetrics/healthRange';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('resolveHealthRange', () => {
  it('defaults to the last 24 hours, aligned to the rollup bucket', () => {
    const range = resolveHealthRange({}, 45, NOW + 123_456);
    expect(range).not.toHaveProperty('error');
    const { fromMs, toMs } = range as { fromMs: number; toMs: number };
    expect(toMs).toBe(NOW + 123_456);
    expect(fromMs % 300_000).toBe(0);
    expect(toMs - fromMs).toBeGreaterThanOrEqual(DAY - 300_000);
    expect(toMs - fromMs).toBeLessThanOrEqual(DAY + 300_000);
  });

  it('bounds period=total to 30 days and an unknown period to 24 hours', () => {
    const total = resolveHealthRange({ period: 'total' }, 45, NOW) as { fromMs: number; toMs: number };
    expect(NOW - total.fromMs).toBeGreaterThanOrEqual(30 * DAY - 300_000);
    expect(NOW - total.fromMs).toBeLessThanOrEqual(30 * DAY);
    const unknown = resolveHealthRange({ period: 'nonsense' }, 45, NOW) as { fromMs: number; toMs: number };
    expect(NOW - unknown.fromMs).toBeLessThanOrEqual(DAY);
  });

  it('explicit from/to win over period and to is capped at now', () => {
    const range = resolveHealthRange(
      { period: 'last_30_days', from: new Date(NOW - 6 * HOUR).toISOString(), to: new Date(NOW + DAY).toISOString() },
      45,
      NOW,
    ) as { fromMs: number; toMs: number };
    expect(range.toMs).toBe(NOW);
    expect(range.fromMs).toBe(NOW - 6 * HOUR);
  });

  it('keeps the range inside retention', () => {
    const range = resolveHealthRange({ from: new Date(NOW - 90 * DAY).toISOString() }, 45, NOW) as { fromMs: number };
    expect(range.fromMs).toBeGreaterThanOrEqual(NOW - 45 * DAY - 300_000);
  });

  it('rejects invalid dates, an inverted range and a range outside retention', () => {
    expect(resolveHealthRange({ from: 'not-a-date' }, 45, NOW)).toHaveProperty('error');
    expect(resolveHealthRange({ to: 'nope' }, 45, NOW)).toHaveProperty('error');
    expect(resolveHealthRange({ from: new Date(NOW).toISOString(), to: new Date(NOW - HOUR).toISOString() }, 45, NOW)).toHaveProperty('error');
    expect(resolveHealthRange({
      from: new Date(NOW - 100 * DAY).toISOString(),
      to: new Date(NOW - 80 * DAY).toISOString(),
    }, 45, NOW)).toHaveProperty('error');
  });
});

describe('sparkBucketMs', () => {
  it('uses whole 5 minute buckets', () => {
    expect(sparkBucketMs({ fromMs: NOW - DAY, toMs: NOW }, 24)).toBe(HOUR);
    expect(sparkBucketMs({ fromMs: NOW - HOUR, toMs: NOW }, 24)).toBe(300_000);
    expect(sparkBucketMs({ fromMs: NOW - HOUR, toMs: NOW }, 0)).toBe(HOUR);
  });
});
