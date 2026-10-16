/**
 * Latency histogram helpers shared by the rollup writer, the health readers
 * and the alert evaluators.
 *
 * Latencies are stored as 15 flat additive counters (`lat0`..`lat14`) per
 * entity_metrics row. Bucket i (0..13) holds samples with
 * `UPPER[i-1] < ms <= UPPER[i]`; `lat14` is the overflow (> 600000 ms).
 * Quantiles are computed at read time from the summed counters.
 */

import {
  ENTITY_LATENCY_BUCKET_FIELDS,
  ENTITY_LATENCY_BUCKET_UPPER_MS,
  ENTITY_METRIC_COUNTER_FIELDS,
  type EntityMetricCounters,
} from '@/lib/database/provider/types.base';

const UPPER = ENTITY_LATENCY_BUCKET_UPPER_MS;
const OVERFLOW_INDEX = UPPER.length;

/** Index (0..14) of the histogram bucket a latency falls into. Non-finite or negative values land in bucket 0. */
export function bucketIndex(ms: number): number {
  if (!Number.isFinite(ms) || ms <= UPPER[0]) return 0;
  for (let i = 1; i < UPPER.length; i += 1) {
    if (ms <= UPPER[i]) return i;
  }
  return OVERFLOW_INDEX;
}

/** A fresh all-zero counter set. */
export function emptyCounters(): EntityMetricCounters {
  const out: Record<string, number> = { latencyMsMax: 0 };
  for (const field of ENTITY_METRIC_COUNTER_FIELDS) out[field] = 0;
  return out as EntityMetricCounters;
}

/** Record one latency sample (sum, count, max and histogram bucket). Mutates `counters`. */
export function addLatency(counters: EntityMetricCounters, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  counters.latencyMsSum += ms;
  counters.latencyCount += 1;
  if (ms > counters.latencyMsMax) counters.latencyMsMax = ms;
  counters[ENTITY_LATENCY_BUCKET_FIELDS[bucketIndex(ms)]] += 1;
}

/** Add two counter sets (max for `latencyMsMax`). Returns a new object. */
export function mergeCounters(a: EntityMetricCounters, b: EntityMetricCounters): EntityMetricCounters {
  const out = emptyCounters();
  for (const field of ENTITY_METRIC_COUNTER_FIELDS) {
    out[field] = (Number(a[field]) || 0) + (Number(b[field]) || 0);
  }
  out.latencyMsMax = Math.max(Number(a.latencyMsMax) || 0, Number(b.latencyMsMax) || 0);
  return out;
}

/**
 * Quantile (q in 0..1) from the histogram: cumulative walk plus linear
 * interpolation inside the bucket. The overflow bucket has no upper bound, so
 * it reports its lower bound. Null when no latency was recorded.
 */
export function quantileFromCounters(counters: EntityMetricCounters, q: number): number | null {
  const counts = ENTITY_LATENCY_BUCKET_FIELDS.map((f) => Math.max(Number(counters[f]) || 0, 0));
  const total = counts.reduce((s, c) => s + c, 0);
  if (!(Number(counters.latencyCount) > 0) || total <= 0) return null;

  const clamped = Math.min(Math.max(Number.isFinite(q) ? q : 0, 0), 1);
  const target = clamped * total;
  let cumulative = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const count = counts[i];
    if (count <= 0) continue;
    const lower = i === 0 ? 0 : UPPER[i - 1];
    if (i === OVERFLOW_INDEX) return lower;
    if (cumulative + count >= target) {
      const fraction = Math.min(Math.max((target - cumulative) / count, 0), 1);
      return lower + (UPPER[i] - lower) * fraction;
    }
    cumulative += count;
  }
  return UPPER[UPPER.length - 1];
}

/**
 * Number of samples slower than `thresholdMs`. The threshold must be one of
 * the bucket upper bounds (the histogram cannot split a bucket), otherwise
 * this throws, because SLO latency math needs exact "<= X" counts.
 */
export function countAbove(counters: EntityMetricCounters, thresholdMs: number): number {
  const idx = (UPPER as readonly number[]).indexOf(thresholdMs);
  if (idx < 0) {
    throw new Error(`thresholdMs must be one of ${UPPER.join(', ')} (got ${thresholdMs})`);
  }
  let above = 0;
  for (let i = idx + 1; i < ENTITY_LATENCY_BUCKET_FIELDS.length; i += 1) {
    above += Math.max(Number(counters[ENTITY_LATENCY_BUCKET_FIELDS[i]]) || 0, 0);
  }
  return above;
}
