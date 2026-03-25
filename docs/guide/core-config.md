# Config Module

The config module (`src/lib/core/config.ts`) provides centralized, typed configuration for the entire application. All settings flow through this module instead of reading `process.env` directly.

## Why

- **Type safety** — Every config value has a known type with sensible defaults.
- **Swappable source** — The `ConfigSource` abstraction lets you replace ENV with a database, settings page, or any other backend in the future.
- **Validation** — Critical values are checked at startup. Missing `JWT_SECRET` is always rejected; `MONGODB_URI` is required only when `DB_PROVIDER=mongodb`.
- **Single cache** — Config is built once and reused for the process lifetime.

## Usage

```typescript
import { getConfig } from '@/lib/core/config';

const cfg = getConfig();

// Typed access with IDE auto-complete
cfg.database.uri;           // string
cfg.gateway.retryMaxAttempts; // number
cfg.cache.provider;          // 'none' | 'memory' | 'redis'
cfg.logging.level;           // 'error' | 'warn' | 'info' | 'debug'
```

## API Reference

### `getConfig(): AppConfig`

Returns the application configuration singleton. Built and cached on first call.

```typescript
const cfg = getConfig();
```

### `validateConfig(cfg: AppConfig): ConfigValidationError[]`

Returns an array of validation errors. An empty array means the config is valid.

```typescript
import { getConfig, validateConfig } from '@/lib/core/config';

const errors = validateConfig(getConfig());
if (errors.length > 0) {
  errors.forEach(e => console.error(`${e.key}: ${e.message}`));
  process.exit(1);
}
```

**Validated fields:**

| Field | Condition |
|-------|-----------|
| `MONGODB_URI` | Must be non-empty when `DB_PROVIDER=mongodb` |
| `JWT_SECRET` | Must be non-empty |
| `REDIS_URL` | Required when `CACHE_PROVIDER=redis` |
| `REDIS_URL` | Required when `RATE_LIMIT_PROVIDER=redis` |

### `reloadConfig(): AppConfig`

Forces a rebuild from the current source. Used in tests after changing env vars.

```typescript
import { reloadConfig } from '@/lib/core/config';

process.env.LOG_LEVEL = 'debug';
const cfg = reloadConfig(); // picks up the change
```

### `setConfigSource(source: ConfigSource): void`

Replace the config source. Invalidates the cached config.

```typescript
import { setConfigSource } from '@/lib/core/config';

setConfigSource({
  name: 'database',
  get(key: string) {
    return dbSettings[key]; // read from database
  },
});
```

### `getConfigSource(): ConfigSource`

Returns the current source (for diagnostics).

## ConfigSource Interface

```typescript
interface ConfigSource {
  readonly name: string;
  get(key: string): string | undefined;
}
```

The default implementation (`EnvConfigSource`) reads from `process.env`. Custom sources must return raw string values — the config builder handles parsing, type conversion, and defaults.

## Config Shape

The full `AppConfig` interface:

```typescript
interface AppConfig {
  nodeEnv: string;

  database: {
    uri: string;
    mainDbName: string;
    minPoolSize: number;
    maxPoolSize: number;
    connectTimeoutMs: number;
    socketTimeoutMs: number;
    serverSelectionTimeoutMs: number;
  };

  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    providerEncryptionSecret: string;
  };

  smtp: { host; port; secure; user; pass; from };
  gateway: { requestTimeoutMs; retryEnabled; retryMaxAttempts; ... };
  cache: { provider; ttlSeconds; redis: { url; keyPrefix } };
  rateLimit: { provider; syncIntervalMs };
  logging: { level; format; logRequestBody; logResponseBody };
  cors: { enabled; allowedOrigins; maxAge };
  health: { endpointEnabled };
  limits: { bodySize; tracingMaxBodySizeMb };
  app: { url; demoEmail; shutdownTimeoutMs };
  providerRuntime: { cacheTtlSeconds };
}
```

See the [Configuration Reference](./configuration.md) for the complete list of environment variables with defaults.

## Helper Functions

The config builder uses typed helper functions for parsing:

| Function | Input | Output |
|----------|-------|--------|
| `str(source, key, fallback)` | Raw string | String (fallback if missing) |
| `int(source, key, fallback)` | Numeric string | Integer (fallback if NaN) |
| `bool(source, key, fallback)` | `"true"` / `"1"` | Boolean |
| `list(source, key, fallback)` | Comma-separated | `string[]` |
| `oneOf(source, key, allowed, fallback)` | Enum string | Validated literal type |

## Rules

> **Mandatory**: Never read `process.env` directly in application code. Always use `getConfig()`.

The only exception is `src/instrumentation.ts` where the `NEXT_RUNTIME` guard runs before the config module is available.
