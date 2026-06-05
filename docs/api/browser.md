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

### Close / Delete Session

- `DELETE /api/client/v1/browser/sessions/:sessionKey`
- `DELETE /api/client/v1/browser/sessions/by-id/:sessionId`

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

- `browser_navigate`
- `browser_click`
- `browser_hover`
- `browser_type`
- `browser_press`
- `browser_wait`
- `browser_snapshot`
- `browser_extract`
- `browser_screenshot`
- `browser_close`

## Relationship To Console Agents

Standalone browser agent management has been removed. If you want a Console-managed agent to browse autonomously:

1. create or reuse a browser profile,
2. attach the `Browser Use` system tool to the agent in Console,
3. invoke that agent through the normal agents / responses surface.

For external runtimes or custom orchestrators, use the browser session API directly or connect through the per-browser MCP endpoint.