/**
 * Null Cache Provider — cache disabled, every operation is a no-op.
 * Selected when CACHE_PROVIDER=none.
 */

import { randomUUID } from 'crypto';
import type { CacheProvider } from './cacheProvider.interface';

export class NullCacheProvider implements CacheProvider {
  readonly name = 'none';

  async init(): Promise<void> {}
  async get<T>(): Promise<T | undefined> { return undefined; }
  async set(): Promise<void> {}
  async del(): Promise<void> {}
  async has(): Promise<boolean> { return false; }
  async clear(): Promise<void> {}
  async incrementCounter(
    _key: string,
    ttlSeconds: number,
    amount: number = 1,
  ): Promise<{ count: number; resetAt: Date }> {
    const ttl = Math.max(1, Math.ceil(ttlSeconds));
    const incrementBy = Math.max(0, Math.ceil(amount));
    return { count: incrementBy, resetAt: new Date(Date.now() + ttl * 1000) };
  }
  async acquireLock(): Promise<string | undefined> { return randomUUID(); }
  async releaseLock(): Promise<void> {}
  async destroy(): Promise<void> {}
}
