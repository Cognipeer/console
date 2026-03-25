# Incidents API

Incidents are automatically created when alert rules fire. They track the lifecycle of an alert event from detection through resolution. Incidents are managed through the dashboard API (not the client API).

::: info
These endpoints are dashboard APIs, authenticated via JWT session (not API tokens). They are used by the Cognipeer Console UI.
:::

## List Incidents

```
GET /api/alerts/incidents
```

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ruleId` | string | No | Filter by alert rule ID |
| `status` | string | No | Filter by status: `open`, `acknowledged`, `investigating`, `resolved`, `closed` |
| `severity` | string | No | Filter by severity: `critical`, `warning`, `info` |
| `limit` | number | No | Max results (default: 50) |
| `skip` | number | No | Pagination offset (default: 0) |

### Response

```json
{
  "incidents": [
    {
      "_id": "inc_abc123",
      "ruleId": "rule_xyz",
      "ruleName": "High Error Rate",
      "metric": "model_usage_error_rate",
      "threshold": 5,
      "actualValue": 12.3,
      "severity": "critical",
      "status": "open",
      "notes": [],
      "statusHistory": [
        { "status": "open", "changedBy": "system", "changedAt": "2026-03-01T10:00:00.000Z" }
      ],
      "createdAt": "2026-03-01T10:00:00.000Z",
      "updatedAt": "2026-03-01T10:00:00.000Z"
    }
  ],
  "openCount": 3
}
```

## Get Incident

```
GET /api/alerts/incidents/:incidentId
```

### Response

```json
{
  "incident": {
    "_id": "inc_abc123",
    "ruleId": "rule_xyz",
    "ruleName": "High Error Rate",
    "metric": "model_usage_error_rate",
    "threshold": 5,
    "actualValue": 12.3,
    "severity": "critical",
    "status": "acknowledged",
    "notes": [
      {
        "userId": "user_1",
        "userEmail": "admin@example.com",
        "content": "Investigating upstream provider issues",
        "createdAt": "2026-03-01T10:30:00.000Z"
      }
    ],
    "statusHistory": [
      { "status": "open", "changedBy": "system", "changedAt": "2026-03-01T10:00:00.000Z" },
      { "status": "acknowledged", "changedBy": "user_1", "changedAt": "2026-03-01T10:15:00.000Z" }
    ],
    "createdAt": "2026-03-01T10:00:00.000Z",
    "updatedAt": "2026-03-01T10:15:00.000Z"
  }
}
```

## Update Incident Status

```
PATCH /api/alerts/incidents/:incidentId
```

### Request

```json
{
  "status": "acknowledged"
}
```

### Valid Statuses

| Status | Description |
|--------|-------------|
| `open` | Initial state when incident is created |
| `acknowledged` | Operator has seen the incident |
| `investigating` | Active investigation in progress |
| `resolved` | Root cause addressed |
| `closed` | Incident fully closed |

### Status Workflow

```
open → acknowledged → investigating → resolved → closed
  ↑                                      │
  └──────────── reopen ──────────────────┘
```

Resolved incidents may be reopened back to `open` if the issue recurs.

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
| `content` | string | Yes | Note text (non-empty) |

### Response

Returns the updated incident with the new note appended.

## Severity Levels

Severity is automatically calculated when an incident is created based on the metric type and how far the actual value exceeds the threshold:

| Severity | Description |
|----------|-------------|
| `critical` | Actual value significantly exceeds threshold |
| `warning` | Threshold breached but within moderate range |
| `info` | Minor threshold violation |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing or invalid status value |
| 401 | Not authenticated |
| 404 | Incident not found |
| 500 | Internal server error |
