import { describe, it, expect } from 'vitest';
import { AhoCorasick, isWordBoundaryMatch, resolveAcOverlaps } from '@/lib/services/pii/ahoCorasick';

describe('AhoCorasick', () => {
  it('finds every pattern in a single pass, including overlapping ones', () => {
    const ac = new AhoCorasick(['he', 'she', 'his', 'hers']);
    const matches = ac.search('ushers');
    // "she" @1-4, "he" @2-4, "hers" @2-6
    const spans = matches.map((m) => [m.start, m.end, m.patternIndex]).sort();
    expect(spans).toEqual([
      [1, 4, 1], // she
      [2, 4, 0], // he
      [2, 6, 3], // hers
    ]);
  });

  it('returns nothing for text with no match', () => {
    const ac = new AhoCorasick(['foo', 'bar']);
    expect(ac.search('completely unrelated text')).toEqual([]);
  });

  it('handles an empty pattern list', () => {
    const ac = new AhoCorasick([]);
    expect(ac.search('anything')).toEqual([]);
  });

  it('matches multi-word patterns verbatim (used for titles like "Prof. Dr.")', () => {
    const ac = new AhoCorasick(['prof. dr.', 'ltd. şti.']);
    const text = 'unvanı prof. dr. olan kişi';
    const matches = ac.search(text);
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0].start, matches[0].end)).toBe('prof. dr.');
  });
});

describe('isWordBoundaryMatch', () => {
  it('accepts a match at a real word boundary', () => {
    const text = 'Can geldi.';
    expect(isWordBoundaryMatch(text, 0, 3)).toBe(true); // "Can"
  });

  it('rejects a match glued to a letter on either side', () => {
    const text = 'Canada';
    expect(isWordBoundaryMatch(text, 0, 3)).toBe(false); // "Can" inside "Canada"
  });
});

describe('resolveAcOverlaps', () => {
  it('keeps the longest match at a start position and drops shorter overlaps, then resumes after it ends', () => {
    // 'ab'@1-3, 'abc'@1-4 (same start, longer wins), 'de'@4-6 (starts exactly where 'abc' ends, kept).
    const matches = [
      { start: 1, end: 3, patternIndex: 0 }, // ab
      { start: 1, end: 4, patternIndex: 1 }, // abc
      { start: 4, end: 6, patternIndex: 2 }, // de
    ];
    expect(resolveAcOverlaps(matches)).toEqual([
      { start: 1, end: 4, patternIndex: 1 },
      { start: 4, end: 6, patternIndex: 2 },
    ]);
  });

  it('drops a match that starts inside an already-kept (longer) match, even if it extends further right', () => {
    // Deliberately documents the greedy (not interval-maximizing) semantics:
    // 'she'@1-4 is kept (longest at start=1); 'hers'@2-6 starts inside it and
    // is dropped even though it covers more text overall.
    const matches = [
      { start: 2, end: 4, patternIndex: 0 }, // he
      { start: 1, end: 4, patternIndex: 1 }, // she
      { start: 2, end: 6, patternIndex: 2 }, // hers
    ];
    expect(resolveAcOverlaps(matches)).toEqual([{ start: 1, end: 4, patternIndex: 1 }]);
  });
});
