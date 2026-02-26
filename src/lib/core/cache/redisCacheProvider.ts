/**
 * Redis Cache Provider — uses ioredis.
 * Selected when CACHE_PROVIDER=redis.
 *
 * Requires REDIS_URL to be set.
 * Suitable for multi-instance / horizontal scaling.
 */

import type { CacheProvider } from './cacheProvider.interface';

// ioredis is an optional dependency — only imported when this provider is used
let Redis: typeof import('ioredis').default;

export class RedisCacheProvider implements CacheProvider {
  readonly name = 'redis';
  private client: InstanceType<typeof Redis> | null = null;
  private readonly url: string;
  private readonly keyPrefix: string;
  private readonly defaultTtl: number;

  /**
   * @param url Redis connection URL (e.g. redis://localhost:6379)
   * @param keyPrefix Prefix for all cache keys (default 'cgate:')
   * @param defaultTtlSeconds Default TTL in seconds (0 = no expiry)
   */
  constructor(url: string, keyPrefix: string = 'cgate:', defaultTtlSeconds: number = 300) {
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

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
