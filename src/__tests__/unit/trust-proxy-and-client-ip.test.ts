/**
 * Regression tests for F-09 (finance-institution assessment, 2026-09-05):
 * getClientIp() read the raw X-Forwarded-For header directly, unconditionally
 * trusting the leftmost value -- any caller who could reach this process at
 * all (not just ones behind the real reverse proxy) could set an arbitrary
 * IP, which fed both the auth rate limiter's bucket key and audit IP
 * logging. trustProxy was also hardcoded to `true` (trust every hop),
 * regardless of whether a real proxy sat in front of this process.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { resolveTrustProxyOption } from '@/server/app';
import { getAuthzClientIp, getClientIp, trustsEveryHop } from '@/server/api/fastify-utils';
import { reloadConfig } from '@/lib/core/config';
import Fastify, { type FastifyRequest } from 'fastify';

function makeRequest(overrides: {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}): FastifyRequest {
  return {
    ip: overrides.ip ?? '',
    headers: overrides.headers ?? {},
  } as unknown as FastifyRequest;
}

describe('resolveTrustProxyOption', () => {
  it('defaults to trusting every hop when unconfigured (unchanged behavior for existing deployments)', () => {
    expect(resolveTrustProxyOption([])).toBe(true);
  });

  it('fails closed for legacy numeric hop counts instead of bypassing Fastify hardening', () => {
    expect(resolveTrustProxyOption(['0'])).toBe(false);
    expect(resolveTrustProxyOption(['1'])).toBe(false);
    expect(resolveTrustProxyOption(['2'])).toBe(false);
  });

  it('treats non-numeric entries as the real proxy/load balancer IPs or CIDRs', () => {
    expect(resolveTrustProxyOption(['10.0.0.5'])).toEqual(['10.0.0.5']);
    expect(resolveTrustProxyOption(['10.0.0.0/8', '172.16.0.0/12'])).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('ignores spoofed forwarded headers for numeric settings and only trusts allowlisted peers', async () => {
    for (const [settings, remoteAddress, expectedIp] of [
      [['1'], '10.0.0.5', '10.0.0.5'],
      [['10.0.0.0/8'], '192.0.2.10', '192.0.2.10'],
      [['10.0.0.0/8'], '10.0.0.5', '203.0.113.9'],
    ] as const) {
      const app = Fastify({ trustProxy: resolveTrustProxyOption([...settings]) });
      app.get('/probe', (request) => ({ ip: getClientIp(request) }));
      try {
        const response = await app.inject({
          method: 'GET', url: '/probe', remoteAddress,
          headers: { 'x-forwarded-for': '203.0.113.9' },
        });
        expect(response.json()).toEqual({ ip: expectedIp });
      } finally {
        await app.close();
      }
    }
  });
});

describe('getClientIp', () => {
  it('uses request.ip -- Fastify\'s own trust-boundary-aware resolution -- when present', () => {
    // request.ip already reflects whatever trustProxy decided is real; a
    // spoofed XFF header must not override it.
    const request = makeRequest({
      ip: '203.0.113.9',
      headers: { 'x-forwarded-for': '6.6.6.6' },
    });

    expect(getClientIp(request)).toBe('203.0.113.9');
  });

  it('never reads X-Forwarded-For itself, even with no request.ip to fall back on', () => {
    // The old implementation read the header directly here, which bypassed
    // trustProxy entirely -- any caller able to reach the process could name
    // their own IP for the auth rate limiter and the audit log. Fastify
    // already folds a TRUSTED proxy's XFF into request.ip; anything else is
    // the caller talking about themselves.
    const request = makeRequest({
      ip: '',
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });

    expect(getClientIp(request)).toBe('unknown');
  });

  it('never reads X-Real-IP itself either', () => {
    const request = makeRequest({
      ip: '',
      headers: { 'x-real-ip': '203.0.113.9' },
    });

    expect(getClientIp(request)).toBe('unknown');
  });

  it('returns "unknown" rather than throwing when nothing is available', () => {
    const request = makeRequest({ ip: '' });
    expect(getClientIp(request)).toBe('unknown');
  });
});

// ── the address AUTHORIZATION decisions use ─────────────────────────────────

describe('getAuthzClientIp (token IP allowlists, policy `ip` conditions)', () => {
  const saved = process.env.TRUSTED_PROXIES;
  const withProxies = (value: string | undefined) => {
    if (value === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = value;
    reloadConfig();
  };
  afterEach(() => {
    withProxies(saved);
  });

  const inject = async (trustedProxies: string[], remoteAddress: string, headers: Record<string, string> = {}) => {
    withProxies(trustedProxies.length > 0 ? trustedProxies.join(',') : undefined);
    const app = Fastify({ trustProxy: resolveTrustProxyOption(trustedProxies) });
    app.get('/probe', (request) => ({ authz: getAuthzClientIp(request), audit: getClientIp(request), requestIp: request.ip }));
    try {
      return (await app.inject({ method: 'GET', url: '/probe', remoteAddress, headers })).json() as { authz: string; audit: string; requestIp: string };
    } finally {
      await app.close();
    }
  };

  it('with no trusted proxy (trustProxy: true) it is the connection peer: a forwarded header is the caller talking about itself', async () => {
    expect(trustsEveryHop()).toBe(true);
    const res = await inject([], '198.51.100.7', { 'x-forwarded-for': '203.0.113.9' });
    expect(res.authz).toBe('198.51.100.7');
    // ... while the audit/rate-limit address keeps following Fastify (unchanged behaviour)
    expect(res.audit).toBe('203.0.113.9');
    expect(res.requestIp).toBe('203.0.113.9');
    // a proxy that appends still cannot make the client's own entry count
    expect((await inject([], '10.0.0.5', { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' })).authz).toBe('10.0.0.5');
  });

  it('with trusted proxies it is what Fastify resolved through them, and a stranger\'s header still counts for nothing', async () => {
    withProxies('10.0.0.0/8');
    expect(trustsEveryHop()).toBe(false);
    expect((await inject(['10.0.0.0/8'], '10.0.0.5', { 'x-forwarded-for': '203.0.113.9' })).authz).toBe('203.0.113.9'); // the proxy's word
    expect((await inject(['10.0.0.0/8'], '10.0.0.5', { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })).authz).toBe('203.0.113.9'); // what the client prepended is ignored
    expect((await inject(['10.0.0.0/8'], '198.51.100.7', { 'x-forwarded-for': '203.0.113.9' })).authz).toBe('198.51.100.7'); // not a proxy
  });

  it('an unusable configuration reads as "trust nobody" for rules', () => {
    withProxies(undefined);
    expect(trustsEveryHop()).toBe(true);
  });

  it('returns "unknown" rather than throwing when there is no peer at all', () => {
    withProxies(undefined);
    expect(getAuthzClientIp({ ip: '', raw: {}, headers: {} } as unknown as FastifyRequest)).toBe('unknown');
  });
});
