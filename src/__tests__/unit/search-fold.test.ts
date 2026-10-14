/**
 * The case folding the search boxes share (browser filters, pickers, and the
 * server's search ranking): English and Turkish text meet at the same letters.
 */
import { describe, expect, it } from 'vitest';
import { foldedRegexSource, foldSearchText, includesFolded } from '@/lib/shared/searchFold';

describe('foldSearchText', () => {
  it('folds the case of the Turkish letter pairs', () => {
    expect(foldSearchText('ŞULE')).toBe(foldSearchText('şule'));
    expect(foldSearchText('ĞÜŞİÖÇ')).toBe(foldSearchText('ğüşiöç'));
    expect(foldSearchText('Çalışıyor')).toBe(foldSearchText('ÇALIŞIYOR'));
  });

  it('makes the four letters of the Turkish i family one letter', () => {
    // The dotted capital used to lower-case to "i" + a combining dot, which a typed "istanbul" never matched.
    expect('İstanbul'.toLowerCase().includes('istanbul')).toBe(false);
    expect(foldSearchText('İstanbul')).toBe('istanbul');
    // "Isparta" is written with a dotless capital I; the same word typed on an English keyboard still finds it.
    expect(foldSearchText('ISPARTA')).toBe(foldSearchText('ısparta'));
    expect(foldSearchText('Isparta')).toBe(foldSearchText('isparta'));
    expect(foldSearchText('ISPARTA')).toBe(foldSearchText('isparta'));
  });

  it('treats a decomposed dotted capital I like the composed one', () => {
    expect(foldSearchText('İstanbul')).toBe('istanbul');
    expect(foldSearchText('i̇stanbul')).toBe('istanbul');
  });

  it('leaves English text with the plain lower-casing', () => {
    expect(foldSearchText('GPT-4o Mini')).toBe('gpt-4o mini');
    expect(foldSearchText('')).toBe('');
  });

  it('does not strip accents: "sule" is not "şule"', () => {
    // The directory searches on the server do not strip them either; a list must not match differently from the search that fed it.
    expect(foldSearchText('Şule')).not.toBe(foldSearchText('sule'));
  });
});

describe('includesFolded', () => {
  it('finds a Turkish name whatever the case of the typed words', () => {
    expect(includesFolded('Müşteri İlişkileri', 'ilişki')).toBe(true);
    expect(includesFolded('Müşteri İlişkileri', 'ILIŞKI')).toBe(true);
    expect(includesFolded('Müşteri İlişkileri', 'MÜŞTERİ')).toBe(true);
    expect(includesFolded('Işık Bilgi İşlem', 'ışık')).toBe(true);
    expect(includesFolded('Işık Bilgi İşlem', 'isik')).toBe(false);
  });

  it('matches everything for an empty needle and nothing for a missing haystack', () => {
    expect(includesFolded('anything', '')).toBe(true);
    expect(includesFolded('anything', '   ')).toBe(true);
    expect(includesFolded(undefined, 'a')).toBe(false);
    expect(includesFolded(null, 'a')).toBe(false);
    expect(includesFolded('', 'a')).toBe(false);
  });

  it('ignores blanks around the needle', () => {
    expect(includesFolded('Retail branches', '  branches ')).toBe(true);
  });
});

describe('foldedRegexSource', () => {
  const matches = (needle: string, haystack: string) => new RegExp(foldedRegexSource(needle), 'i').test(haystack);

  it('makes the Turkish i family interchangeable in a pattern, like the folding does in text', () => {
    expect(matches('ISPARTA', 'ısparta')).toBe(true);
    expect(matches('ısparta', 'Isparta Bölgesi')).toBe(true);
    expect(matches('istanbul', 'İstanbul')).toBe(true);
    expect(matches('İSTANBUL', 'istanbul')).toBe(true);
    expect(matches('şube', 'ŞUBE')).toBe(true);
    expect(matches('ışık', 'IŞIK')).toBe(true);
  });

  it('agrees with foldSearchText on what matches', () => {
    for (const [needle, haystack] of [['ISPARTA', 'ısparta'], ['istanbul', 'İstanbul'], ['sule', 'Şule'], ['ankara', 'Antalya']]) {
      expect(matches(needle!, haystack!), `${needle} / ${haystack}`).toBe(includesFolded(haystack, needle!));
    }
  });

  it('escapes what a regular expression would read as syntax', () => {
    expect(matches('a.b', 'a.b')).toBe(true);
    expect(matches('a.b', 'axb')).toBe(false);
    expect(matches('(x)', 'say (x) now')).toBe(true);
    expect(matches('a+b', 'a+b')).toBe(true);
    expect(matches('[i]', 'a[I]b')).toBe(true);
    expect(() => new RegExp(foldedRegexSource('*?\\^$|{}'))).not.toThrow();
  });
});
