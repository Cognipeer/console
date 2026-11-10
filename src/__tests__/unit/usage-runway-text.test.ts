import { describe, expect, it } from 'vitest';
import { MAX_RUNWAY_DAYS, runwayText } from '@/components/usage/format';

const t = (key: string, values?: Record<string, string | number>) => `${key}${values ? JSON.stringify(values) : ''}`;

describe('runwayText', () => {
  it('shows the day count up to a year', () => {
    expect(runwayText(t, 'en', 30)).toBe('creditCard.runwayValue{"days":"30"}');
    expect(runwayText(t, 'en', MAX_RUNWAY_DAYS)).toContain('creditCard.runwayValue');
  });

  it('shows the more-than-a-year text above a year', () => {
    expect(runwayText(t, 'en', MAX_RUNWAY_DAYS + 1)).toBe('creditCard.runwayOverYear');
    expect(runwayText(t, 'en', 244993)).toBe('creditCard.runwayOverYear');
  });

  it('shows the no-spend text when there is no runway', () => {
    expect(runwayText(t, 'en', undefined)).toBe('creditCard.noRunway');
  });
});
