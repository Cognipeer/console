/**
 * In-Memory Cache Provider — Map-based with TTL eviction.
 * Selected when CACHE_PROVIDER=memory.
 *
 * Good for single-instance deployments and development.
 * No external dependency required.
 */

import type { CacheProvider } from './cacheProvider.interface';

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number; // epoch ms, 0 = no expiry
}

export class MemoryCacheProvider implements CacheProvider {
  readonly name = 'memory';
  private store = new Map<string, CacheEntry>();
  private defaultTtl: number;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param defaultTtlSeconds Default TTL in seconds (0 = no expiry)
   * @param evictionIntervalSeconds How often to sweep expired keys (default 60s)
   */
  constructor(defaultTtlSeconds: number = 300, evictionIntervalSeconds: number = 60) {
    this.defaultTtl = defaultTtlSeconds;
    // Eviction sweep
    this.evictionTimer = setInterval(() => this.evict(), evictionIntervalSeconds * 1000);
    this.evictionTimer.unref(); // don't block process exit
  }

  async init(): Promise<void> {
    // Nothing to initialize
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtl;
    const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== undefined;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async destroy(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.store.clear();
  }

  /** Remove expired entries */
  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt > 0 && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}
