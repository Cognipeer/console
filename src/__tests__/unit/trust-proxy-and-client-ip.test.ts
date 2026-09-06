/**
 * Regression tests for F-09 (finance-institution assessment, 2026-09-05):
 * getClientIp() read the raw X-Forwarded-For header directly, unconditionally
 * trusting the leftmost value -- any caller who could reach this process at
 * all (not just ones behind the real reverse proxy) could set an arbitrary
 * IP, which fed both the auth rate limiter's bucket key and audit IP
 * logging. trustProxy was also hardcoded to `true` (trust every hop),
 * regardless of whether a real proxy sat in front of this process.
 */
import { describe, it, expect } from 'vitest';
import { resolveTrustProxyOption } from '@/server/app';
import { getClientIp } from '@/server/api/fastify-utils';
import type { FastifyRequest } from 'fastify';

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

  it('treats a single numeric entry as a hop count', () => {
    expect(resolveTrustProxyOption(['1'])).toBe(1);
    expect(resolveTrustProxyOption(['2'])).toBe(2);
  });

  it('treats non-numeric entries as the real proxy/load balancer IPs or CIDRs', () => {
    expect(resolveTrustProxyOption(['10.0.0.5'])).toEqual(['10.0.0.5']);
    expect(resolveTrustProxyOption(['10.0.0.0/8', '172.16.0.0/12'])).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
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
