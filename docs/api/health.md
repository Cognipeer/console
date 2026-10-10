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
    "cache": { "status": "ok", "latencyMs": 2, "details": { "provider": "memory" } },
    "authorization-engine": {
      "status": "ok",
      "latencyMs": 1,
      "details": {
        "cedar": { "loaded": true, "sdk": "4.13.0", "language": "4.5" },
        "unavailableRecently": false,
        "skippedStatements": 0
      }
    }
  }
}
```

### The `authorization-engine` check

The policy engine decides every request, so it reports here. The check re-runs a few canned decisions on every call and carries no counters (the endpoint is public; counters are in `GET /api/iam/engine/stats`, behind the session):

| Status | When |
|--------|------|
| `ok` | The canned decisions come out right. |
| `degraded` | Requests were refused with `503 authorization_unavailable` in the last minute, or some custom policy statements could not be loaded and are not applied. The endpoint still answers `200`. |
| `down` | The canned decisions fail. The endpoint answers `503`. A server whose engine cannot load at boot does not start at all. |

See [Authorization](/guide/authorization#when-authorization-is-unavailable).

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
| `automations` | Automations subsystem health |

Additional checks can be registered using `registerHealthCheck()` from the core health module.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_ENDPOINT_ENABLED` | `true` | Enable/disable health endpoints |
