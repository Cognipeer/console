# Configuration

All application configuration is managed through the central `getConfig()` function in `src/lib/core/config.ts`. Environment variables are the default source, but the abstraction supports swapping to database-backed configuration.

> **Rule**: Never read `process.env` directly in application code. Always use `getConfig()`.

## Environment Variables Reference

### Required

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Secret for JWT signing (min 32 chars) | — |

### Database

| Variable | Description | Default |
|----------|-------------|----------|
| `DB_PROVIDER` | Database backend: `sqlite` or `mongodb` | `sqlite` |
| `SQLITE_DATA_DIR` | Data directory for SQLite files | `./data` |
| `MONGODB_URI` | MongoDB connection string (required when `DB_PROVIDER=mongodb`) | — |
| `MAIN_DB_NAME` | Main database name | `console_main` |
| `MONGODB_MIN_POOL_SIZE` | Min connection pool size | `2` |
| `MONGODB_MAX_POOL_SIZE` | Max connection pool size | `10` |
| `MONGODB_CONNECT_TIMEOUT_MS` | Connection timeout | `10000` |
| `MONGODB_SOCKET_TIMEOUT_MS` | Socket timeout | `45000` |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | Server selection timeout | `30000` |

### Authentication

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_EXPIRES_IN` | JWT token expiry | `7d` |
| `PROVIDER_ENCRYPTION_SECRET` | Encryption key for provider credentials | Falls back to `JWT_SECRET` |

### Gateway (Resilience)

| Variable | Description | Default |
|----------|-------------|---------|
| `GATEWAY_REQUEST_TIMEOUT_MS` | Request timeout for provider calls | `120000` |
| `GATEWAY_RETRY_ENABLED` | Enable automatic retries | `true` |
| `GATEWAY_RETRY_MAX_ATTEMPTS` | Maximum retry attempts | `3` |
| `GATEWAY_RETRY_INITIAL_DELAY_MS` | Initial retry delay (exponential) | `200` |
| `GATEWAY_CIRCUIT_BREAKER_ENABLED` | Enable circuit breaker | `true` |
| `GATEWAY_CIRCUIT_BREAKER_THRESHOLD` | Failures before opening circuit | `5` |
| `GATEWAY_CIRCUIT_BREAKER_RESET_MS` | Time before half-open test | `30000` |

### Cache

| Variable | Description | Default |
|----------|-------------|---------|
| `CACHE_PROVIDER` | Cache backend: `none`, `memory`, `redis` | `memory` |
| `CACHE_TTL_SECONDS` | Default cache TTL | `300` |
| `REDIS_URL` | Redis connection URL (required when provider=redis) | — |
| `REDIS_KEY_PREFIX` | Key prefix for Redis cache | `console:` |

### Rate Limiting

| Variable | Description | Default |
|----------|-------------|---------|
| `RATE_LIMIT_PROVIDER` | Provider: `mongodb`, `memory`, `redis` | `mongodb` |
| `RATE_LIMIT_SYNC_INTERVAL_MS` | Sync interval for distributed counters | `5000` |

### Logging

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Log level: `error`, `warn`, `info`, `debug` | `debug` (dev) / `info` (prod) |
| `LOG_FORMAT` | Output format: `json`, `pretty` | `pretty` (dev) / `json` (prod) |
| `LOG_REQUEST_BODY` | Log request bodies | `false` |
| `LOG_RESPONSE_BODY` | Log response bodies | `false` |

### CORS

| Variable | Description | Default |
|----------|-------------|---------|
| `CORS_ENABLED` | Enable CORS for client API | `false` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins | — |
| `CORS_MAX_AGE` | Preflight cache duration (seconds) | `86400` |

### SMTP (Email)

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_HOST` | SMTP server host | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP server port | `587` |
| `SMTP_SECURE` | Use TLS | `false` |
| `SMTP_USER` | SMTP username | — |
| `SMTP_PASS` | SMTP password | — |
| `SMTP_FROM` | From address | Falls back to `SMTP_USER` |

### Application

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_APP_URL` | Public application URL | `http://localhost:3000` |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown timeout | `15000` |
| `TRACING_MAX_BODY_SIZE_MB` | Max tracing payload size | `10` |
| `HEALTH_ENDPOINT_ENABLED` | Enable health endpoints | `true` |
| `PROVIDER_RUNTIME_CACHE_TTL_SECONDS` | Runtime pool entry TTL | `300` |

## Config Source Abstraction

The config module uses a `ConfigSource` interface, making it easy to swap between ENV-based and database-backed configuration:

```typescript
interface ConfigSource {
  readonly name: string;
  get(key: string): string | undefined;
}
```

The default `EnvConfigSource` reads from `process.env`. You can replace it:

```typescript
import { setConfigSource } from '@/lib/core/config';

setConfigSource(myDatabaseConfigSource);
```

## Validation

At startup, critical configuration is validated:

```typescript
const cfg = getConfig();
const errors = validateConfig(cfg);
// Checks: MONGODB_URI required, JWT_SECRET required,
// REDIS_URL required when CACHE_PROVIDER=redis, etc.
```

Validation errors are logged but do not crash the server — this allows K8s secrets to be injected after initial startup.

## Example `.env.local`

### SQLite mode (default, zero dependencies)

```bash
# Required
JWT_SECRET=your-secret-key-must-be-at-least-32-chars

# Database (SQLite is the default — no MongoDB needed)
# DB_PROVIDER=sqlite
# SQLITE_DATA_DIR=./data

# Cache
CACHE_PROVIDER=memory

# Logging
LOG_LEVEL=debug
LOG_FORMAT=pretty

# CORS (for client SDKs)
CORS_ENABLED=true
CORS_ALLOWED_ORIGINS=http://localhost:3001,http://localhost:5173
```

### MongoDB mode

```bash
# Required
JWT_SECRET=your-secret-key-must-be-at-least-32-chars

# Database
DB_PROVIDER=mongodb
MONGODB_URI=mongodb://localhost:27017

# Cache
CACHE_PROVIDER=memory
# REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=debug
LOG_FORMAT=pretty

# CORS (for client SDKs)
CORS_ENABLED=true
CORS_ALLOWED_ORIGINS=http://localhost:3001,http://localhost:5173

# SMTP (optional)
# SMTP_HOST=smtp.gmail.com
# SMTP_USER=your@email.com
# SMTP_PASS=your-app-password
```
