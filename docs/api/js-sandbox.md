# JS Sandbox API

Two surfaces:

- **Dashboard API** (`/api/js-sandbox/*`) — runtime CRUD, ad-hoc execution, execution history. Session-authenticated.
- **Client API** (`/api/client/v1/js-sandbox/*`) — list/get runtimes and execute code with an API token.

## Libraries

```http
GET /api/js-sandbox/libraries
```

Returns the static catalog of opt-in helpers — the same list the dashboard form uses.

```json
{
  "libraries": [
    { "key": "std:collections", "label": "Collections", "description": "groupBy, countBy, uniqueBy and sortBy helpers." },
    { "key": "std:math", "label": "Math", "description": "sum, avg, min, max and round helpers." },
    { "key": "std:text", "label": "Text", "description": "slugify, truncate and compact whitespace helpers." }
  ]
}
```

## Runtimes

### List

```http
GET /api/js-sandbox/runtimes?status=active&search=report
```

### Create

```http
POST /api/js-sandbox/runtimes
```

```json
{
  "name": "report-shaper",
  "key": "report-shaper",
  "description": "Transforms raw report rows for downstream agents",
  "status": "active",
  "libraries": ["std:collections", "std:math"],
  "limits": {
    "defaultTimeoutMs": 3000,
    "maxTimeoutMs": 10000,
    "memoryLimitMb": 128,
    "maxCodeSizeBytes": 65536,
    "maxResultSizeBytes": 65536,
    "maxLogEntries": 200
  },
  "network": {
    "enabled": false,
    "allowList": []
  },
  "metadata": {}
}
```

Validated by `createJsSandboxRuntimeInputSchema` (Zod) — `400` with a structured error on failure.

### Get / Update / Delete

```
GET    /api/js-sandbox/runtimes/:idOrKey
PATCH  /api/js-sandbox/runtimes/:idOrKey
DELETE /api/js-sandbox/runtimes/:idOrKey
```

`idOrKey` accepts either the internal id or the runtime key.

## Execute

### Ad-hoc

```http
POST /api/js-sandbox/execute
```

```json
{
  "jsRuntimeId": "report-shaper",
  "code": "return libs.collections.groupBy(input.records, r => r.region);",
  "input": { "records": [{ "region": "EU", "v": 1 }, { "region": "US", "v": 2 }] },
  "timeoutMs": 2000
}
```

### Runtime-scoped

```http
POST /api/js-sandbox/runtimes/:idOrKey/execute
```

Same body as above but `jsRuntimeId` is taken from the path.

#### Response (both endpoints)

```json
{
  "execution": {
    "id": "exec_…",
    "runtimeId": "rt_…",
    "runtimeKey": "report-shaper",
    "status": "success",
    "result": { "EU": [...], "US": [...] },
    "logs": { "stdout": [], "stderr": [] },
    "durationMs": 12,
    "createdAt": "2026-05-18T10:00:00.000Z"
  }
}
```

`status` is `success | error | timeout`. Failure is a property of the execution — the HTTP request still returns `200`.

## Executions

### List

```http
GET /api/js-sandbox/executions?runtimeKey=report-shaper&status=success&from=2026-04-01&limit=50&page=1
```

| Query | Notes |
|---|---|
| `runtimeId` / `runtimeKey` | Filter to one runtime. |
| `status` | `success`, `error`, `timeout`. |
| `from` / `to` | ISO timestamps. |
| `limit` | Default 50, capped at 200. |
| `page` | 1-based pagination. |
| `skip` | Alternative offset (overrides `page`). |

#### Response

```json
{
  "executions": [...],
  "total": 124,
  "limit": 50,
  "page": 1,
  "totalPages": 3
}
```

### Get

```http
GET /api/js-sandbox/executions/:id
```

Returns the execution including truncated `codePreview` and `inputPreview` (not the full `code`/`input`), `result`, and captured logs.

## Client API (token-authenticated)

```
GET  /api/client/v1/js-sandbox/runtimes
GET  /api/client/v1/js-sandbox/runtimes/:idOrKey
POST /api/client/v1/js-sandbox/execute
```

The execute response is flattened (compared to the dashboard surface):

```json
{
  "status": "success",
  "executionId": "exec_…",
  "runtimeKey": "report-shaper",
  "result": { ... },
  "logs": { "stdout": [], "stderr": [] },
  "durationMs": 12,
  "errorMessage": null
}
```

Every client execution is tagged `callerType: "api"` and carries the token id for audit.

## Errors

| Status | Cause |
|---|---|
| 400 | Zod validation error, bad body, malformed payload. |
| 404 | Runtime / execution not found. |
| 500 | Internal error. |
