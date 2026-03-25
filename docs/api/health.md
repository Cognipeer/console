# Health API

Health check endpoints for monitoring and Kubernetes probes. These endpoints are public (no authentication required).

## Liveness Probe

```
GET /api/health/live
```

Always returns 200 if the process is running.

```json
{ "status": "up" }
```

Use for Kubernetes liveness probes — confirms the process is alive.

## Readiness Probe

```
GET /api/health/ready
```

Runs all registered health checks and returns an aggregated report.

### Healthy Response (200)

```json
{
  "status": "up",
  "components": {
    "mongodb": { "status": "ok", "latencyMs": 5 },
    "cache": { "status": "ok", "latencyMs": 2, "details": { "provider": "memory" } }
  }
}
```

### Unhealthy Response (503)

```json
{
  "status": "down",
  "components": {
    "mongodb": { "status": "ok", "latencyMs": 5 },
    "cache": { "status": "down", "message": "Redis connection failed", "latencyMs": 3000 }
  }
}
```

Use for Kubernetes readiness probes — prevents traffic from reaching unhealthy instances.

## Kubernetes Configuration

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

## Registered Checks

| Component | What It Checks |
|-----------|---------------|
| `mongodb` | Database ping response |
| `cache` | Cache read/write roundtrip |

Additional checks can be registered using `registerHealthCheck()` from the core health module.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_ENDPOINT_ENABLED` | `true` | Enable/disable health endpoints |
