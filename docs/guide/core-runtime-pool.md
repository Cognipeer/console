# Runtime Pool Module

The runtime pool (`src/lib/core/runtimePool.ts`) is an LRU cache for provider SDK client instances. It avoids recreating LangChain, OpenAI, and other SDK clients on every request while automatically invalidating entries when credentials change.

## Why

- **Performance** — SDK client initialization (connection setup, auth handshake) is expensive. Reusing clients eliminates this overhead.
- **Credential rotation** — When provider credentials are updated, the pool detects the change via hash comparison and creates a fresh client.
- **TTL expiration** — Stale entries are automatically swept to prevent memory leaks.
- **Tenant isolation** — Cache keys include the tenant ID, ensuring zero cross-tenant leakage.

## Usage

```typescript
import { runtimePool, hashCredentials } from '@/lib/core/runtimePool';

const cacheKey = `${tenantId}:${providerKey}`;
const credHash = hashCredentials(credentials);

const runtime = await runtimePool.getOrCreate(
  cacheKey,
  credHash,
  () => providerRegistry.createRuntime(driver, context),
);

// Use the cached runtime
const response = await runtime.chat(messages);
```

## API Reference

### `runtimePool.getOrCreate<T>(key, credentialsHash, factory): Promise<T>`

Get a cached runtime or create a new one.

| Parameter | Description |
|-----------|-------------|
| `key` | Unique cache key (e.g., `tenant_acme:openai-prod`) |
| `credentialsHash` | Hash of current credentials (triggers refresh when changed) |
| `factory` | Async factory function to create a new runtime |

**Cache hit** conditions (both must be true):
- Entry exists for the given key
- TTL has not expired
- Credentials hash matches

If any condition fails, the old entry is removed and a new one is created.

### `runtimePool.invalidate(key): void`

Remove a specific cached runtime.

```typescript
runtimePool.invalidate(`${tenantId}:${providerKey}`);
```

### `runtimePool.invalidateByPrefix(prefix): void`

Remove all runtimes matching a prefix. Useful when a tenant's credentials change globally.

```typescript
// Invalidate all runtimes for a tenant
runtimePool.invalidateByPrefix(`${tenantId}:`);
```

### `runtimePool.stats(): { size, keys }`

Get pool statistics for monitoring.

```typescript
const { size, keys } = runtimePool.stats();
logger.info('Runtime pool', { size, keys });
```

### `runtimePool.destroy(): void`

Clear all entries and stop the sweep timer. Called during graceful shutdown.

### `hashCredentials(credentials: unknown): string`

Compute a short SHA-256 hash for credential change detection.

```typescript
import { hashCredentials } from '@/lib/core/runtimePool';

const hash = hashCredentials({ apiKey: 'sk-...', region: 'us-east-1' });
// Returns 16-char hex string: "a1b2c3d4e5f6g7h8"
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROVIDER_RUNTIME_CACHE_TTL_SECONDS` | `300` | TTL for cached runtime instances |

## Cache Invalidation

The pool handles three invalidation scenarios:

| Trigger | Behavior |
|---------|----------|
| TTL expired | Entry removed on next access or periodic sweep |
| Credentials changed | Hash mismatch detected → old entry removed, new one created |
| Manual invalidation | `invalidate()` or `invalidateByPrefix()` |

The periodic sweep runs every 60 seconds to remove expired entries even if they are not accessed.

## Shutdown

```typescript
registerShutdownHandler('runtime-pool', () => {
  runtimePool.destroy();
  return Promise.resolve();
});
```

## Where It's Used

The runtime pool is integrated into these services:

- **Inference Service** — Caches LLM provider SDK clients (OpenAI, Anthropic, etc.)
- **Vector Service** — Caches vector store SDK clients (Pinecone, Qdrant, etc.)
- **File Service** — Caches file storage SDK clients (S3, MinIO, etc.)
