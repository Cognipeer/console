/**
 * What of a host's `params._meta` is kept for the MCP request log: bounded,
 * flat, free of untrusted keys, and never carrying coordinates.
 */

import { describe, expect, it } from 'vitest';
import { boundClientMeta } from '@/lib/services/mcp/clientMeta';

const bound = (raw: unknown, maxBytes = 100_000) => boundClientMeta(raw, { maxBytes });

describe('boundClientMeta', () => {
  it('keeps what a host sends as it is when it is small and flat', () => {
    const meta = {
      'openai/subject': 'v1/abc123',
      'openai/locale': 'en-US',
      'openai/userAgent': 'ChatGPT/1.2025.043',
      count: 3,
      beta: true,
      nothing: null,
    };
    expect(bound(meta)).toEqual(meta);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'meta'],
    ['a number', 7],
    ['a boolean', true],
    ['an array', [{ a: 1 }]],
  ])('stores nothing when _meta is %s', (_label, raw) => {
    expect(bound(raw)).toBeUndefined();
  });

  it('stores nothing when nothing is left after cleaning', () => {
    expect(bound({})).toBeUndefined();
    expect(bound({ progressToken: 'p-1' })).toBeUndefined();
    expect(bound({ '   ': 'blank key', undef: undefined })).toBeUndefined();
  });

  it('drops the protocol key progressToken and keeps the rest', () => {
    expect(bound({ progressToken: 'p-1', 'openai/session': 's-1' })).toEqual({ 'openai/session': 's-1' });
  });

  describe('untrusted keys', () => {
    it('never carries __proto__, constructor or prototype', () => {
      const raw = JSON.parse('{"__proto__":{"polluted":true},"constructor":"x","prototype":"y","ok":1}');
      const result = bound(raw)!;
      expect(Object.keys(result)).toEqual(['ok']);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('applies the same rule inside a nested object', () => {
      const raw = JSON.parse('{"host":{"__proto__":{"polluted":true},"constructor":"x","name":"h"}}');
      const result = bound(raw) as { host: Record<string, unknown> };
      expect(Object.keys(result.host)).toEqual(['name']);
    });

    it('judges a key after it is cleaned', () => {
      expect(bound(JSON.parse('{" __proto__ ":1,"\\nconstructor":2}'))).toBeUndefined();
    });
  });

  describe('control characters', () => {
    it('replaces them in keys and string values', () => {
      const result = bound({ 'a\r\nb': 'line1\nline2\u0000end' })!;
      expect(result).toEqual({ 'a  b': 'line1 line2 end' });
    });

    it('replaces C1 controls, line separators and bidi overrides, which could spoof the log view', () => {
      const result = bound({ 'k\u0085\u202ey': 'a\u0085b\u202ec\u2028d\u2066e\u2069f' })!;
      expect(result).toEqual({ 'k  y': 'a b c d e f' });
    });

    it('trims a key', () => {
      expect(bound({ '  spaced  ': 1 })).toEqual({ spaced: 1 });
    });
  });

  describe('size bounds', () => {
    it('cuts a key at 128 characters', () => {
      const result = bound({ [`k${'x'.repeat(300)}`]: 1 })!;
      const [key] = Object.keys(result);
      expect(key).toHaveLength(128);
    });

    it('cuts a string value at 256 characters', () => {
      const result = bound({ note: 'n'.repeat(1_000) })!;
      expect(result.note).toHaveLength(256);
    });

    it('never cuts an emoji in half: a lone surrogate would not survive a JSON store', () => {
      const value = `${'a'.repeat(255)}😀`;
      const result = bound({ note: value, [`${'k'.repeat(127)}😀`]: 1 })!;
      expect(result.note).toBe(`${'a'.repeat(255)}\ufffd`);
      expect(Object.keys(result)[1]).toBe(`${'k'.repeat(127)}\ufffd`);
      // A lone half the peer sent on its own is replaced the same way.
      expect(bound({ x: 'a\ud800b' })).toEqual({ x: 'a\ufffdb' });
      expect(JSON.stringify(result)).not.toMatch(/\\ud[89ab]/i);
    });

    it('keeps at most 32 keys and drops the rest', () => {
      const raw = Object.fromEntries(Array.from({ length: 80 }, (_v, i) => [`k${i}`, i]));
      const keys = Object.keys(bound(raw)!);
      expect(keys).toHaveLength(32);
      expect(keys[0]).toBe('k0');
      expect(keys[31]).toBe('k31');
    });

    it('applies the key cap to a nested object too', () => {
      const raw = { inner: Object.fromEntries(Array.from({ length: 80 }, (_v, i) => [`k${i}`, i])) };
      expect(Object.keys((bound(raw) as { inner: object }).inner)).toHaveLength(32);
    });
  });

  describe('structure', () => {
    it('keeps a nested object one level deep, with the same rules for its entries', () => {
      const result = bound({
        client: { name: 'ChatGPT', 'bad\nkey': 'a\tb', big: 'z'.repeat(500), n: 2, ok: false },
      }) as { client: Record<string, unknown> };
      expect(result.client.name).toBe('ChatGPT');
      expect(result.client['bad key']).toBe('a b');
      expect(result.client.big).toHaveLength(256);
      expect(result.client).toMatchObject({ n: 2, ok: false });
    });

    it('turns anything deeper into a short marker', () => {
      const result = bound({ a: { b: { c: { d: 1 } } } }) as { a: Record<string, unknown> };
      expect(result).toEqual({ a: { b: '[object]' } });
    });

    it('turns an array into a marker, at the top and one level down', () => {
      expect(bound({ list: [1, 2, 3], a: { list: [{ x: 1 }] } })).toEqual({
        list: '[array]',
        a: { list: '[array]' },
      });
    });

    it('drops values JSON cannot carry', () => {
      const result = bound({
        fn: () => 1,
        big: BigInt(5),
        inf: Number.POSITIVE_INFINITY,
        nan: Number.NaN,
        ok: 1,
      });
      expect(result).toEqual({ ok: 1 });
    });
  });

  describe('location precision', () => {
    it('keeps the coordinate keys of a nested object but not their values', () => {
      const result = bound({
        'openai/userLocation': {
          city: 'Istanbul',
          country: 'TR',
          latitude: 41.0082,
          longitude: 28.9784,
          Lat: 41.0082,
          LNG: 28.9784,
          lon: '28.9784',
        },
      }) as { 'openai/userLocation': Record<string, unknown> };
      expect(result['openai/userLocation']).toEqual({
        city: 'Istanbul',
        country: 'TR',
        latitude: '[redacted]',
        longitude: '[redacted]',
        Lat: '[redacted]',
        LNG: '[redacted]',
        lon: '[redacted]',
      });
    });

    it('does not let a structured value stand in for a coordinate', () => {
      const result = bound({ place: { latitude: { deg: 41, min: 0 } } });
      expect(result).toEqual({ place: { latitude: '[redacted]' } });
    });

    it('applies at the top level as well', () => {
      expect(bound({ latitude: 41.0082 })).toEqual({ latitude: '[redacted]' });
    });
  });

  describe('total size', () => {
    const entries = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_v, i) => [`key${String(i).padStart(2, '0')}`, 'v'.repeat(100)]));

    it('leaves a result that fits untouched, with no _truncated flag', () => {
      const result = bound(entries(5), 2048)!;
      expect(Object.keys(result)).toHaveLength(5);
      expect(result).not.toHaveProperty('_truncated');
    });

    it('drops keys from the end until it fits, and says so', () => {
      const result = bound(entries(30), 1024)!;
      expect(result._truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024);
      const kept = Object.keys(result).filter((k) => k !== '_truncated');
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(30);
      // The head survives, the tail goes.
      expect(kept[0]).toBe('key00');
      expect(kept).not.toContain('key29');
    });

    it('counts UTF-8 bytes, not characters', () => {
      const result = bound({ a: 'ş'.repeat(200), b: 'ş'.repeat(200) }, 600)!;
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(600);
      expect(result._truncated).toBe(true);
      expect(result).toHaveProperty('a');
      expect(result).not.toHaveProperty('b');
    });

    it('judges the size after the scrub, which can make a short value longer', () => {
      const scrub = (meta: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, k.startsWith('token') ? '••••••' : v]));
      const raw = Object.fromEntries(Array.from({ length: 20 }, (_v, i) => [`token${i}`, 'x']));
      const result = boundClientMeta(raw, { maxBytes: 256, scrub })!;
      expect(result._truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(256);
    });

    it('reduces to the flag alone when not even one key fits', () => {
      expect(bound({ a: 'v'.repeat(200) }, 40)).toEqual({ _truncated: true });
    });
  });
});
