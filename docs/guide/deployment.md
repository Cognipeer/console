# Deployment

The Cognipeer Console supports multiple deployment strategies: standalone Docker, Kubernetes with manifests of your own, and traditional Node.js process management.

## Docker

Cognipeer Console runs in two common modes:

- **SQLite mode** for zero-dependency local, edge, or smaller self-hosted installations.
- **MongoDB mode** for higher-concurrency or centralized database deployments.

### Build

```bash
docker build -t cognipeer-console:latest .
```

The Dockerfile uses a multi-stage build:

1. **deps** — Install npm dependencies (cached layer)
2. **builder** — Build the Next.js application
3. **runner** — `node:22` image running as a non-root user (`node`)

### Run

SQLite mode (default):

```bash
docker run -d \
  --name cognipeer-console \
  -p 3000:3000 \
  -e JWT_SECRET="<random value, at least 32 characters>" \
  -e PROVIDER_ENCRYPTION_SECRET="<a different random value, at least 32 characters>" \
  -v console-data:/app/data \
  cognipeer-console:latest
```

MongoDB mode:

```bash
docker run -d \
  --name cognipeer-console \
  -p 3000:3000 \
  -e DB_PROVIDER="mongodb" \
  -e MONGODB_URI="mongodb://host.docker.internal:27017" \
  -e JWT_SECRET="<random value, at least 32 characters>" \
  -e PROVIDER_ENCRYPTION_SECRET="<a different random value, at least 32 characters>" \
  cognipeer-console:latest
```

The image runs with `NODE_ENV=production`, so it refuses to start unless both secrets are valid. Generate each value once, for example with `openssl rand -hex 32`, and keep them: credentials stored under the old `PROVIDER_ENCRYPTION_SECRET` cannot be read with a new one, and a different `JWT_SECRET` signs everyone out.

### Docker Compose

```yaml
version: '3.8'
services:
  gateway:
    build: .
    ports:
      - "3000:3000"
    environment:
      DB_PROVIDER: sqlite
      MAIN_DB_NAME: cgate_main
      SQLITE_DATA_DIR: /app/data/sqlite
      JWT_SECRET: "<random value, at least 32 characters>"
      PROVIDER_ENCRYPTION_SECRET: "<a different random value, at least 32 characters>"
      LOG_LEVEL: info
      LOG_FORMAT: json
      CACHE_PROVIDER: memory
    healthcheck:
      test: wget -q --spider http://localhost:3000/api/health/live || exit 1
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

volumes:
  console-data:
```

If you want MongoDB instead, set `DB_PROVIDER=mongodb`, add `MONGODB_URI`, and provision the database separately. An installation on MongoDB defaults to the hosted (`saas`) deployment mode, which refuses provider endpoints on private networks unless the operator opens them for an organization; for an installation you run yourself also set `DEPLOYMENT_MODE=onprem` (see [Deployment mode](/guide/configuration#deployment-mode), including what it does to `MONGODB_SINGLE_DATABASE`).

## Kubernetes

This repository does not include a Helm chart, a helmfile or Kubernetes manifests. To run Console on Kubernetes, deploy the image built from the repository's `Dockerfile` (see [Docker](#docker)) with manifests of your own. For help with a Kubernetes deployment, contact [developer@cognipeer.com](mailto:developer@cognipeer.com).

What the image gives your manifests:

- The container listens on port `3000` and runs as the non-root user `node`.
- `GET /api/health/live` and `GET /api/health/ready` are public endpoints for liveness and readiness probes (see [Health Probes](#health-probes) below).
- Node is the container's main process, so `SIGTERM` reaches it and starts a [graceful shutdown](#graceful-shutdown).
- SQLite databases and local files are written under `/app/data`. Mount a persistent volume there, or use MongoDB (`DB_PROVIDER=mongodb`).
- Settings are environment variables; see the [Configuration Reference](../guide/configuration.md). `JWT_SECRET` and `PROVIDER_ENCRYPTION_SECRET` are required.

### Health Probes

Example settings for the probes in your own manifests. The endpoints are described in the [Health API](/api/health).

```yaml
livenessProbe:
  httpGet:
    path: /api/health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /api/health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 10
  failureThreshold: 3
```

## Standalone Node.js

### Production Build

```bash
npm run build
npm start
```

`npm start` runs the custom Fastify server (`src/server/index.ts`) with `NODE_ENV=production`.

### Process Manager

With PM2:

```bash
pm2 start npm --name cognipeer-console -- start
```

## Environment Configuration

### Required Variables

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | JWT signing secret (min 32 chars) |
| `PROVIDER_ENCRYPTION_SECRET` | Key that encrypts provider credentials at rest (min 32 chars, must differ from `JWT_SECRET`) |

### Conditionally Required Variables

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | Required only when `DB_PROVIDER=mongodb` |
| `DEPLOYMENT_MODE` | Set to `onprem` for a self-hosted installation on MongoDB (it defaults to `saas` there; SQLite installations default to `onprem`). It also changes the default of `MONGODB_SINGLE_DATABASE` to `true`: an installation that keeps its tenants in per-tenant databases sets `MONGODB_SINGLE_DATABASE=false` as well (see [Deployment mode](/guide/configuration#deployment-mode)) |

### Recommended Production Settings

```bash
# Logging
LOG_LEVEL=info
LOG_FORMAT=json

# Cache
CACHE_PROVIDER=redis
REDIS_URL=redis://redis:6379

# Security
CORS_ENABLED=true
CORS_ALLOWED_ORIGINS=https://app.yourdomain.com

# Performance
MONGODB_MIN_POOL_SIZE=5
MONGODB_MAX_POOL_SIZE=20

# Resilience
GATEWAY_RETRY_ENABLED=true
GATEWAY_CIRCUIT_BREAKER_ENABLED=true

# Shutdown
SHUTDOWN_TIMEOUT_MS=30000
```

See the [Configuration Reference](../guide/configuration.md) for all available variables.

## Graceful Shutdown

The gateway handles `SIGTERM` and `SIGINT` for graceful shutdown:

1. Stop accepting new requests
2. Drain pending async tasks
3. Close cache connections
4. Clear runtime pool
5. Disconnect database
6. Exit

Configure the timeout with `SHUTDOWN_TIMEOUT_MS` (default: 15s).

For Kubernetes, ensure `terminationGracePeriodSeconds` is greater than `SHUTDOWN_TIMEOUT_MS`:

```yaml
spec:
  terminationGracePeriodSeconds: 45
```
