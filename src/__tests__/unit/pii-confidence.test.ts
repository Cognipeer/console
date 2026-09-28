import { describe, it, expect } from 'vitest';
import { findContextWord, applyContextBoost, noisyOr, foldGeneral } from '@/lib/services/pii/confidence';

describe('foldGeneral — the Turkish "I" problem', () => {
  it('folds an ASCII "I" the English way, unlike tr-locale folding', () => {
    expect(foldGeneral('NINE')).toBe('nine');
    // Sanity check the bug this guards against actually exists in the platform:
    expect('NINE'.toLocaleLowerCase('tr')).toBe('nıne');
  });

  it('folds a Turkish dotted İ without introducing a combining mark', () => {
    const folded = foldGeneral('İstanbul');
    expect(folded).toBe('istanbul');
    expect([...folded]).toHaveLength(8); // no extra combining-dot codepoint
  });
});

describe('findContextWord', () => {
  it('finds a context word within the window, case-insensitively', () => {
    const text = 'Vergi No: 1234567890 numaralı hesap.';
    const hit = findContextWord(text, 10, 20, ['vergi no']);
    expect(hit).toBe('vergi no');
  });

  it('does not find a context word outside the window', () => {
    const prefix = 'vergi no '.padEnd(200, 'x');
    const text = `${prefix}1234567890`;
    const hit = findContextWord(text, text.length - 10, text.length, ['vergi no']);
    expect(hit).toBeNull();
  });

  it('is unaffected by an all-caps English word colliding with the Turkish-I fold', () => {
    // "NINE" must not spuriously match a context list, nor crash, when
    // folded generically instead of with tr-locale rules.
    const hit = findContextWord('the NINE elements', 4, 8, ['vergi no', 'phone']);
    expect(hit).toBeNull();
  });

  it('returns null for an empty or missing word list', () => {
    expect(findContextWord('anything', 0, 3, [])).toBeNull();
    expect(findContextWord('anything', 0, 3, undefined)).toBeNull();
  });
});

describe('applyContextBoost', () => {
  it('leaves the score untouched when nothing matched', () => {
    expect(applyContextBoost(0.4, false)).toBe(0.4);
  });

  it('adds a fixed boost when something matched, capped below 1', () => {
    expect(applyContextBoost(0.4, true)).toBeCloseTo(0.75, 5);
    expect(applyContextBoost(0.9, true)).toBeLessThanOrEqual(0.99);
  });
});

describe('noisyOr', () => {
  it('returns 0 for no scores', () => {
    expect(noisyOr([])).toBe(0);
  });

  it('returns the single score unchanged for one input', () => {
    expect(noisyOr([0.4])).toBeCloseTo(0.4, 5);
  });

  it('compounds two weak-but-independent signals into a stronger one', () => {
    // 1 - (1-0.4)*(1-0.5) = 1 - 0.6*0.5 = 0.7
    expect(noisyOr([0.4, 0.5])).toBeCloseTo(0.7, 5);
  });

  it('never exceeds 1 even with many high scores', () => {
    expect(noisyOr([0.9, 0.9, 0.9, 0.9])).toBeLessThanOrEqual(1);
  });
});
