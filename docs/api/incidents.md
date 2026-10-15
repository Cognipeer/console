# Incidents API

Incidents are automatically created when alert rules fire: one per rule and entity (agent, model, knowledge base, MCP server or tool). They track the lifecycle of an alert from detection through resolution, and an alert that recovers resolves its incident by itself. Incidents are managed through the dashboard API (not the client API). Rules, channels and alert history are in the [Alerts API](./alerts); how alerts fire and resolve is in [Monitoring](/guide/monitoring#from-breach-to-incident).

::: info
These endpoints are dashboard APIs, authenticated via JWT session (not API tokens). They are used by the Cognipeer Console UI. Reading needs **Read** on the Alerts & Incidents service (`alerts`); every change needs **Write**. The list and the bulk update work inside the active project. By id, a member reaches only incidents of the active project (another project's answers `404`); workspace owners and admins can open an incident of any project by id.
:::

## List Incidents

```
GET /api/alerts/incidents
```

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status: `open`, `acknowledged`, `investigating`, `resolved`, `closed` |
| `severity` | string | No | Filter by severity: `critical`, `warning`, `info` |
| `module` | string | No | Filter by the module of the rule: `agents`, `models`, `rag`, `mcp`, `tools`, `inference`, `guardrails`, `analysis`, `evaluation`, `redteam`, `ai-app-gateway` |
| `ruleId` | string | No | Filter by alert rule ID |
| `entityKey` | string | No | Filter by entity: the agent name, model key, tool key, MCP server key or knowledge base key |
| `limit` | number | No | Page size (default: 50, max: 100) |
| `skip` | number | No | Pagination offset (default: 0) |

A value outside the allowed list answers `400` with `code: "invalid_filter"`. Incidents are ordered newest first.

### Response

```json
{
  "incidents": [
    {
      "_id": "665f1c1a8b1d4c0012ab34ce",
      "alertEventId": "665f1c1a8b1d4c0012ab34cf",
      "ruleId": "665f1c0e8b1d4c0012ab34cd",
      "ruleName": "Agent error rate",
      "module": "agents",
      "metric": "agent_error_rate",
      "entityType": "agent",
      "entityKey": "pulse-main",
      "threshold": 5,
      "actualValue": 7.1,
      "baselineValue": null,
      "lastValue": 9.4,
      "peakValue": 11.2,
      "severity": "warning",
      "status": "acknowledged",
      "firedAt": "2026-10-15T09:42:11.000Z",
      "acknowledgedAt": "2026-10-15T09:50:02.000Z",
      "acknowledgedBy": "665e0f7a8b1d4c0012ab0002",
      "acknowledgedByName": "Alex Admin",
      "assignedTo": "665e0f7a8b1d4c0012ab0002",
      "assignedToName": "Alex Admin",
      "resolvedByName": null,
      "notes": [],
      "projectId": "665e0f7a8b1d4c0012ab1111",
      "tenantId": "665e0f7a8b1d4c0012ab0001",
      "createdAt": "2026-10-15T09:42:11.000Z",
      "updatedAt": "2026-10-15T09:50:02.000Z"
    }
  ],
  "total": 12,
  "hasMore": false,
  "openCount": 3,
  "counts": { "open": 3, "acknowledged": 4, "investigating": 1, "resolved": 3, "closed": 1 }
}
```

| Field | Description |
|-------|-------------|
| `counts` | Incidents of the project per status. Every status is present, and the filters above do not change it |
| `openCount` | `counts.open` |
| `total` | The number of incidents for the `status` filter (all statuses without it). With any of the `severity`, `module`, `ruleId` or `entityKey` filters it is the number of incidents up to the end of this page, plus one when `hasMore` is `true` |
| `hasMore` | Whether another page exists. Use it to paginate |

## The incident object

| Field | Description |
|-------|-------------|
| `ruleId`, `ruleName`, `module`, `metric` | The rule that fired. `module` is absent on incidents created before per-entity alerting |
| `entityType`, `entityKey` | The entity the alert is about: `agent`, `model`, `tool`, `mcp` or `kb` and its key. `null` or absent for a rule without an entity target |
| `threshold` | The rule's threshold (the meaningful number for threshold rules) |
| `actualValue` | The value that made the alert fire |
| `baselineValue` | The normal value, for baseline alerts |
| `lastValue`, `peakValue` | The latest value and the highest value seen while the alert is firing |
| `severity` | `critical`, `warning` or `info` (see [Severity Levels](#severity-levels)) |
| `status` | `open`, `acknowledged`, `investigating`, `resolved` or `closed` |
| `alertEventId` | The alert event in the [alert history](./alerts#alert-history) |
| `assignedTo`, `acknowledgedBy`, `resolvedBy` | User ids. `resolvedBy` is `system` when the alert recovered by itself |
| `assignedToName`, `acknowledgedByName`, `resolvedByName` | Display names of those users, or `null` (for `system` and for users that no longer exist). Emails are never returned |
| `autoResolved` | `true` when the alert recovered by itself and resolved the incident. Reopening an incident clears it |
| `firedAt`, `acknowledgedAt`, `resolvedAt`, `closedAt` | Lifecycle timestamps |
| `notes` | Notes and system notes, oldest first |
| `context` | What was gathered when the alert fired (below). Absent when nothing could be gathered |

### `context`

Gathered once, when the alert fires, and best effort: an alert is never delayed or dropped because the context could not be gathered. For agent alerts it carries the version change, the most common errors and the failing sessions. The Enterprise edition adds related models and tools that changed (`correlations`).

```json
{
  "mode": "threshold",
  "windowMinutes": 15,
  "versionChange": { "from": "1.4.0", "to": "1.5.0", "firstSeenAt": "2026-10-15T09:24:00.000Z" },
  "errorSignatures": [{ "message": "tool timeout after <n>ms", "count": 12 }],
  "failingSessions": {
    "count": 14,
    "listPath": "/dashboard/tracing/sessions?agent=pulse-main&status=error&from=2026-10-15T09%3A27%3A00.000Z&to=2026-10-15T09%3A42%3A00.000Z"
  },
  "correlations": [
    {
      "entityType": "model",
      "entityKey": "gpt-main",
      "metric": "model_error_rate",
      "value": 18.2,
      "baseline": 1.4,
      "ratio": 13
    }
  ],
  "notes": []
}
```

| Field | Description |
|-------|-------------|
| `mode` | The condition type of the rule: `threshold`, `absence`, `baseline` or `slo_burn` |
| `windowMinutes` | The evaluation window of the rule |
| `versionChange` | Agents. `{ from, to, firstSeenAt }`: the version that appeared most recently among those running in the rule's window (`to`), the version seen last before it (`from`) and when `to` was first seen (`firstSeenAt`, ISO). The lookback is up to 6 hours before the alert fired, or twice the rule's window when that is longer, so a release that went out before the window still shows. When two versions run side by side it reports the newer one. `null` when no change is found: a new agent, a rollback, or a version that was already running when the lookback began |
| `errorSignatures` | Agents. Up to 5 of the most frequent error messages of the failing sessions, with ids and numbers masked so that equal failures group together, with the number of sessions each appeared in. Absent when there are none |
| `failingSessions` | Agents. The number of failed sessions and a dashboard path to the session list filtered to them, or `null` when none failed. Session ids are not included |
| `correlations` | Enterprise. Models and tools the agent used (up to 10 of each) whose error rate or p95 latency is outside its own normal range, compared with the previous 7 days, worst first (at most 5) |
| `notes` | Short remarks about what could not be gathered |

## Get Incident

```
GET /api/alerts/incidents/:incidentId
```

### Response

```json
{
  "incident": {
    "_id": "665f1c1a8b1d4c0012ab34ce",
    "ruleId": "665f1c0e8b1d4c0012ab34cd",
    "ruleName": "Agent error rate",
    "module": "agents",
    "metric": "agent_error_rate",
    "entityType": "agent",
    "entityKey": "pulse-main",
    "threshold": 5,
    "actualValue": 7.1,
    "lastValue": 3.2,
    "peakValue": 11.2,
    "severity": "warning",
    "status": "resolved",
    "autoResolved": true,
    "firedAt": "2026-10-15T09:42:11.000Z",
    "acknowledgedAt": "2026-10-15T09:50:02.000Z",
    "acknowledgedBy": "665e0f7a8b1d4c0012ab0002",
    "acknowledgedByName": "Alex Admin",
    "resolvedAt": "2026-10-15T10:12:30.000Z",
    "resolvedBy": "system",
    "resolvedByName": null,
    "assignedTo": null,
    "assignedToName": null,
    "alertEventId": "665f1c1a8b1d4c0012ab34cf",
    "projectId": "665e0f7a8b1d4c0012ab1111",
    "tenantId": "665e0f7a8b1d4c0012ab0001",
    "notes": [
      {
        "userId": "665e0f7a8b1d4c0012ab0002",
        "userName": "Alex Admin",
        "content": "Rolled back to 1.4.0",
        "createdAt": "2026-10-15T09:58:40.000Z"
      },
      {
        "userId": "system",
        "userName": "System",
        "content": "Automatically resolved: Agent Error Rate back to 3.2%",
        "createdAt": "2026-10-15T10:12:30.000Z"
      }
    ],
    "context": {
      "mode": "threshold",
      "windowMinutes": 15,
      "versionChange": { "from": "1.4.0", "to": "1.5.0", "firstSeenAt": "2026-10-15T09:24:00.000Z" }
    },
    "createdAt": "2026-10-15T09:42:11.000Z",
    "updatedAt": "2026-10-15T10:12:30.000Z"
  }
}
```

## Update Incident

```
PATCH /api/alerts/incidents/:incidentId
```

Change the status, the assignee, or both in one call. At least one of `status` and `assignedTo` is required. The status is applied first.

### Request

```json
{
  "status": "acknowledged",
  "assignedTo": "me"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | The new status (below). The move must be allowed from the current status |
| `assignedTo` | string or `null` | A user id, `"me"` for the caller, or `null` to unassign |

Returns `{ "incident": { ... } }` with the display names filled in.

### Valid Statuses

| Status | Description |
|--------|-------------|
| `open` | Initial state when the incident is created |
| `acknowledged` | Operator has seen the incident |
| `investigating` | Active investigation in progress |
| `resolved` | Root cause addressed, or the alert recovered by itself |
| `closed` | Incident fully closed |

### Status Workflow

| From | Allowed next statuses |
|------|-----------------------|
| `open` | `acknowledged`, `investigating`, `resolved`, `closed` |
| `acknowledged` | `investigating`, `resolved`, `closed` |
| `investigating` | `resolved`, `closed` |
| `resolved` | `closed`, `open` (reopen) |
| `closed` | `open` (reopen) |

Any other move answers `409` with `code: "invalid_transition"`, including setting the status it already has.

There is no `statusHistory` array. Transitions are tracked via the timestamp
fields `acknowledgedAt`, `resolvedAt`, `closedAt`, the actors `acknowledgedBy` and `resolvedBy`, and the notes. Reopening clears `resolvedAt`, `resolvedBy`, `closedAt` and `autoResolved`.

An incident that is still `open`, `acknowledged` or `investigating` is resolved automatically (`autoResolved: true`, `resolvedBy: "system"`, with a system note) after the alert has been clear for two evaluation windows. An incident that a person already resolved or closed is left as it is.

## Bulk Update

```
POST /api/alerts/incidents/bulk
```

Applies one action to up to 100 incidents of the active project.

### Request

```json
{
  "ids": ["665f1c1a8b1d4c0012ab34ce", "665f1c1a8b1d4c0012ab34d0"],
  "action": "acknowledge"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ids` | string[] | Yes | 1 to 100 incident ids (duplicates are ignored) |
| `action` | string | Yes | `acknowledge`, `resolve` or `close` (the statuses `acknowledged`, `resolved` and `closed`, under the same workflow rules) |

### Response

```json
{
  "updated": 1,
  "failed": [
    { "id": "665f1c1a8b1d4c0012ab34d0", "error": "Cannot transition from \"closed\" to \"acknowledged\". Allowed: open" }
  ]
}
```

Each incident is handled on its own: an unknown id or a move that is not allowed lands in `failed` and the others are still updated.

## Add Note

```
POST /api/alerts/incidents/:incidentId/notes
```

### Request

```json
{
  "content": "Identified root cause: upstream provider rate limiting"
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Note text (non-empty, at most 4,000 characters) |

### Response

Returns the updated incident with the new note appended.

## Severity Levels

Severity comes from the rule. A rule set to `info`, `warning` or `critical` gives every incident that severity. A rule with severity `auto` (the default) derives it when the alert fires:

| Condition type | `critical` | `warning` | `info` |
|----------------|------------|-----------|--------|
| Threshold | The value is at least 2× past the threshold (for `lt` and `lte`, threshold ÷ value) | At least 1.25× | Less than 1.25×. A threshold of 0 or less and the `eq` operator give `warning` |
| Absence | Always | | |
| Baseline | The deviation is at least twice the configured `minRatio` or `minZ`, in the configured direction | Otherwise | |
| SLO burn | The short-window burn is at least twice the configured `burnRate` | Otherwise | |

## Errors

Errors are `{ "error": "<message>" }`; the ones that carry a `code` also have `code` and `message`.

| Status | Description |
|--------|-------------|
| 400 | Missing or invalid status, `assignedTo`, filter (`invalid_filter`), `ids` (`invalid_ids`), `action` (`invalid_action`) or note content, or a body that is not a JSON object (`invalid_body`) |
| 401 | Not authenticated |
| 403 | The caller lacks the `alerts` permission |
| 404 | Incident not found |
| 409 | The status change is not allowed from the current status (`invalid_transition`) |
| 500 | Internal server error |
