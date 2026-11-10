import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    maxPlanUsagePeak: vi.fn(async (..._a: unknown[]) => undefined),
    getPlanUsagePeaks: vi.fn(async (..._a: unknown[]) => [] as any[]),
  },
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => h.db }));

import { clearPeaksForTests, getPeaks24h, notePeak } from '@/lib/limits/peaks';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-01-02T10:30:00Z'));
  clearPeaksForTests();
  h.db.maxPlanUsagePeak.mockClear();
  h.db.getPlanUsagePeaks.mockReset();
  h.db.getPlanUsagePeaks.mockResolvedValue([]);
});
afterEach(() => {
  clearPeaksForTests();
  vi.useRealTimers();
});

describe('notePeak', () => {
  it('writes the first value, then only increases, at most once a minute', async () => {
    notePeak('t1', 'agent', 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.db.maxPlanUsagePeak).toHaveBeenCalledWith('t1', '2030-01-02', 'agent', 10, 2);
    notePeak('t1', 'agent', 1); // lower: ignored
    notePeak('t1', 'agent', 5); // higher but within a minute: deferred
    notePeak('t1', 'agent', 6);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.db.maxPlanUsagePeak).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.db.maxPlanUsagePeak).toHaveBeenCalledTimes(2);
    expect(h.db.maxPlanUsagePeak).toHaveBeenLastCalledWith('t1', '2030-01-02', 'agent', 10, 6);
  });

  it('rejects bad dimensions and values without throwing', async () => {
    notePeak('t1', 'a.b', 1);
    notePeak('t1', 'agent', Number.NaN);
    notePeak('t1', 'agent', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.db.maxPlanUsagePeak).not.toHaveBeenCalled();
  });
});

describe('getPeaks24h', () => {
  it('takes the max per dimension over the last 24 hourly buckets', async () => {
    h.db.getPlanUsagePeaks.mockResolvedValue([
      { day: '2030-01-01', dimension: 'agent', hour: 9, value: 99 }, // older than 24 buckets
      { day: '2030-01-01', dimension: 'agent', hour: 12, value: 4 },
      { day: '2030-01-02', dimension: 'agent', hour: 3, value: 7 },
      { day: '2030-01-02', dimension: 'flow', hour: 8, value: 2 },
    ]);
    notePeak('t1', 'flow', 3);
    const peaks = await getPeaks24h('t1');
    expect(peaks).toEqual({ agent: 7, flow: 3 });
    expect(h.db.getPlanUsagePeaks).toHaveBeenCalledWith('t1', ['2030-01-02', '2030-01-01']);
  });

  it('returns what it has when the read fails', async () => {
    h.db.getPlanUsagePeaks.mockRejectedValue(new Error('db'));
    notePeak('t1', 'job', 1);
    expect(await getPeaks24h('t1')).toEqual({ job: 1 });
  });
});
