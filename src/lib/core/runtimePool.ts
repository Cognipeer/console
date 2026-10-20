/**
 * Provider Runtime Pool — caches SDK client instances per provider+tenant.
 *
 * Avoids recreating LangChain / AWS SDK clients on every request.
 * Cache is invalidated when credentials change (detected via hash).
 * Requests that arrive while a key's first runtime is still being built share
 * that one build, so a runtime that owns connections is never created twice
 * and left unreleased.
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

/** A runtime that is being built: whoever asks for the same key and config meanwhile waits for it. */
interface PendingCreation {
  credentialsHash: string;
  promise: Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/*  Pool Implementation                                               */
/* ------------------------------------------------------------------ */

class RuntimePool {
  private pool = new Map<string, PoolEntry>();
  /** Runtimes being built, by key. Dropping an entry marks that build as superseded (see `adopt`). */
  private creating = new Map<string, PendingCreation>();
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
   * @param credentialsHash Hash of current credentials (triggers refresh when changed);
   *   `hashRuntimeConfig` when the provider's settings shape the runtime too
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

    // A build for this key and config is already under way (concurrent first use, or the first requests after
    // a settings edit): share it. Building a second runtime would leave one of the two in nobody's hands to close.
    const inFlight = this.creating.get(key);
    if (inFlight && inFlight.credentialsHash === credentialsHash) {
      return inFlight.promise as Promise<T>;
    }

    // Create new runtime. A build for the same key but ANOTHER config (the provider was edited meanwhile) is
    // left to finish; this one replaces it as the build that counts.
    const creation = { credentialsHash } as PendingCreation;
    this.creating.set(key, creation);
    creation.promise = this.build(key, creation, factory);
    return creation.promise as Promise<T>;
  }

  private async build<T>(key: string, creation: PendingCreation, factory: () => Promise<T>): Promise<T> {
    try {
      const runtime = await factory();
      this.adopt(key, creation, runtime);
      return runtime;
    } finally {
      if (this.creating.get(key) === creation) this.creating.delete(key);
    }
  }

  /**
   * Pool a runtime that was just built, unless its build was superseded (a newer build for the key started,
   * or the key was invalidated while this one ran). A superseded runtime still goes to the callers that
   * asked for it - they hold it for the call in hand - but is not pooled, and is released like any retired one.
   */
  private adopt(key: string, creation: PendingCreation, runtime: unknown): void {
    if (this.creating.get(key) !== creation) {
      log.debug(`Runtime built for a superseded config, not cached: ${key}`);
      this.retire(key, runtime);
      return;
    }

    // Nothing else builds into the pool, but a leftover entry must not be overwritten unreleased.
    if (this.pool.has(key)) this.evict(key);
    this.pool.set(key, {
      runtime,
      credentialsHash: creation.credentialsHash,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    log.debug(`Runtime created and cached: ${key}`);
  }

  /**
   * Invalidate a specific cached runtime.
   */
  invalidate(key: string): void {
    this.evict(key);
    this.creating.delete(key);
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
    for (const key of [...this.creating.keys()]) {
      if (key.startsWith(prefix)) {
        this.creating.delete(key);
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
    if (entry) this.retire(key, entry.runtime);
  }

  /** Queue a runtime that is no longer pooled (evicted, or built for a superseded config) for release. */
  private retire(key: string, runtime: unknown): void {
    if (!asDisposable(runtime)) return;

    const graceMs = getConfig().providerRuntime.disposeGraceSeconds * 1000;
    // After `destroy()` nothing sweeps the queue any more, and the process is on its way out.
    if (graceMs <= 0 || this.sweepTimer === null) {
      void this.closeRuntime(key, runtime);
      return;
    }

    // A request that already holds this runtime must be allowed to finish;
    // closing underneath it would fail a live query to fix a slow leak.
    this.pendingDisposal.push({
      key,
      runtime,
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
    // A build still running finishes into nothing: its runtime is released as it arrives.
    this.creating.clear();
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

/** JSON replacer that writes every object's keys in sorted order. */
function sortObjectKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((name) => [name, source[name]]));
}

/**
 * Hash everything that shapes a runtime — driver, credentials AND settings — for
 * change detection. A runtime built from a bucket, an endpoint or an auth method
 * keeps using the old one until its entry expires when only the credentials are
 * hashed (`hashCredentials`), so a settings edit looked like it had been ignored.
 *
 * The key order of the config (and of anything nested in it) never matters: the
 * same values hash the same however the record was stored or merged, so a
 * re-saved but unchanged provider does not rebuild its runtime.
 */
export function hashRuntimeConfig(config: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(config, sortObjectKeys))
    .digest('hex')
    .slice(0, 16);
}

/** Singleton runtime pool instance */
export const runtimePool = new RuntimePool();
