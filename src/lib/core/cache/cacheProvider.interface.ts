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

  /** Graceful shutdown. */
  destroy(): Promise<void>;
}
