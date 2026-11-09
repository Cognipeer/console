import { describe, expect, it } from 'vitest';
import { describeCreditEntry, utcMonth, type CreditLedgerEntry } from '@/components/usage/creditsApi';

/** Echoes the key and its values, so the assertions read the structure, not a language. */
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : key;
const n = (value: number) => String(value);

function entry(overrides: Partial<CreditLedgerEntry>): CreditLedgerEntry {
  return { id: 'e1', at: '2026-11-09T10:00:00.000Z', kind: 'charge', credits: -2, ...overrides };
}

describe('describeCreditEntry', () => {
  it('describes a chat charge with its model, tier, tokens and agent', () => {
    const text = describeCreditEntry(
      entry({
        model: 'platform.model-a',
        modelLabel: 'Model A',
        details: { service: 'chat', tier: 'large', inputTokens: 40_000, outputTokens: 900, agentKey: 'support-bot' },
      }),
      t,
      n,
    );
    expect(text).toBe('Model A · credits.describe.tier(tier=large) · credits.describe.tokens(input=40000,output=900) · credits.describe.agent(agent=support-bot)');
  });

  it('marks estimated counts and falls back to the model key without a label', () => {
    const text = describeCreditEntry(
      entry({ model: 'platform.embed', details: { service: 'embedding', inputTokens: 1200, estimated: true, source: 'rag' } }),
      t,
      n,
    );
    expect(text).toBe('platform.embed · credits.describe.embeddingTokens(input=1200) · credits.describe.estimated · credits.describe.source(source=rag)');
  });

  it('describes a search by its units', () => {
    expect(describeCreditEntry(entry({ model: 'search', details: { service: 'search', units: 2 } }), t, n)).toBe(
      'credits.describe.search(count=2)',
    );
  });

  it('describes grants, redemptions and expiries without details', () => {
    expect(describeCreditEntry(entry({ kind: 'monthly_grant', credits: 1000 }), t, n)).toBe('credits.describe.monthlyGrant');
    expect(describeCreditEntry(entry({ kind: 'redeem', credits: 500 }), t, n)).toBe('credits.describe.redeem');
    expect(describeCreditEntry(entry({ kind: 'expire', credits: -10 }), t, n)).toBe('credits.describe.expire');
  });

  it('keeps model and note for a charge written before details existed', () => {
    expect(describeCreditEntry(entry({ model: 'platform.model-a', note: 'chat tier=standard in=10 out=5' }), t, n)).toBe(
      'platform.model-a · chat tier=standard in=10 out=5',
    );
  });
});

describe('utcMonth', () => {
  it('formats the UTC month and steps back across a year', () => {
    const date = new Date('2026-01-15T12:00:00Z');
    expect(utcMonth(date)).toBe('2026-01');
    expect(utcMonth(date, 1)).toBe('2025-12');
  });
});
