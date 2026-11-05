/**
 * The platform's per-address limit on the client and public APIs
 * (CLIENT_API_IP_RATE_LIMIT_PER_MINUTE): off by default, counted per address
 * (IPv6 per /64), only on /api/client/* and /api/public/*.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = { rateLimit: { provider: 'memory', maxTrackedKeys: 1000, clientApiIpPerMinute: 0 } };
vi.mock('@/lib/core/config', () => ({ getConfig: () => config }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { checkPlatformIpLimit, isPlatformIpLimitedPath } from '@/server/api/platformIpLimit';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';

async function decisions(ip: string | undefined, times: number) {
  const out: boolean[] = [];
  for (let i = 0; i < times; i += 1) out.push((await checkPlatformIpLimit(ip)).allowed);
  return out;
}

describe('platform IP limit', () => {
  beforeEach(() => {
    resetRateLimitStore();
    config.rateLimit.clientApiIpPerMinute = 0;
  });

  it('covers the client and public APIs only', () => {
    expect(isPlatformIpLimitedPath('/api/client/v1/chat/completions')).toBe(true);
    expect(isPlatformIpLimitedPath('/api/public/mcp/abc')).toBe(true);
    expect(isPlatformIpLimitedPath('/api/auth/login')).toBe(false);
    expect(isPlatformIpLimitedPath('/api/health/live')).toBe(false);
    expect(isPlatformIpLimitedPath('/api/metrics')).toBe(false);
  });

  it('is off by default', async () => {
    expect(await decisions('198.51.100.1', 50)).not.toContain(false);
  });

  it('refuses an address over the limit, with a retry time, and counts addresses apart', async () => {
    config.rateLimit.clientApiIpPerMinute = 2;
    expect(await decisions('198.51.100.2', 3)).toEqual([true, true, false]);
    const refused = await checkPlatformIpLimit('198.51.100.2');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(await decisions('198.51.100.3', 2)).toEqual([true, true]);
  });

  it('counts IPv6 per /64 and skips a request without an address', async () => {
    config.rateLimit.clientApiIpPerMinute = 2;
    expect(await decisions('2001:db8:aa:1::1', 1)).toEqual([true]);
    expect(await decisions('2001:db8:aa:1::2', 2)).toEqual([true, false]);
    expect(await decisions(undefined, 5)).not.toContain(false);
  });
});
