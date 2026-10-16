# Tools API

Manage and execute tools from the unified tool system. Tools can be backed by OpenAPI specifications or MCP servers and expose discrete actions that can be invoked independently or bound to agents.

## List Tools

```
GET /api/client/v1/tools
```

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status: `active`, `disabled` |
| `type` | string | No | Filter by type: `openapi`, `mcp` |

### Response

```json
{
  "tools": [
    {
      "key": "weather-api",
      "name": "Weather API",
      "description": "Real-time weather data",
      "type": "openapi",
      "status": "active",
      "actions": [
        {
          "key": "get-current-weather",
          "name": "Get Current Weather",
          "description": "Retrieve current weather for a location",
          "inputSchema": {
            "type": "object",
            "properties": {
              "location": { "type": "string", "description": "City name" }
            },
            "required": ["location"]
          }
        }
      ],
      "createdAt": "2026-02-01T08:00:00.000Z"
    }
  ]
}
```

## Get Tool

```
GET /api/client/v1/tools/:toolKey
```

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `toolKey` | string | Yes | Unique tool key |

### Response

```json
{
  "tool": {
    "key": "weather-api",
    "name": "Weather API",
    "description": "Real-time weather data",
    "type": "openapi",
    "status": "active",
    "actions": [
      {
        "key": "get-current-weather",
        "name": "Get Current Weather",
        "description": "Retrieve current weather for a location",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    ],
    "createdAt": "2026-02-01T08:00:00.000Z"
  }
}
```

## Execute Tool Action

Execute a specific action on a tool.

```
POST /api/client/v1/tools/:toolKey/actions/:actionKey/execute
```

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `toolKey` | string | Yes | Tool key |
| `actionKey` | string | Yes | Action key within the tool |

### Request

```json
{
  "arguments": {
    "location": "Istanbul"
  }
}
```

Accepts `arguments` or `args` as the key for the action parameters.

For `openapi` tools, the arguments are matched against the operation. Only parameters the operation declares are sent upstream; other argument names are ignored. Path parameters are required, must be non-empty strings or numbers, and cannot be relative path segments (`.` or `..`, also when percent-encoded) or contain control characters. A request body is sent only for an operation that declares one. The request always goes to the tool's configured upstream base URL, under the operation's path.

### Response

```json
{
  "result": {
    "temperature": 22,
    "condition": "Partly Cloudy",
    "humidity": 65
  },
  "latencyMs": 234,
  "toolKey": "weather-api",
  "actionKey": "get-current-weather"
}
```

### Error Response

```json
{
  "error": "Connection timeout to upstream service"
}
```

## Tool Types

| Type | Source | Description |
|------|--------|-------------|
| `openapi` | OpenAPI 3.x specification | Actions are derived from the spec's operations |
| `mcp` | MCP server | Actions are extracted from the MCP server's tool list |

## Tool Lifecycle

1. **Create** a tool in the dashboard with an OpenAPI spec or MCP server URL
2. Actions are **parsed automatically** from the spec
3. **Bind** tools to agents or call them directly via the API
4. Execution is **logged** with latency, arguments, results, and errors

## Errors

| Status | Description |
|--------|-------------|
| 400 | Execution failed (upstream error returned), or an argument is missing or invalid |
| 401 | Invalid API token |
| 403 | Tool is disabled |
| 404 | Tool or action not found |
| 500 | Internal server error |
