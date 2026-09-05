# Browser API

Cognipeer Console exposes two browser-oriented surfaces under the client API:

- browser profiles and browser sessions for direct Playwright-backed automation,
- per-browser MCP endpoints that expose the same Browser Use toolset through the Model Context Protocol.

## Browser Profiles

Browser profiles are reusable containers. They own shared defaults such as session configuration, artifact bucket selection, and default model/runtime metadata.

### Create Browser

```http
POST /api/client/v1/browser/browsers
```

#### Request

```json
{
  "name": "research-browser",
  "defaultSessionConfig": {
    "headless": true,
    "viewport": { "width": 1440, "height": 900 },
    "idleTimeoutMs": 120000
  }
}
```

### List / Get / Update / Delete Browser

- `GET /api/client/v1/browser/browsers`
- `GET /api/client/v1/browser/browsers/:idOrKey`
- `PATCH /api/client/v1/browser/browsers/:idOrKey`
- `DELETE /api/client/v1/browser/browsers/:idOrKey`

## Browser Sessions

Browser sessions are the direct automation surface. A session always belongs to a browser profile.

### Create Session

```http
POST /api/client/v1/browser/sessions
```

#### Request

```json
{
  "browserId": "brw_123",
  "name": "akbank-research"
}
```

### List / Get Sessions

- `GET /api/client/v1/browser/sessions`
- `GET /api/client/v1/browser/sessions/:sessionId`

### List Session Events

```http
GET /api/client/v1/browser/sessions/:sessionId/events?limit=50&skip=0
```

### Run Browser Action

```http
POST /api/client/v1/browser/sessions/:sessionKey/actions
```

#### Example Action

```json
{
  "type": "goto",
  "url": "https://www.akbank.com",
  "waitUntil": "networkidle"
}
```

### Extract Content

```http
POST /api/client/v1/browser/sessions/:sessionKey/extract
```

```json
{
  "selector": "h1",
  "mode": "text",
  "multiple": true
}
```

### Snapshot

```http
GET /api/client/v1/browser/sessions/:sessionKey/snapshot
```

### Screenshot / PDF

- `GET /api/client/v1/browser/sessions/:sessionKey/screenshot/live`
- `POST /api/client/v1/browser/sessions/:sessionKey/screenshot`
- `POST /api/client/v1/browser/sessions/:sessionKey/pdf`

### Find Text / Diagnostics / Export Profile

- `GET /api/client/v1/browser/sessions/:sessionKey/find?text=…&limit=…` — locate visible text and get a **durable target** for each hit, cheaper than a full snapshot.
- `GET /api/client/v1/browser/sessions/:sessionKey/diagnostics` — console messages, failed requests and the last dialog the session saw.
- `GET /api/client/v1/browser/sessions/:sessionKey/profile` — export this session's cookies + origin storage, ready to attach as a browser profile.

### Close / Delete Session

- `DELETE /api/client/v1/browser/sessions/:sessionKey`
- `DELETE /api/client/v1/browser/sessions/by-id/:sessionId`

## Signed-In Profiles

- `PUT /api/client/v1/browser/browsers/:idOrKey/profile` — attach a Playwright `storageState` so new sessions start authenticated. Body is either the raw export or `{ "storageState": …, "fileName": "profile.json" }`. Encrypted at rest; the response is a summary only and the payload is never readable back.
- `DELETE /api/client/v1/browser/browsers/:idOrKey/profile`

## Browser Flows

A flow is a recorded, replayable step list — discovery once, deterministic execution afterwards.

- `POST /api/client/v1/browser/flows` — create (steps may be supplied directly)
- `GET /api/client/v1/browser/flows` — list, filterable by `status`, `browserId`, `search`
- `GET|PATCH|DELETE /api/client/v1/browser/flows/:idOrKey`
- `POST /api/client/v1/browser/flows/record` — turn a driven session into a flow
- `POST /api/client/v1/browser/flows/:idOrKey/run` — replay it and wait for the result
- `GET /api/client/v1/browser/flow-runs` — run history, filterable by `flowId` and `status`
- `GET /api/client/v1/browser/flow-runs/:runId`

A step's action uses the same schema as a live action, with one added rule: **a stored `ref` is rejected**. A ref is valid only for the snapshot that produced it, so a persisted one resolves to nothing on the next run and burns the step's whole timeout finding that out. Use `role` + `name`, `testId`, `label`, `placeholder`, `text` or `selector`.

A failed run still returns `200` with `run.status: "failed"` — the request succeeded and the caller gets a complete, inspectable answer including `failedStepIndex` and per-step results.

## Per-Browser MCP

Every browser profile exposes its own MCP server.

### Open SSE Stream

```http
GET /api/client/v1/browser/:browserKey/mcp/sse
```

The stream returns:

- `X-Mcp-Session-Id` response header
- an `endpoint` SSE event containing the browser-scoped message URL

### Send JSON-RPC Message

```http
POST /api/client/v1/browser/:browserKey/mcp/message?sessionId=<id>
```

Supported methods:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

### Browser MCP Toolset

The browser MCP server exposes the Browser Use-compatible tools:

- `browser_navigate`, `browser_history` (back / forward / reload)
- `browser_click`, `browser_hover`, `browser_type`, `browser_press`
- `browser_select`, `browser_check`, `browser_upload`, `browser_scroll`
- `browser_wait`, `browser_tabs`
- `browser_snapshot` (accessibility tree with `[ref=…]` markers), `browser_find`, `browser_extract`
- `browser_diagnostics` (console, failed requests, last dialog)
- `browser_screenshot`, `browser_pdf`
- `browser_list_flows`, `browser_run_flow`
- `browser_close`

The list is derived from the same definitions the `Browser Use` system tool binds, so the MCP and agent surfaces cannot drift apart.

## Relationship To Console Agents

Standalone browser agent management has been removed. If you want a Console-managed agent to browse autonomously:

1. create or reuse a browser profile,
2. attach the `Browser Use` system tool to the agent in Console,
3. invoke that agent through the normal agents / responses surface.

The agent addresses elements by the `ref` values in `browser_snapshot`'s output. Those are valid only until the next snapshot — every action result also returns `resolvedTarget`, the durable `role`/`name` form, which is what a flow step stores. Where a flow already exists for the task, `browser_run_flow` replays it without a model in the loop.

For external runtimes or custom orchestrators, use the browser session API directly or connect through the per-browser MCP endpoint.