/**
 * Quota — IP scope and the domain registry.
 *
 * What is pinned here:
 *  - address keys (IPv4 as is, IPv6 per /64) and range matching, including an
 *    unreadable address, which only "everyone" ranges reach;
 *  - range validation: at least one, at most MAX_QUOTA_IP_RANGES, normalized;
 *  - `perAddress` counts each address on its own, `shared` counts the ranges once;
 *  - IP limits are counted NEXT TO the caller's own limits, never instead of them;
 *  - a call without a client address is not IP-limited; the address comes from
 *    the request context when the call does not name one;
 *  - `global` policies do not reach the domains added with the registry;
 *  - the policy API refuses IP rows that set more than rate limits, or no ranges.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const config = {
  quota: { policyCacheTtlSeconds: 0 },
  rateLimit: { provider: 'mongodb' },
};

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(await getDatabase())),
  };
});
vi.mock('@/lib/core/config', () => ({ getConfig: () => config }));
vi.mock('@/lib/core/cache', () => ({
  getCache: async () => ({ get: async () => undefined, set: async () => {}, del: async () => {} }),
}));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { getDatabase } from '@/lib/database';
import type { IQuotaPolicy, ITenant } from '@/lib/database';
import { runWithRequestContext } from '@/lib/core/requestContext';
import {
  checkConcurrency,
  checkRateLimit,
  resetQuotaGroupCacheForTests,
  type QuotaContext,
} from '@/lib/quota/quotaGuard';
import {
  addressMatchesRanges,
  parseClientIp,
  quotaAddressKey,
  validateQuotaIpRanges,
} from '@/lib/quota/ipScope';
import { ENFORCED_QUOTA_DOMAINS, domainFallsBackToGlobal } from '@/lib/quota/domains';
import { MAX_QUOTA_IP_RANGES, type QuotaLimits } from '@/lib/quota/types';
import { assertValidQuotaPolicy, QuotaPolicyValidationError } from '@/lib/services/quota/quotaService';
import { registerEnterpriseQuotaDomains, resetEnterpriseQuotaDomainsForTests } from '@/enterprise/quota-domains';

const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';

let seq = 0;
function policy(overrides: Partial<IQuotaPolicy>): IQuotaPolicy {
  seq += 1;
  return {
    _id: `p-${seq}`,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    domain: 'llm',
    scope: 'tenant',
    priority: 10,
    enabled: true,
    limits: {},
    ...overrides,
  } as IQuotaPolicy;
}

const rpm = (perMinute: number): QuotaLimits => ({ rateLimit: { requests: { perMinute } } });

function context(overrides: Partial<QuotaContext> = {}): QuotaContext {
  return {
    tenantDbName: 'tenant_acme',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    domain: 'llm',
    ...overrides,
  };
}

describe('ip scope — addresses and ranges', () => {
  it('keys IPv4 by the address and IPv6 by its /64', () => {
    expect(quotaAddressKey(parseClientIp('203.0.113.5'))).toBe('203.0.113.5');
    const a = quotaAddressKey(parseClientIp('2001:db8:1:2::1'));
    const b = quotaAddressKey(parseClientIp('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    const other = quotaAddressKey(parseClientIp('2001:db8:1:3::1'));
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(other).not.toBe(a);
    expect(quotaAddressKey(null)).toBe('invalid');
  });

  it('matches ranges; an unreadable address matches only an "everyone" range', () => {
    const ip = parseClientIp('10.1.2.3');
    expect(addressMatchesRanges(ip, ['10.0.0.0/8'])).toBe(true);
    expect(addressMatchesRanges(ip, ['192.168.0.0/16'])).toBe(false);
    expect(addressMatchesRanges(ip, [])).toBe(false);
    expect(addressMatchesRanges(null, ['10.0.0.0/8'])).toBe(false);
    expect(addressMatchesRanges(null, ['0.0.0.0/0'])).toBe(true);
    expect(addressMatchesRanges(parseClientIp('2001:db8::1'), ['2001:db8::/32'])).toBe(true);
  });

  it('validates ranges: at least one, at most the maximum, each a valid address or CIDR', () => {
    expect(validateQuotaIpRanges([]).ok).toBe(false);
    expect(validateQuotaIpRanges(undefined).ok).toBe(false);
    expect(validateQuotaIpRanges(['not-an-ip']).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_QUOTA_IP_RANGES + 1 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(validateQuotaIpRanges(tooMany).ok).toBe(false);
    const ok = validateQuotaIpRanges(['10.0.0.0/8', '203.0.113.5']);
    expect(ok.ok).toBe(true);
  });
});

describe('quota guard — ip scope', () => {
  let db: ReturnType<typeof createMockDb>;
  let counters: Map<string, number>;

  function setPolicies(...policies: IQuotaPolicy[]) {
    db.listQuotaPolicies.mockResolvedValue(policies);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetQuotaGroupCacheForTests();
    seq = 0;
    counters = new Map();
    db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: TENANT_ID, slug: 'acme' } as unknown as ITenant);
    db.listGroupMembersByUser.mockResolvedValue([] as never);
    db.incrementRateLimit.mockImplementation(async (key: string, _window: number, amount: number) => {
      const count = (counters.get(key) ?? 0) + amount;
      counters.set(key, count);
      return { count, resetAt: new Date(Date.now() + 60_000) };
    });
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  async function runs(ctx: QuotaContext, times: number) {
    const results = [];
    for (let i = 0; i < times; i += 1) results.push((await checkRateLimit(ctx, { requests: 1 })).allowed);
    return results;
  }

  it('perAddress: every address in the ranges gets its own count', async () => {
    setPolicies(policy({ scope: 'ip', ipRanges: ['10.0.0.0/8'], ipMode: 'perAddress', limits: rpm(2) }));

    expect(await runs(context({ clientIp: '10.0.0.1' }), 3)).toEqual([true, true, false]);
    expect(await runs(context({ clientIp: '10.0.0.2' }), 2)).toEqual([true, true]);
    // Outside the ranges: not limited.
    expect(await runs(context({ clientIp: '192.168.1.1' }), 3)).toEqual([true, true, true]);
    expect([...counters.keys()].filter((key) => key.includes('ip:'))).toEqual(
      expect.arrayContaining([expect.stringContaining('ip:10.0.0.1'), expect.stringContaining('ip:10.0.0.2')]),
    );
  });

  it('perAddress: IPv6 addresses of one /64 share a count', async () => {
    setPolicies(policy({ scope: 'ip', ipRanges: ['::/0'], ipMode: 'perAddress', limits: rpm(2) }));

    expect(await runs(context({ clientIp: '2001:db8:1:2::1' }), 1)).toEqual([true]);
    expect(await runs(context({ clientIp: '2001:db8:1:2::99' }), 2)).toEqual([true, false]);
    expect(await runs(context({ clientIp: '2001:db8:1:3::1' }), 1)).toEqual([true]);
  });

  it('shared: all addresses in the ranges draw from one count', async () => {
    setPolicies(policy({ scope: 'ip', ipRanges: ['10.0.0.0/8'], ipMode: 'shared', limits: rpm(2) }));

    expect(await runs(context({ clientIp: '10.0.0.1' }), 1)).toEqual([true]);
    expect(await runs(context({ clientIp: '10.9.9.9' }), 2)).toEqual([true, false]);
  });

  it('counts IP limits next to the caller\'s own limits: a call must pass both', async () => {
    setPolicies(
      policy({ scope: 'user', scopeId: 'u1', priority: 20, limits: rpm(1) }),
      policy({ scope: 'ip', ipRanges: ['10.0.0.0/8'], ipMode: 'perAddress', limits: rpm(5) }),
    );
    // The user limit (1) refuses even though the IP limit has room.
    expect(await runs(context({ userId: 'u1', clientIp: '10.0.0.1' }), 2)).toEqual([true, false]);

    setPolicies(
      policy({ scope: 'user', scopeId: 'u2', priority: 20, limits: rpm(5) }),
      policy({ scope: 'ip', ipRanges: ['10.0.0.0/8'], ipMode: 'perAddress', limits: rpm(1) }),
    );
    // The IP limit (1) refuses even though the user limit has room.
    const second = await runs(context({ userId: 'u2', clientIp: '10.0.0.7' }), 2);
    expect(second).toEqual([true, false]);
  });

  it('does not IP-limit a call without a client address', async () => {
    setPolicies(policy({ scope: 'ip', ipRanges: ['0.0.0.0/0', '::/0'], ipMode: 'shared', limits: rpm(1) }));
    expect(await runs(context(), 3)).toEqual([true, true, true]);
  });

  it('reads the client address from the request context when the call does not name it', async () => {
    setPolicies(policy({ scope: 'ip', ipRanges: ['10.0.0.0/8'], ipMode: 'perAddress', limits: rpm(1) }));
    const results = await runWithRequestContext({ clientIp: '10.0.0.1', tenantId: TENANT_ID }, () => runs(context(), 2));
    expect(results).toEqual([true, false]);
  });

  it('does not let a global policy reach a domain added with the registry', async () => {
    setPolicies(policy({ domain: 'global', scope: 'tenant', limits: rpm(1) }));
    expect(domainFallsBackToGlobal('websearch')).toBe(false);
    expect(domainFallsBackToGlobal('llm')).toBe(true);
    expect(await runs(context({ domain: 'websearch' }), 3)).toEqual([true, true, true]);
    // An existing domain still inherits it.
    expect(await runs(context({ domain: 'llm' }), 2)).toEqual([true, false]);
  });

  it('counts the units counter of a domain that has one', async () => {
    setPolicies(policy({ domain: 'crawler', scope: 'tenant', limits: { rateLimit: { units: { perHour: 10 } } } }));
    const ctx = context({ domain: 'crawler' });
    expect((await checkRateLimit(ctx, { units: 8 })).allowed).toBe(true);
    expect((await checkRateLimit(ctx, { units: 5 })).allowed).toBe(false);
  });

  it('refuses a new session at the concurrency limit', async () => {
    setPolicies(policy({ domain: 'browser', scope: 'tenant', limits: { perRequest: { maxConcurrentRequests: 2 } } }));
    expect((await checkConcurrency(context({ domain: 'browser' }), 1)).allowed).toBe(true);
    expect((await checkConcurrency(context({ domain: 'browser' }), 2)).allowed).toBe(false);
  });
});

describe('quota policy validation — ip scope', () => {
  const validate = (patch: Record<string, unknown>) =>
    assertValidQuotaPolicy('tenant_acme', TENANT_ID, patch as never, null);

  it('accepts an IP row with ranges and rate limits', async () => {
    await expect(validate({ scope: 'ip', domain: 'llm', ipRanges: ['10.0.0.0/8'], ipMode: 'shared', limits: rpm(10) }))
      .resolves.toBeUndefined();
  });

  it('refuses an IP row without ranges', async () => {
    await expect(validate({ scope: 'ip', domain: 'llm', ipRanges: [], limits: rpm(10) }))
      .rejects.toMatchObject({ code: 'invalid_ip_ranges' });
  });

  it('refuses an IP row that sets more than rate limits', async () => {
    await expect(validate({
      scope: 'ip',
      domain: 'llm',
      ipRanges: ['10.0.0.0/8'],
      limits: { ...rpm(10), budget: { dailySpendLimit: 5 } },
    })).rejects.toMatchObject({ code: 'ip_limits_rate_only' });
  });

  it('refuses IP fields on a row of another scope', async () => {
    await expect(validate({ scope: 'user', domain: 'llm', ipMode: 'shared' }))
      .rejects.toBeInstanceOf(QuotaPolicyValidationError);
    await expect(validate({ scope: 'user', domain: 'llm', ipRanges: ['10.0.0.0/8'] }))
      .rejects.toMatchObject({ code: 'ip_ranges_require_ip_scope' });
  });

  it('offers the sandbox and the overlay\'s job kinds only once the enterprise overlay registers them', async () => {
    resetEnterpriseQuotaDomainsForTests();
    await expect(validate({ scope: 'tenant', domain: 'sandbox' })).rejects.toMatchObject({ code: 'invalid_domain' });
    await expect(validate({ scope: 'resource', domain: 'jobs', scopeId: 'flow' })).rejects.toMatchObject({ code: 'invalid_job_kind' });
    await expect(validate({ scope: 'resource', domain: 'jobs', scopeId: 'analysis' })).resolves.toBeUndefined();

    registerEnterpriseQuotaDomains({ domains: ['sandbox'], jobKinds: ['flow'] });
    await expect(validate({ scope: 'tenant', domain: 'sandbox' })).resolves.toBeUndefined();
    await expect(validate({ scope: 'resource', domain: 'jobs', scopeId: 'flow' })).resolves.toBeUndefined();
    await expect(validate({ scope: 'resource', domain: 'jobs', scopeId: 'abacus' })).rejects.toMatchObject({ code: 'invalid_job_kind' });
    resetEnterpriseQuotaDomainsForTests();
  });

  it('accepts every enforced domain and refuses an unknown one', async () => {
    for (const domain of ENFORCED_QUOTA_DOMAINS) {
      await expect(validate({ scope: 'tenant', domain })).resolves.toBeUndefined();
    }
    await expect(validate({ scope: 'tenant', domain: 'nope' })).rejects.toMatchObject({ code: 'invalid_domain' });
  });
});
