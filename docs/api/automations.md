# Automations API

Automations are the platform's background schedulers and maintenance jobs (alert evaluation, inference-server polling, and browser-session housekeeping). This client surface lets you inspect their live state and metrics, trigger an immediate run, or pause/resume the ones that support it.

All endpoints are under `/api/client/v1` and require a `Bearer cgt_…` API token.

## Automation keys

There is a fixed set of automations, each addressed by a stable `key`:

| Key | Domain | Cadence | Pausable | Triggerable |
|---|---|---|---|---|
| `alert-evaluation` | alerts | scheduled | yes | yes |
| `inference-monitoring-poll` | monitoring | scheduled | yes | yes |
| `browser-session-reaper` | browser | scheduled | yes | yes |
| `browser-session-reconciliation` | browser | manual maintenance | no | yes |

- `alert-evaluation` — evaluates active alert rules across tenants and emits incidents or notifications.
- `inference-monitoring-poll` — polls inference servers on their due intervals and refreshes operational metrics.
- `browser-session-reaper` — closes idle or over-lifetime browser sessions inside the local Playwright runtime.
- `browser-session-reconciliation` — reconciles browser sessions left active in the database after a runtime restart. Manual-only: it cannot be paused or resumed.

## Automation object

Every endpoint returns the same `automation` view shape:

```json
{
  "key": "alert-evaluation",
  "name": "Alert Evaluation",
  "description": "Evaluates active alert rules across tenants and emits incidents or notifications.",
  "domain": "alerts",
  "cadenceLabel": "Every 30s",
  "distributed": true,
  "metrics": {
    "firedCount": 2,
    "lockProvider": "redis",
    "pendingAsyncTasks": 0,
    "processedTenants": 14
  },
  "state": "active",
  "supportsPause": true,
  "supportsTrigger": true,
  "lastStartedAt": "2026-06-15T09:30:00.000Z",
  "lastCompletedAt": "2026-06-15T09:30:01.200Z",
  "lastDurationMs": 1200,
  "lastError": null
}
```

| Field | Type | Notes |
|---|---|---|
| `key` | string | One of the automation keys above. |
| `name` | string | Display name. |
| `description` | string | What the automation does. |
| `domain` | `alerts \| browser \| monitoring` | Functional area. |
| `cadenceLabel` | string | Human cadence, e.g. `Every 30s`, or `Manual maintenance`. |
| `distributed` | boolean | Whether runs are guarded by a distributed lock across instances. |
| `metrics` | object | Per-automation metrics; keys vary by `domain` (see below). |
| `state` | `active \| degraded \| idle \| paused \| running` | Derived live state. |
| `supportsPause` | boolean | Whether pause/resume are available. |
| `supportsTrigger` | boolean | Whether an immediate run can be triggered. |
| `lastStartedAt` | string \| null | ISO timestamp of the last run start. |
| `lastCompletedAt` | string \| null | ISO timestamp of the last run completion. |
| `lastDurationMs` | number \| null | Duration of the last run, in milliseconds. |
| `lastError` | string \| null | Error message from the last run, if any. |

The `metrics` keys depend on the automation:

- `alert-evaluation` — `firedCount`, `lockProvider`, `pendingAsyncTasks`, `processedTenants`.
- `inference-monitoring-poll` — `dueServers`, `lockProvider`, `processedTenants`.
- `browser-session-reaper` — `browserConnected`, `liveSessions`, `shuttingDown`.
- `browser-session-reconciliation` — `pendingAsyncTasks`, `sessionsReconciled`, `tenantsScanned`.

## Endpoints

### List

```http
GET /api/client/v1/automations
Authorization: Bearer cgt_…
```

Returns every automation and its current state.

#### Response

```json
{
  "automations": [
    { "key": "browser-session-reaper", "name": "Browser Session Reaper", "...": "..." },
    { "key": "browser-session-reconciliation", "name": "Browser Session Reconciliation", "...": "..." },
    { "key": "inference-monitoring-poll", "name": "Inference Poll Scheduler", "...": "..." },
    { "key": "alert-evaluation", "name": "Alert Evaluation", "...": "..." }
  ]
}
```

### Get

```http
GET /api/client/v1/automations/:key
Authorization: Bearer cgt_…
```

| Param | In | Notes |
|---|---|---|
| `key` | path | An automation key (see table above). |

#### Response

```json
{ "automation": { "key": "alert-evaluation", "state": "active", "...": "..." } }
```

### Run

```http
POST /api/client/v1/automations/:key/run
Authorization: Bearer cgt_…
```

Triggers an immediate run of the automation and waits for it to finish before responding. No request body is required.

For scheduled automations (`alert-evaluation`, `inference-monitoring-poll`, `browser-session-reaper`) this runs the job out of band without affecting the normal schedule. For `browser-session-reconciliation` the run is the only way to invoke it; if a reconciliation is already in progress the current state is returned without starting another.

#### Response

```json
{ "automation": { "key": "alert-evaluation", "state": "active", "lastDurationMs": 1200, "...": "..." } }
```

The returned `automation` reflects the freshly updated `lastStartedAt`, `lastCompletedAt`, `lastDurationMs`, `metrics`, and `lastError`.

### Pause

```http
POST /api/client/v1/automations/:key/pause
Authorization: Bearer cgt_…
```

Pauses the automation's scheduler so it will not run on its cadence until resumed. In-flight runs are not interrupted. No request body is required. Only valid for automations with `supportsPause: true`; calling it on `browser-session-reconciliation` returns an error.

#### Response

```json
{ "automation": { "key": "alert-evaluation", "state": "paused", "...": "..." } }
```

### Resume

```http
POST /api/client/v1/automations/:key/resume
Authorization: Bearer cgt_…
```

Resumes a paused scheduler so it runs on its cadence again. No request body is required. Only valid for pausable automations; calling it on `browser-session-reconciliation` returns an error.

#### Response

```json
{ "automation": { "key": "alert-evaluation", "state": "active", "...": "..." } }
```

## Errors

| Status | Cause |
|---|---|
| 400 | Invalid automation key. |
| 401 | Missing/invalid API token. |
| 404 | Automation not found (Get only). |
| 500 | Internal error, e.g. pausing/resuming an automation that does not support it, or a run that threw. The message is returned in `error`. |

## Example

```bash
# List automations
curl https://your-console/api/client/v1/automations \
  -H "Authorization: Bearer cgt_your_token"

# Trigger an immediate alert-evaluation run
curl -X POST https://your-console/api/client/v1/automations/alert-evaluation/run \
  -H "Authorization: Bearer cgt_your_token"

# Pause and resume the inference poll scheduler
curl -X POST https://your-console/api/client/v1/automations/inference-monitoring-poll/pause \
  -H "Authorization: Bearer cgt_your_token"
curl -X POST https://your-console/api/client/v1/automations/inference-monitoring-poll/resume \
  -H "Authorization: Bearer cgt_your_token"
```
