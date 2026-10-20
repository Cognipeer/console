/**
 * The keys of uploaded files:
 *
 *  - a key the console generates keeps its NAME (the last path segment) within what a store and a file system take,
 *    however long the file's name is (the Upload screen shows the same key; a test holds the two together);
 *  - a destination (`keyHint`, `folder`) has no control character (U+007F included) and no unpaired surrogate;
 *  - only a hint that is neither empty nor a folder names a whole key.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseRelativeFileKey,
  composeUploadKeyHint,
  generateFileRelativeKey,
  namesWholeKey,
} from '@/lib/services/files/fileService';

const UNIQUE = /-\d{13}-[0-9a-f]{8}/;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const lastSegment = (key: string) => key.split('/').pop()!;
/** A string is well-formed when it round-trips through UTF-8. */
const wellFormed = (text: string) => Buffer.from(text, 'utf8').toString('utf8') === text;

describe('generateFileRelativeKey', () => {
  it('is the stem, a unique part and the extension for a name that fits', () => {
    expect(generateFileRelativeKey('Report Q3.PDF')).toMatch(new RegExp(`^report-q3${UNIQUE.source}\\.PDF$`));
    expect(generateFileRelativeKey('noextension')).toMatch(new RegExp(`^noextension${UNIQUE.source}$`));
    expect(generateFileRelativeKey('şirket raporu.pdf')).toMatch(new RegExp(`^sirket-raporu${UNIQUE.source}\\.pdf$`));
  });

  it('spells accented letters in ASCII instead of dropping them, and falls back to "file" for a script it cannot spell', () => {
    for (const [name, stem] of [
      ['Şubat Özeti.pdf', 'subat-ozeti'],
      ['İstanbul ışık GÜNLÜĞÜ.txt', 'istanbul-isik-gunlugu'],
      ['Çiçek ağacı.docx', 'cicek-agaci'],
      ['Straße Æble Øre Łódź.md', 'strasse-aeble-ore-lodz'],
      ['Ｆｕｌｌ ｗｉｄｔｈ.csv', 'full-width'],
      ['報告書.pdf', 'file'],
    ]) {
      expect(generateFileRelativeKey(name), name).toMatch(new RegExp(`^${stem}${UNIQUE.source}\\.`));
    }
  });

  // A file name is kept to 255 characters before a key is made of it (`normalizeFileName`), so these are the longest names.
  it.each([
    ['a long stem', `${'x'.repeat(250)}.md`],
    ['a long stem and a short extension', `${'y'.repeat(251)}.md`],
    ['a name that is only a long stem', 'x'.repeat(300)],
    ['a long name made of words', `${'quarterly-report-'.repeat(13)}final.pdf`],
    ['a long name with spaces and capitals', `${'Q3 Board Meeting Minutes '.repeat(9)}.docx`],
  ])('keeps the name within 200 bytes for %s', (_label, name) => {
    const key = generateFileRelativeKey(name);
    expect(bytes(key)).toBeLessThanOrEqual(200);
    expect(key).toMatch(UNIQUE);
    // The unique part is what keeps two uploads apart: it is never the part that is cut.
    expect(generateFileRelativeKey(name)).not.toBe(key);
  });

  it('cuts the stem to the room that is left, and no more', () => {
    // 200 bytes: the unique part is 23 and the extension 3.
    const key = generateFileRelativeKey(`${'x'.repeat(250)}.md`);
    expect(key).toMatch(new RegExp(`^x{174}${UNIQUE.source}\\.md$`));
    expect(bytes(key)).toBe(200);
    // A name that fits is not touched, right up to the limit.
    const fits = generateFileRelativeKey(`${'x'.repeat(174)}.md`);
    expect(fits).toMatch(new RegExp(`^x{174}${UNIQUE.source}\\.md$`));
  });

  it('cuts the stem, keeps the extension and the unique part, and leaves no dash where it cut', () => {
    // The stem is cut after 172 characters, where the pattern has a dash: that dash goes too.
    const key = generateFileRelativeKey(`${'abc-'.repeat(60)}.docx`);
    expect(key).toMatch(new RegExp(`^(?:abc-){42}abc${UNIQUE.source}\\.docx$`));
    expect(bytes(key)).toBeLessThanOrEqual(200);
  });

  it('cuts an extension of more than 32 bytes between characters, never through one', () => {
    const long = `report.${'日'.repeat(60)}`;
    const key = generateFileRelativeKey(long);
    const extension = key.slice(key.search(/\.[^.]*$/));
    expect(bytes(extension)).toBeLessThanOrEqual(32);
    expect(wellFormed(key)).toBe(true);
    expect(extension).toMatch(/^\.日+$/);
    expect(bytes(key)).toBeLessThanOrEqual(200);
  });

  it('drops an unpaired surrogate from the extension: the key is text a store can write', () => {
    const key = generateFileRelativeKey('photo.\ud800jpg');
    expect(wellFormed(key)).toBe(true);
    expect(key).toMatch(new RegExp(`^photo${UNIQUE.source}\\.jpg$`));
  });

  it('keeps a pair of surrogates (an emoji) in the extension', () => {
    const key = generateFileRelativeKey('photo.😀');
    expect(key.endsWith('.😀')).toBe(true);
    expect(wellFormed(key)).toBe(true);
  });

  it('falls back to a plain stem when nothing of the name can be used', () => {
    expect(generateFileRelativeKey('🎉🎉.png')).toMatch(new RegExp(`^file${UNIQUE.source}\\.png$`));
  });

  it('is still unique: two keys made of the same long name differ', () => {
    const name = `${'z'.repeat(250)}.txt`;
    const keys = new Set(Array.from({ length: 20 }, () => generateFileRelativeKey(name)));
    expect(keys.size).toBe(20);
  });
});

describe('chooseRelativeFileKey', () => {
  it('stores a file with a long name under a name that fits, in a folder or at the root', () => {
    const name = `${'n'.repeat(250)}.pdf`;
    const atRoot = chooseRelativeFileKey(undefined, name);
    const inFolder = chooseRelativeFileKey('reports/2026/', name);
    expect(bytes(atRoot)).toBeLessThanOrEqual(200);
    expect(inFolder.startsWith('reports/2026/')).toBe(true);
    expect(bytes(lastSegment(inFolder))).toBeLessThanOrEqual(200);
    expect(atRoot.endsWith('.pdf')).toBe(true);
  });

  it('leaves the key a caller names exactly as it is, however long: the store judges it', () => {
    const hint = `reports/${'k'.repeat(300)}.pdf`;
    expect(chooseRelativeFileKey(hint, 'ignored.pdf')).toBe(hint);
  });
});

describe('namesWholeKey', () => {
  it.each([
    ['a file name', 'report.pdf', true],
    ['a path', 'reports/2026/q1.pdf', true],
    ['a path with a leading slash', '/reports/q1.pdf', true],
    ['a name with space around it', '  report.pdf  ', true],
    ['no hint', undefined, false],
    ['an empty hint', '', false],
    ['a hint of spaces', '   ', false],
    ['a folder', 'reports/2026/', false],
    ['a folder with a leading slash', '/reports/', false],
    ['the root', '/', false],
    ['the root, written twice', '//', false],
  ])('%s', (_label, hint, expected) => {
    expect(namesWholeKey(hint)).toBe(expected);
  });

  it('agrees with chooseRelativeFileKey about which hints are kept as they are', () => {
    for (const hint of ['report.pdf', 'a/b.txt', '/lead.txt', '  spaced.txt ', 'folder/', '/', '   ', '']) {
      const kept = chooseRelativeFileKey(hint, 'x.txt') === hint.trim().replace(/^\/+/, '');
      expect(namesWholeKey(hint), JSON.stringify(hint)).toBe(kept && hint.trim().replace(/^\/+/, '') !== '');
    }
  });
});

describe('composeUploadKeyHint', () => {
  it.each([
    ['DEL', 'a\u007fb'],
    ['NUL', 'a\u0000b'],
    ['a tab', 'a\tb'],
  ])('refuses %s as a control character, in a keyHint and in a folder', (_label, text) => {
    expect(composeUploadKeyHint({ keyHint: text })).toEqual({ error: 'keyHint cannot contain control characters.' });
    expect(composeUploadKeyHint({ folder: text })).toEqual({ error: 'folder cannot contain control characters.' });
  });

  it.each([
    ['a high surrogate alone', 'a\ud800b'],
    ['a low surrogate alone', 'a\udc00b'],
    ['a high surrogate at the end', 'name\ud83d'],
    ['two high surrogates', '\ud83d\ud83d'],
    ['a low surrogate before a high one', '\ude00\ud83d'],
  ])('refuses %s, in a keyHint and in a folder', (_label, text) => {
    expect(composeUploadKeyHint({ keyHint: text })).toEqual({ error: 'keyHint cannot contain unpaired surrogate characters.' });
    expect(composeUploadKeyHint({ folder: text })).toEqual({ error: 'folder cannot contain unpaired surrogate characters.' });
  });

  it('accepts text in any language, with pairs of surrogates (emoji) in it', () => {
    expect(composeUploadKeyHint({ keyHint: 'raporlar/Şirket 報告書 😀.pdf' })).toEqual({ keyHint: 'raporlar/Şirket 報告書 😀.pdf' });
    expect(composeUploadKeyHint({ folder: '🎉/party' })).toEqual({ keyHint: '🎉/party/' });
  });

  it('keeps asking for the other rules first', () => {
    expect(composeUploadKeyHint({ keyHint: '../\ud800' })).toEqual({ error: 'keyHint cannot contain "." or ".." segments.' });
    expect(composeUploadKeyHint({ keyHint: 5 })).toEqual({ error: 'keyHint must be text.' });
  });
});
