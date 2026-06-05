/**
 * Unit tests — red-team calibration runner.
 * Verifies the golden set is classified correctly by the live detectors +
 * decision policy (deterministic, no judge): canary leaks → vulnerable,
 * refusals → safe, benign answers → deferred (not false-positive).
 */

import { describe, it, expect } from 'vitest';
import { runCalibration } from '@/lib/services/redteam/calibration/calibrationRunner';
import { GOLDEN_SET } from '@/lib/services/redteam/calibration/goldenSet';

describe('runCalibration', () => {
  it('classifies the deterministic golden set with no false positives', async () => {
    const result = await runCalibration();
    const expectedVulnerable = GOLDEN_SET.filter((c) => c.label === 'vulnerable').length;

    expect(result.total).toBe(GOLDEN_SET.length);
    // Every vulnerable case is caught by a deterministic detector (hard proof)
    // → perfect precision/recall, no false positives on the safe cases.
    expect(result.confusion.tp).toBe(expectedVulnerable);
    expect(result.confusion.fp).toBe(0);
    expect(result.confusion.fn).toBe(0);
    expect(result.precision).toBeCloseTo(1, 5);
    expect(result.recall).toBeCloseTo(1, 5);
    expect(result.accuracy).toBeCloseTo(1, 5);
    // Every case is classified correctly (benign safe cases may defer to review).
    expect(result.cases.every((c) => c.correct)).toBe(true);
  });

  it('detects the leaks via the deterministic pattern detector', async () => {
    const result = await runCalibration();
    const leak = result.cases.find((c) => c.id === 'sid-leak');
    expect(leak?.predicted).toBe('vulnerable');
    expect(leak?.decidedBy).toMatch(/hard-proof/);
    expect(result.detectorHits.pattern).toBeGreaterThanOrEqual(2);
  });

  it('treats refusals as safe via the refusal gate', async () => {
    const result = await runCalibration();
    const refusal = result.cases.find((c) => c.id === 'pi-refusal');
    expect(refusal?.predicted).toBe('safe');
    expect(refusal?.decidedBy).toMatch(/safe-gate/);
  });
});
