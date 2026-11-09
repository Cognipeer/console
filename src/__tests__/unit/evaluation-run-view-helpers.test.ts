/**
 * Unit tests for the pure run-screen helpers
 * (src/components/evaluations/runViewHelpers.ts): derived error rate, the
 * scored-item denominator, item/score outcome precedence, run-page merging,
 * error-message extraction and the compare mismatch warning.
 */

import { describe, expect, it } from 'vitest';
import {
  appendRunPage,
  compareMismatchWarning,
  deriveErrorRate,
  isRunActive,
  itemOutcome,
  mergeRunPages,
  readErrorMessage,
  refreshRunList,
  runRefreshLimit,
  scoreOutcome,
  scoredCount,
  summaryCount,
} from '@/components/evaluations/runViewHelpers';
import type { EvalRunView } from '@/components/evaluations/types';

const run = (id: string, status = 'completed', extra: Partial<EvalRunView> = {}): EvalRunView =>
  ({ id, status, suiteKey: 's', targetKey: 't', datasetKey: 'd', ...extra }) as EvalRunView;

describe('isRunActive', () => {
  it('is true only for pending and running', () => {
    expect(isRunActive('pending')).toBe(true);
    expect(isRunActive('running')).toBe(true);
    expect(isRunActive('cancelled')).toBe(false);
    expect(isRunActive('completed')).toBe(false);
    expect(isRunActive(undefined)).toBe(false);
  });
});

describe('deriveErrorRate', () => {
  it('prefers the server value', () => {
    expect(deriveErrorRate({ total: 10, failed: 5, errorRate: 0.1 })).toBe(0.1);
  });
  it('derives failed / total for older runs', () => {
    expect(deriveErrorRate({ total: 10, failed: 3 })).toBeCloseTo(0.3);
  });
  it('is 0 for an empty run or missing aggregate', () => {
    expect(deriveErrorRate({ total: 0, failed: 0 })).toBe(0);
    expect(deriveErrorRate(null)).toBe(0);
  });
});

describe('scoredCount', () => {
  it('subtracts skipped items from completed', () => {
    expect(scoredCount({ completed: 10, skipped: 3 })).toBe(7);
  });
  it('treats absent skipped as 0', () => {
    expect(scoredCount({ completed: 10 })).toBe(10);
  });
});

describe('outcomes', () => {
  it('item: error beats skipped beats pass/fail', () => {
    expect(itemOutcome({ error: 'x', skipped: true, passed: true })).toBe('error');
    expect(itemOutcome({ skipped: true, passed: false })).toBe('skipped');
    expect(itemOutcome({ passed: true })).toBe('pass');
    expect(itemOutcome({ passed: false })).toBe('fail');
  });
  it('score: same precedence', () => {
    expect(scoreOutcome({ error: 'boom', passed: false })).toBe('error');
    expect(scoreOutcome({ skipped: true, passed: false })).toBe('skipped');
    expect(scoreOutcome({ passed: true })).toBe('pass');
  });
});

describe('run page merging', () => {
  it('mergeRunPages puts fresh rows first and keeps older pages', () => {
    const merged = mergeRunPages(
      [run('a', 'running'), run('b'), run('c')],
      [run('a', 'completed'), run('n')],
    );
    expect(merged.map((r) => r.id)).toEqual(['a', 'n', 'b', 'c']);
    expect(merged[0].status).toBe('completed');
  });
  it('appendRunPage skips rows already present', () => {
    expect(appendRunPage([run('a'), run('b')], [run('b'), run('c')]).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('runRefreshLimit re-reads every loaded row, at least one page and at most the server cap', () => {
    expect(runRefreshLimit(0)).toBe(50);
    expect(runRefreshLimit(73)).toBe(73);
    expect(runRefreshLimit(500)).toBe(200);
  });
  it('refreshRunList replaces the list when the refresh covers it (later-page status, deleted runs)', () => {
    const onScreen = [run('a'), run('b'), run('c', 'running')];
    const refreshed = refreshRunList(onScreen, [run('a'), run('c', 'completed')], 50);
    expect(refreshed.map((r) => [r.id, r.status])).toEqual([['a', 'completed'], ['c', 'completed']]);
  });
  it('refreshRunList keeps the tail beyond the cap', () => {
    const onScreen = [run('a'), run('b'), run('c')];
    expect(refreshRunList(onScreen, [run('a'), run('b')], 2).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('readErrorMessage', () => {
  it('uses the server error text', async () => {
    const res = new Response(JSON.stringify({ error: 'Runs have different datasets' }), { status: 409 });
    expect(await readErrorMessage(res, 'Compare failed')).toBe('Runs have different datasets');
  });
  it('falls back with the status for non-JSON bodies', async () => {
    const res = new Response('<html>bad gateway</html>', { status: 502 });
    expect(await readErrorMessage(res, 'Compare failed')).toBe('Compare failed (HTTP 502)');
  });
});

describe('compareMismatchWarning', () => {
  it('warns when the datasets differ', () => {
    const w = compareMismatchWarning({ datasetKey: 'old', suiteKey: 's' }, { datasetKey: 'new', suiteKey: 's' });
    expect(w).toContain('old');
    expect(w).toContain('new');
  });
  it('is quiet when they match or there is no baseline', () => {
    expect(compareMismatchWarning({ datasetKey: 'd', suiteKey: 's' }, { datasetKey: 'd', suiteKey: 's' })).toBeNull();
    expect(compareMismatchWarning(undefined, { datasetKey: 'd', suiteKey: 's' })).toBeNull();
  });
});

describe('summaryCount', () => {
  it('reads missing counts as 0', () => {
    expect(summaryCount({ regressed: 2 }, 'not_comparable')).toBe(0);
    expect(summaryCount({ not_comparable: 4 }, 'not_comparable')).toBe(4);
  });
});
