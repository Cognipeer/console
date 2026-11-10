import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetTracingRetentionSweepState,
  shouldRunTracingRetentionSweep,
} from '@/lib/services/tracingRetentionSweep';

describe('tracing retention sweep throttle', () => {
  beforeEach(() => resetTracingRetentionSweepState());

  it('runs once per interval for the same tenant and project', () => {
    expect(shouldRunTracingRetentionSweep('t1', 'p1', 1_000, 60_000)).toBe(true);
    expect(shouldRunTracingRetentionSweep('t1', 'p1', 2_000, 60_000)).toBe(false);
    expect(shouldRunTracingRetentionSweep('t1', 'p1', 61_001, 60_000)).toBe(true);
  });

  it('tracks tenants and projects independently', () => {
    expect(shouldRunTracingRetentionSweep('t1', 'p1', 1_000, 60_000)).toBe(true);
    expect(shouldRunTracingRetentionSweep('t1', 'p2', 1_000, 60_000)).toBe(true);
    expect(shouldRunTracingRetentionSweep('t2', 'p1', 1_000, 60_000)).toBe(true);
  });

  it('sweeps on every request when the interval is 0', () => {
    expect(shouldRunTracingRetentionSweep('t1', 'p1', 1_000, 0)).toBe(true);
    expect(shouldRunTracingRetentionSweep('t1', 'p1', 1_001, 0)).toBe(true);
  });
});
