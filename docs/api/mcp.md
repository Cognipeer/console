# MCP Servers API

Connect to external MCP (Model Context Protocol) servers and execute tools through the gateway. The gateway acts as an MCP proxy, supporting both direct execution and the full MCP protocol via SSE transport.

## Direct Tool Execution

### List Server Tools

```
GET /api/client/v1/mcp/:serverKey/execute
```

Returns MCP server metadata and its available tools.

#### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `serverKey` | string | Yes | MCP server key |

#### Response

```json
{
  "server": {
    "key": "tavily-search",
    "name": "Tavily Search",
    "status": "active",
    "toolCount": 2,
    "createdAt": "2026-01-20T12:00:00.000Z"
  },
  "tools": [
    {
      "name": "search",
      "description": "Search the web using Tavily",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        },
        "required": ["query"]
      }
    }
  ]
}
```

### Execute Tool

```
POST /api/client/v1/mcp/:serverKey/execute
```

Execute a specific tool on the MCP server.

#### Request

```json
{
  "tool": "search",
  "arguments": {
    "query": "latest AI news"
  }
}
```

#### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tool` | string | Yes | Name of the tool to execute |
| `arguments` | object | No | Tool arguments (default: `{}`) |

#### Response

```json
{
  "result": {
    "results": [
      { "title": "...", "url": "...", "content": "..." }
    ]
  },
  "metadata": {
    "tool": "search",
    "server": "tavily-search",
    "latencyMs": 1523
  }
}
```

## MCP Protocol (SSE Transport)

The gateway implements the MCP protocol specification (version `2024-11-05`) over SSE transport, allowing standard MCP clients to connect.

### Open SSE Stream

```
GET /api/client/v1/mcp/:serverKey/sse
```

Opens a Server-Sent Events stream. The server sends an `endpoint` event containing the URL the client should POST JSON-RPC messages to.

#### Response Headers

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Mcp-Session-Id: <session-id>
```

#### Initial Event

```
event: endpoint
data: https://gateway.example.com/api/client/v1/mcp/tavily-search/message?sessionId=abc-123
```

### Send JSON-RPC Message

```
POST /api/client/v1/mcp/:serverKey/message?sessionId=<id>
```

Send MCP JSON-RPC messages. Responses are pushed through the SSE stream when a session is active, or returned directly in the HTTP body for stateless mode.

#### Supported Methods

| Method | Description |
|--------|-------------|
| `initialize` | Initialize MCP session (returns capabilities and server info) |
| `notifications/initialized` | Client acknowledgment (no response) |
| `ping` | Health check |
| `tools/list` | List available tools with schemas |
| `tools/call` | Execute a tool by name with arguments |

### Initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {}
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": { "listChanged": false }
    },
    "serverInfo": {
      "name": "cognipeer-mcp-gateway",
      "version": "1.0.0"
    }
  }
}
```

### List Tools (JSON-RPC)

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "search",
        "description": "Search the web",
        "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } }
      }
    ]
  }
}
```

### Call Tool (JSON-RPC)

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": { "query": "AI news" }
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "{ ... search results ... }" }
    ],
    "isError": false
  }
}
```

### Error Codes

| Code | Meaning |
|------|---------|
| -32700 | Parse error (invalid JSON) |
| -32600 | Invalid request (missing method) |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32001 | MCP server not found |
| -32002 | MCP server disabled |
| -32603 | Internal error |

## Stateless Mode

If no `sessionId` query parameter is provided to the message endpoint, responses are returned directly in the HTTP body instead of being pushed through SSE. This is useful for simple integrations that don't need persistent sessions.

```bash
curl -X POST https://gateway.example.com/api/client/v1/mcp/tavily-search/message \
  -H "Authorization: Bearer cgt_your_token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing `tool` field or invalid JSON-RPC |
| 401 | Invalid API token |
| 403 | MCP server is disabled |
| 404 | MCP server not found |
| 500 | Internal server error |
| 502 | Upstream tool execution failed |
