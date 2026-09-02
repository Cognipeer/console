/**
 * `customPatterns` used to be stored with only an `Array.isArray` check, so an
 * uncompilable or catastrophically-backtracking pattern was accepted at save
 * time and only surfaced as a silently `degraded` scan. The save path now
 * refuses exactly what the detector would skip.
 */
import { describe, it, expect } from 'vitest';
import { parseCustomPatternsInput, MAX_CUSTOM_PATTERNS_PER_POLICY } from '@/lib/services/pii';

const ok = { id: 'p1', categoryId: 'customer_id', label: 'Customer id', pattern: 'CUST-\\d{6}', enabled: true };

describe('parseCustomPatternsInput', () => {
  it('passes an absent field through untouched', () => {
    expect(parseCustomPatternsInput(undefined)).toEqual({});
  });

  it('accepts a well-formed list', () => {
    const res = parseCustomPatternsInput([ok]);
    expect(res.error).toBeUndefined();
    expect(res.patterns).toHaveLength(1);
  });

  it('rejects non-arrays and non-object entries with the index', () => {
    expect(parseCustomPatternsInput('x').error).toMatch(/must be an array/);
    expect(parseCustomPatternsInput([42]).error).toMatch(/customPatterns\[0\] must be an object/);
    expect(parseCustomPatternsInput([{ ...ok, pattern: 7 }]).error).toMatch(/\[0\]\.pattern must be a string/);
  });

  it('rejects a pattern the detector would refuse (does not compile / over the source cap)', () => {
    expect(parseCustomPatternsInput([{ ...ok, pattern: '(' }]).error).toMatch(/does not compile/);
    expect(parseCustomPatternsInput([{ ...ok, pattern: 'a'.repeat(600) }]).error).toMatch(/over the .* character limit/);
    expect(parseCustomPatternsInput([{ ...ok, pattern: '' }]).error).toMatch(/empty/);
  });

  it('caps the number of patterns per policy', () => {
    const many = Array.from({ length: MAX_CUSTOM_PATTERNS_PER_POLICY + 1 }, (_, i) => ({ ...ok, id: `p${i}` }));
    expect(parseCustomPatternsInput(many).error).toMatch(/at most/);
  });
});
