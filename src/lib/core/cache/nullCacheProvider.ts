/**
 * Null Cache Provider — value caching is disabled.
 * Selected when CACHE_PROVIDER=none.
 *
 * Counters and locks stay process-local (backed by an in-process store) so
 * rate limits, quotas and single-runner sweeps keep working on one instance.
 */

import type { CacheProvider } from './cacheProvider.interface';
import { MemoryCacheProvider } from './memoryCacheProvider';

export class NullCacheProvider implements CacheProvider {
  readonly name = 'none';
  private readonly local = new MemoryCacheProvider(0);

  /* eslint-disable @typescript-eslint/no-unused-vars */
  async init(): Promise<void> {}
  async get<T>(_key: string): Promise<T | undefined> { return undefined; }
  async set<T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> {}
  async del(_key: string): Promise<void> {}
  async has(_key: string): Promise<boolean> { return false; }
  async clear(): Promise<void> {}
  /* eslint-enable @typescript-eslint/no-unused-vars */
  incrementCounter(
    key: string,
    ttlSeconds: number,
    amount: number = 1,
  ): Promise<{ count: number; resetAt: Date }> {
    return this.local.incrementCounter(key, ttlSeconds, amount);
  }
  acquireLock(key: string, ttlSeconds: number): Promise<string | undefined> {
    return this.local.acquireLock(key, ttlSeconds);
  }
  releaseLock(key: string, token: string): Promise<void> {
    return this.local.releaseLock(key, token);
  }
  async destroy(): Promise<void> { await this.local.destroy(); }
}
