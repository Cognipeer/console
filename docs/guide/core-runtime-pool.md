# Runtime Pool Module

The runtime pool (`src/lib/core/runtimePool.ts`) is a TTL-based cache for provider SDK client instances. It avoids recreating LangChain, OpenAI, and other SDK clients on every request while automatically invalidating entries when credentials, or the whole provider configuration, change. A runtime that owns connections is built once per key and released in an orderly way when it is replaced.

## Why

- **Performance** — SDK client initialization (connection setup, auth handshake) is expensive. Reusing clients eliminates this overhead.
- **Credential rotation** — When provider credentials are updated, the pool detects the change via hash comparison and creates a fresh client.
- **Configuration changes** — A runtime that is shaped by more than its credentials (a bucket, an endpoint, an authentication method) is keyed on a hash of the whole configuration, so an edited setting takes effect on the next request instead of when the entry expires.
- **One build per key** — Requests that arrive while the first runtime of a key is still being built share that build, so a runtime that owns connections is never created twice and left unreleased.
- **Orderly release** — A replaced or expired runtime that exposes `close()` has its connections closed after a grace period, so a request that still holds it can finish.
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

When the provider's settings shape the runtime as much as its credentials do, hash the whole configuration with `hashRuntimeConfig` (the file service does):

```typescript
import { runtimePool, hashRuntimeConfig } from '@/lib/core/runtimePool';

const runtime = await runtimePool.getOrCreate(
  `file-runtime:${tenantId}:${record.key}`,
  hashRuntimeConfig({ driver: record.driver, credentials, settings: record.settings ?? {} }),
  () => providerRegistry.createRuntime(record.driver, context),
);
```

## API Reference

### `runtimePool.getOrCreate<T>(key, credentialsHash, factory): Promise<T>`

Get a cached runtime or create a new one.

| Parameter | Description |
|-----------|-------------|
| `key` | Unique cache key (e.g., `tenant_acme:openai-prod`) |
| `credentialsHash` | Hash of current credentials, or of the whole configuration with `hashRuntimeConfig` (triggers refresh when changed) |
| `factory` | Async factory function to create a new runtime |

**Cache hit** conditions (all must be true):
- Entry exists for the given key
- TTL has not expired (a TTL of `0` never expires)
- The hash matches

If any condition fails, the old entry is removed and a new one is created.

Concurrent calls for the same key and hash share one in-flight build. If the configuration changes while a build is running, the newer build is the one that counts: the older runtime still goes to the callers that asked for it, but it is not pooled and is released like any retired runtime.

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

### `hashRuntimeConfig(config: unknown): string`

Compute the same kind of 16-character SHA-256 hash over **everything that shapes a runtime**: the driver, the credentials and the settings. Hashing only the credentials means a runtime built from a bucket, an endpoint or an authentication method keeps using the old one until its entry expires, so a settings edit looks as if it had been ignored.

The key order of the config, and of anything nested in it, never matters: the same values hash the same however the record was stored or merged, so re-saving an unchanged provider does not rebuild its runtime.

```typescript
import { hashRuntimeConfig } from '@/lib/core/runtimePool';

hashRuntimeConfig({ driver: 'azure-blob-files', credentials, settings });
```

Use `hashCredentials` when only the credentials matter, and `hashRuntimeConfig` when the settings do too.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROVIDER_RUNTIME_CACHE_TTL_SECONDS` | `300` | TTL for cached runtime instances. `0` turns expiry off: entries then live until their configuration changes or they are invalidated. |
| `PROVIDER_RUNTIME_DISPOSE_GRACE_SECONDS` | `300` | How long a retired runtime keeps its connections open before they are closed. `0` closes immediately. |

## Cache Invalidation

The pool handles three invalidation scenarios:

| Trigger | Behavior |
|---------|----------|
| TTL expired | Entry removed on next access or periodic sweep |
| Credentials changed | Hash mismatch detected → old entry removed, new one created |
| Configuration changed | For callers that pass `hashRuntimeConfig`, an edited setting is a hash mismatch too |
| Manual invalidation | `invalidate()` or `invalidateByPrefix()` |

The periodic sweep runs every 60 seconds to remove expired entries even if they are not accessed.

## Releasing connections

A runtime that owns connections (a pg pool, an Elasticsearch client, the HTTP agents of a storage client) exposes `close()`. The pool detects that structurally, so a driver opts in by adding the method; a runtime without one is simply dropped.

When an entry is evicted (expired, replaced after a hash mismatch, invalidated) or a build turns out to be superseded, its runtime is queued for release and closed once `PROVIDER_RUNTIME_DISPOSE_GRACE_SECONDS` has passed, so a request that already holds it can finish. The queue is drained by the same 60-second sweep, so a close happens at the first sweep after the grace period has elapsed. A failure to close is logged and does not affect the request. `destroy()` skips the grace period: on shutdown every pending runtime is closed at once.

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
- **File Service** — Caches file storage clients (S3-compatible, Amazon S3, Azure Blob, MongoDB GridFS, local filesystem). The key is `file-runtime:<tenantId>:<providerKey>` (a namespace of the file service's own, so that another caller which pools the same provider under a key of its own cannot evict these runtimes) and the hash covers the driver, the credentials **and** the settings, so editing a bucket, an endpoint or an authentication method rebuilds the runtime. The S3 and Azure runtimes implement `close()`, which releases their HTTP agents when the entry is retired.
