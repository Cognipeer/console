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

/**
 * A runtime that owns connections (a pg pool, an Elasticsearch client) and can
 * release them. Detected structurally so any driver can opt in by exposing
 * `close()` — runtimes without one are dropped as before.
 */
interface DisposableRuntime {
  close(): Promise<void> | void;
}

function asDisposable(runtime: unknown): DisposableRuntime | null {
  if (!runtime || typeof runtime !== 'object') return null;
  const close = (runtime as { close?: unknown }).close;
  return typeof close === 'function' ? (runtime as DisposableRuntime) : null;
}

/** An evicted runtime waiting out its grace period before being closed. */
interface PendingDisposal {
  key: string;
  runtime: unknown;
  disposeAt: number;
}

/* ------------------------------------------------------------------ */
/*  Pool Implementation                                               */
/* ------------------------------------------------------------------ */

class RuntimePool {
  private pool = new Map<string, PoolEntry>();
  private pendingDisposal: PendingDisposal[] = [];
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
      this.evict(key);
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
    this.evict(key);
  }

  /**
   * Invalidate all runtimes for a tenant.
   */
  invalidateByPrefix(prefix: string): void {
    for (const key of [...this.pool.keys()]) {
      if (key.startsWith(prefix)) {
        this.evict(key);
      }
    }
  }

  /**
   * Remove all expired entries.
   */
  private sweep(): void {
    // Runs before the TTL check: entries retired by an explicit invalidate
    // still have connections to release even when expiration is disabled.
    this.drainDisposals();

    const ttl = getConfig().providerRuntime.cacheTtlSeconds * 1000;
    if (ttl <= 0) return; // no expiration

    const now = Date.now();
    for (const [key, entry] of [...this.pool]) {
      if (now - entry.createdAt > ttl) {
        this.evict(key, entry);
      }
    }
  }

  /**
   * Drop an entry from the pool and queue its connections for release.
   *
   * Eviction used to be a bare `delete`, which left every pooled pg/Elasticsearch
   * socket open for the lifetime of the process — a slow but unbounded FD leak
   * across tenant×provider combinations.
   */
  private evict(key: string, known?: PoolEntry): void {
    const entry = known ?? this.pool.get(key);
    this.pool.delete(key);
    if (!entry || !asDisposable(entry.runtime)) return;

    const graceMs = getConfig().providerRuntime.disposeGraceSeconds * 1000;
    if (graceMs <= 0) {
      void this.closeRuntime(key, entry.runtime);
      return;
    }

    // A request that already holds this runtime must be allowed to finish;
    // closing underneath it would fail a live query to fix a slow leak.
    this.pendingDisposal.push({
      key,
      runtime: entry.runtime,
      disposeAt: Date.now() + graceMs,
    });
  }

  private async closeRuntime(key: string, runtime: unknown): Promise<void> {
    try {
      await asDisposable(runtime)?.close();
      log.debug(`Runtime connections released: ${key}`);
    } catch (error) {
      log.warn(`Failed to release runtime connections: ${key}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Close every retired runtime whose grace period has elapsed. */
  private drainDisposals(force = false): void {
    if (this.pendingDisposal.length === 0) return;

    const now = Date.now();
    const due: PendingDisposal[] = [];
    const waiting: PendingDisposal[] = [];

    for (const item of this.pendingDisposal) {
      (force || item.disposeAt <= now ? due : waiting).push(item);
    }

    this.pendingDisposal = waiting;
    for (const item of due) {
      void this.closeRuntime(item.key, item.runtime);
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
    for (const key of [...this.pool.keys()]) {
      this.evict(key);
    }
    // Shutdown skips the grace period: the process is going away, and holding
    // sockets open past this point only delays a clean exit.
    this.drainDisposals(true);
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
