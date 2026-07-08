import { describe, expect, it } from 'vitest';
import {
  applyDashboardDateFilterToSearchParams,
  buildDashboardDateSearchParams,
  dashboardDateFilterFromSearchParams,
  dashboardDateFilterKey,
  defaultDashboardDateFilter,
  parseLocalDate,
  type DashboardDateFilterState,
} from '@/lib/utils/dashboardDateFilter';

describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD as local midnight', () => {
    const parsed = parseLocalDate('2026-07-03');
    expect(parsed).not.toBeNull();
    expect(parsed!.getFullYear()).toBe(2026);
    expect(parsed!.getMonth()).toBe(6);
    expect(parsed!.getDate()).toBe(3);
    expect(parsed!.getHours()).toBe(0);
    expect(parsed!.getMinutes()).toBe(0);
  });

  it('passes through valid Date instances', () => {
    const date = new Date(2026, 5, 15, 10, 30);
    expect(parseLocalDate(date)).toBe(date);
  });

  it('parses full ISO strings', () => {
    const parsed = parseLocalDate('2026-07-03T10:00:00.000Z');
    expect(parsed?.getTime()).toBe(Date.parse('2026-07-03T10:00:00.000Z'));
  });

  it('returns null for empty and invalid values', () => {
    expect(parseLocalDate(null)).toBeNull();
    expect(parseLocalDate(undefined)).toBeNull();
    expect(parseLocalDate('')).toBeNull();
    expect(parseLocalDate('not-a-date')).toBeNull();
    expect(parseLocalDate(new Date('invalid'))).toBeNull();
  });
});

describe('buildDashboardDateSearchParams', () => {
  it('serializes a custom range to start/end of day', () => {
    const from = new Date(2026, 6, 1, 15, 0);
    const to = new Date(2026, 6, 5, 9, 0);
    const params = buildDashboardDateSearchParams({
      period: 'custom',
      dateRange: [from, to],
    });
    expect(params.get('period')).toBe('custom');
    const parsedFrom = new Date(params.get('from')!);
    const parsedTo = new Date(params.get('to')!);
    expect(parsedFrom.getHours()).toBe(0);
    expect(parsedFrom.getDate()).toBe(1);
    expect(parsedTo.getHours()).toBe(23);
    expect(parsedTo.getDate()).toBe(5);
  });

  it('does not throw when string dates sneak into the state (Mantine 8 regression)', () => {
    const state = {
      period: 'custom',
      dateRange: ['2026-07-01', '2026-07-05'],
    } as unknown as DashboardDateFilterState;
    const params = buildDashboardDateSearchParams(state);
    // Strings are ignored by the Date guard rather than crashing the fetch.
    expect(params.get('period')).toBe('custom');
    expect(params.get('from')).toBeNull();
    expect(params.get('to')).toBeNull();
  });

  it('omits from/to for preset periods', () => {
    const params = buildDashboardDateSearchParams({
      period: 'last_7_days',
      dateRange: [null, null],
    });
    expect(params.get('period')).toBe('last_7_days');
    expect(params.get('from')).toBeNull();
    expect(params.get('to')).toBeNull();
  });
});

describe('URL round-trip', () => {
  it('preserves preset periods', () => {
    const state: DashboardDateFilterState = { period: 'last_30_days', dateRange: [null, null] };
    const params = new URLSearchParams();
    applyDashboardDateFilterToSearchParams(state, params);
    expect(params.get('period')).toBe('last_30_days');
    const parsed = dashboardDateFilterFromSearchParams(params);
    expect(dashboardDateFilterKey(parsed)).toBe(dashboardDateFilterKey(state));
  });

  it('preserves custom ranges as short local dates', () => {
    const state: DashboardDateFilterState = {
      period: 'custom',
      dateRange: [new Date(2026, 6, 1), new Date(2026, 6, 5)],
    };
    const params = new URLSearchParams();
    applyDashboardDateFilterToSearchParams(state, params);
    expect(params.get('from')).toBe('2026-07-01');
    expect(params.get('to')).toBe('2026-07-05');
    const parsed = dashboardDateFilterFromSearchParams(params);
    expect(parsed.period).toBe('custom');
    expect(parsed.dateRange[0]?.getDate()).toBe(1);
    expect(parsed.dateRange[1]?.getDate()).toBe(5);
  });

  it('keeps total out of the URL entirely', () => {
    const params = new URLSearchParams('foo=bar&period=custom&from=2026-07-01');
    applyDashboardDateFilterToSearchParams(defaultDashboardDateFilter(), params);
    expect(params.get('period')).toBeNull();
    expect(params.get('from')).toBeNull();
    expect(params.get('foo')).toBe('bar');
  });

  it('falls back to total for unknown periods and empty custom ranges', () => {
    expect(
      dashboardDateFilterFromSearchParams(new URLSearchParams('period=bogus')).period,
    ).toBe('total');
    expect(
      dashboardDateFilterFromSearchParams(new URLSearchParams('period=custom')).period,
    ).toBe('total');
  });
});
