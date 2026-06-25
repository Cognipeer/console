# Health API

Health check endpoints for monitoring and Kubernetes probes. These endpoints are public (no authentication required).

## Liveness Probe

```
GET /api/health/live
```

Always returns 200 if the process is running.

```json
{ "status": "ok", "uptime": 86400 }
```

`uptime` is the process uptime in seconds.

Use for Kubernetes liveness probes — confirms the process is alive.

## Readiness Probe

```
GET /api/health/ready
```

Runs all registered health checks and returns an aggregated report.

The top-level `status` is one of `ok | degraded | down`. Each component's
`status` is likewise `ok | degraded | down`; a `degraded` component still returns
HTTP 200. The response always includes `uptime` (process uptime in seconds) and
`timestamp`, and wraps the per-component results under the `checks` key.

### Healthy Response (200)

```json
{
  "status": "ok",
  "uptime": 86400,
  "timestamp": "2026-03-01T10:00:00.000Z",
  "checks": {
    "mongodb": { "status": "ok", "latencyMs": 5 },
    "cache": { "status": "ok", "latencyMs": 2, "details": { "provider": "memory" } }
  }
}
```

### Unhealthy Response (503)

```json
{
  "status": "down",
  "uptime": 86400,
  "timestamp": "2026-03-01T10:00:00.000Z",
  "checks": {
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
| `mongodb` (or `sqlite`) | Database ping response |
| `cache` | Cache read/write roundtrip |
| `cluster` | Cluster registry / coordination health |
| `queue` | Background queue connectivity |
| `browser-runtime` | Browser automation runtime health |
| `js-sandbox-runtime` | JS sandbox runtime health |
| `automations` | Automations subsystem health |

Additional checks can be registered using `registerHealthCheck()` from the core health module.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_ENDPOINT_ENABLED` | `true` | Enable/disable health endpoints |
