# Health Check Module

The health module (`src/lib/core/health.ts`) provides a registry for health check contributors. Services register their health checks, and the health endpoint aggregates them into a single status report.

## Why

- **Kubernetes readiness** — The `/api/health/ready` endpoint returns 503 if any component is down, preventing traffic from reaching unhealthy instances.
- **Component visibility** — Each subsystem (database, cache, providers) reports its own status independently.
- **Latency tracking** — Each check includes execution time for diagnosing slow dependencies.
- **Extensible** — New services register their checks without modifying the health endpoint.

## Usage

### Registering a Health Check

```typescript
import { registerHealthCheck } from '@/lib/core/health';

registerHealthCheck('mongodb', async () => {
  await db.command({ ping: 1 });
  return { status: 'ok' };
});

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

### Checking Health Programmatically

```typescript
import { checkHealth, checkLiveness } from '@/lib/core/health';

// Full health report (runs all checks)
const report = await checkHealth();
// {
//   status: 'ok',
//   uptime: 12345,
//   timestamp: '2025-01-15T10:30:00.000Z',
//   checks: {
//     mongodb: { status: 'ok', latencyMs: 5 },
//     cache: { status: 'ok', latencyMs: 2, details: { provider: 'memory' } }
//   }
// }

// Simple liveness (no dependency checks)
const liveness = checkLiveness();
// { status: 'ok', uptime: 12345 }
```

## API Reference

### `registerHealthCheck(name, check): void`

Register a named health check contributor.

| Parameter | Description |
|-----------|-------------|
| `name` | Unique identifier for this check |
| `check` | Async function returning `HealthCheckResult` |

### `checkHealth(): Promise<HealthReport>`

Run all registered checks and produce an aggregated report.

### `checkLiveness(): { status: 'ok', uptime: number }`

Simple liveness check — always returns `ok` if the process is running.

## Types

```typescript
type HealthStatus = 'ok' | 'degraded' | 'down';

interface HealthCheckResult {
  status: HealthStatus;
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

interface HealthReport {
  status: HealthStatus;        // Worst status across all checks
  uptime: number;              // Seconds since process start
  timestamp: string;           // ISO timestamp
  checks: Record<string, HealthCheckResult>;
}
```

## Status Aggregation

The overall report status is the worst status across all checks:

| Any check is... | Overall status |
|----------------|----------------|
| `down` | `down` |
| `degraded` (and none `down`) | `degraded` |
| All `ok` | `ok` |

If a check throws an exception, it's recorded as `down` with the error message.

## Health Endpoints

Two HTTP endpoints are available via the API routes:

| Endpoint | Purpose | HTTP Status |
|----------|---------|-------------|
| `GET /api/health/live` | Liveness probe | Always 200 |
| `GET /api/health/ready` | Readiness probe | 200 (ok) or 503 (down/degraded) |

### Kubernetes Configuration

```yaml
livenessProbe:
  httpGet:
    path: /api/health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /api/health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

## Registered Checks

The gateway registers these health checks at startup:

| Name | What It Checks |
|------|---------------|
| `mongodb` | Database ping response |
| `cache` | Cache read/write roundtrip |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_ENDPOINT_ENABLED` | `true` | Enable/disable health endpoints |

## Rules

> **Mandatory**: When adding a new subsystem with external dependencies, register a health check using `registerHealthCheck()`. This ensures the readiness probe reflects the true state of the application.
