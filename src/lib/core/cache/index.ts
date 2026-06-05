/**
 * Cache Module — provider-based, no fallback.
 *
 * The active provider is determined by CACHE_PROVIDER env:
 *   - none:   caching disabled (NullCacheProvider)
 *   - memory: in-process Map with TTL (MemoryCacheProvider)
 *   - redis:  Redis via ioredis (RedisCacheProvider) — requires REDIS_URL
 *
 * Usage:
 *   import { getCache } from '@/lib/core/cache';
 *   const cache = await getCache();
 *   await cache.set('key', value, 60);
 *   const val = await cache.get<MyType>('key');
 */

import { getConfig } from '../config';
import { createLogger } from '../logger';
import type { CacheProvider } from './cacheProvider.interface';
import { NullCacheProvider } from './nullCacheProvider';
import { MemoryCacheProvider } from './memoryCacheProvider';
import { RedisCacheProvider } from './redisCacheProvider';

export type { CacheProvider } from './cacheProvider.interface';

const log = createLogger('cache');

let instance: CacheProvider | null = null;
let initPromise: Promise<CacheProvider> | null = null;

function createProvider(): CacheProvider {
  const cfg = getConfig();

  switch (cfg.cache.provider) {
    case 'redis':
      if (!cfg.cache.redis.url) {
        throw new Error('CACHE_PROVIDER=redis requires REDIS_URL to be set');
      }
      return new RedisCacheProvider(
        cfg.cache.redis.url,
        cfg.cache.redis.keyPrefix,
        cfg.cache.ttlSeconds,
      );

    case 'memory':
      return new MemoryCacheProvider(cfg.cache.ttlSeconds);

    case 'none':
      return new NullCacheProvider();

    default:
      throw new Error(`Unknown CACHE_PROVIDER: ${cfg.cache.provider}`);
  }
}

/**
 * Get the initialized cache provider (singleton).
 * First call triggers init(); subsequent calls return the same instance.
 */
export async function getCache(): Promise<CacheProvider> {
  if (instance) return instance;

  if (!initPromise) {
    initPromise = (async () => {
      const provider = createProvider();
      await provider.init();
      instance = provider;
      log.info(`Cache provider initialized: ${provider.name}`);
      return provider;
    })();
  }

  return initPromise;
}

/**
 * Destroy the cache provider (for graceful shutdown / tests).
 */
export async function destroyCache(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = null;
    initPromise = null;
  }
}
