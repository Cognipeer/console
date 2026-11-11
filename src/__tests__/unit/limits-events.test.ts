import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    insertPlanLimitEvents: vi.fn(async (_events: unknown[]) => undefined),
    listPlanLimitEvents: vi.fn(async () => []),
    deletePlanLimitEventsBefore: vi.fn(async () => 0),
  },
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => h.db }));

import {
  clearLimitEventsForTests,
  flushLimitEvents,
  listLimitEvents,
  outcomeEventFor,
  pruneLimitEvents,
  recordLimitEvent,
} from '@/lib/limits/events';

const base = {
  tenantId: 't1',
  kind: 'concurrency' as const,
  dimension: 'agent',
  outcome: 'refused' as const,
  source: { type: 'user' as const, id: 'u1' },
};

function stored(): any[] {
  return h.db.insertPlanLimitEvents.mock.calls.flatMap((c) => c[0] as any[]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  clearLimitEventsForTests();
  Object.values(h.db).forEach((m) => m.mockClear());
});
afterEach(() => {
  clearLimitEventsForTests();
  vi.useRealTimers();
});

describe('recordLimitEvent', () => {
  it('does not touch the database on the caller path and flushes on the timer', async () => {
    recordLimitEvent(base);
    expect(h.db.insertPlanLimitEvents).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2100);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ tenantId: 't1', count: 1, outcome: 'refused' });
  });

  it('folds sampled events into the count of the next stored one', async () => {
    recordLimitEvent(base);
    recordLimitEvent(base);
    recordLimitEvent(base);
    await flushLimitEvents();
    expect(stored()).toHaveLength(1);
    vi.advanceTimersByTime(10_500);
    recordLimitEvent(base);
    await flushLimitEvents();
    expect(stored()).toHaveLength(2);
    expect(stored()[1].count).toBe(3);
  });

  it('samples per key', async () => {
    recordLimitEvent(base);
    recordLimitEvent({ ...base, dimension: 'flow' });
    recordLimitEvent({ ...base, outcome: 'waited' });
    recordLimitEvent({ ...base, source: { type: 'user', id: 'u2' } });
    recordLimitEvent({ ...base, tenantId: 't2' });
    await flushLimitEvents();
    expect(stored()).toHaveLength(5);
  });

  it('flushes at 100 events', async () => {
    for (let i = 0; i < 100; i++) recordLimitEvent({ ...base, source: { type: 'user', id: `u${i}` } });
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toHaveLength(100);
  });

  it('never throws when the database fails', async () => {
    h.db.insertPlanLimitEvents.mockRejectedValueOnce(new Error('db'));
    recordLimitEvent(base);
    await expect(flushLimitEvents()).resolves.toBeUndefined();
  });
});

describe('outcomeEventFor', () => {
  it('records only non-allowed decisions, always as mode on', async () => {
    outcomeEventFor({ allowed: true, outcome: 'allowed', kind: 'monthly', dimension: 'searches' }, { tenantId: 't1' });
    outcomeEventFor(
      { allowed: false, outcome: 'refused', kind: 'monthly', dimension: 'flowRuns', limit: 5, used: 5 },
      { tenantId: 't1' },
    );
    await flushLimitEvents();
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ outcome: 'refused', mode: 'on', limit: 5, used: 5, kind: 'monthly' });
  });
});

describe('list and prune', () => {
  it('clamps the list limit and flushes first', async () => {
    recordLimitEvent(base);
    await listLimitEvents('t1', { limit: 99_999 });
    expect(stored()).toHaveLength(1);
    expect(h.db.listPlanLimitEvents).toHaveBeenCalledWith('t1', { since: undefined, kind: undefined, limit: 1000 });
    await listLimitEvents('t1');
    expect(h.db.listPlanLimitEvents).toHaveBeenLastCalledWith('t1', { since: undefined, kind: undefined, limit: 200 });
  });

  it('hides rows stored by the retired measure-only mode', async () => {
    const at = new Date(0);
    h.db.listPlanLimitEvents.mockResolvedValueOnce([
      { tenantId: 't1', kind: 'monthly', outcome: 'would_refuse', mode: 'shadow', count: 1, at },
      { tenantId: 't1', kind: 'monthly', outcome: 'refused', mode: 'on', count: 1, at },
    ] as never);
    const events = await listLimitEvents('t1');
    expect(events.map((e) => e.outcome)).toEqual(['refused']);
  });

  it('prunes events older than 90 days', async () => {
    await pruneLimitEvents();
    const calls = h.db.deletePlanLimitEventsBefore.mock.calls as unknown as Date[][];
    const cutoff = calls[0][0];
    expect(Date.now() - cutoff.getTime()).toBe(90 * 24 * 3600 * 1000);
  });
});
