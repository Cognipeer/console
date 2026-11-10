/**
 * Redis Cache Provider — uses ioredis.
 * Selected when CACHE_PROVIDER=redis.
 *
 * Requires REDIS_URL to be set.
 * Suitable for multi-instance / horizontal scaling.
 */

import { randomUUID } from 'crypto';
import { getThisNodeName } from '../cluster/nodeRegistry';
import type { CacheProvider, LeaseAcquireResult, RateTakeResult } from './cacheProvider.interface';

// ioredis is an optional dependency — only imported when this provider is used
let Redis: typeof import('ioredis').default;

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const INCREMENT_COUNTER_SCRIPT = `
local count = redis.call("incrby", KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) then
  redis.call("expire", KEYS[1], ARGV[2])
end
local ttl = redis.call("ttl", KEYS[1])
if ttl < 0 then
  redis.call("expire", KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
return { count, ttl }
`;

// GCRA, 1-minute burst. ARGV: limitPerMinute, nowMs. Returns { allowed, retryAfterMs, remaining, resetAfterMs }.
const RATE_TAKE_SCRIPT = `
local limit = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local window = 60000
local interval = window / limit
local stored = tonumber(redis.call("get", KEYS[1]))
local tat = now
if stored and stored > now then tat = stored end
local newTat = tat + interval
local diff = newTat - now
if diff > window then
  return { 0, math.ceil(diff - window), 0, math.ceil(math.max(0, tat - now)) }
end
redis.call("set", KEYS[1], string.format("%.3f", newTat), "PX", 120000)
return { 1, 0, math.floor((window - diff) / interval), math.ceil(diff) }
`;

// Lease set as a sorted set: member -> expiry ms. ARGV: member, limit (-1 = none), ttlMs, nowMs.
const LEASE_ACQUIRE_SCRIPT = `
redis.call("zremrangebyscore", KEYS[1], "-inf", ARGV[4])
local expiry = tonumber(ARGV[4]) + tonumber(ARGV[3])
if redis.call("zscore", KEYS[1], ARGV[1]) then
  redis.call("zadd", KEYS[1], expiry, ARGV[1])
  redis.call("pexpire", KEYS[1], ARGV[3])
  return { 1, redis.call("zcard", KEYS[1]) }
end
local count = redis.call("zcard", KEYS[1])
local limit = tonumber(ARGV[2])
if limit >= 0 and count >= limit then
  return { 0, count }
end
redis.call("zadd", KEYS[1], expiry, ARGV[1])
redis.call("pexpire", KEYS[1], ARGV[3])
return { 1, count + 1 }
`;

// ARGV: member, ttlMs, nowMs. Returns 1 when the member was held and live.
const LEASE_RENEW_SCRIPT = `
local score = redis.call("zscore", KEYS[1], ARGV[1])
if not score or tonumber(score) <= tonumber(ARGV[3]) then
  return 0
end
redis.call("zadd", KEYS[1], tonumber(ARGV[3]) + tonumber(ARGV[2]), ARGV[1])
redis.call("pexpire", KEYS[1], ARGV[2])
return 1
`;

// ARGV: nowMs.
const LEASE_COUNT_SCRIPT = `
redis.call("zremrangebyscore", KEYS[1], "-inf", ARGV[1])
return redis.call("zcard", KEYS[1])
`;

export class RedisCacheProvider implements CacheProvider {
  readonly name = 'redis';
  private client: InstanceType<typeof Redis> | null = null;
  private readonly url: string;
  private readonly keyPrefix: string;
  private readonly defaultTtl: number;

  /**
   * @param url Redis connection URL (e.g. redis://localhost:6379)
   * @param keyPrefix Prefix for all cache keys (default 'console:')
   * @param defaultTtlSeconds Default TTL in seconds (0 = no expiry)
   */
  constructor(url: string, keyPrefix: string = 'console:', defaultTtlSeconds: number = 300) {
    this.url = url;
    this.keyPrefix = keyPrefix;
    this.defaultTtl = defaultTtlSeconds;
  }

  async init(): Promise<void> {
    // Dynamic import so ioredis is truly optional
    const ioredis = await import('ioredis');
    Redis = ioredis.default;
    this.client = new Redis(this.url, {
      keyPrefix: this.keyPrefix,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 3000),
      lazyConnect: true,
      connectionName: `console:${getThisNodeName()}:cache`,
    });
    await this.client.connect();
  }

  private ensureClient(): InstanceType<typeof Redis> {
    if (!this.client) {
      throw new Error('RedisCacheProvider not initialized. Call init() first.');
    }
    return this.client;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.ensureClient().get(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtl;
    const serialized = JSON.stringify(value);
    if (ttl > 0) {
      await this.ensureClient().set(key, serialized, 'EX', ttl);
    } else {
      await this.ensureClient().set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.ensureClient().del(key);
  }

  async has(key: string): Promise<boolean> {
    const exists = await this.ensureClient().exists(key);
    return exists === 1;
  }

  async clear(): Promise<void> {
    const client = this.ensureClient();
    // Only clear keys with our prefix
    const keys = await client.keys('*');
    if (keys.length > 0) {
      // Keys already have the prefix stripped by ioredis keyPrefix
      const pipeline = client.pipeline();
      for (const key of keys) {
        pipeline.del(key);
      }
      await pipeline.exec();
    }
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | undefined> {
    const ttl = Math.max(1, Math.ceil(ttlSeconds));
    const token = randomUUID();
    const result = await this.ensureClient().set(key, token, 'EX', ttl, 'NX');
    return result === 'OK' ? token : undefined;
  }

  async incrementCounter(
    key: string,
    ttlSeconds: number,
    amount: number = 1,
  ): Promise<{ count: number; resetAt: Date }> {
    const ttl = Math.max(1, Math.ceil(ttlSeconds));
    const incrementBy = Math.max(0, Math.ceil(amount));
    const result = await this.ensureClient().eval(
      INCREMENT_COUNTER_SCRIPT,
      1,
      key,
      String(incrementBy),
      String(ttl),
    );

    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('Unexpected Redis counter response');
    }

    const count = Number(result[0]);
    const remainingTtl = Number(result[1]);
    return {
      count,
      resetAt: new Date(Date.now() + Math.max(1, remainingTtl) * 1000),
    };
  }

  async rateTake(key: string, limitPerMinute: number, nowMs: number = Date.now()): Promise<RateTakeResult> {
    const result = await this.ensureClient().eval(
      RATE_TAKE_SCRIPT,
      1,
      key,
      String(limitPerMinute),
      String(nowMs),
    );
    if (!Array.isArray(result) || result.length < 4) {
      throw new Error('Unexpected Redis rate response');
    }
    return {
      allowed: Number(result[0]) === 1,
      retryAfterMs: Number(result[1]),
      remaining: Number(result[2]),
      resetAfterMs: Number(result[3]),
    };
  }

  async leaseAcquire(
    key: string,
    member: string,
    limit: number | null,
    ttlMs: number,
    nowMs: number = Date.now(),
  ): Promise<LeaseAcquireResult> {
    const result = await this.ensureClient().eval(
      LEASE_ACQUIRE_SCRIPT,
      1,
      key,
      member,
      String(limit === null ? -1 : limit),
      String(Math.max(1, Math.ceil(ttlMs))),
      String(nowMs),
    );
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('Unexpected Redis lease response');
    }
    return { acquired: Number(result[0]) === 1, count: Number(result[1]) };
  }

  async leaseRenew(key: string, member: string, ttlMs: number): Promise<boolean> {
    const result = await this.ensureClient().eval(
      LEASE_RENEW_SCRIPT,
      1,
      key,
      member,
      String(Math.max(1, Math.ceil(ttlMs))),
      String(Date.now()),
    );
    return Number(result) === 1;
  }

  async leaseRelease(key: string, member: string): Promise<void> {
    await this.ensureClient().zrem(key, member);
  }

  async leaseCount(key: string): Promise<number> {
    const result = await this.ensureClient().eval(LEASE_COUNT_SCRIPT, 1, key, String(Date.now()));
    return Number(result);
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.ensureClient().eval(RELEASE_LOCK_SCRIPT, 1, key, token);
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
