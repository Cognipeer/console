import { describe, expect, it } from 'vitest';
import { clampLimit, clampSkip } from '@/lib/database/provider/paging';
import { distinctStrings, normalizeBetaAccessCode } from '@/lib/database/provider/normalize';
import { assertUniqueItemIds } from '@/lib/database/provider/evaluationItems';
import { isDuplicateKeyError } from '@/lib/database/mongodb/errors';
import { toIdString, toObjectIdOrThrow } from '@/lib/database/mongodb/docIds';

describe('provider/paging', () => {
  it('clamps limit into [1, max] with a fallback', () => {
    expect(clampLimit(undefined, 50)).toBe(50);
    expect(clampLimit(0, 50)).toBe(1);
    expect(clampLimit(9999, 50)).toBe(200);
    expect(clampLimit(9999, 50, 5000)).toBe(5000);
    expect(clampLimit(7.9, 50)).toBe(7);
  });
  it('clamps skip to a non-negative integer', () => {
    expect(clampSkip(undefined)).toBe(0);
    expect(clampSkip(-3)).toBe(0);
    expect(clampSkip(4.7)).toBe(4);
  });
});

describe('provider/normalize', () => {
  it('normalizes beta codes and dedupes strings', () => {
    expect(normalizeBetaAccessCode('  ab-12 ')).toBe('AB-12');
    expect(distinctStrings(['a', 'a', '', 3, 'b'])).toEqual(['a', 'b']);
  });
});

describe('provider/evaluationItems', () => {
  const item = (id?: string) => ({ id } as never);
  it('rejects repeated ids', () => {
    expect(() => assertUniqueItemIds([item('a'), item('a')])).toThrow(/already exists/);
    expect(() => assertUniqueItemIds([item('a'), item('b')])).not.toThrow();
  });
});

describe('mongodb helpers', () => {
  it('detects duplicate-key codes', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError({ code: 11001 })).toBe(true);
    expect(isDuplicateKeyError({ code: 1 })).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
  it('converts ids', () => {
    expect(toIdString(undefined)).toBe('');
    expect(toIdString('abc')).toBe('abc');
    const hex = 'a'.repeat(24);
    expect(toIdString(toObjectIdOrThrow(hex))).toBe(hex);
    expect(() => toObjectIdOrThrow('nope')).toThrow();
  });
});
