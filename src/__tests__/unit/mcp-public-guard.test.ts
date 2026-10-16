/**
 * Limits on the public MCP endpoints: how a client address is counted, the
 * request rates (per address and endpoint, per endpoint as a whole, and per
 * address overall), and the cap on a tenant's concurrent tool calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const cache = vi.hoisted(() => ({
  current: null as null | { name: string; incrementCounter: ReturnType<typeof vi.fn> },
}));

vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => {
    if (!cache.current) throw new Error('no cache');
    return cache.current;
  }),
}));

import type { IMcpServer } from '@/lib/database';
import {
  acquirePublicCallSlot,
  checkPublicAddressRate,
  checkPublicEndpointRate,
  clientAddressBucket,
  publicCallsInFlight,
  resetPublicGuardState,
} from '@/lib/services/mcp/publicGuard';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';

const originalSource = getConfigSource();

function setTestConfig(values: Record<string, string | undefined> = {}) {
  const source: ConfigSource = { name: 'test', get: (key) => values[key] };
  setConfigSource(source);
}

/** The stored record a limiter key is built from. */
function endpoint(overrides: Partial<Pick<IMcpServer, 'tenantId' | '_id' | 'key'>> = {}) {
  return { tenantId: 't1', _id: 'srv-a', key: 'key-a', ...overrides } as Pick<IMcpServer, 'tenantId' | '_id' | 'key'>;
}

beforeEach(() => {
  setTestConfig();
  resetRateLimitStore();
  resetPublicGuardState();
  cache.current = null;
});

afterEach(() => {
  setConfigSource(originalSource);
});

describe('clientAddressBucket', () => {
  it('counts an IPv4 address as itself', () => {
    expect(clientAddressBucket('203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts an IPv4-mapped IPv6 address as the IPv4 address, in either spelling', () => {
    expect(clientAddressBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressBucket('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(clientAddressBucket('0:0:0:0:0:ffff:7f00:1')).toBe('127.0.0.1');
  });

  it('counts every address of an IPv6 /64 as one', () => {
    const a = clientAddressBucket('2001:db8:1:2::1');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(clientAddressBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe(a);
    expect(clientAddressBucket('2001:db8:1:2:aaaa::')).toBe(a);
    expect(clientAddressBucket('2001:db8:1:3::1')).not.toBe(a);
  });

  it('expands the shorthand forms', () => {
    expect(clientAddressBucket('::1')).toBe('0:0:0:0::/64');
    expect(clientAddressBucket('::')).toBe('0:0:0:0::/64');
    expect(clientAddressBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientAddressBucket('[2001:db8::5]')).toBe('2001:db8:0:0::/64');
  });

  it('keeps something bounded for text that is not an address', () => {
    expect(clientAddressBucket('unknown')).toBe('unknown');
    expect(clientAddressBucket('')).toBe('unknown');
    expect(clientAddressBucket(undefined)).toBe('unknown');
    expect(clientAddressBucket('x'.repeat(500))).toHaveLength(64);
    expect(clientAddressBucket('1:2:3:4:5:6:7:8:9')).toHaveLength(17);
  });
});

describe('request rate per address and endpoint', () => {
  const caller = { server: endpoint(), clientAddress: '203.0.113.7' };

  it('lets a caller through up to the limit, then refuses with a retry hint', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '3' });
    for (let i = 0; i < 3; i += 1) {
      expect((await checkPublicEndpointRate(caller)).allowed).toBe(true);
    }
    const refused = await checkPublicEndpointRate(caller);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts each address and each endpoint separately', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1' });
    expect((await checkPublicEndpointRate(caller)).allowed).toBe(true);
    expect((await checkPublicEndpointRate(caller)).allowed).toBe(false);
    expect((await checkPublicEndpointRate({ ...caller, clientAddress: '203.0.113.8' })).allowed).toBe(true);
    expect((await checkPublicEndpointRate({ ...caller, server: endpoint({ _id: 'srv-b' }) })).allowed).toBe(true);
    expect((await checkPublicEndpointRate({ ...caller, server: endpoint({ tenantId: 't2' }) })).allowed).toBe(true);
  });

  it('counts the addresses of one IPv6 /64 together', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1' });
    expect((await checkPublicEndpointRate({ ...caller, clientAddress: '2001:db8:1:2::1' })).allowed).toBe(true);
    expect((await checkPublicEndpointRate({ ...caller, clientAddress: '2001:db8:1:2::2' })).allowed).toBe(false);
  });

  it('does not limit when the limit is 0', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0' });
    for (let i = 0; i < 50; i += 1) {
      expect((await checkPublicEndpointRate(caller)).allowed).toBe(true);
    }
  });

  it('defaults to 300 a minute', async () => {
    for (let i = 0; i < 300; i += 1) {
      expect((await checkPublicEndpointRate(caller)).allowed, `request ${i + 1}`).toBe(true);
    }
    expect((await checkPublicEndpointRate(caller)).allowed).toBe(false);
  });

  describe('with RATE_LIMIT_PROVIDER=redis', () => {
    beforeEach(() => {
      setTestConfig({
        MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5',
        RATE_LIMIT_PROVIDER: 'redis',
        CACHE_PROVIDER: 'redis',
        REDIS_URL: 'redis://localhost:6379',
      });
    });

    it('also counts in the shared store, so the limit holds across replicas', async () => {
      const counts = new Map<string, number>();
      cache.current = {
        name: 'redis',
        incrementCounter: vi.fn(async (key: string, ttl: number) => {
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return { count, resetAt: new Date(Date.now() + ttl * 1000) };
        }),
      };
      // Another replica already served four requests for this caller.
      counts.set('mcp-public:t1:srv-a:203.0.113.7', 4);

      expect((await checkPublicEndpointRate(caller)).allowed).toBe(true);
      const refused = await checkPublicEndpointRate(caller);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(cache.current.incrementCounter).toHaveBeenCalledWith('mcp-public:t1:srv-a:203.0.113.7', 60, 1);
    });

    it('falls back to the process-local limit when the shared store fails', async () => {
      cache.current = {
        name: 'redis',
        incrementCounter: vi.fn(async () => { throw new Error('redis down'); }),
      };
      for (let i = 0; i < 5; i += 1) {
        expect((await checkPublicEndpointRate(caller)).allowed).toBe(true);
      }
      expect((await checkPublicEndpointRate(caller)).allowed).toBe(false);
    });

    it('uses only the local limit when the cache is not the configured provider', async () => {
      cache.current = {
        name: 'memory',
        incrementCounter: vi.fn(async () => ({ count: 1000, resetAt: new Date() })),
      };
      expect((await checkPublicEndpointRate(caller)).allowed).toBe(true);
      expect(cache.current.incrementCounter).not.toHaveBeenCalled();
    });

    function sharedStore(counts = new Map<string, number>()) {
      const incrementCounter = vi.fn(async (key: string, ttl: number) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { count, resetAt: new Date(Date.now() + ttl * 1000) };
      });
      cache.current = { name: 'redis', incrementCounter };
      return { counts, incrementCounter };
    }

    it('also counts the endpoint as a whole in the shared store', async () => {
      setTestConfig({
        MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '100',
        MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '12',
        RATE_LIMIT_PROVIDER: 'redis',
        CACHE_PROVIDER: 'redis',
        REDIS_URL: 'redis://localhost:6379',
      });
      const { counts, incrementCounter } = sharedStore();
      // The other replicas already served eleven requests for this endpoint.
      counts.set('mcp-public-endpoint:t1:srv-a', 11);

      expect((await checkPublicEndpointRate(caller)).allowed).toBe(true);
      const refused = await checkPublicEndpointRate({ ...caller, clientAddress: '203.0.113.99' });
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(incrementCounter).toHaveBeenCalledWith('mcp-public-endpoint:t1:srv-a', 60, 1);
    });

    it('does not count a request in the endpoint-wide shared counter when its own address is refused', async () => {
      const { counts, incrementCounter } = sharedStore();
      // The caller is already at its limit of five in the shared store.
      counts.set('mcp-public:t1:srv-a:203.0.113.7', 5);

      expect((await checkPublicEndpointRate(caller)).allowed).toBe(false);
      expect(incrementCounter.mock.calls.map(([key]) => key)).toEqual(['mcp-public:t1:srv-a:203.0.113.7']);
    });

    it('asks the shared store again only after a pause once it has failed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
        const incrementCounter = vi.fn(async () => { throw new Error('redis down'); });
        cache.current = { name: 'redis', incrementCounter };

        for (let i = 0; i < 4; i += 1) {
          expect((await checkPublicEndpointRate({ ...caller, clientAddress: `203.0.113.${i + 1}` })).allowed).toBe(true);
        }
        // One failed attempt; the three requests after it did not wait on the store.
        expect(incrementCounter).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2030-01-01T00:00:11Z'));
        await checkPublicEndpointRate({ ...caller, clientAddress: '203.0.113.50' });
        expect(incrementCounter).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps applying the local limits while the shared store is being skipped', async () => {
      cache.current = {
        name: 'redis',
        incrementCounter: vi.fn(async () => { throw new Error('redis down'); }),
      };
      for (let i = 0; i < 5; i += 1) await checkPublicEndpointRate(caller);
      expect((await checkPublicEndpointRate(caller)).allowed).toBe(false);
    });
  });

  it('keeps a process-local count only for the other providers', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '1', RATE_LIMIT_PROVIDER: 'mongodb' });
    cache.current = { name: 'redis', incrementCounter: vi.fn(async () => ({ count: 1, resetAt: new Date() })) };
    expect((await checkPublicEndpointRate(caller)).allowed).toBe(true);
    expect(cache.current.incrementCounter).not.toHaveBeenCalled();
  });
});

describe('request rate per endpoint, all callers together', () => {
  const from = (n: number, server = endpoint()) => ({ server, clientAddress: `198.51.100.${(n % 250) + 1}` });

  it('refuses once the endpoint has served its rate, whichever addresses the requests came from', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '12' });
    const allowed: boolean[] = [];
    // A different address for every request: none of them is near the per-address rate.
    for (let i = 0; i < 20; i += 1) {
      allowed.push((await checkPublicEndpointRate(from(i))).allowed);
    }
    expect(allowed.slice(0, 12)).toEqual(Array(12).fill(true));
    expect(allowed.slice(12)).toEqual(Array(8).fill(false));
  });

  it('answers a refusal with a retry hint inside the window', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '1' });
    await checkPublicEndpointRate(from(1));
    const refused = await checkPublicEndpointRate(from(2));
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('defaults to twenty times the per-address rate', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '3' });
    for (let i = 0; i < 60; i += 1) {
      expect((await checkPublicEndpointRate(from(i))).allowed, `request ${i + 1}`).toBe(true);
    }
    expect((await checkPublicEndpointRate(from(60))).allowed).toBe(false);
  });

  it('is 6000 a minute with the default per-address rate', async () => {
    for (let i = 0; i < 6000; i += 1) {
      // 200 addresses, each within its own 300 a minute.
      expect((await checkPublicEndpointRate({ server: endpoint(), clientAddress: `10.0.${i % 200}.1` })).allowed, `request ${i + 1}`).toBe(true);
    }
    expect((await checkPublicEndpointRate({ server: endpoint(), clientAddress: '10.0.250.1' })).allowed).toBe(false);
  });

  it('counts each endpoint on its own', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '2' });
    const other = endpoint({ _id: 'srv-b' });
    expect((await checkPublicEndpointRate(from(1))).allowed).toBe(true);
    expect((await checkPublicEndpointRate(from(2))).allowed).toBe(true);
    expect((await checkPublicEndpointRate(from(3))).allowed).toBe(false);
    expect((await checkPublicEndpointRate(from(4, other))).allowed).toBe(true);
    expect((await checkPublicEndpointRate(from(5, endpoint({ tenantId: 't2' })))).allowed).toBe(true);
  });

  it('holds the endpoint to its rate while the limiter keeps meeting addresses it has not seen', async () => {
    setTestConfig({
      MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5',
      MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '50',
      RATE_LIMIT_MAX_TRACKED_KEYS: '100',
    });
    let allowed = 0;
    for (let i = 0; i < 2000; i += 1) {
      // 2,000 different addresses, against a limiter that keeps 100 counters.
      const decision = await checkPublicEndpointRate({ server: endpoint(), clientAddress: `10.${i >> 8}.${i & 255}.9` });
      if (decision.allowed) allowed += 1;
    }
    expect(allowed).toBe(50);
  });

  it('does not take a request its own address was refused for', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '2', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '5' });
    const outcomes: boolean[] = [];
    for (let i = 0; i < 30; i += 1) {
      outcomes.push((await checkPublicEndpointRate({ server: endpoint(), clientAddress: '203.0.113.7' })).allowed);
    }
    expect(outcomes.filter(Boolean)).toHaveLength(2);
    // Three of the endpoint's five requests are left for everyone else.
    for (let i = 0; i < 3; i += 1) {
      expect((await checkPublicEndpointRate(from(i))).allowed, `other caller ${i + 1}`).toBe(true);
    }
    expect((await checkPublicEndpointRate(from(3))).allowed).toBe(false);
  });

  it('can be turned off on its own with 0', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '5', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '0' });
    for (let i = 0; i < 300; i += 1) {
      expect((await checkPublicEndpointRate(from(i))).allowed).toBe(true);
    }
    // The per-address rate still applies.
    for (let i = 0; i < 5; i += 1) await checkPublicEndpointRate(from(1000));
    expect((await checkPublicEndpointRate(from(1000))).allowed).toBe(false);
  });

  it('is off with the per-address rate when that is 0 and this is not set', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0' });
    for (let i = 0; i < 200; i += 1) {
      expect((await checkPublicEndpointRate(from(i))).allowed).toBe(true);
    }
  });

  it('applies on its own when it is set and the per-address rate is 0', async () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0', MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE: '3' });
    expect((await checkPublicEndpointRate(from(1))).allowed).toBe(true);
    expect((await checkPublicEndpointRate(from(1))).allowed).toBe(true);
    expect((await checkPublicEndpointRate(from(1))).allowed).toBe(true);
    expect((await checkPublicEndpointRate(from(1))).allowed).toBe(false);
  });
});

describe('counter keys', () => {
  function redisConfig() {
    setTestConfig({
      RATE_LIMIT_PROVIDER: 'redis',
      CACHE_PROVIDER: 'redis',
      REDIS_URL: 'redis://localhost:6379',
    });
    const incrementCounter = vi.fn(async (_key: string, ttl: number) => ({
      count: 1,
      resetAt: new Date(Date.now() + ttl * 1000),
    }));
    cache.current = { name: 'redis', incrementCounter };
    return incrementCounter;
  }

  it('are built from the ids of the stored record', async () => {
    const incrementCounter = redisConfig();
    await checkPublicEndpointRate({
      server: endpoint({ tenantId: 'tenant-1', _id: 'srv-9', key: 'my-key' }),
      clientAddress: '203.0.113.7',
    });
    expect(incrementCounter.mock.calls.map(([key]) => key)).toEqual([
      'mcp-public:tenant-1:srv-9:203.0.113.7',
      'mcp-public-endpoint:tenant-1:srv-9',
    ]);
  });

  it('use the server key when the record carries no id', async () => {
    const incrementCounter = redisConfig();
    await checkPublicEndpointRate({
      server: { tenantId: 'tenant-1', key: 'my-key' } as Pick<IMcpServer, 'tenantId' | '_id' | 'key'>,
      clientAddress: '203.0.113.7',
    });
    expect(incrementCounter.mock.calls.map(([key]) => key)).toEqual([
      'mcp-public:tenant-1:my-key:203.0.113.7',
      'mcp-public-endpoint:tenant-1:my-key',
    ]);
  });

  it('stringify an object id the way the database prints it', async () => {
    const incrementCounter = redisConfig();
    const id = { toString: () => '64b7f0c2a1b2c3d4e5f60718' } as unknown as IMcpServer['_id'];
    await checkPublicEndpointRate({ server: endpoint({ _id: id }), clientAddress: '203.0.113.7' });
    expect(incrementCounter.mock.calls[1][0]).toBe('mcp-public-endpoint:t1:64b7f0c2a1b2c3d4e5f60718');
  });
});

describe('request rate per address, across endpoints', () => {
  it('allows ten times the per-endpoint rate before refusing', () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '2' });
    for (let i = 0; i < 20; i += 1) {
      expect(checkPublicAddressRate('203.0.113.7').allowed, `request ${i + 1}`).toBe(true);
    }
    const refused = checkPublicAddressRate('203.0.113.7');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(checkPublicAddressRate('203.0.113.8').allowed).toBe(true);
  });

  it('is off when the limit is 0', () => {
    setTestConfig({ MCP_PUBLIC_RATE_LIMIT_PER_MINUTE: '0' });
    for (let i = 0; i < 100; i += 1) expect(checkPublicAddressRate('203.0.113.7').allowed).toBe(true);
  });
});

describe('concurrent tool calls per tenant', () => {
  it('hands out slots up to the limit and refuses beyond it', () => {
    setTestConfig({ MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT: '2' });
    const a = acquirePublicCallSlot('t1');
    const b = acquirePublicCallSlot('t1');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(publicCallsInFlight('t1')).toBe(2);
    expect(acquirePublicCallSlot('t1')).toBeNull();
    a?.();
    b?.();
  });

  it('gives a slot back when the call ends, once however often it is released', () => {
    setTestConfig({ MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT: '1' });
    const first = acquirePublicCallSlot('t1');
    expect(acquirePublicCallSlot('t1')).toBeNull();
    first?.();
    first?.();
    expect(publicCallsInFlight('t1')).toBe(0);
    const second = acquirePublicCallSlot('t1');
    expect(second).not.toBeNull();
    // The earlier, repeated release must not have freed the second call's slot.
    first?.();
    expect(acquirePublicCallSlot('t1')).toBeNull();
    second?.();
  });

  it('counts each tenant on its own', () => {
    setTestConfig({ MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT: '1' });
    const a = acquirePublicCallSlot('t1');
    expect(acquirePublicCallSlot('t2')).not.toBeNull();
    expect(acquirePublicCallSlot('t1')).toBeNull();
    a?.();
  });

  it('is off when the limit is 0', () => {
    setTestConfig({ MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT: '0' });
    const slots = Array.from({ length: 500 }, () => acquirePublicCallSlot('t1'));
    expect(slots.every((slot) => slot !== null)).toBe(true);
    expect(publicCallsInFlight('t1')).toBe(0);
  });

  it('defaults to 100 at a time', () => {
    const slots = Array.from({ length: 100 }, () => acquirePublicCallSlot('t1'));
    expect(slots.every((slot) => slot !== null)).toBe(true);
    expect(acquirePublicCallSlot('t1')).toBeNull();
    slots.forEach((slot) => slot?.());
    expect(publicCallsInFlight('t1')).toBe(0);
  });
});
