/**
 * Null Cache Provider — cache disabled, every operation is a no-op.
 * Selected when CACHE_PROVIDER=none.
 */

import type { CacheProvider } from './cacheProvider.interface';

export class NullCacheProvider implements CacheProvider {
  readonly name = 'none';

  async init(): Promise<void> {}
  async get<T>(): Promise<T | undefined> { return undefined; }
  async set(): Promise<void> {}
  async del(): Promise<void> {}
  async has(): Promise<boolean> { return false; }
  async clear(): Promise<void> {}
  async destroy(): Promise<void> {}
}
