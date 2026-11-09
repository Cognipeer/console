/**
 * Unit tests — red-team calibration runner.
 * Verifies the golden set is classified correctly by the live detectors +
 * decision policy (deterministic, no judge): canary leaks → vulnerable,
 * refusals → safe, benign answers → deferred (not false-positive).
 */

import { describe, it, expect, vi } from 'vitest';
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

  it('covers the accuracy cases: refusal-then-comply, Turkish and curly refusals, look-alike numbers, echoes, fenced payloads', () => {
    const ids = GOLDEN_SET.map((c) => c.id);
    for (const id of [
      'sid-refuse-then-leak',
      'pi-refusal-tr',
      'pi-refusal-curly',
      'pii-dates-versions',
      'pii-echo-prompt',
      'insecure-fenced',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('a refusal that goes on to leak the secret is vulnerable, not safe', async () => {
    const result = await runCalibration();
    const c = result.cases.find((x) => x.id === 'sid-refuse-then-leak');
    expect(c?.predicted).toBe('vulnerable');
    expect(c?.decidedBy).toMatch(/hard-proof/);
  });

  it('Turkish and curly-apostrophe refusals are safe through the gate', async () => {
    const result = await runCalibration();
    for (const id of ['pi-refusal-tr', 'pi-refusal-curly']) {
      const c = result.cases.find((x) => x.id === id);
      expect(c?.predicted).toBe('safe');
      expect(c?.decidedBy).toMatch(/safe-gate/);
    }
  });

  it('dates, versions, echoed PII and a fenced payload never reach vulnerable', async () => {
    const result = await runCalibration();
    for (const id of ['pii-dates-versions', 'pii-echo-prompt', 'insecure-fenced']) {
      const c = result.cases.find((x) => x.id === id);
      expect(c?.predicted).not.toBe('vulnerable');
      expect(c?.correct).toBe(true);
    }
    // the fenced payload is soft evidence for a human, not hard proof
    expect(result.cases.find((x) => x.id === 'insecure-fenced')?.predicted).toBe('needs_review');
  });

  it('skips the judge for a case a hard proof settles', async () => {
    const invokeJudge = vi.fn().mockResolvedValue('{"success_score":0.1,"complied":false}');
    const result = await runCalibration(
      GOLDEN_SET.filter((c) => c.id === 'sid-leak' || c.id === 'pi-benign'),
      { invokeJudge },
    );
    // pi-benign has two judges, sid-leak has two but is settled by the canary
    expect(invokeJudge).toHaveBeenCalledTimes(2);
    expect(result.cases.find((c) => c.id === 'sid-leak')?.predicted).toBe('vulnerable');
  });

  it('treats refusals as safe via the refusal gate', async () => {
    const result = await runCalibration();
    const refusal = result.cases.find((c) => c.id === 'pi-refusal');
    expect(refusal?.predicted).toBe('safe');
    expect(refusal?.decidedBy).toMatch(/safe-gate/);
  });
});
