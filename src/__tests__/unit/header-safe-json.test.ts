/**
 * `toHeaderSafeJson`: JSON for a response header value (printable ASCII only), that still parses back to the original.
 */
import { validateHeaderValue } from 'node:http';
import { describe, expect, it } from 'vitest';
import { toHeaderSafeJson } from '@/lib/utils/headerSafeJson';

const PRINTABLE_ASCII = /^[ -~]*$/;

describe('toHeaderSafeJson', () => {
  it('leaves printable ASCII exactly as JSON.stringify writes it', () => {
    const value = { name: 'report.pdf', tags: ['a', 'b'], size: 12, ok: true, none: null, quote: 'say "hi"', slash: 'a\\b/c' };
    expect(toHeaderSafeJson(value)).toBe(JSON.stringify(value));
  });

  it('escapes the Turkish letters per character', () => {
    expect(toHeaderSafeJson({ title: 'şğıİ' })).toBe('{"title":"\\u015f\\u011f\\u0131\\u0130"}');
  });

  it('escapes CJK text', () => {
    expect(toHeaderSafeJson({ title: '報告書' })).toBe('{"title":"\\u5831\\u544a\\u66f8"}');
  });

  it('writes an emoji as the escapes of its surrogate pair', () => {
    expect(toHeaderSafeJson('😀')).toBe('"\\ud83d\\ude00"');
  });

  it('escapes Latin-1 letters too (a header would carry them, a proxy may not)', () => {
    expect(toHeaderSafeJson('ünï')).toBe('"\\u00fcn\\u00ef"');
  });

  it('escapes DEL, the line and paragraph separators and control characters', () => {
    const text = `a\u007fb c d\u0000e\u001ff\n\t`;
    const json = toHeaderSafeJson(text);
    expect(json).toBe('"a\\u007fb\\u2028c\\u2029d\\u0000e\\u001ff\\n\\t"');
    expect(PRINTABLE_ASCII.test(json)).toBe(true);
    expect(JSON.parse(json)).toBe(text);
  });

  it('keeps a lone surrogate escaped, without losing it', () => {
    const lone = `x\ud800y`;
    const json = toHeaderSafeJson(lone);
    expect(PRINTABLE_ASCII.test(json)).toBe(true);
    expect(JSON.parse(json)).toBe(lone);
  });

  it('produces printable ASCII that parses back to the same value, keys and nesting included', () => {
    const metadata = {
      'Müşteri Adı': 'Çağrı Öğütçü',
      title: 'Şirket Bütçesi İçin ığİ',
      jp: '日本語のメタデータ',
      cn: '报告书',
      emoji: 'ok 👍🏽 🇹🇷',
      nested: { list: ['ş', 1, true, null, { 'ğ': 'ı' }], empty: {}, text: '' },
      mixed: 'a "quoted" \\ back\\slash\nline',
    };
    const json = toHeaderSafeJson(metadata);
    expect(PRINTABLE_ASCII.test(json)).toBe(true);
    expect(JSON.parse(json)).toEqual(metadata);
  });

  it('is a value Node accepts as a header, where the plain JSON text of the same value is refused', () => {
    const metadata = { title: 'Şirket Bütçesi', owner: '山田' };
    expect(() => validateHeaderValue('x-file-metadata', JSON.stringify(metadata))).toThrow(/Invalid character/);
    expect(() => validateHeaderValue('x-file-metadata', toHeaderSafeJson(metadata))).not.toThrow();
  });

  it('writes other JSON values the way JSON.stringify does', () => {
    expect(toHeaderSafeJson(null)).toBe('null');
    expect(toHeaderSafeJson(42)).toBe('42');
    expect(toHeaderSafeJson(true)).toBe('true');
    expect(toHeaderSafeJson([])).toBe('[]');
    expect(toHeaderSafeJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(toHeaderSafeJson(new Date('2026-10-19T00:00:00.000Z'))).toBe('"2026-10-19T00:00:00.000Z"');
  });

  it('throws for what has no JSON text, so a caller that must not fail the response can leave the header out', () => {
    expect(() => toHeaderSafeJson(undefined)).toThrow(TypeError);
    expect(() => toHeaderSafeJson(() => 1)).toThrow(TypeError);
    expect(() => toHeaderSafeJson(Symbol('s'))).toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toHeaderSafeJson(circular)).toThrow(TypeError);
    expect(() => toHeaderSafeJson({ big: BigInt(1) })).toThrow(TypeError);
  });
});
