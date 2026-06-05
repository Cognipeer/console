/**
 * Cache Provider Interface
 *
 * Each provider is independent — no fallback chain.
 * The active provider is selected via CACHE_PROVIDER env.
 *
 * Providers: none | memory | redis
 */

export interface CacheProvider {
  readonly name: string;

  /** Initialize the provider (connect, etc.) */
  init(): Promise<void>;

  /** Get a cached value. Returns undefined on miss. */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /** Set a value with optional TTL override (seconds). */
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /** Delete a specific key. */
  del(key: string): Promise<void>;

  /** Check if key exists. */
  has(key: string): Promise<boolean>;

  /** Clear all keys (use with caution). */
  clear(): Promise<void>;

  /** Atomically increment a numeric counter and set a TTL when the window starts. */
  incrementCounter(
    key: string,
    ttlSeconds: number,
    amount?: number,
  ): Promise<{ count: number; resetAt: Date }>;

  /**
   * Acquire a best-effort lock with TTL. Returns an owner token when acquired,
   * or undefined when another owner already holds the lock.
   */
  acquireLock(key: string, ttlSeconds: number): Promise<string | undefined>;

  /** Release a lock only when the owner token still matches. */
  releaseLock(key: string, token: string): Promise<void>;

  /** Graceful shutdown. */
  destroy(): Promise<void>;
}
