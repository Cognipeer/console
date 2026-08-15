/**
 * Robust statistics for the prescriptions engine — no training, no state.
 *
 * Everything here is deterministic and tenant-local: baselines are computed
 * from the subject's own window, so the detectors work from the first report
 * on any tenant (no cross-tenant model, no cold start). MAD-based z-scores
 * are used instead of mean/stddev because LLM traffic series are heavy-tailed
 * (one machine-driven burst would poison a mean-based baseline).
 */

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Median absolute deviation (raw, not normalized). */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * Robust z-score of `value` against `baseline`. The 1.4826 factor makes MAD
 * comparable to a standard deviation under normality. A zero MAD (constant
 * series) falls back to a small fraction of the median so a genuine jump on
 * a flat series still registers instead of dividing by zero.
 */
export function robustZ(value: number, baseline: number[]): number {
  if (baseline.length === 0) return 0;
  const m = median(baseline);
  const scale = mad(baseline) * 1.4826 || Math.abs(m) * 0.1 || 1;
  return (value - m) / scale;
}

export interface SeriesOutlier {
  index: number;
  value: number;
  z: number;
}

/**
 * Flag points whose robust z-score against the REST of the series (leave-one-
 * out) exceeds `threshold`. Requires a minimum of `minPoints` observations —
 * an outlier verdict from 3 days of data is noise, not signal.
 */
export function findOutliers(
  series: number[],
  options: { threshold?: number; minPoints?: number } = {},
): SeriesOutlier[] {
  const threshold = options.threshold ?? 5;
  const minPoints = options.minPoints ?? 8;
  if (series.length < minPoints) return [];
  const outliers: SeriesOutlier[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const rest = series.filter((_, j) => j !== i);
    const z = robustZ(series[i], rest);
    if (Math.abs(z) >= threshold) outliers.push({ index: i, value: series[i], z });
  }
  return outliers;
}

export interface RegimeShift {
  /** Median of the trailing window vs the median of the window before it. */
  recentMedian: number;
  priorMedian: number;
  /** recent / prior; Infinity when prior is 0 and recent is not. */
  ratio: number;
  direction: 'up' | 'down';
}

/**
 * Compare the trailing `recentDays` of a daily series against the
 * `priorDays` before them. Returns null when there is not enough history or
 * when the change is inside `minRatio` (both directions) — a regime shift is
 * a sustained level change, not day-to-day wiggle.
 */
export function detectRegimeShift(
  series: number[],
  options: { recentDays?: number; priorDays?: number; minRatio?: number } = {},
): RegimeShift | null {
  const recentDays = options.recentDays ?? 7;
  const priorDays = options.priorDays ?? 14;
  const minRatio = options.minRatio ?? 2;
  if (series.length < recentDays + priorDays) return null;

  const recent = series.slice(-recentDays);
  const prior = series.slice(-(recentDays + priorDays), -recentDays);
  const recentMedian = median(recent);
  const priorMedian = median(prior);

  if (priorMedian === 0 && recentMedian === 0) return null;
  const ratio = priorMedian === 0 ? Number.POSITIVE_INFINITY : recentMedian / priorMedian;

  if (ratio >= minRatio) {
    return { recentMedian, priorMedian, ratio, direction: 'up' };
  }
  if (ratio <= 1 / minRatio) {
    return { recentMedian, priorMedian, ratio, direction: 'down' };
  }
  return null;
}
