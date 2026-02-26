# Cache Module

The cache module (`src/lib/core/cache/`) provides a provider-based caching layer with no silent fallbacks. The active provider is selected via the `CACHE_PROVIDER` environment variable.

## Why

- **Provider abstraction** — Swap between no-cache, in-memory, and Redis without changing application code.
- **No silent fallback** — If Redis is configured and unavailable, operations fail explicitly instead of silently degrading.
- **TTL support** — Default and per-key TTL for automatic expiration.
- **Singleton lifecycle** — Initialized once, destroyed on graceful shutdown.

## Providers

| Provider | `CACHE_PROVIDER` | Description |
|----------|-----------------|-------------|
| Null | `none` | Caching disabled — all reads miss, writes are no-ops |
| Memory | `memory` | In-process `Map` with TTL sweep (default) |
| Redis | `redis` | Redis via `ioredis` — requires `REDIS_URL` |

## Usage

```typescript
import { getCache } from '@/lib/core/cache';

const cache = await getCache();

// Set with default TTL (CACHE_TTL_SECONDS)
await cache.set('user:123', { name: 'Alice', role: 'admin' });

// Set with custom TTL (seconds)
await cache.set('session:abc', sessionData, 3600);

// Get (returns undefined on miss)
const user = await cache.get<User>('user:123');
if (user) {
  // cache hit
}

// Check existence
const exists = await cache.has('user:123');

// Delete
await cache.del('user:123');

// Clear all (use with caution)
await cache.clear();
```

## API Reference

### `getCache(): Promise<CacheProvider>`

Returns the initialized cache provider singleton. First call triggers initialization.

### `destroyCache(): Promise<void>`

Destroys the cache provider. Called during graceful shutdown.

### CacheProvider Interface

```typescript
interface CacheProvider {
  readonly name: string;

  init(): Promise<void>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  destroy(): Promise<void>;
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_PROVIDER` | `memory` | Provider: `none`, `memory`, `redis` |
| `CACHE_TTL_SECONDS` | `300` | Default TTL for cached entries |
| `REDIS_URL` | — | Redis connection URL (required for `redis` provider) |
| `REDIS_KEY_PREFIX` | `cgate:` | Key prefix for Redis entries |

## Where Cache is Used

The gateway uses caching in these critical paths:

| Use Case | Key Pattern | TTL |
|----------|-------------|-----|
| API token validation | `apiToken:{hash}` | 300s |
| Model metadata lookup | `model:{tenantDb}:{key}` | 300s |
| Provider config | `provider:{tenantDb}:{key}` | 300s |

## Health Check

The cache module registers a health check that verifies the provider can read and write:

```typescript
registerHealthCheck('cache', async () => {
  const cache = await getCache();
  await cache.set('__health__', 'ok', 10);
  const val = await cache.get('__health__');
  return {
    status: val === 'ok' ? 'ok' : 'degraded',
    details: { provider: cache.name },
  };
});
```

## Shutdown

Cache is destroyed during graceful shutdown:

```typescript
registerShutdownHandler('cache', async () => {
  await destroyCache();
});
```

## Rules

> **Mandatory**: Access cache only through `getCache()` from `@/lib/core/cache`. The provider is selected by `CACHE_PROVIDER` env var. No silent fallback: if Redis is configured and unavailable, operations fail explicitly.
