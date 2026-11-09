/**
 * Unit tests — red-team run comparison: transitions on shared attempts, errored
 * attempts that are neither regressions nor fixes, probe-set differences, and
 * attempts supplied apart from the runs (runs that keep attempts as rows).
 */

import { describe, expect, it } from 'vitest';
import { compareRedTeamRuns } from '@/lib/services/redteam/compare';
import type { IRedTeamAggregate, IRedTeamAttemptResult, IRedTeamRun, RedTeamOutcome } from '@/lib/database';

function attempt(
  probeKey: string,
  attemptId: string,
  outcome: RedTeamOutcome,
  extra: Partial<IRedTeamAttemptResult> = {},
): IRedTeamAttemptResult {
  return {
    probeKey,
    attemptId,
    family: 'f',
    category: 'LLM01-prompt-injection',
    severity: 'high',
    outcome,
    decidedBy: 'test',
    confidence: 1,
    transcript: [],
    signals: [],
    ...extra,
  };
}

/** A target that never answered the attempt. */
const failed = (probeKey: string, attemptId: string) =>
  attempt(probeKey, attemptId, 'needs_review', { error: 'timed out after 120s' });

function run(
  id: string,
  attempts: IRedTeamAttemptResult[],
  aggregate: Partial<IRedTeamAggregate> = {},
): IRedTeamRun {
  return {
    _id: id,
    tenantId: 't',
    campaignKey: 'c',
    targetKind: 'model',
    targetRef: 'm',
    status: 'completed',
    mode: 'sync',
    progress: { total: attempts.length, completed: attempts.length, failed: 0 },
    aggregate: {
      total: attempts.length,
      completed: attempts.length,
      failed: 0,
      vulnerable: attempts.filter((a) => a.outcome === 'vulnerable').length,
      safe: 0,
      needsReview: 0,
      attackSuccessRate: 0.5,
      resilienceScore: 0.5,
      bySeverity: {},
      byCategory: {},
      avgLatencyMs: null,
      ...aggregate,
    },
    attempts,
    createdBy: 'u',
  };
}

describe('compareRedTeamRuns', () => {
  it('counts an attempt that got no answer as errored, never as a regression or a fix', () => {
    const baseline = run('b', [attempt('p', 'a1', 'safe'), attempt('p', 'a2', 'vulnerable'), attempt('p', 'a3', 'safe')]);
    const current = run('c', [failed('p', 'a1'), failed('p', 'a2'), attempt('p', 'a3', 'safe')]);
    const cmp = compareRedTeamRuns(baseline, current);
    expect(cmp.summary).toMatchObject({ regressed: 0, fixed: 0, errored: 2, unchanged: 1 });
    expect(cmp.changes.map((c) => [c.attemptId, c.status])).toEqual([
      ['a1', 'errored'],
      ['a2', 'errored'],
    ]);
    // The failed side has no outcome to show; the answered side keeps its own.
    expect(cmp.changes[0]).toMatchObject({ baseline: 'safe' });
    expect(cmp.changes[0].current).toBeUndefined();
  });

  it('is errored when the baseline attempt failed and the current one answered', () => {
    const baseline = run('b', [failed('p', 'a1')]);
    const current = run('c', [attempt('p', 'a1', 'vulnerable')]);
    const cmp = compareRedTeamRuns(baseline, current);
    expect(cmp.summary.errored).toBe(1);
    expect(cmp.summary.regressed).toBe(0);
  });

  it('compares a partial attempt (judged before the error) like any answered one', () => {
    const baseline = run('b', [attempt('p', 'a1', 'safe')]);
    const current = run('c', [attempt('p', 'a1', 'vulnerable', { error: 'cut', partial: true })]);
    expect(compareRedTeamRuns(baseline, current).summary.regressed).toBe(1);
  });

  it('uses the effective outcome: a review overrides the machine verdict', () => {
    const review = { outcome: 'safe' as const, reviewedBy: 'u', reviewedAt: new Date() };
    const baseline = run('b', [attempt('p', 'a1', 'vulnerable', { review })]);
    const current = run('c', [attempt('p', 'a1', 'safe')]);
    expect(compareRedTeamRuns(baseline, current).summary.unchanged).toBe(1);
  });

  it('keys attempts by probe and id, so the same attempt id under two probes stays apart', () => {
    const baseline = run('b', [attempt('p1', 'a1', 'safe'), attempt('p2', 'a1', 'safe')]);
    const current = run('c', [attempt('p1', 'a1', 'vulnerable'), attempt('p2', 'a1', 'safe')]);
    const cmp = compareRedTeamRuns(baseline, current);
    expect(cmp.summary).toMatchObject({ regressed: 1, unchanged: 1 });
    expect(cmp.changes[0]).toMatchObject({ key: 'p1::a1', probeKey: 'p1' });
  });

  it('reports the probe-set difference and counts only shared attempts as transitions', () => {
    const baseline = run('b', [attempt('p', 'a1', 'safe'), attempt('p', 'old', 'vulnerable')]);
    const current = run('c', [attempt('p', 'a1', 'vulnerable'), attempt('p', 'new', 'vulnerable')]);
    const cmp = compareRedTeamRuns(baseline, current);
    expect(cmp.probeSetChanged).toBe(true);
    expect(cmp.onlyInBaseline).toEqual(['p::old']);
    expect(cmp.onlyInCurrent).toEqual(['p::new']);
    expect(cmp.summary).toMatchObject({ regressed: 1, added: 1, removed: 1, fixed: 0 });
  });

  it('does not flag a probe-set change when both runs ran the same attempts', () => {
    const cmp = compareRedTeamRuns(run('b', [attempt('p', 'a1', 'safe')]), run('c', [attempt('p', 'a1', 'safe')]));
    expect(cmp.probeSetChanged).toBe(false);
    expect(cmp.onlyInBaseline).toEqual([]);
    expect(cmp.onlyInCurrent).toEqual([]);
  });

  it('lists regressions first, then fixes, errors, added and removed', () => {
    const baseline = run('b', [
      attempt('p', 'fix', 'vulnerable'),
      attempt('p', 'reg', 'safe'),
      attempt('p', 'err', 'safe'),
      attempt('p', 'gone', 'safe'),
    ]);
    const current = run('c', [
      attempt('p', 'fix', 'safe'),
      attempt('p', 'reg', 'vulnerable'),
      failed('p', 'err'),
      attempt('p', 'fresh', 'safe'),
    ]);
    const order = compareRedTeamRuns(baseline, current).changes.map((c) => c.status);
    expect(order).toEqual(['regressed', 'fixed', 'errored', 'added', 'removed']);
  });

  it('reads attempts supplied apart from the runs, and honours a stored attempt key', () => {
    const baseline = run('b', []);
    const current = run('c', []);
    const cmp = compareRedTeamRuns(baseline, current, {
      baseline: [attempt('p', 'a1', 'safe', { attemptKey: 'p::a1' })],
      current: [attempt('p', 'a1', 'vulnerable', { attemptKey: 'p::a1' })],
    });
    expect(cmp.summary.regressed).toBe(1);
    expect(cmp.baselineRunId).toBe('b');
    expect(cmp.runId).toBe('c');
  });

  it('leaves a rate delta null when either run has no rate', () => {
    const baseline = run('b', [], { attackSuccessRate: null, resilienceScore: null });
    const current = run('c', [], { attackSuccessRate: 0.25, resilienceScore: 0.75 });
    const cmp = compareRedTeamRuns(baseline, current);
    expect(cmp.deltas.attackSuccessRate).toBeNull();
    expect(cmp.deltas.resilienceScore).toBeNull();
    const both = compareRedTeamRuns(run('b2', [], { attackSuccessRate: 0.5 }), current);
    expect(both.deltas.attackSuccessRate).toBeCloseTo(-0.25, 5);
  });
});
