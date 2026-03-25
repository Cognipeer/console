# Monitoring & Observability

Cognipeer Console provides structured logging, health checks, and usage tracking for production observability.

## Structured Logging

All server-side code uses the Winston-based structured logger:

```typescript
import { createLogger } from '@/lib/core/logger';
const logger = createLogger('my-service');
```

### Log Format

**JSON (production):**

```json
{
  "timestamp": "2025-01-15 10:30:45.123",
  "level": "info",
  "scope": "inference",
  "requestId": "a1b2c3d4-5678-90ab-cdef",
  "tenantId": "tenant_acme",
  "message": "Chat completion",
  "model": "gpt-4",
  "tokens": 150,
  "latencyMs": 450
}
```

**Pretty (development):**

```
2025-01-15 10:30:45.123 info [inference](a1b2c3d4){tenant_acme} Chat completion {"model":"gpt-4","tokens":150}
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | `pretty` (dev) / `json` (prod) | `json` or `pretty` |
| `LOG_REQUEST_BODY` | `false` | Log request body (sanitized) |
| `LOG_RESPONSE_BODY` | `false` | Log response body (sanitized) |

### Log Aggregation

JSON logs are compatible with common aggregation tools:

- **ELK Stack** — Elasticsearch, Logstash, Kibana
- **Datadog** — Direct JSON log ingestion
- **Grafana Loki** — Label-based log aggregation
- **CloudWatch** — AWS native log ingestion

Per-request fields (`requestId`, `tenantId`, `scope`) enable filtering and correlation across services.

## Health Checks

### Endpoints

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /api/health/live` | Liveness (is process alive?) | Always 200 |
| `GET /api/health/ready` | Readiness (are dependencies healthy?) | 200 or 503 |

### Health Report

```json
{
  "status": "ok",
  "uptime": 86400,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "checks": {
    "mongodb": { "status": "ok", "latencyMs": 5 },
    "cache": { "status": "ok", "latencyMs": 2, "details": { "provider": "redis" } }
  }
}
```

### Status Values

| Status | Meaning |
|--------|---------|
| `ok` | Component is healthy |
| `degraded` | Component is working but with issues |
| `down` | Component is unavailable |

## Request Tracing

Every request gets a unique `requestId` (UUID) that flows through the entire processing chain:

```
Client → Middleware (set x-request-id)
       → Route Handler
         → Service Layer
           → Provider Call
             → All log entries include requestId
```

Clients can provide their own request ID via the `X-Request-Id` header or `request_id` body field.

## Circuit Breaker Monitoring

Circuit breaker states are available programmatically:

```typescript
import { getAllCircuitStates } from '@/lib/core/resilience';

const states = getAllCircuitStates();
// Map<string, { state: 'closed'|'open'|'half-open', failures: number }>
```

Monitor for `open` circuits to identify unhealthy providers.

## Usage Tracking

Every LLM inference request is logged with:

| Field | Description |
|-------|-------------|
| Model key | Which model was used |
| Provider | Which provider handled the request |
| Token counts | Input, output, total, cached |
| Latency | End-to-end request time (ms) |
| Status | Success or error |
| Tool calls | Any tool/function calls made |
| Request ID | For correlation |

Usage data is written asynchronously via `fireAndForget` to avoid impacting response latency.

## Runtime Pool Stats

```typescript
import { runtimePool } from '@/lib/core/runtimePool';

const { size, keys } = runtimePool.stats();
// size: number of cached provider SDK instances
// keys: list of cache keys
```

## Async Task Monitoring

```typescript
import { pendingTaskCount } from '@/lib/core/asyncTask';

const count = pendingTaskCount();
// Number of fire-and-forget tasks still running
```

## Alerts

The gateway includes an alerting system with configurable rules:

- **Alert Rules** — Define conditions (thresholds, patterns) that trigger alerts
- **Alert Channels** — Define notification targets (email, webhook, etc.)
- **Alert Events** — Historical record of triggered alerts

## Recommended Monitoring Stack

| Component | Purpose |
|-----------|---------|
| **JSON Logs** | Log aggregation + search |
| **Health endpoints** | Kubernetes probes + uptime monitoring |
| **Usage tracking** | Dashboard analytics + billing |
| **Circuit breaker states** | Provider health monitoring |
| **Async task count** | Background processing health |
