/**
 * `maskSecretValues` — the value-only scrub used on error text, the `lastError`
 * stored on a server record and tool results — plus the pieces of the log
 * scrubber it shares a secret list with.
 */

import { describe, expect, it } from 'vitest';
import {
  authConfigSecretValues,
  DEFAULT_MAX_PAYLOAD_BYTES,
  LOG_SECRET_MASK,
  maskSecretValues,
  redactLogPayload,
  SECRET_REDACTED,
} from '@/lib/services/logRedaction';

const TOKEN = 'sk-live-0123456789abcdef';

describe('maskSecretValues — strings', () => {
  it('replaces every occurrence with [REDACTED]', () => {
    expect(SECRET_REDACTED).toBe('[REDACTED]');
    const out = maskSecretValues(`first ${TOKEN}, again ${TOKEN}.`, [TOKEN]);
    expect(out).toBe('first [REDACTED], again [REDACTED].');
  });

  it('returns the input unchanged when there is nothing to mask', () => {
    expect(maskSecretValues('plain text', [TOKEN])).toBe('plain text');
    expect(maskSecretValues('plain text', [])).toBe('plain text');
    expect(maskSecretValues('plain text')).toBe('plain text');
  });

  it('ignores secrets too short to be told apart from ordinary text', () => {
    expect(maskSecretValues('the basic option', ['basic'])).toBe('the basic option');
  });

  it('masks the longer secret whole when one secret contains another', () => {
    const short = 'abcdef';
    const long = 'abcdef-and-a-longer-tail';
    expect(maskSecretValues(`x ${long} y`, [short, long])).toBe('x [REDACTED] y');
    expect(maskSecretValues(`x ${long} y`, [long, short])).toBe('x [REDACTED] y');
  });

  it('masks the spellings an upstream is likely to print the value in', () => {
    const value = 'p@ss word/with+chars="q"';
    const urlForm = encodeURIComponent(value);
    const jsonForm = JSON.stringify(value).slice(1, -1);
    const text = `raw=${value} url=${urlForm} json=${jsonForm}`;
    const out = maskSecretValues(text, [value]);
    expect(out).toBe('raw=[REDACTED] url=[REDACTED] json=[REDACTED]');
  });

  it('truncates after masking, so a secret cut by the limit leaves no fragment', () => {
    const text = `${'x'.repeat(40)}${TOKEN}${'y'.repeat(40)}`;
    const out = maskSecretValues(text, [TOKEN], { maxChars: 50 });
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…[truncated]')).toBe(true);
    // The kept text is a prefix of the MASKED string, never of the raw one.
    expect(out).not.toContain('sk-');
    expect(out).not.toContain(TOKEN.slice(0, 8));
  });

  it('keeps a short string within the limit untouched', () => {
    expect(maskSecretValues('short', [TOKEN], { maxChars: 50 })).toBe('short');
  });

  it('accepts another mask', () => {
    expect(maskSecretValues(`a ${TOKEN}`, [TOKEN], { mask: '***' })).toBe('a ***');
  });
});

describe('maskSecretValues — structures', () => {
  it('masks values at any depth and leaves everything else alone', () => {
    const input = {
      ok: true,
      count: 3,
      nothing: null,
      echoed: { headers: { forwarded: `Bearer ${TOKEN}` } },
      list: [`${TOKEN}`, 7, { deep: [`x${TOKEN}x`] }],
    };
    const out = maskSecretValues(input, [TOKEN]);
    expect(out).toEqual({
      ok: true,
      count: 3,
      nothing: null,
      echoed: { headers: { forwarded: 'Bearer [REDACTED]' } },
      list: ['[REDACTED]', 7, { deep: ['x[REDACTED]x'] }],
    });
  });

  it('does not mutate its input', () => {
    const input = { a: { b: TOKEN } };
    maskSecretValues(input, [TOKEN]);
    expect(input.a.b).toBe(TOKEN);
  });

  it('does not mask key names, so a result keeps its shape', () => {
    const out = maskSecretValues({ token: 'visible', [TOKEN]: 'v' }, [TOKEN]) as Record<string, unknown>;
    expect(out.token).toBe('visible');
    expect(Object.keys(out)).toContain(TOKEN);
  });

  it('leaves non-JSON values (Date, Buffer, Error) as they are', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const buf = Buffer.from(TOKEN);
    const out = maskSecretValues({ when, buf }, [TOKEN]) as { when: Date; buf: Buffer };
    expect(out.when).toBe(when);
    expect(out.buf).toBe(buf);
  });

  it('keeps an own "__proto__" key from parsed JSON', () => {
    const input = JSON.parse(`{"__proto__":{"v":"${TOKEN}"},"k":"1"}`) as Record<string, unknown>;
    const out = maskSecretValues(input, [TOKEN]) as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(out)).toContain('__proto__');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('survives a cycle', () => {
    const a: Record<string, unknown> = { v: TOKEN };
    a.self = a;
    const out = maskSecretValues(a, [TOKEN]) as Record<string, unknown>;
    expect(out.v).toBe('[REDACTED]');
    expect(out.self).toBe('[Circular]');
  });

  it('masks a value nested far deeper than it walks', () => {
    let nested: unknown = { leaf: `echoed ${TOKEN}` };
    for (let i = 0; i < 80; i += 1) nested = { next: nested };
    const out = maskSecretValues(nested, [TOKEN]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).toContain('[REDACTED]');
  });

  it('passes scalars through', () => {
    expect(maskSecretValues(42, [TOKEN])).toBe(42);
    expect(maskSecretValues(null, [TOKEN])).toBeNull();
    expect(maskSecretValues(undefined, [TOKEN])).toBeUndefined();
  });
});

describe('authConfigSecretValues — basic credentials', () => {
  it('collects the password, the base64 wire value and the user:password pair', () => {
    const values = authConfigSecretValues({ username: 'alice', password: 'p@ssw0rd!' });
    expect(values).toContain('p@ssw0rd!');
    expect(values).toContain(Buffer.from('alice:p@ssw0rd!').toString('base64'));
    expect(values).toContain('alice:p@ssw0rd!');
  });

  it('masks all three in one pass', () => {
    const auth = { username: 'alice', password: 'p@ssw0rd!' };
    const text = [
      'pair alice:p@ssw0rd!',
      `wire ${Buffer.from('alice:p@ssw0rd!').toString('base64')}`,
      'pw p@ssw0rd!',
    ].join(' | ');
    const out = maskSecretValues(text, authConfigSecretValues(auth));
    expect(out).toBe('pair [REDACTED] | wire [REDACTED] | pw [REDACTED]');
  });
});

describe('redactLogPayload — shared secret list', () => {
  it('masks a secret value nested deeper than the key-masking depth', () => {
    let nested: unknown = { leaf: `echoed ${TOKEN}` };
    for (let i = 0; i < 20; i += 1) nested = { next: nested };
    const out = redactLogPayload(nested, { secretValues: [TOKEN] });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).toContain(LOG_SECRET_MASK);
  });

  it('keeps the truncation marker inside a small cap', () => {
    const out = redactLogPayload({ blob: 'x'.repeat(5_000) }, { maxBytes: 400 }) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(400);
    expect((out.preview as string).length).toBeLessThanOrEqual(200);
  });

  it('leaves the default marker size alone', () => {
    const out = redactLogPayload({ blob: 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES + 10) }) as Record<string, unknown>;
    expect((out.preview as string).length).toBe(2048);
  });

  it('falls back to the default cap for a limit that is not a usable number', () => {
    const big = { blob: 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES + 10) };
    for (const maxBytes of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect((redactLogPayload(big, { maxBytes }) as Record<string, unknown>)._truncated, String(maxBytes)).toBe(true);
      expect(redactLogPayload({ v: 'ok' }, { maxBytes }), String(maxBytes)).toEqual({ v: 'ok' });
    }
  });
});
