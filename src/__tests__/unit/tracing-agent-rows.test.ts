/** The agents list rows: health overview joined with the directory, sorting, filters, the red flag. */
import { describe, expect, it } from 'vitest';
import {
  deriveAlertState,
  errorSpark,
  filterAgentRows,
  healthRank,
  isErrorRateElevated,
  mergeAgentRows,
  sortAgentRows,
  type AgentDirectoryApiRow,
  type AgentHealthApiRow,
} from '@/components/tracing/health/agentRows';
import { normalizeTracingStatus } from '@/components/tracing/sessionStatus';

const spark = { requests: [1, 2], errorRate: [null, null], p95Ms: [null, null] };

function health(name: string, over: Partial<AgentHealthApiRow> = {}): AgentHealthApiRow {
  return {
    name,
    totals: { requests: 10, errorRate: 2, p95Ms: 500, toolCalls: 0, costUsd: 0 },
    previous: null,
    spark,
    alert: { phase: null },
    ...over,
  };
}

const directory: AgentDirectoryApiRow[] = [
  { name: 'alpha', sessionsCount: 5, latestSessionAt: '2026-10-14T10:00:00Z', latestStatus: 'success' },
  { name: 'quiet', sessionsCount: 1, latestSessionAt: '2026-10-01T10:00:00Z', latestStatus: 'abandoned' },
];

describe('mergeAgentRows', () => {
  it('joins health rows with the directory and appends agents only the directory knows', () => {
    const rows = mergeAgentRows([health('alpha'), health('beta')], directory);
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'beta', 'quiet']);
    expect(rows[0]).toMatchObject({ latestStatus: 'success', latestSessionAt: '2026-10-14T10:00:00Z' });
    // No directory entry: the status is unknown, the health stays.
    expect(rows[1]).toMatchObject({ latestStatus: null, totals: expect.objectContaining({ requests: 10 }) });
    // Directory only: no health data in this period.
    expect(rows[2]).toMatchObject({ totals: null, spark: null, alert: { phase: null }, latestStatus: 'abandoned' });
  });

  it('works without a directory (it failed or is still loading)', () => {
    const rows = mergeAgentRows([health('alpha')], null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latestStatus).toBeNull();
  });
});

describe('healthRank and the red flag', () => {
  it('ranks firing by severity above pending above nothing', () => {
    expect(healthRank({ phase: 'firing', severity: 'critical' })).toBeGreaterThan(healthRank({ phase: 'firing', severity: 'warning' }));
    expect(healthRank({ phase: 'firing' })).toBeGreaterThan(healthRank({ phase: 'pending' }));
    expect(healthRank({ phase: 'pending' })).toBeGreaterThan(healthRank({ phase: null }));
    expect(healthRank(undefined)).toBe(0);
  });

  it('flags an error rate above 5% that grew by half against the previous period', () => {
    expect(isErrorRateElevated({ errorRate: 12 }, { errorRate: 6 })).toBe(true);
    expect(isErrorRateElevated({ errorRate: 12 }, { errorRate: 9 })).toBe(false); // 12 is not > 9 * 1.5
    expect(isErrorRateElevated({ errorRate: 4.9 }, { errorRate: 0 })).toBe(false); // below the floor
    expect(isErrorRateElevated({ errorRate: 8 }, { errorRate: 0 })).toBe(true);
    // Nothing to compare with (a new agent): not flagged, per the "grew by half" rule.
    expect(isErrorRateElevated({ errorRate: 8 }, null)).toBe(false);
    expect(isErrorRateElevated({ errorRate: 8 }, { errorRate: null })).toBe(false);
    expect(isErrorRateElevated({ errorRate: null }, null)).toBe(false);
    expect(isErrorRateElevated(null, null)).toBe(false);
  });
});

describe('sortAgentRows', () => {
  const rows = mergeAgentRows(
    [
      health('b', { totals: { requests: 30, errorRate: 1, p95Ms: 900 } }),
      health('a', { totals: { requests: 30, errorRate: 9, p95Ms: null as unknown as number } }),
      health('c', { totals: { requests: 5, errorRate: null as unknown as number, p95Ms: 100 }, alert: { phase: 'firing', severity: 'critical' } }),
    ],
    [{ name: 'd', sessionsCount: 1, latestSessionAt: null, latestStatus: 'error' }],
  );

  it('sorts numbers both ways with the name as the tie-break', () => {
    expect(sortAgentRows(rows, 'sessions', 'desc').map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortAgentRows(rows, 'sessions', 'asc').map((r) => r.name)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('puts rows without a value last whichever the direction', () => {
    expect(sortAgentRows(rows, 'errorRate', 'desc').map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortAgentRows(rows, 'errorRate', 'asc').map((r) => r.name)).toEqual(['b', 'a', 'c', 'd']);
    expect(sortAgentRows(rows, 'p95Ms', 'asc').map((r) => r.name)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('sorts by health with the most urgent first, and by name case-insensitively', () => {
    expect(sortAgentRows(rows, 'health', 'desc')[0]!.name).toBe('c');
    expect(sortAgentRows(rows, 'name', 'asc').map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortAgentRows(rows, 'lastStatus', 'asc')[0]!.name).toBe('d');
  });

  it('does not change the input', () => {
    const before = rows.map((r) => r.name);
    sortAgentRows(rows, 'name', 'desc');
    expect(rows.map((r) => r.name)).toEqual(before);
  });
});

describe('filterAgentRows', () => {
  const rows = mergeAgentRows(
    [
      health('Pulse Main', { alert: { phase: 'firing', severity: 'warning' } }),
      health('pulse-batch', { alert: { phase: 'pending' } }),
      health('support'),
    ],
    [
      { name: 'Pulse Main', sessionsCount: 1, latestSessionAt: null, latestStatus: 'error' },
      { name: 'pulse-batch', sessionsCount: 1, latestSessionAt: null, latestStatus: 'in_progress' },
      { name: 'support', sessionsCount: 1, latestSessionAt: null, latestStatus: 'running' },
    ],
  );
  const base = { query: '', status: 'all', health: 'all' as const };

  it('searches by name', () => {
    expect(filterAgentRows(rows, { ...base, query: ' PULSE' }, normalizeTracingStatus).map((r) => r.name)).toEqual(['Pulse Main', 'pulse-batch']);
  });

  it('filters by latest status, with running read as in_progress and abandoned offered', () => {
    expect(filterAgentRows(rows, { ...base, status: 'in_progress' }, normalizeTracingStatus).map((r) => r.name)).toEqual(['pulse-batch', 'support']);
    expect(filterAgentRows(rows, { ...base, status: 'abandoned' }, normalizeTracingStatus)).toEqual([]);
  });

  it('filters by health state', () => {
    expect(filterAgentRows(rows, { ...base, health: 'firing' }, normalizeTracingStatus).map((r) => r.name)).toEqual(['Pulse Main']);
    expect(filterAgentRows(rows, { ...base, health: 'pending' }, normalizeTracingStatus).map((r) => r.name)).toEqual(['pulse-batch']);
    expect(filterAgentRows(rows, { ...base, health: 'ok' }, normalizeTracingStatus).map((r) => r.name)).toEqual(['support']);
  });
});

describe('errorSpark', () => {
  it('turns gaps into zeros, and needs two points with data', () => {
    expect(errorSpark([null, 2, null, 4])).toEqual([0, 2, 0, 4]);
    expect(errorSpark([null, 2, null])).toBeNull();
    expect(errorSpark(undefined)).toBeNull();
  });
});

describe('alert state: unmonitored and unreadable are not OK', () => {
  it('derives the state from the phase, the coverage flag and the response availability', () => {
    expect(deriveAlertState({ phase: 'firing', covered: true })).toBe('firing');
    expect(deriveAlertState({ phase: 'pending', covered: true })).toBe('pending');
    expect(deriveAlertState({ phase: null, covered: true })).toBe('ok');
    expect(deriveAlertState({ phase: null, covered: false })).toBe('uncovered');
    // An older server sends neither flag: shown as before.
    expect(deriveAlertState({ phase: null })).toBe('ok');
    expect(deriveAlertState(undefined)).toBe('ok');
    expect(deriveAlertState({ phase: null }, true)).toBe('ok');
    // A failed alert read beats everything, a stale phase included.
    expect(deriveAlertState({ phase: null, covered: true }, false)).toBe('unknown');
    expect(deriveAlertState({ phase: 'firing' }, false)).toBe('unknown');
  });

  it('puts the state on every merged row and filters OK apart from no-rule and unknown', () => {
    const rows = mergeAgentRows(
      [
        health('watched', { alert: { phase: null, covered: true } }),
        health('bare', { alert: { phase: null, covered: false } }),
        health('hot', { alert: { phase: 'firing', covered: true } }),
      ],
      null,
    );
    expect(rows.map((r) => r.alertState)).toEqual(['ok', 'uncovered', 'firing']);
    const base = { query: '', status: 'all', health: 'all' as const };
    expect(filterAgentRows(rows, { ...base, health: 'ok' }, normalizeTracingStatus).map((r) => r.name)).toEqual(['watched']);
    expect(filterAgentRows(rows, { ...base, health: 'uncovered' }, normalizeTracingStatus).map((r) => r.name)).toEqual(['bare']);

    const unreadable = mergeAgentRows([health('watched', { alert: { phase: null, covered: true } })], [
      { name: 'dir-only', sessionsCount: 1, latestSessionAt: null, latestStatus: 'success' },
    ], false);
    expect(unreadable.map((r) => r.alertState)).toEqual(['unknown', 'unknown']);
    expect(filterAgentRows(unreadable, { ...base, health: 'ok' }, normalizeTracingStatus)).toEqual([]);
  });
});
