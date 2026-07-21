/**
 * Persisted-log scrubber — the response-side counterpart to the request-side
 * `describeRuntimeAuth` name-only redaction. Guards against an upstream echoing
 * a passthrough runtime-header value or the server/tool's static credential
 * back into a logged `responsePayload` / `errorMessage`, and caps payload size.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_STRING_CHARS,
  LOG_SECRET_MASK,
  authConfigSecretValues,
  redactLogPayload,
  redactLogString,
} from '@/lib/services/logRedaction';

describe('redactLogPayload — value scrubbing', () => {
  it('masks an echoed secret value under an arbitrary (non-sensitive) key', () => {
    const secret = 'Bearer sk-live-abcdef1234567890';
    const out = redactLogPayload(
      { echoed: { you_sent: secret }, ok: true },
      { secretValues: [secret] },
    );
    expect(JSON.stringify(out)).not.toContain('sk-live-abcdef1234567890');
    expect((out as any).echoed.you_sent).toBe(LOG_SECRET_MASK);
    expect((out as any).ok).toBe(true);
  });

  it('masks a secret embedded inside a larger string', () => {
    const secret = 'super-secret-token-value';
    const out = redactLogPayload(
      { msg: `received header Authorization=${secret} and processed` },
      { secretValues: [secret] },
    );
    expect((out as any).msg).toBe(`received header Authorization=${LOG_SECRET_MASK} and processed`);
  });

  it('does not mask secret values below the minimum length (collision guard)', () => {
    const out = redactLogPayload({ note: 'basic auth' }, { secretValues: ['basic'] });
    expect((out as any).note).toBe('basic auth');
  });

  it('does not mutate the input object', () => {
    const secret = 'another-long-secret-here';
    const input = { a: { b: secret } };
    redactLogPayload(input, { secretValues: [secret] });
    expect(input.a.b).toBe(secret);
  });
});

describe('redactLogPayload — sensitive key scrubbing', () => {
  it('masks values whose KEY is sensitive regardless of the value', () => {
    const out = redactLogPayload({
      authorization: 'Bearer xyz',
      api_key: 'k-123',
      nested: { access_token: 'at-1', keep: 'visible' },
    });
    expect((out as any).authorization).toBe(LOG_SECRET_MASK);
    expect((out as any).api_key).toBe(LOG_SECRET_MASK);
    expect((out as any).nested.access_token).toBe(LOG_SECRET_MASK);
    expect((out as any).nested.keep).toBe('visible');
  });

  it('preserves the _runtimeAuth header-name audit info (names are not secrets)', () => {
    const out = redactLogPayload({
      tool: 'search',
      _runtimeAuth: { headerKeys: ['authorization', 'x-tenant'], source: 'api' },
    });
    expect((out as any)._runtimeAuth.headerKeys).toEqual(['authorization', 'x-tenant']);
  });
});

describe('redactLogPayload — size cap', () => {
  it('replaces an over-cap payload with a truncation marker', () => {
    const big = { blob: 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES + 100) };
    const out = redactLogPayload(big) as any;
    expect(out._truncated).toBe(true);
    expect(out._originalBytes).toBeGreaterThan(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(typeof out.preview).toBe('string');
  });

  it('leaves a normal-sized payload untouched', () => {
    const out = redactLogPayload({ value: 'small' });
    expect(out).toEqual({ value: 'small' });
  });
});

describe('redactLogPayload — native instances', () => {
  it('preserves Date and Buffer values instead of erasing them to {}', () => {
    const when = new Date('2026-07-20T00:00:00.000Z');
    const buf = Buffer.from('hi');
    const out = redactLogPayload({ when, buf, keep: 'v' }) as any;
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.toISOString()).toBe('2026-07-20T00:00:00.000Z');
    expect(Buffer.isBuffer(out.buf)).toBe(true);
    expect(out.keep).toBe('v');
  });
});

describe('redactLogString', () => {
  it('scrubs known secret values from an error string', () => {
    const secret = 'Bearer sk-live-abcdef1234567890';
    const out = redactLogString(`Upstream API error (401): rejected ${secret}`, [secret]);
    expect(out).toBe(`Upstream API error (401): rejected ${LOG_SECRET_MASK}`);
  });

  it('returns the string unchanged when no secrets are supplied', () => {
    expect(redactLogString('plain error', [])).toBe('plain error');
    expect(redactLogString(undefined)).toBeUndefined();
  });

  it('caps an oversized error body (echoed upstream text)', () => {
    const huge = 'e'.repeat(DEFAULT_MAX_STRING_CHARS + 500);
    const out = redactLogString(huge, []) as string;
    expect(out.length).toBeLessThan(huge.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });
});

describe('authConfigSecretValues', () => {
  it('collects token / headerValue / basic values', () => {
    expect(authConfigSecretValues({ token: 'tok-123456' })).toEqual(['tok-123456']);
    expect(authConfigSecretValues({ headerValue: 'hv-abcdef' })).toEqual(['hv-abcdef']);

    const basic = authConfigSecretValues({ username: 'alice', password: 'p@ssw0rd' });
    expect(basic).toContain('p@ssw0rd');
    expect(basic).toContain(Buffer.from('alice:p@ssw0rd').toString('base64'));
  });

  it('returns nothing for a missing or none auth config', () => {
    expect(authConfigSecretValues(undefined)).toEqual([]);
    expect(authConfigSecretValues({})).toEqual([]);
  });

  it('end-to-end: a static credential echoed in the response is scrubbed', () => {
    const auth = { type: 'token', token: 'sk-static-credential-xyz' };
    const secretValues = authConfigSecretValues(auth);
    const response = redactLogPayload(
      { debug: { headers: { forwarded: `Bearer ${auth.token}` } } },
      { secretValues },
    );
    expect(JSON.stringify(response)).not.toContain('sk-static-credential-xyz');
  });
});
