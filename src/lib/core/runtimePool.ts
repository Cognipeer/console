/**
 * Provider Runtime Pool — caches SDK client instances per provider+tenant.
 *
 * Avoids recreating LangChain / AWS SDK clients on every request.
 * Cache is invalidated when credentials change (detected via hash).
 *
 * Config: PROVIDER_RUNTIME_CACHE_TTL_SECONDS (default 300)
 *
 * Usage:
 *   import { runtimePool } from '@/lib/core/runtimePool';
 *
 *   const runtime = await runtimePool.getOrCreate(
 *     cacheKey,
 *     credentialsHash,
 *     () => providerRegistry.createRuntime(driver, context),
 *   );
 */

import { createHash } from 'crypto';
import { getConfig } from './config';
import { createLogger } from './logger';

const log = createLogger('runtime-pool');

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface PoolEntry<T = unknown> {
  runtime: T;
  credentialsHash: string;
  createdAt: number;
  lastUsedAt: number;
}

/* ------------------------------------------------------------------ */
/*  Pool Implementation                                               */
/* ------------------------------------------------------------------ */

class RuntimePool {
  private pool = new Map<string, PoolEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic sweep to remove expired entries
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  /**
   * Get a cached runtime or create a new one.
   *
   * @param key Unique cache key (e.g. `${tenantId}:${providerKey}`)
   * @param credentialsHash Hash of current credentials (triggers refresh when changed)
   * @param factory Async factory to create a new runtime
   */
  async getOrCreate<T>(
    key: string,
    credentialsHash: string,
    factory: () => Promise<T>,
  ): Promise<T> {
    const existing = this.pool.get(key);
    const ttl = getConfig().providerRuntime.cacheTtlSeconds * 1000;

    if (existing) {
      const isExpired = ttl > 0 && Date.now() - existing.createdAt > ttl;
      const credentialsChanged = existing.credentialsHash !== credentialsHash;

      if (!isExpired && !credentialsChanged) {
        existing.lastUsedAt = Date.now();
        return existing.runtime as T;
      }

      // Remove stale entry
      this.pool.delete(key);
      if (credentialsChanged) {
        log.debug(`Runtime credentials changed, refreshing: ${key}`);
      }
    }

    // Create new runtime
    const runtime = await factory();

    this.pool.set(key, {
      runtime,
      credentialsHash,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    log.debug(`Runtime created and cached: ${key}`);
    return runtime;
  }

  /**
   * Invalidate a specific cached runtime.
   */
  invalidate(key: string): void {
    this.pool.delete(key);
  }

  /**
   * Invalidate all runtimes for a tenant.
   */
  invalidateByPrefix(prefix: string): void {
    for (const key of this.pool.keys()) {
      if (key.startsWith(prefix)) {
        this.pool.delete(key);
      }
    }
  }

  /**
   * Remove all expired entries.
   */
  private sweep(): void {
    const ttl = getConfig().providerRuntime.cacheTtlSeconds * 1000;
    if (ttl <= 0) return; // no expiration

    const now = Date.now();
    for (const [key, entry] of this.pool) {
      if (now - entry.createdAt > ttl) {
        this.pool.delete(key);
      }
    }
  }

  /**
   * Get pool stats (for monitoring).
   */
  stats(): { size: number; keys: string[] } {
    return { size: this.pool.size, keys: Array.from(this.pool.keys()) };
  }

  /**
   * Destroy the pool (for graceful shutdown).
   */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.pool.clear();
  }
}

/**
 * Compute a hash of credentials for change detection.
 */
export function hashCredentials(credentials: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(credentials))
    .digest('hex')
    .slice(0, 16);
}

/** Singleton runtime pool instance */
export const runtimePool = new RuntimePool();
