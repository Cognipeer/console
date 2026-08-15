/**
 * Robust statistics behind the prescriptions engine. These are the numeric
 * foundations of anomaly/regime findings — every verdict must be mechanical.
 */

import { describe, expect, it } from 'vitest';
import {
  detectRegimeShift,
  findOutliers,
  mad,
  median,
  robustZ,
} from '@/lib/services/prescriptions/stats';

describe('median / mad', () => {
  it('computes the median for odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('computes the median absolute deviation', () => {
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
    expect(mad([5, 5, 5])).toBe(0);
  });
});

describe('robustZ', () => {
  it('is ~0 at the baseline median and large for a spike', () => {
    const baseline = [10, 11, 9, 10, 12, 10, 11];
    expect(Math.abs(robustZ(10, baseline))).toBeLessThan(1);
    expect(robustZ(100, baseline)).toBeGreaterThan(10);
  });

  it('does not divide by zero on a constant series', () => {
    const z = robustZ(50, [10, 10, 10, 10]);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeGreaterThan(5);
  });
});

describe('findOutliers', () => {
  it('finds a machine-traffic spike day against an organic baseline', () => {
    // ~600 sessions/day, one 11× day (the classic runaway-automation shape).
    const series = [580, 612, 590, 605, 620, 6716, 598, 610, 601, 595];
    const outliers = findOutliers(series, { threshold: 5 });
    expect(outliers).toHaveLength(1);
    expect(outliers[0].index).toBe(5);
    expect(outliers[0].value).toBe(6716);
  });

  it('stays silent below the minimum observation count', () => {
    expect(findOutliers([1, 1, 100], { threshold: 5 })).toHaveLength(0);
  });

  it('stays silent on a well-behaved series', () => {
    const series = [10, 12, 11, 13, 9, 10, 12, 11, 10, 13];
    expect(findOutliers(series, { threshold: 5 })).toHaveLength(0);
  });
});

describe('detectRegimeShift', () => {
  it('detects a sustained level increase', () => {
    const series = [...Array(14).fill(20), ...Array(7).fill(100)];
    const shift = detectRegimeShift(series);
    expect(shift).not.toBeNull();
    expect(shift!.direction).toBe('up');
    expect(shift!.recentMedian).toBe(100);
    expect(shift!.priorMedian).toBe(20);
  });

  it('detects a sustained drop', () => {
    const series = [...Array(14).fill(100), ...Array(7).fill(30)];
    expect(detectRegimeShift(series)?.direction).toBe('down');
  });

  it('returns null for wiggle inside the ratio band and for short series', () => {
    const flat = [...Array(14).fill(50), ...Array(7).fill(60)];
    expect(detectRegimeShift(flat)).toBeNull();
    expect(detectRegimeShift([1, 2, 3])).toBeNull();
  });

  it('handles a prior of zero without dividing by zero', () => {
    const series = [...Array(14).fill(0), ...Array(7).fill(10)];
    const shift = detectRegimeShift(series);
    expect(shift).not.toBeNull();
    expect(shift!.direction).toBe('up');
  });
});
