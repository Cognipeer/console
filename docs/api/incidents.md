# Incidents API

Incidents are automatically created when alert rules fire: one per rule and entity (agent, model, knowledge base, MCP server or tool). They track the lifecycle of an alert from detection through resolution, and an alert that recovers resolves its incident by itself. Incidents are managed through the dashboard API (not the client API). Rules, channels and alert history are in the [Alerts API](./alerts); how alerts fire and resolve is in [Monitoring](/guide/monitoring#from-breach-to-incident).

::: info
These endpoints are dashboard APIs, authenticated via JWT session (not API tokens). They are used by the Cognipeer Console UI. Reading needs **Read** on the Alerts & Incidents service (`alerts`); every change needs **Write**. The list, the stats and the bulk update work inside the active project. By id, a member reaches only incidents of the active project (another project's answers `404`); workspace owners and admins can open an incident of any project by id.
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
| `q` | string | No | Case-insensitive substring of the rule name, the entity key or the metric. `I`, `İ`, `ı` and `i` match each other |
| `assignee` | string | No | `me` for the caller, `unassigned` for nobody, or a user id |
| `snoozed` | string | No | `true`: only incidents snoozed right now. `false`: only the others |
| `updatedAfter` | string | No | ISO 8601: only incidents changed after this time (for polling, below) |
| `sort` | string | No | `-firedAt` (default, newest first), `firedAt`, `-updatedAt`, `updatedAt`, `-severity` (critical first) or `severity` (info first). Within a severity, newest first |
| `limit` | number | No | Page size (default: 50, max: 100) |
| `skip` | number | No | Pagination offset (default: 0) |

A value outside the allowed list, or an `updatedAfter` that is not a date, answers `400` with `code: "invalid_filter"`.

To keep a list current without reloading it, pass the `serverTime` of the previous response as `updatedAfter` and merge the incidents you get by `_id`. `serverTime` is taken before the read, so a change made during the read shows up again on the next poll rather than being missed.

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
  "counts": { "open": 3, "acknowledged": 4, "investigating": 1, "resolved": 3, "closed": 1 },
  "serverTime": "2026-10-15T10:00:00.000Z"
}
```

| Field | Description |
|-------|-------------|
| `counts` | Incidents of the project per status. Every status is present, and the filters above do not change it |
| `openCount` | `counts.open` |
| `total` | The number of incidents for the `status` filter (all statuses without it). With any other filter (`severity`, `module`, `ruleId`, `entityKey`, `q`, `assignee`, `snoozed` or `updatedAfter`) it is the number of incidents up to the end of this page, plus one when `hasMore` is `true` |
| `hasMore` | Whether another page exists. Use it to paginate |
| `serverTime` | When the list was read, for the next `updatedAfter` |

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
| `snoozedUntil`, `snoozedBy` | Set while the incident is [snoozed](#snooze), `null` or absent otherwise. A `snoozedUntil` in the past means the snooze has run out |
| `reopenedAt`, `reopenCount` | When the incident was last reopened, and how many times it was |
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

Change the status, the assignee, the snooze, or several of them in one call. At least one of `status`, `assignedTo` and `snoozedUntil` is required. The assignee and the snooze time are checked before anything is written, and the changes are then applied in that order.

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
| `assignedTo` | string or `null` | The id of a user of the workspace, `"me"` for the caller, or `null` to unassign. An id that is not a user of the workspace answers `400` with `invalid_assignee` |
| `snoozedUntil` | string or `null` | Snooze the incident until this time (ISO 8601), or `null` to end a snooze (see [Snooze](#snooze)) |

Returns `{ "incident": { ... } }` with the display names filled in.

### Snooze

A snooze silences the reminders of an incident (the rule's **Remind every**) until `snoozedUntil`, without changing its status. Each reminder skipped meanwhile is recorded as a `suppressed` delivery with the reason `incident_snoozed`, and the snooze ends by itself at that time. The notification of a recovery is not affected.

Only an `open`, `acknowledged` or `investigating` incident can be snoozed (`409`, `invalid_transition` otherwise), for at most 30 days, and the time must be in the future (`400`, `invalid_snooze`). Ending a snooze is always allowed. Resolving or closing an incident ends its snooze. Since reminders are only sent while an incident is `open`, a snooze makes a difference to notifications only there.

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
fields `acknowledgedAt`, `resolvedAt`, `closedAt`, `reopenedAt`, the actors `acknowledgedBy` and `resolvedBy`, and the notes. Reopening clears `resolvedAt`, `resolvedBy`, `closedAt` and `autoResolved`, sets `reopenedAt` and adds one to `reopenCount`. The bulk `reopen` action also reopens an `acknowledged` or `investigating` incident.

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
| `action` | string | Yes | The action, below |
| `assignedTo` | string or `null` | For `assign` | A user id of the workspace, `"me"` for the caller, or `null` to unassign |
| `until` | string | For `snooze` | When the snooze ends (ISO 8601), in the future and at most 30 days ahead |

| `action` | Effect |
|----------|--------|
| `acknowledge`, `resolve`, `close` | The statuses `acknowledged`, `resolved` and `closed`, under the same workflow rules as [Update Incident](#update-incident) |
| `reopen` | Back to `open` from `acknowledged`, `investigating`, `resolved` or `closed` |
| `assign` | Sets the assignee. An id that is not a user of the workspace refuses the whole request (`400`, `invalid_assignee`) |
| `snooze`, `unsnooze` | Starts or ends a [snooze](#snooze) |

### Response

```json
{
  "updated": 1,
  "failed": [
    { "id": "665f1c1a8b1d4c0012ab34d0", "error": "Cannot transition from \"closed\" to \"acknowledged\". Allowed: open" }
  ],
  "results": [
    { "id": "665f1c1a8b1d4c0012ab34ce", "ok": true },
    { "id": "665f1c1a8b1d4c0012ab34d0", "ok": false, "error": "Cannot transition from \"closed\" to \"acknowledged\". Allowed: open" }
  ]
}
```

Each incident is handled on its own: an unknown id or a move that is not allowed lands in `failed` and the others are still updated. `results` has one entry per distinct id.

## Incident Stats

```
GET /api/alerts/incidents/stats
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `range` | string | No | `24h` (default), `7d` or `30d` |

```json
{
  "open": 3,
  "acknowledged": 4,
  "firedInRange": 9,
  "resolvedInRange": 7,
  "mttaMs": 420000,
  "mttrMs": 1860000,
  "sample": 11,
  "mttaSample": 6,
  "mttrSample": 7,
  "capped": false,
  "range": "24h"
}
```

| Field | Description |
|-------|-------------|
| `open`, `acknowledged` | Incidents of the project in that status now |
| `firedInRange`, `resolvedInRange` | Incidents that fired, and incidents resolved, within the range |
| `mttaMs` | Median time from firing to acknowledgement, over the incidents acknowledged within the range (an acknowledgement from before a reopening does not count). `null` without any |
| `mttrMs` | Median time from firing to resolution, over the incidents resolved within the range. `null` without any |
| `sample`, `mttaSample`, `mttrSample` | Incidents read, and how many of them each median is based on |
| `capped` | `true` when 5,000 or more incidents fired or were resolved within the range: the numbers then cover the 5,000 that fired last |

## Incident Deliveries

```
GET /api/alerts/incidents/:incidentId/deliveries
```

Every notification attempt for the incident, one row per channel and attempt, newest first (at most 200). Rows are kept for 30 days.

```json
{
  "deliveries": [
    {
      "ruleId": "665f1c0e8b1d4c0012ab34cd",
      "incidentId": "665f1c1a8b1d4c0012ab34ce",
      "eventId": "665f1c1a8b1d4c0012ab34cf",
      "channelId": "ch_3f9a1c2b7d4e",
      "channelKind": "slack",
      "channelName": "On-call Slack",
      "trigger": "fire",
      "status": "sent",
      "reason": null,
      "error": null,
      "attemptAt": "2026-10-15T09:42:12.000Z"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `trigger` | `fire`, `resolve` or `renotify` (a reminder) |
| `status` | `sent`, `failed` or `suppressed` |
| `reason` | Why a `suppressed` row was not sent (`rule_muted` or `incident_snoozed`), or the cause of a `failed` row that has one: `channel_missing` when the library channel no longer exists. Otherwise `null` |
| `error` | The delivery error of a `failed` row, at most 500 characters (`channel_missing` for a library channel that no longer exists) |
| `channelKind` | `email`, `webhook`, `slack`, `teams` or `pagerduty`; `library` for a library channel that no longer exists |
| `channelName` | The name of the [library channel](./alerts#channel-library) the row went through, else `null` (also when that channel no longer exists) |

## Similar Incidents

```
GET /api/alerts/incidents/:incidentId/similar
```

The other incidents of the same rule and entity in the last 30 days.

```json
{
  "count30d": 4,
  "medianDurationMs": 1500000,
  "last": [
    { "id": "665f0a118b1d4c0012ab3301", "firedAt": "2026-10-13T14:02:00.000Z", "resolvedAt": "2026-10-13T14:27:00.000Z", "status": "resolved" }
  ]
}
```

`medianDurationMs` is the median time from firing to resolution of those that were resolved (`null` without any), and `last` lists the five newest. At most 200 incidents are read, so `count30d` stops at 200.

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
| 400 | Missing or invalid status, `assignedTo` (`invalid_assignee`), filter (`invalid_filter`), `ids` (`invalid_ids`), `action` (`invalid_action`), snooze time (`invalid_snooze`) or note content, or a body that is not a JSON object (`invalid_body`) |
| 401 | Not authenticated |
| 403 | The caller lacks the `alerts` permission |
| 404 | Incident not found |
| 409 | The status change, reopening or snooze is not allowed from the current status (`invalid_transition`) |
| 500 | Internal server error |
