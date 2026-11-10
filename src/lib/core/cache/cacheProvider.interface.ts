/**
 * Cache Provider Interface
 *
 * Each provider is independent — no fallback chain.
 * The active provider is selected via CACHE_PROVIDER env.
 *
 * Providers: none | memory | redis
 */

/** Result of one GCRA take (see `rateTake`). */
export interface RateTakeResult {
  allowed: boolean;
  /** When refused: ms until a request would be admitted. 0 when allowed. */
  retryAfterMs: number;
  /** Requests still available inside the 1-minute burst. */
  remaining: number;
  /** Ms until the bucket is empty again. */
  resetAfterMs: number;
}

export interface LeaseAcquireResult {
  acquired: boolean;
  /** Members holding the lease key after the call. */
  count: number;
}

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

  /**
   * OPTIONAL (redis only): one GCRA step with a 1-minute burst, atomically.
   * `limitPerMinute` > 0. Memory/null providers do not implement it.
   */
  rateTake?(key: string, limitPerMinute: number, nowMs?: number): Promise<RateTakeResult>;

  /**
   * OPTIONAL (redis only): add `member` to the lease set `key`. Expired members are dropped first; an
   * existing member is renewed and counts as acquired; `limit` null adds without checking.
   */
  leaseAcquire?(
    key: string,
    member: string,
    limit: number | null,
    ttlMs: number,
    nowMs?: number,
  ): Promise<LeaseAcquireResult>;

  /** OPTIONAL (redis only): extend a held lease. false = it was not held (expired). */
  leaseRenew?(key: string, member: string, ttlMs: number): Promise<boolean>;

  /** OPTIONAL (redis only): drop a member from a lease set. */
  leaseRelease?(key: string, member: string): Promise<void>;

  /** OPTIONAL (redis only): live members of a lease set (expired ones dropped first). */
  leaseCount?(key: string): Promise<number>;

  /** Graceful shutdown. */
  destroy(): Promise<void>;
}
