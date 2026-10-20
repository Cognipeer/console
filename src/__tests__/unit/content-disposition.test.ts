/**
 * Unit tests - contentDisposition: the one place a file name from the outside becomes a response header.
 *
 * A name can hold anything: accents, a script the ASCII form cannot spell, quotes, separators, line breaks, a
 * lone surrogate. None of it may end the header value, add a parameter, or make the encoding throw.
 */

import { describe, expect, it } from 'vitest';
import { validateHeaderValue } from 'node:http';
import { contentDisposition } from '@/lib/utils/contentDisposition';

/** `attachment; filename="<fallback>"; filename*=UTF-8''<encoded>` taken apart. */
function parse(header: string) {
  const match = /^(attachment|inline); filename="([^"]*)"; filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]*)$/.exec(header);
  expect(match, header).not.toBeNull();
  return { type: match![1]!, fallback: match![2]!, encoded: match![3]!, name: decodeURIComponent(match![3]!) };
}

describe('contentDisposition', () => {
  it('writes both forms of a plain name', () => {
    expect(contentDisposition('report.pdf', 'attachment')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(contentDisposition('report.pdf', 'inline')).toBe(`inline; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('is an attachment unless told otherwise', () => {
    expect(contentDisposition('a.txt')).toMatch(/^attachment;/);
  });

  it('keeps a Turkish name whole in filename* and spells it in ASCII in the fallback', () => {
    const header = contentDisposition('Çalışma Planı İçin.pdf', 'attachment');
    const { fallback, name } = parse(header);
    expect(name).toBe('Çalışma Planı İçin.pdf');
    expect(fallback).toMatch(/^[\x20-\x7e]+$/);
    // Letters that decompose keep their base letter; the dotless i has none and becomes a placeholder.
    expect(fallback).toBe('Cal_sma Plan_ Icin.pdf');
    expect(header).toContain(`filename*=UTF-8''%C3%87al%C4%B1%C5%9Fma%20Plan%C4%B1%20%C4%B0%C3%A7in.pdf`);
  });

  it('keeps a CJK name whole in filename* and leaves a readable shape in the fallback', () => {
    const { fallback, name } = parse(contentDisposition('报告 2024年.pdf', 'inline'));
    expect(name).toBe('报告 2024年.pdf');
    expect(fallback).toBe('__ 2024_.pdf');
  });

  it('keeps an emoji (a surrogate pair) whole', () => {
    const { name, fallback } = parse(contentDisposition('party 🎉.txt'));
    expect(name).toBe('party 🎉.txt');
    expect(fallback).toBe('party _.txt');
  });

  it('cannot be made to end the header: CR and LF are dropped', () => {
    const header = contentDisposition('evil\r\nSet-Cookie: session=1.txt', 'attachment');
    expect(header).not.toMatch(/[\r\n]/);
    expect(parse(header).name).toBe('evilSet-Cookie: session=1.txt');
    expect(() => validateHeaderValue('Content-Disposition', header)).not.toThrow();
  });

  it('drops every other control character too (NUL, tab, DEL, C1)', () => {
    const header = contentDisposition('a\u0000b\tc\u007fd\u0085e.txt');
    expect(parse(header).name).toBe('abcde.txt');
  });

  it('neutralises quotes, semicolons and percent signs in the fallback so no parameter can be added', () => {
    const header = contentDisposition('a"; filename=evil.exe; x="%41.txt');
    const { fallback, name } = parse(header);
    expect(fallback).not.toMatch(/["%;]/);
    expect(fallback).toBe('a__ filename=evil.exe_ x=__41.txt');
    // The real name travels intact (and encoded, so its quotes and semicolons are data there).
    expect(name).toBe('a"; filename=evil.exe; x="%41.txt');
    // `parse` only matches a header of exactly two parameters: the quoted fallback cannot be closed early.
    expect(header.startsWith('attachment; filename="a__ filename=evil.exe_ x=__41.txt"; filename*=UTF-8\'\'')).toBe(true);
  });

  it('turns path separators into underscores: a name is never a path', () => {
    expect(parse(contentDisposition('../../etc/passwd')).name).toBe('.._.._etc_passwd');
    expect(parse(contentDisposition('C:\\Users\\me\\a.txt')).name).toBe('C:_Users_me_a.txt');
  });

  it('percent-encodes the characters encodeURIComponent leaves alone but the header grammar does not allow', () => {
    const { encoded, name } = parse(contentDisposition("it's (final)*.txt"));
    expect(encoded).toBe('it%27s%20%28final%29%2A.txt');
    expect(name).toBe("it's (final)*.txt");
  });

  it('never throws on a lone surrogate (encodeURIComponent would)', () => {
    const header = contentDisposition('broken\ud83d.txt');
    expect(parse(header).name).toBe('broken\ufffd.txt');
    const low = contentDisposition('broken\ude00.txt');
    expect(parse(low).name).toBe('broken\ufffd.txt');
  });

  it('falls back to "file" when nothing is left of the name', () => {
    for (const name of ['', '   ', '\r\n', undefined as unknown as string, null as unknown as string]) {
      expect(parse(contentDisposition(name)).name).toBe('file');
    }
  });

  it('cuts a very long name by characters, never inside one', () => {
    const long = `${'🎉'.repeat(400)}.txt`;
    const { name } = parse(contentDisposition(long));
    expect(Array.from(name)).toHaveLength(180);
    expect(name.startsWith('🎉')).toBe(true);
    expect(() => encodeURIComponent(name)).not.toThrow();
  });

  it('always produces a value Node accepts as a header, whatever it is given', () => {
    const names = ['', 'x', 'é', '日本語', 'a\r\nb', '"', '\\', ';', 'a;b', '\ud800', '\udfff', '😀'.repeat(300), '\u0000', '\u2028\u2029'];
    for (const name of names) {
      for (const type of ['attachment', 'inline'] as const) {
        const header = contentDisposition(name, type);
        expect(() => validateHeaderValue('Content-Disposition', header), JSON.stringify(name)).not.toThrow();
        expect(header, JSON.stringify(name)).not.toMatch(/[^\x20-\x7e]/);
      }
    }
  });
});
