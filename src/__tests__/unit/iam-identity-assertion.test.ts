/**
 * Identity assertions (src/lib/iam/identityAssertion.ts): the verification every "act for a
 * person" feature rests on.
 *
 *   algorithm pinning   only what the administrator pinned; `none` never; one key family per algorithm
 *   key confusion       a public key's text used as a shared secret, or the secret offered to RS256, gets nowhere
 *   key ids             HS256 rotation picks the secret by `kid`; an unknown or missing one is not trusted
 *   key sets            a real HTTP server on port 0 behind the SSRF guard: cached, size-limited, refetched rarely
 *   claims              iss / aud / exp / iat / nbf / sub, skew, maximum age, lifetime
 *   single use          a `jti` is accepted once until it expires; the cache is bounded
 *   result              profile claims in a bounded shape; ctx is size-limited
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import {
  IdentityAssertionError,
  MAX_CTX_BYTES,
  MAX_JWKS_BYTES,
  REPLAY_CACHE_MAX,
  replayCacheSizeForTests,
  resetIdentityAssertionCachesForTests,
  setReplayCacheLimitForTests,
  validateIdentityAssertionTrust,
  verifyIdentityAssertion,
  type IdentityAssertionTrust,
} from '@/lib/iam/identityAssertion';

const ISSUER = 'https://idp.example.com/';
const AUDIENCE = 'console-api';
const SECRET_A = 'a-shared-secret-of-at-least-32-characters-A';
const SECRET_B = 'another-shared-secret-of-32-characters-B';

const enc = new TextEncoder();

interface TokenOptions {
  alg?: string;
  key?: Parameters<SignJWT['sign']>[0];
  kid?: string | number;
  iss?: string;
  aud?: string | string[];
  sub?: string | null;
  iat?: number | null;
  exp?: number | null;
  nbf?: number;
  jti?: string;
  claims?: Record<string, unknown>;
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function mint(options: TokenOptions = {}): Promise<string> {
  const alg = options.alg ?? 'HS256';
  const key = options.key ?? enc.encode(SECRET_A);
  const header: Record<string, unknown> = { alg };
  if (options.kid !== undefined) header.kid = options.kid;
  const jwt = new SignJWT({ ...(options.claims ?? {}) }).setProtectedHeader(header as never);
  if (options.iss !== undefined || !('iss' in options)) jwt.setIssuer(options.iss ?? ISSUER);
  if (options.aud !== undefined || !('aud' in options)) jwt.setAudience(options.aud ?? AUDIENCE);
  if (options.sub !== null) jwt.setSubject(options.sub ?? 'user-42');
  if (options.iat !== null) jwt.setIssuedAt(options.iat ?? nowSec());
  if (options.exp !== null) jwt.setExpirationTime(options.exp ?? nowSec() + 60);
  if (options.nbf !== undefined) jwt.setNotBefore(options.nbf);
  if (options.jti !== undefined) jwt.setJti(options.jti);
  return jwt.sign(key);
}

const hsTrust = (extra: Partial<IdentityAssertionTrust> = {}): IdentityAssertionTrust => ({
  issuer: ISSUER,
  audience: AUDIENCE,
  algorithms: ['HS256'],
  keys: { hsSecrets: [{ kid: 'k1', secret: SECRET_A }] },
  ...extra,
});

async function expectCode(promise: Promise<unknown>, code: IdentityAssertionError['code']) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error, `expected ${code}`).toBeInstanceOf(IdentityAssertionError);
  expect((error as IdentityAssertionError).code).toBe(code);
  return error as IdentityAssertionError;
}

const original = getConfigSource();
const sourceWith = (overrides: Record<string, string>): ConfigSource => ({ get: (key: string) => overrides[key] ?? process.env[key] }) as ConfigSource;

beforeEach(() => {
  resetIdentityAssertionCachesForTests();
  setConfigSource(sourceWith({}));
});
afterEach(() => {
  vi.useRealTimers();
  setConfigSource(original);
  resetIdentityAssertionCachesForTests();
});

describe('a good assertion', () => {
  it('verifies and returns the issuer, the subject and the profile claims in a bounded shape', async () => {
    const token = await mint({
      kid: 'k1',
      claims: {
        email: ' Ada@Example.com ',
        email_verified: true,
        name: '  Ada Lovelace ',
        groups: ['sales', 'sales', 7, '', null, { a: 1 }, 'support'],
        ctx: { tenantRegion: 'eu', plan: 'gold' },
        locale: 'tr',
      },
    });
    const result = await verifyIdentityAssertion({ token, trust: hsTrust() });
    expect(result).toMatchObject({
      issuer: ISSUER,
      subject: 'user-42',
      email: 'Ada@Example.com',
      emailVerified: true,
      name: 'Ada Lovelace',
      groups: ['sales', 'support'],
      ctx: { tenantRegion: 'eu', plan: 'gold' },
    });
    expect(result.claims).toMatchObject({ iss: ISSUER, sub: 'user-42', locale: 'tr' });
  });

  it('leaves out what the token does not carry, and a non-boolean email_verified', async () => {
    const result = await verifyIdentityAssertion({
      token: await mint({ kid: 'k1', claims: { email: 'a@b.co', email_verified: 'true' } }),
      trust: hsTrust(),
    });
    expect(result.email).toBe('a@b.co');
    expect(result.emailVerified).toBeUndefined();
    expect(result.name).toBeUndefined();
    expect(result.groups).toBeUndefined();
    expect(result.ctx).toBeUndefined();
    // an unverified address says so
    const unverified = await verifyIdentityAssertion({ token: await mint({ kid: 'k1', claims: { email: 'a@b.co', email_verified: false } }), trust: hsTrust() });
    expect(unverified.emailVerified).toBe(false);
  });

  it('accepts a single configured secret without a kid, and several audiences', async () => {
    const trust = hsTrust({ audience: ['other-api', AUDIENCE] });
    await expect(verifyIdentityAssertion({ token: await mint(), trust })).resolves.toMatchObject({ subject: 'user-42' });
    await expect(verifyIdentityAssertion({ token: await mint({ aud: ['x', AUDIENCE] }), trust })).resolves.toMatchObject({ subject: 'user-42' });
  });
});

describe('algorithm pinning', () => {
  it('refuses an algorithm the administrator did not pin', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const rs = await mint({ alg: 'RS256', key: privateKey });
    // HS256 only pinned: the RS256 token is not acceptable, however good its signature
    await expectCode(verifyIdentityAssertion({ token: rs, trust: hsTrust() }), 'invalid_assertion');
    expect(publicKey).toBeTruthy();
  });

  it('never accepts alg none, in any spelling, with or without a signature', async () => {
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'x', iat: nowSec(), exp: nowSec() + 60 })).toString('base64url');
    for (const alg of ['none', 'None', 'NONE', 'nOnE']) {
      const header = Buffer.from(JSON.stringify({ alg })).toString('base64url');
      await expectCode(verifyIdentityAssertion({ token: `${header}.${payload}.`, trust: hsTrust() }), 'invalid_assertion');
      await expectCode(verifyIdentityAssertion({ token: `${header}.${payload}.c2ln`, trust: hsTrust() }), 'invalid_assertion');
    }
  });

  it('cannot be configured to pin none or an unknown algorithm', async () => {
    for (const algorithms of [['none'], ['HS256', 'none'], ['HS512'], ['RS512'], ['PS256'], []]) {
      const trust = hsTrust({ algorithms: algorithms as never });
      expect(validateIdentityAssertionTrust(trust).length, JSON.stringify(algorithms)).toBeGreaterThan(0);
      await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'k1' }), trust }), 'untrusted_key');
    }
  });
});

describe('key confusion', () => {
  it('does not accept an HS256 token signed with the text of the issuer\'s public key', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // the attacker uses the (public) PEM text as the HMAC secret and claims HS256
    const forged = await mint({ alg: 'HS256', key: enc.encode(pem) });
    // RS256 only pinned: HS256 is not even a candidate
    await expectCode(verifyIdentityAssertion({ token: forged, trust: { issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'], keys: { pem } } }), 'invalid_assertion');
    // both families pinned: the HS256 secret is the configured one, not the key text
    const both: IdentityAssertionTrust = { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256', 'RS256'], keys: { pem, hsSecrets: [{ kid: 'k1', secret: SECRET_A }] } };
    await expectCode(verifyIdentityAssertion({ token: forged, trust: both }), 'invalid_assertion');
  });

  it('does not verify an RS256 token with the shared secret, nor an HS256 token with the public key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const rs = await mint({ alg: 'RS256', key: privateKey });
    // only a secret is configured for an HS256-only trust: the RS256 token is refused before any key is chosen
    await expectCode(verifyIdentityAssertion({ token: rs, trust: hsTrust() }), 'invalid_assertion');
    // a trust that pins both and has only a secret is not a configuration to SAVE ...
    const pinsBoth = hsTrust({ algorithms: ['HS256', 'RS256'] });
    expect(validateIdentityAssertionTrust(pinsBoth, { requireKeyMatch: true })).toEqual(
      expect.arrayContaining([expect.stringContaining('RS256 / ES256 is pinned but no public key')]),
    );
    // ... but at verification it only costs the tokens of the algorithm that has no key: they are not trusted, the others verify
    expect(validateIdentityAssertionTrust(pinsBoth)).toEqual([]);
    await expectCode(verifyIdentityAssertion({ token: rs, trust: pinsBoth }), 'untrusted_key');
    await expect(verifyIdentityAssertion({ token: await mint({ kid: 'k1' }), trust: pinsBoth })).resolves.toMatchObject({ subject: 'user-42' });
    // and the good RS256 token verifies with the public key, which is what the family split is for
    await expect(verifyIdentityAssertion({ token: rs, trust: { issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'], keys: { pem } } })).resolves.toMatchObject({ subject: 'user-42' });
  });

  it('refuses a public key of the wrong type for the algorithm, and a key that is too weak', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ecPem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaToken = await mint({ alg: 'RS256', key: rsa.privateKey });
    // an EC key configured while the token is RS256
    await expectCode(verifyIdentityAssertion({
      token: rsaToken,
      trust: { issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256', 'ES256'], keys: { pem: ecPem } },
    }), 'untrusted_key');

    // jose will not even sign with a 1024-bit key, so the token is signed by hand: what a careless issuer's library might do
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const weakPem = weak.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const head = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'x', iat: nowSec(), exp: nowSec() + 60 })).toString('base64url');
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(weak.privateKey).toString('base64url');
    await expectCode(verifyIdentityAssertion({
      token: `${head}.${body}.${signature}`,
      trust: { issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'], keys: { pem: weakPem } },
    }), 'untrusted_key');
  });

  it('verifies ES256 with an EC public key', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const token = await mint({ alg: 'ES256', key: ec.privateKey });
    await expect(verifyIdentityAssertion({ token, trust: { issuer: ISSUER, audience: AUDIENCE, algorithms: ['ES256'], keys: { pem } } })).resolves.toMatchObject({ subject: 'user-42' });
    // a signature by another key of the same type is a bad signature, not an untrusted key
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await expectCode(verifyIdentityAssertion({ token: await mint({ alg: 'ES256', key: other.privateKey }), trust: { issuer: ISSUER, audience: AUDIENCE, algorithms: ['ES256'], keys: { pem } } }), 'invalid_assertion');
  });
});

describe('key ids (HS256 rotation)', () => {
  const rotating = hsTrust({ keys: { hsSecrets: [{ kid: 'old', secret: SECRET_A }, { kid: 'new', secret: SECRET_B }] } });

  it('picks the secret the token names', async () => {
    await expect(verifyIdentityAssertion({ token: await mint({ kid: 'old', key: enc.encode(SECRET_A) }), trust: rotating })).resolves.toMatchObject({ subject: 'user-42' });
    await expect(verifyIdentityAssertion({ token: await mint({ kid: 'new', key: enc.encode(SECRET_B) }), trust: rotating })).resolves.toMatchObject({ subject: 'user-42' });
  });

  it('does not try the other secret when the named one does not match', async () => {
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'old', key: enc.encode(SECRET_B) }), trust: rotating }), 'invalid_assertion');
  });

  it('does not trust an unknown key id, a missing one when there are several secrets, or an odd one', async () => {
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'retired' }), trust: rotating }), 'untrusted_key');
    await expectCode(verifyIdentityAssertion({ token: await mint(), trust: rotating }), 'untrusted_key');
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 5 }), trust: rotating }), 'invalid_assertion');
    // a single configured secret with a different kid named by the token
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'other' }), trust: hsTrust() }), 'untrusted_key');
  });

  it('refuses shared secrets that are short, share an id or have an odd id', () => {
    const base = hsTrust();
    expect(validateIdentityAssertionTrust({ ...base, keys: { hsSecrets: [{ kid: 'k', secret: 'short' }] } })).toEqual(expect.arrayContaining([expect.stringContaining('at least 32 characters')]));
    expect(validateIdentityAssertionTrust({ ...base, keys: { hsSecrets: [{ kid: 'k', secret: SECRET_A }, { kid: 'k', secret: SECRET_B }] } })).toEqual(expect.arrayContaining([expect.stringContaining('used twice')]));
    expect(validateIdentityAssertionTrust({ ...base, keys: { hsSecrets: [{ kid: 'a b', secret: SECRET_A }] } })).toEqual(expect.arrayContaining([expect.stringContaining('key id')]));
  });
});

describe('claims', () => {
  it('refuses another issuer and another audience', async () => {
    await expectCode(verifyIdentityAssertion({ token: await mint({ iss: 'https://evil.example.com/' }), trust: hsTrust() }), 'invalid_assertion');
    await expectCode(verifyIdentityAssertion({ token: await mint({ iss: ISSUER.slice(0, -1) }), trust: hsTrust() }), 'invalid_assertion');
    await expectCode(verifyIdentityAssertion({ token: await mint({ aud: 'someone-else' }), trust: hsTrust() }), 'invalid_assertion');
    await expectCode(verifyIdentityAssertion({ token: await mint({ aud: ['x', 'y'] }), trust: hsTrust() }), 'invalid_assertion');
  });

  it('requires iss, aud, sub, exp and iat', async () => {
    for (const missing of [{ sub: null }, { iat: null }, { exp: null }] as TokenOptions[]) {
      await expectCode(verifyIdentityAssertion({ token: await mint(missing), trust: hsTrust() }), 'invalid_assertion');
    }
    // a subject that is blank is not a subject
    await expectCode(verifyIdentityAssertion({ token: await mint({ sub: '   ' }), trust: hsTrust() }), 'invalid_assertion');
    await expectCode(verifyIdentityAssertion({ token: await mint({ sub: 'x'.repeat(513) }), trust: hsTrust() }), 'invalid_assertion');
  });

  it('refuses an expired assertion, with the skew as the only grace', async () => {
    const t0 = Date.UTC(2026, 9, 11, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const sec = Math.floor(t0 / 1000);
    const trust = hsTrust({ clockSkewSeconds: 30 });
    // 20 s past exp: inside the skew
    await expect(verifyIdentityAssertion({ token: await mint({ iat: sec - 100, exp: sec - 20 }), trust })).resolves.toMatchObject({ subject: 'user-42' });
    // 40 s past exp: outside it
    await expectCode(verifyIdentityAssertion({ token: await mint({ iat: sec - 100, exp: sec - 40 }), trust }), 'expired');
    // no skew at all
    await expectCode(verifyIdentityAssertion({ token: await mint({ iat: sec - 100, exp: sec - 1 }), trust: hsTrust({ clockSkewSeconds: 0 }) }), 'expired');
  });

  it('refuses an assertion issued in the future or not valid yet', async () => {
    const t0 = Date.UTC(2026, 9, 11, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const sec = Math.floor(t0 / 1000);
    const trust = hsTrust({ clockSkewSeconds: 30 });
    await expect(verifyIdentityAssertion({ token: await mint({ iat: sec + 20, exp: sec + 200 }), trust })).resolves.toBeTruthy();
    await expectCode(verifyIdentityAssertion({ token: await mint({ iat: sec + 90, exp: sec + 300 }), trust }), 'invalid_assertion');
    await expectCode(verifyIdentityAssertion({ token: await mint({ nbf: sec + 120, iat: sec, exp: sec + 300 }), trust }), 'invalid_assertion');
  });

  it('enforces the maximum age: the life a token was issued for, and how long ago', async () => {
    const t0 = Date.UTC(2026, 9, 11, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const sec = Math.floor(t0 / 1000);
    const trust = hsTrust({ maxTokenAgeSeconds: 300, clockSkewSeconds: 10 });
    // a five-minute token, fresh; and one exactly at the limit
    await expect(verifyIdentityAssertion({ token: await mint({ iat: sec - 5, exp: sec - 5 + 300 }), trust })).resolves.toBeTruthy();
    // issued for an hour, not expired: refused for its life
    await expectCode(verifyIdentityAssertion({ token: await mint({ iat: sec, exp: sec + 3600 }), trust }), 'invalid_assertion');
    await expectCode(verifyIdentityAssertion({ token: await mint({ iat: sec, exp: sec + 301 }), trust }), 'invalid_assertion');
    // a five-minute token issued six minutes ago has run out: expired (and cannot be older than allowed while still valid)
    await expectCode(verifyIdentityAssertion({ token: await mint({ iat: sec - 360, exp: sec - 60 }), trust }), 'expired');
    // without a maximum the life is the issuer's business
    await expect(verifyIdentityAssertion({ token: await mint({ iat: sec, exp: sec + 86_400 }), trust: hsTrust() })).resolves.toBeTruthy();
  });

  it('refuses garbage', async () => {
    const trust = hsTrust();
    for (const token of ['', 'abc', 'a.b', 'a.b.c.d', '....', ' ', 'x'.repeat(20_000), '{}', 'eyJhbGciOiJIUzI1NiJ9.e30']) {
      await expectCode(verifyIdentityAssertion({ token, trust }), 'invalid_assertion');
    }
    await expectCode(verifyIdentityAssertion({ token: undefined as never, trust }), 'invalid_assertion');
  });

  it('refuses a token whose signature was cut or changed', async () => {
    const token = await mint({ kid: 'k1' });
    const [h, p, s] = token.split('.');
    await expectCode(verifyIdentityAssertion({ token: `${h}.${p}.${s.slice(0, -4)}AAAA`, trust: hsTrust() }), 'invalid_assertion');
    const forgedPayload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'admin', iat: nowSec(), exp: nowSec() + 60 })).toString('base64url');
    await expectCode(verifyIdentityAssertion({ token: `${h}.${forgedPayload}.${s}`, trust: hsTrust() }), 'invalid_assertion');
  });
});

describe('profile claims', () => {
  it('refuses an email that is not an address, keeps ctx within its bound', async () => {
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'k1', claims: { email: 'not-an-address' } }), trust: hsTrust() }), 'invalid_assertion');
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'k1', claims: { email: 42 } }), trust: hsTrust() }), 'invalid_assertion');
    const big = { blob: 'x'.repeat(MAX_CTX_BYTES) };
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'k1', claims: { ctx: big } }), trust: hsTrust() }), 'invalid_assertion');
    const fits = { blob: 'x'.repeat(MAX_CTX_BYTES - 20) };
    await expect(verifyIdentityAssertion({ token: await mint({ kid: 'k1', claims: { ctx: fits } }), trust: hsTrust() })).resolves.toMatchObject({ ctx: fits });
  });

  it('caps the groups and the length of each', async () => {
    const groups = Array.from({ length: 150 }, (_, i) => `g${i}`).concat(['x'.repeat(201)]);
    const result = await verifyIdentityAssertion({ token: await mint({ kid: 'k1', claims: { groups } }), trust: hsTrust() });
    expect(result.groups).toHaveLength(100);
    expect(result.groups?.includes('x'.repeat(201))).toBe(false);
  });
});

describe('single use', () => {
  it('accepts a jti once until it expires, and requires one', async () => {
    const trust = hsTrust({ requireSingleUse: true });
    const token = await mint({ kid: 'k1', jti: 'jti-1' });
    await expect(verifyIdentityAssertion({ token, trust })).resolves.toMatchObject({ subject: 'user-42' });
    await expectCode(verifyIdentityAssertion({ token, trust }), 'replayed');
    // another jti is another assertion
    await expect(verifyIdentityAssertion({ token: await mint({ kid: 'k1', jti: 'jti-2' }), trust })).resolves.toBeTruthy();
    // without a jti the token cannot be single-use
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'k1' }), trust }), 'invalid_assertion');
    // a trust that does not ask for it lets the same token through again
    const lax = hsTrust();
    await expect(verifyIdentityAssertion({ token, trust: lax })).resolves.toBeTruthy();
    await expect(verifyIdentityAssertion({ token, trust: lax })).resolves.toBeTruthy();
  });

  it('remembers a jti per issuer', async () => {
    const other = 'https://other-idp.example.com/';
    const trustA = hsTrust({ requireSingleUse: true });
    const trustB = hsTrust({ requireSingleUse: true, issuer: other });
    await verifyIdentityAssertion({ token: await mint({ kid: 'k1', jti: 'same' }), trust: trustA });
    await expect(verifyIdentityAssertion({ token: await mint({ kid: 'k1', jti: 'same', iss: other }), trust: trustB })).resolves.toBeTruthy();
  });

  it('does not use up a jti on an assertion that is refused for another reason', async () => {
    const trust = hsTrust({ requireSingleUse: true });
    const bad = await mint({ kid: 'k1', jti: 'precious', aud: 'wrong' });
    await expectCode(verifyIdentityAssertion({ token: bad, trust }), 'invalid_assertion');
    expect(replayCacheSizeForTests()).toBe(0);
    await expect(verifyIdentityAssertion({ token: await mint({ kid: 'k1', jti: 'precious' }), trust })).resolves.toBeTruthy();
  });

  it('forgets a token once it can no longer be presented, and stays within its bound', async () => {
    const trust = hsTrust({ requireSingleUse: true, clockSkewSeconds: 5 });
    const t0 = Date.UTC(2026, 9, 11, 12, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const sec = Math.floor(t0 / 1000);
    await verifyIdentityAssertion({ token: await mint({ kid: 'k1', jti: 'short', iat: sec, exp: sec + 10 }), trust });
    expect(replayCacheSizeForTests()).toBe(1);
    vi.setSystemTime(t0 + 20_000);
    // the next single-use assertion sweeps the expired entry
    const later = Math.floor((t0 + 20_000) / 1000);
    await verifyIdentityAssertion({ token: await mint({ kid: 'k1', jti: 'next', iat: later, exp: later + 10 }), trust });
    expect(replayCacheSizeForTests()).toBe(1);

    // the bound: the oldest entries make room
    setReplayCacheLimitForTests(3);
    resetIdentityAssertionCachesForTests();
    setReplayCacheLimitForTests(3);
    for (const jti of ['a', 'b', 'c', 'd', 'e']) {
      await verifyIdentityAssertion({ token: await mint({ kid: 'k1', jti, iat: later, exp: later + 600 }), trust });
      expect(replayCacheSizeForTests()).toBeLessThanOrEqual(3);
    }
    expect(replayCacheSizeForTests()).toBe(3);
    // the newest are still remembered, the oldest were let go
    await expectCode(verifyIdentityAssertion({ token: await mint({ kid: 'k1', jti: 'e', iat: later, exp: later + 600 }), trust }), 'replayed');
    expect(REPLAY_CACHE_MAX).toBeGreaterThanOrEqual(10_000);
  });
});

describe('trust configuration', () => {
  it('names what is wrong', () => {
    expect(validateIdentityAssertionTrust(hsTrust())).toEqual([]);
    const problems = (patch: Record<string, unknown>) => validateIdentityAssertionTrust({ ...hsTrust(), ...patch });
    expect(problems({ issuer: '' }).length).toBeGreaterThan(0);
    expect(problems({ issuer: ' padded ' }).length).toBeGreaterThan(0);
    expect(problems({ audience: [] }).length).toBeGreaterThan(0);
    expect(problems({ audience: 5 }).length).toBeGreaterThan(0);
    expect(problems({ maxTokenAgeSeconds: 0 }).length).toBeGreaterThan(0);
    expect(problems({ maxTokenAgeSeconds: 1.5 }).length).toBeGreaterThan(0);
    expect(problems({ clockSkewSeconds: -1 }).length).toBeGreaterThan(0);
    expect(problems({ clockSkewSeconds: 9999 }).length).toBeGreaterThan(0);
    expect(problems({ requireSingleUse: 'yes' }).length).toBeGreaterThan(0);
    expect(validateIdentityAssertionTrust(null)).toHaveLength(1);
    expect(validateIdentityAssertionTrust([])).toHaveLength(1);
  });

  it('refuses a private key where a public key is asked for, and a key set over plain http from the open internet', () => {
    const pk = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    const rsTrust = (keys: Record<string, unknown>, options: { requireKeyMatch?: boolean } = { requireKeyMatch: true }) =>
      validateIdentityAssertionTrust({ issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'], keys }, options);
    expect(rsTrust({ pem: pk })).toEqual(expect.arrayContaining([expect.stringContaining('private key')]));
    expect(rsTrust({ pem: 'garbage' })).toEqual(expect.arrayContaining([expect.stringContaining('PEM')]));
    expect(rsTrust({ jwksUrl: 'http://idp.example.com/jwks.json' })).toEqual(expect.arrayContaining([expect.stringContaining('https')]));
    expect(rsTrust({ jwksUrl: 'ftp://idp.example.com/jwks.json' })).toHaveLength(1);
    expect(rsTrust({ jwksUrl: 'https://user:pass@idp.example.com/jwks.json' })).toHaveLength(1);
    expect(rsTrust({ jwksUrl: 'https://idp.example.com/.well-known/jwks.json' })).toEqual([]);
    expect(rsTrust({ jwksUrl: 'http://127.0.0.1:8080/jwks.json' })).toEqual([]);
    expect(rsTrust({ jwksUrl: 'http://keys.corp.internal/jwks.json' })).toEqual([]);
    expect(rsTrust({})).toEqual(expect.arrayContaining([expect.stringContaining('no public key')]));
    // the checks about one value at a time apply everywhere; the key / algorithm match is the save path's
    expect(rsTrust({}, {})).toEqual([]);
    expect(rsTrust({ pem: pk }, {})).toEqual(expect.arrayContaining([expect.stringContaining('private key')]));
  });

  it('refuses key material that does not belong to a pinned algorithm', () => {
    const strict = { requireKeyMatch: true };
    expect(validateIdentityAssertionTrust({ issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'], keys: { hsSecrets: [{ kid: 'k', secret: SECRET_A }], jwksUrl: 'https://idp.example.com/jwks.json' } }, strict))
      .toEqual(expect.arrayContaining([expect.stringContaining('neither RS256 nor ES256')]));
    expect(validateIdentityAssertionTrust({ issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'], keys: { jwksUrl: 'https://idp.example.com/jwks.json', hsSecrets: [{ kid: 'k', secret: SECRET_A }] } }, strict))
      .toEqual(expect.arrayContaining([expect.stringContaining('HS256 is not pinned')]));
  });
});

// ── a real key set behind the SSRF guard ─────────────────────────────────

describe('key sets (JWKS)', () => {
  let server: Server;
  let url: string;
  let hits = 0;
  let body: () => string = () => '{"keys":[]}';
  let respond: (res: import('node:http').ServerResponse) => void = (res) => {
    res.setHeader('content-type', 'application/json');
    res.end(body());
  };

  let privateA: CryptoKey;
  let jwkA: JWK;
  let privateB: CryptoKey;
  let jwkB: JWK;

  const open = sourceWith({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
  const rsTrust = (jwksUrl = url, extra: Partial<IdentityAssertionTrust> = {}): IdentityAssertionTrust => ({
    issuer: ISSUER, audience: AUDIENCE, algorithms: ['RS256'], keys: { jwksUrl }, ...extra,
  });

  beforeEach(async () => {
    hits = 0;
    const a = await generateKeyPair('RS256', { extractable: true });
    const b = await generateKeyPair('RS256', { extractable: true });
    privateA = a.privateKey as CryptoKey;
    privateB = b.privateKey as CryptoKey;
    jwkA = { ...(await exportJWK(a.publicKey)), kid: 'key-a', alg: 'RS256', use: 'sig' };
    jwkB = { ...(await exportJWK(b.publicKey)), kid: 'key-b', alg: 'RS256', use: 'sig' };
    body = () => JSON.stringify({ keys: [jwkA] });
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(body());
    };
    server = createServer((req, res) => {
      hits += 1;
      respond(res);
      void req;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
    setConfigSource(open);
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('verifies with the key whose kid the token names, and caches the set', async () => {
    const token = await mint({ alg: 'RS256', key: privateA, kid: 'key-a' });
    await expect(verifyIdentityAssertion({ token, trust: rsTrust() })).resolves.toMatchObject({ subject: 'user-42' });
    await expect(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a' }), trust: rsTrust() })).resolves.toBeTruthy();
    expect(hits).toBe(1);
  });

  it('refetches the set (at most every thirty seconds) when a token names a kid it does not have, and so follows a rotation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    await verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a' }), trust: rsTrust() });
    expect(hits).toBe(1);
    // the issuer rotates: the set now has key-b as well
    body = () => JSON.stringify({ keys: [jwkA, jwkB] });
    // inside the cooldown an unknown kid is not trusted and does not trigger a fetch
    await expectCode(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateB, kid: 'key-b' }), trust: rsTrust() }), 'untrusted_key');
    expect(hits).toBe(1);
    // after it, the set is read again and the new key works
    vi.setSystemTime(t0 + 31_000);
    await expect(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateB, kid: 'key-b', iat: Math.floor((t0 + 31_000) / 1000), exp: Math.floor((t0 + 31_000) / 1000) + 60 }), trust: rsTrust() })).resolves.toBeTruthy();
    expect(hits).toBe(2);
  });

  it('reads the set again after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    await verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a' }), trust: rsTrust() });
    vi.setSystemTime(t0 + 11 * 60_000);
    const later = Math.floor((t0 + 11 * 60_000) / 1000);
    await verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a', iat: later, exp: later + 60 }), trust: rsTrust() });
    expect(hits).toBe(2);
  });

  it('does not accept a signature by a key that is not in the set', async () => {
    // key B signs but claims kid key-a
    await expectCode(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateB, kid: 'key-a' }), trust: rsTrust() }), 'invalid_assertion');
  });

  it('trusts nothing when the set cannot be read, is too large or is not a key set', async () => {
    const token = () => mint({ alg: 'RS256', key: privateA, kid: 'key-a' });
    respond = (res) => { res.statusCode = 500; res.end('nope'); };
    await expectCode(verifyIdentityAssertion({ token: await token(), trust: rsTrust() }), 'untrusted_key');

    resetIdentityAssertionCachesForTests();
    respond = (res) => { res.setHeader('content-type', 'application/json'); res.end('<html>'); };
    await expectCode(verifyIdentityAssertion({ token: await token(), trust: rsTrust() }), 'untrusted_key');

    resetIdentityAssertionCachesForTests();
    respond = (res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwkA], padding: 'x'.repeat(MAX_JWKS_BYTES) })); };
    await expectCode(verifyIdentityAssertion({ token: await token(), trust: rsTrust() }), 'untrusted_key');

    // a streamed body that never declares its length is cut off as well: it is valid JSON holding the right key, so only the limit stops it
    resetIdentityAssertionCachesForTests();
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.write(`{"keys":[${JSON.stringify(jwkA)}],"pad":"`);
      for (let i = 0; i < 8; i += 1) res.write('x'.repeat(64 * 1024));
      res.end('"}');
    };
    await expectCode(verifyIdentityAssertion({ token: await token(), trust: rsTrust() }), 'untrusted_key');
    // the same key set, small, is fine
    resetIdentityAssertionCachesForTests();
    respond = (res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwkA] })); };
    await expect(verifyIdentityAssertion({ token: await token(), trust: rsTrust() })).resolves.toBeTruthy();
  });

  it('does not ask an endpoint that just failed again for ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    respond = (res) => { res.statusCode = 503; res.end('down'); };
    const token = () => mint({ alg: 'RS256', key: privateA, kid: 'key-a' });
    await expectCode(verifyIdentityAssertion({ token: await token(), trust: rsTrust() }), 'untrusted_key');
    const first = hits;
    await expectCode(verifyIdentityAssertion({ token: await token(), trust: rsTrust() }), 'untrusted_key');
    expect(hits).toBe(first);
    vi.setSystemTime(t0 + 11_000);
    const later = Math.floor((t0 + 11_000) / 1000);
    respond = (res) => { res.setHeader('content-type', 'application/json'); res.end(body()); };
    await expect(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a', iat: later, exp: later + 60 }), trust: rsTrust() })).resolves.toBeTruthy();
  });

  it('goes through the SSRF guard: an address inside the network is refused unless the operator allows it', async () => {
    setConfigSource(sourceWith({}));
    await expectCode(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a' }), trust: rsTrust() }), 'untrusted_key');
    expect(hits).toBe(0);
    // the operator allow-lists the host: the same trust works
    resetIdentityAssertionCachesForTests();
    setConfigSource(sourceWith({ OUTBOUND_HTTP_ALLOWED_HOSTS: '127.0.0.1' }));
    await expect(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a' }), trust: rsTrust() })).resolves.toBeTruthy();
  });

  it('does not read a key set that no pinned algorithm uses, and does not let its keys verify anything', async () => {
    // HS256 only is pinned; the key set is extra material at verification (saving such a trust is refused, see the trust tests)
    const hs = hsTrust({ keys: { hsSecrets: [{ kid: 'k1', secret: SECRET_A }], jwksUrl: url } });
    await expect(verifyIdentityAssertion({ token: await mint({ kid: 'k1' }), trust: hs })).resolves.toMatchObject({ subject: 'user-42' });
    // a token signed with a key of that set is refused for its algorithm: RS256 is not pinned
    await expectCode(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a' }), trust: hs }), 'invalid_assertion');
    expect(hits).toBe(0);
  });

  it('uses the configured public key first and the key set for what it does not cover', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const trust = rsTrust(url, { keys: { pem, jwksUrl: url } });
    // signed by the PEM's key: the key set is never read
    await expect(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: other.privateKey }), trust })).resolves.toBeTruthy();
    expect(hits).toBe(0);
    // signed by a key of the set: the PEM does not match, the set does
    await expect(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: privateA, kid: 'key-a' }), trust })).resolves.toBeTruthy();
    expect(hits).toBe(1);
    // a claim failure after a good signature is the token's, and ends the search
    await expectCode(verifyIdentityAssertion({ token: await mint({ alg: 'RS256', key: other.privateKey, aud: 'nope' }), trust }), 'invalid_assertion');
  });
});
