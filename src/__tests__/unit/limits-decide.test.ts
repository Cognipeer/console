import { describe, expect, it } from 'vitest';
import { decideLimit } from '@/lib/limits/decide';

describe('decideLimit', () => {
  const base = { kind: 'concurrency' as const, dimension: 'agent' };

  it.each([
    ['off', 5, 5, 'allowed', true],
    ['shadow', 5, 5, 'would_refuse', true],
    ['on', 5, 5, 'refused', false],
    ['on', 5, 4, 'allowed', true],
    ['shadow', 5, 4, 'allowed', true],
  ] as const)('mode %s limit %i used %i -> %s', (mode, limit, used, outcome, allowed) => {
    const d = decideLimit({ ...base, mode, limit, used });
    expect(d.outcome).toBe(outcome);
    expect(d.allowed).toBe(allowed);
  });

  it('no limit never refuses', () => {
    expect(decideLimit({ ...base, mode: 'on', used: 1_000_000 }).outcome).toBe('allowed');
  });

  it('limit 0 allows nothing', () => {
    expect(decideLimit({ ...base, mode: 'on', limit: 0, used: 0 }).outcome).toBe('refused');
  });

  it('uses amount', () => {
    expect(decideLimit({ ...base, mode: 'on', limit: 10, used: 6, amount: 4 }).allowed).toBe(true);
    expect(decideLimit({ ...base, mode: 'on', limit: 10, used: 6, amount: 5 }).allowed).toBe(false);
  });

  it('carries retry hints only when over', () => {
    const resetAt = new Date(0);
    const over = decideLimit({ ...base, mode: 'on', limit: 1, used: 1, retryAfterMs: 7, resetAt });
    expect(over.retryAfterMs).toBe(7);
    expect(over.resetAt).toBe(resetAt);
    const ok = decideLimit({ ...base, mode: 'on', limit: 2, used: 1, retryAfterMs: 7, resetAt });
    expect(ok.retryAfterMs).toBeUndefined();
  });
});
