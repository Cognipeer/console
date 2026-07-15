import { describe, expect, it } from 'vitest';
import {
  groupUsageDailyRows,
  toUtcDay,
} from '@/lib/services/usage/usageBreakdown';

/** Minimal usage_daily row for the pure grouping function. */
function row(overrides: Partial<{
  userId: string;
  apiTokenId: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}> = {}) {
  return {
    userId: '',
    apiTokenId: '',
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

describe('toUtcDay', () => {
  it('formats as the UTC calendar day', () => {
    expect(toUtcDay(new Date('2026-07-15T23:59:59.999Z'))).toBe('2026-07-15');
    expect(toUtcDay(new Date('2026-07-15T00:00:00.000Z'))).toBe('2026-07-15');
  });
});

describe('groupUsageDailyRows', () => {
  it('groups daily rows per user and sums counters', () => {
    const { entries, totals } = groupUsageDailyRows(
      [
        row({ userId: 'u1', requests: 3, errors: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.5 }),
        row({ userId: 'u1', requests: 2, inputTokens: 40, outputTokens: 10, totalTokens: 50, costUsd: 0.25 }),
        row({ userId: 'u2', requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 2 }),
      ],
      'user',
    );

    expect(entries).toHaveLength(2);
    const u1 = entries.find((entry) => entry.id === 'u1')!;
    expect(u1).toMatchObject({
      requests: 5,
      errors: 1,
      inputTokens: 140,
      outputTokens: 60,
      totalTokens: 200,
      costUsd: 0.75,
    });
    expect(totals).toEqual({
      requests: 6,
      errors: 1,
      inputTokens: 150,
      outputTokens: 65,
      totalTokens: 215,
      costUsd: 2.75,
    });
  });

  it('groups by apiTokenId when groupBy is token', () => {
    const { entries } = groupUsageDailyRows(
      [
        row({ userId: 'u1', apiTokenId: 't1', requests: 1, costUsd: 1 }),
        row({ userId: 'u2', apiTokenId: 't1', requests: 2, costUsd: 2 }),
        row({ userId: 'u1', apiTokenId: 't2', requests: 4, costUsd: 0.1 }),
      ],
      'token',
    );

    expect(entries.map((entry) => entry.id)).toEqual(['t1', 't2']);
    expect(entries[0]).toMatchObject({ requests: 3, costUsd: 3 });
    expect(entries[1]).toMatchObject({ requests: 4, costUsd: 0.1 });
  });

  it('sorts entries by cost descending', () => {
    const { entries } = groupUsageDailyRows(
      [
        row({ userId: 'cheap', requests: 100, costUsd: 0.01 }),
        row({ userId: 'mid', requests: 1, costUsd: 1 }),
        row({ userId: 'big', requests: 1, costUsd: 10 }),
      ],
      'user',
    );
    expect(entries.map((entry) => entry.id)).toEqual(['big', 'mid', 'cheap']);
  });

  it('collapses empty ids into a single unattributed entry', () => {
    const { entries } = groupUsageDailyRows(
      [
        row({ userId: '', requests: 2, costUsd: 0.2 }),
        row({ userId: '', requests: 3, costUsd: 0.3 }),
        row({ userId: 'u1', requests: 1, costUsd: 0.1 }),
      ],
      'user',
    );
    expect(entries).toHaveLength(2);
    const unattributed = entries.find((entry) => entry.id === '')!;
    expect(unattributed).toMatchObject({ requests: 5, costUsd: 0.5 });
    expect(unattributed.name).toBeUndefined();
  });

  it('returns zeroed totals and no entries for no rows', () => {
    const { entries, totals } = groupUsageDailyRows([], 'user');
    expect(entries).toEqual([]);
    expect(totals).toEqual({
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  });
});
