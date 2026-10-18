/**
 * Unit tests — crawler schedulePlanner
 * Covers cron next-run, interval next-run, window enforcement, validation.
 */

import { describe, it, expect } from 'vitest';
import {
  computeNextRun,
  dueSlot,
  isDue,
  validateSchedule,
} from '@/lib/services/crawler/schedulePlanner';
import type { ICrawlerSchedule } from '@/lib/database';

const FIXED = new Date('2026-05-19T10:00:00.000Z');

describe('schedulePlanner.validateSchedule', () => {
  it('returns null for disabled schedules without checking other fields', () => {
    expect(validateSchedule({ mode: 'cron', enabled: false } as ICrawlerSchedule)).toBeNull();
  });

  it('rejects interval below 60 seconds', () => {
    const err = validateSchedule({
      mode: 'interval',
      enabled: true,
      intervalSeconds: 30,
    });
    expect(err).toMatch(/intervalSeconds/);
  });

  it('rejects missing cron expression', () => {
    expect(
      validateSchedule({ mode: 'cron', enabled: true } as ICrawlerSchedule),
    ).toMatch(/cron expression is required/);
  });

  it('rejects malformed cron expression', () => {
    expect(
      validateSchedule({ mode: 'cron', enabled: true, cron: 'not a cron' }),
    ).toMatch(/invalid cron/i);
  });

  it('accepts a valid hourly cron', () => {
    expect(
      validateSchedule({ mode: 'cron', enabled: true, cron: '0 * * * *' }),
    ).toBeNull();
  });
});

describe('schedulePlanner.computeNextRun — interval', () => {
  it('returns null when schedule is disabled', () => {
    expect(
      computeNextRun({ mode: 'interval', enabled: false, intervalSeconds: 60 }, FIXED),
    ).toBeNull();
  });

  it('fires immediately on first run', () => {
    const next = computeNextRun(
      { mode: 'interval', enabled: true, intervalSeconds: 3600 },
      FIXED,
    );
    expect(next?.toISOString()).toBe(FIXED.toISOString());
  });

  it('computes next from lastRunAt', () => {
    const lastRun = new Date('2026-05-19T09:30:00.000Z');
    const next = computeNextRun(
      {
        mode: 'interval',
        enabled: true,
        intervalSeconds: 3600,
        lastRunAt: lastRun,
      },
      FIXED,
    );
    expect(next?.toISOString()).toBe('2026-05-19T10:30:00.000Z');
  });

  it('catches up when lastRunAt is far in the past', () => {
    const next = computeNextRun(
      {
        mode: 'interval',
        enabled: true,
        intervalSeconds: 3600,
        lastRunAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      FIXED,
    );
    // Old last + 1h is in the past, so we get caught up to "from"
    expect(next?.toISOString()).toBe(FIXED.toISOString());
  });

  it('respects startAt window', () => {
    const future = new Date('2026-05-19T12:00:00.000Z');
    const next = computeNextRun(
      {
        mode: 'interval',
        enabled: true,
        intervalSeconds: 60,
        startAt: future,
      },
      FIXED,
    );
    expect(next?.toISOString()).toBe(future.toISOString());
  });

  it('returns null past endAt', () => {
    const next = computeNextRun(
      {
        mode: 'interval',
        enabled: true,
        intervalSeconds: 60,
        endAt: new Date('2026-05-19T09:00:00.000Z'),
      },
      FIXED,
    );
    expect(next).toBeNull();
  });
});

describe('schedulePlanner.computeNextRun — cron', () => {
  it('parses standard hourly cron', () => {
    const next = computeNextRun(
      { mode: 'cron', enabled: true, cron: '0 * * * *' },
      FIXED,
    );
    expect(next?.toISOString()).toBe('2026-05-19T11:00:00.000Z');
  });

  it('handles every-5-minutes', () => {
    const next = computeNextRun(
      { mode: 'cron', enabled: true, cron: '*/5 * * * *' },
      new Date('2026-05-19T10:03:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-05-19T10:05:00.000Z');
  });

  it('returns null on invalid cron', () => {
    const next = computeNextRun(
      { mode: 'cron', enabled: true, cron: 'broken' },
      FIXED,
    );
    expect(next).toBeNull();
  });

  it('moves past lastRunAt to avoid double-firing', () => {
    const lastRun = new Date('2026-05-19T11:00:00.000Z');
    const next = computeNextRun(
      { mode: 'cron', enabled: true, cron: '0 * * * *', lastRunAt: lastRun },
      FIXED,
    );
    // lastRun is in the "future" relative to FIXED → next cron after lastRun
    expect(next?.toISOString()).toBe('2026-05-19T12:00:00.000Z');
  });
});

describe('schedulePlanner.isDue', () => {
  it('is due immediately when interval schedule just enabled', () => {
    expect(
      isDue({ mode: 'interval', enabled: true, intervalSeconds: 60 }, FIXED),
    ).toBe(true);
  });

  it('is not due when next cron fire is in the future', () => {
    expect(
      isDue({ mode: 'cron', enabled: true, cron: '0 * * * *' }, FIXED),
    ).toBe(false);
  });

  it('respects disabled flag', () => {
    expect(
      isDue({ mode: 'interval', enabled: false, intervalSeconds: 60 }, FIXED),
    ).toBe(false);
  });
});

describe('schedulePlanner.isDue / dueSlot — cron prev() slot', () => {
  const hourly: ICrawlerSchedule = { mode: 'cron', enabled: true, cron: '0 * * * *' };
  const since = new Date('2026-05-19T08:30:00.000Z');

  it('is due exactly at the slot', () => {
    expect(isDue(hourly, new Date('2026-05-19T10:00:00.000Z'), since)).toBe(true);
    expect(dueSlot(hourly, new Date('2026-05-19T10:00:00.000Z'), since)).toBe('2026-05-19T10:00:00.000Z');
  });

  it('is due after the slot, naming that slot', () => {
    expect(dueSlot(hourly, new Date('2026-05-19T10:00:20.000Z'), since)).toBe('2026-05-19T10:00:00.000Z');
  });

  it('is not due before the first slot after creation', () => {
    expect(isDue(hourly, new Date('2026-05-19T08:59:59.000Z'), since)).toBe(false);
  });

  it('is not due twice for the same slot once lastRunAt is recorded', () => {
    const ran = { ...hourly, lastRunAt: new Date('2026-05-19T10:00:20.000Z') };
    expect(isDue(ran, new Date('2026-05-19T10:00:50.000Z'), since)).toBe(false);
    expect(isDue(ran, new Date('2026-05-19T10:59:59.000Z'), since)).toBe(false);
    expect(isDue(ran, new Date('2026-05-19T11:00:00.000Z'), since)).toBe(true);
  });

  it('fires only the latest slot after downtime (no backlog replay)', () => {
    const ran = { ...hourly, lastRunAt: new Date('2026-05-19T06:00:05.000Z') };
    expect(dueSlot(ran, new Date('2026-05-19T10:10:00.000Z'))).toBe('2026-05-19T10:00:00.000Z');
  });

  it('has nothing due without any baseline', () => {
    expect(isDue(hourly, new Date('2026-05-19T10:00:00.000Z'))).toBe(false);
  });

  it('does not fire before startAt, fires the first slot at or after it', () => {
    const windowed = { ...hourly, startAt: new Date('2026-05-19T10:30:00.000Z') };
    expect(isDue(windowed, new Date('2026-05-19T10:10:00.000Z'))).toBe(false);
    expect(isDue(windowed, new Date('2026-05-19T10:59:59.000Z'))).toBe(false);
    expect(dueSlot(windowed, new Date('2026-05-19T11:00:05.000Z'))).toBe('2026-05-19T11:00:00.000Z');
  });

  it('fires a slot that lands exactly on startAt', () => {
    const windowed = { ...hourly, startAt: new Date('2026-05-19T10:00:00.000Z') };
    expect(isDue(windowed, new Date('2026-05-19T10:00:05.000Z'))).toBe(true);
  });

  it('does not fire a slot after endAt', () => {
    const windowed = { ...hourly, endAt: new Date('2026-05-19T09:30:00.000Z') };
    expect(isDue(windowed, new Date('2026-05-19T10:00:05.000Z'), since)).toBe(false);
    expect(isDue(windowed, new Date('2026-05-19T09:00:05.000Z'), since)).toBe(true);
  });

  it('computeNextRun stays strictly after now (display only)', () => {
    expect(computeNextRun(hourly, new Date('2026-05-19T10:00:00.000Z'))?.toISOString()).toBe(
      '2026-05-19T11:00:00.000Z',
    );
  });
});

describe('schedulePlanner.dueSlot — interval mode', () => {
  it('is due on first run with a stable id, then after lastRunAt + interval', () => {
    const base: ICrawlerSchedule = { mode: 'interval', enabled: true, intervalSeconds: 3600 };
    expect(dueSlot(base, FIXED)).toBe('first');
    const ran = { ...base, lastRunAt: new Date('2026-05-19T08:00:00.000Z') };
    expect(dueSlot(ran, FIXED)).toBe('after-2026-05-19T08:00:00.000Z');
    expect(isDue({ ...ran, lastRunAt: new Date('2026-05-19T09:30:00.000Z') }, FIXED)).toBe(false);
  });
});
