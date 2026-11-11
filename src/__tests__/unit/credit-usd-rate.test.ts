/**
 * The USD-per-credit rate the CRM sells credits at: carried by the license plan claim, and used to show
 * credit spend in USD (the usage page, and the recorded cost of a credit-paid call).
 */
import { describe, expect, it } from 'vitest';
import { normalizePlanClaim } from '@/lib/license/planClaim';
import { creditUsd } from '@/components/usage/format';
import { costOfCreditQuote } from '@/lib/services/models/usageLogger';

describe('license plan claim: credits.usdPerCredit', () => {
  it('keeps a fractional rate next to the monthly credits', () => {
    const claim = normalizePlanClaim({ id: 'team', credits: { includedPerMonth: 5000, usdPerCredit: 0.006 } });
    expect(claim?.credits).toEqual({ includedPerMonth: 5000, usdPerCredit: 0.006 });
  });

  it('a claim without a rate stays without one', () => {
    const claim = normalizePlanClaim({ id: 'team', credits: { includedPerMonth: 5000 } });
    expect(claim?.credits).toEqual({ includedPerMonth: 5000 });
  });

  it('refuses a negative, non-numeric or absurd rate', () => {
    expect(() => normalizePlanClaim({ id: 'team', credits: { usdPerCredit: -1 } })).toThrow(/usdPerCredit/);
    expect(() => normalizePlanClaim({ id: 'team', credits: { usdPerCredit: '0.01' } })).toThrow(/usdPerCredit/);
    expect(() => normalizePlanClaim({ id: 'team', credits: { usdPerCredit: 5000 } })).toThrow(/usdPerCredit/);
  });
});

describe('creditUsd (usage page)', () => {
  it('shows the USD of fully priced credits', () => {
    expect(creditUsd(1.5, 250, 0)).toEqual({ text: '$1.50', partial: false });
    expect(creditUsd(0.006, 1, 0)).toEqual({ text: '$0.0060', partial: false });
  });

  it('is null when none of the credits has a rate (a dash, not $0.00)', () => {
    expect(creditUsd(0, 120, 120)).toBeNull();
    expect(creditUsd(undefined, 120, 0)).toBeNull();
  });

  it('flags a partial figure when some credits have no rate', () => {
    expect(creditUsd(0.6, 200, 100)).toEqual({ text: '$0.6000', partial: true });
  });

  it('keeps the sign of a negative amount', () => {
    expect(creditUsd(-0.03, -5, 0)?.text).toBe('-$0.0300');
  });
});

describe('costOfCreditQuote', () => {
  it('is the whole USD amount, with the credits and the rate it was priced at', () => {
    expect(costOfCreditQuote({ credits: 4, usdPerCredit: 0.006, usd: 0.024 })).toEqual({
      currency: 'USD',
      inputCost: 0,
      outputCost: 0,
      cachedCost: 0,
      cacheWriteCost: 0,
      totalCost: 0.024,
      credits: 4,
      usdPerCredit: 0.006,
    });
  });
});
