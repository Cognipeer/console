# Deployment

The Cognipeer Gateway supports multiple deployment strategies: standalone Docker, Kubernetes with Helm, and traditional Node.js process management.

## Docker

### Build

```bash
docker build -t cgate:latest .
```

The Dockerfile uses a multi-stage build:

1. **deps** — Install npm dependencies (cached layer)
2. **builder** — Build Next.js standalone output
3. **runner** — Minimal Alpine image with non-root user

### Run

```bash
docker run -d \
  --name cgate \
  -p 3000:3000 \
  -e MONGODB_URI="mongodb://host.docker.internal:27017" \
  -e JWT_SECRET="your-secret-here" \
  cgate:latest
```

### Docker Compose

```yaml
version: '3.8'
services:
  gateway:
    build: .
    ports:
      - "3000:3000"
    environment:
      MONGODB_URI: mongodb://mongo:27017
      JWT_SECRET: change-me-in-production
      LOG_LEVEL: info
      LOG_FORMAT: json
      CACHE_PROVIDER: memory
    depends_on:
      - mongo
    healthcheck:
      test: wget -q --spider http://localhost:3000/api/health/live || exit 1
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

## Kubernetes

### Helm Chart

The project includes a Helm chart at `deploy/k8s/cgate/`:

```bash
# Install
helm install cgate deploy/k8s/cgate \
  --set image.repository=your-registry/cgate \
  --set image.tag=latest

# Upgrade
helm upgrade cgate deploy/k8s/cgate \
  --set image.tag=v1.2.0
```

### Helmfile

For multi-environment deployments:

```bash
# Deploy to dev
helmfile -e dev apply

# Deploy to production
helmfile -e production apply
```

Environment-specific values are in `deploy/k8s/values/`:

```
deploy/k8s/values/
├── common.yaml.gotmpl  # Shared across environments
├── dev.yaml             # Development overrides
└── production.yaml      # Production overrides
```

### Health Probes

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

### Security Context

The Helm chart configures:

```yaml
securityContext:
  capabilities:
    drop: [ALL]
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  runAsUser: 1000
```

## Standalone Node.js

### Production Build

```bash
npm run build
node .next/standalone/server.js
```

### Process Manager

With PM2:

```bash
pm2 start .next/standalone/server.js --name cgate -i max
```

## Environment Configuration

### Required Variables

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | JWT signing secret |

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
