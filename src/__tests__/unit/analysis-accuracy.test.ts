/**
 * Unit tests — analysis reference-based accuracy scoring.
 */

import { describe, it, expect } from 'vitest';
import { scoreAccuracy, valuesMatch } from '@/lib/services/analysis/accuracy';
import type { FieldSet } from '@/lib/services/analysis/types';

const FIELDS: FieldSet = [
  { key: 'intent', type: 'enum', enumValues: ['billing', 'support'] },
  { key: 'resolved', type: 'boolean' },
  { key: 'amount', type: 'number' },
];

describe('valuesMatch', () => {
  it('compares numbers regardless of string/number form', () => {
    expect(valuesMatch('100', 100, 'number')).toBe(true);
    expect(valuesMatch(100, 101, 'number')).toBe(false);
  });
  it('compares strings case/space-insensitively', () => {
    expect(valuesMatch('Billing ', 'billing', 'string')).toBe(true);
  });
  it('compares booleans across representations', () => {
    expect(valuesMatch('yes', true, 'boolean')).toBe(true);
    expect(valuesMatch('no', true, 'boolean')).toBe(false);
  });
});

describe('scoreAccuracy', () => {
  it('only compares fields present in the reference', () => {
    const r = scoreAccuracy(
      { intent: 'billing', resolved: true, amount: 50 },
      { intent: 'Billing', resolved: 'yes' },
      FIELDS,
    );
    expect(r.comparedCount).toBe(2);
    expect(r.score).toBe(1);
    expect(r.perField.intent.match).toBe(true);
    expect(r.perField.amount).toBeUndefined();
  });
  it('computes a partial score and flags mismatches', () => {
    const r = scoreAccuracy(
      { intent: 'support', resolved: true },
      { intent: 'billing', resolved: true },
      FIELDS,
    );
    expect(r.comparedCount).toBe(2);
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.perField.intent.match).toBe(false);
    expect(r.perField.resolved.match).toBe(true);
  });
  it('returns score 1 when there is nothing to compare', () => {
    const r = scoreAccuracy({ intent: 'billing' }, {}, FIELDS);
    expect(r.comparedCount).toBe(0);
    expect(r.score).toBe(1);
  });
});
