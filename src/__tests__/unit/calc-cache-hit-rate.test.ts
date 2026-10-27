import { describe, it, expect } from 'vitest';
import { calcCacheHitRate } from '@/lib/utils/tracingUtils';

describe('calcCacheHitRate', () => {
  it('is cached / input (cached is a subset of input)', () => {
    expect(calcCacheHitRate(1000, 250)).toBeCloseTo(0.25, 10);
    expect(calcCacheHitRate(100, 100)).toBe(1);
  });

  it('clamps to [0, 1] for legacy rows with cached > input', () => {
    expect(calcCacheHitRate(100, 500)).toBe(1);
    expect(calcCacheHitRate(100, -5)).toBe(0);
  });

  it('is 0 when there is no input or values are missing', () => {
    expect(calcCacheHitRate(0, 10)).toBe(0);
    expect(calcCacheHitRate(null, null)).toBe(0);
    expect(calcCacheHitRate(undefined, 5)).toBe(0);
  });
});
