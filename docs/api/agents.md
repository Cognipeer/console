# Agents API

Manage and invoke AI agents via the client API. Agents combine a model, system prompt, tools, guardrails, and RAG modules into a single deployable unit.

## List Agents

```
GET /api/client/v1/agents
```

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status: `active`, `inactive`, `draft` |

### Response

```json
{
  "agents": [
    {
      "key": "support-bot",
      "name": "Support Bot",
      "description": "Customer support agent",
      "config": {
        "modelKey": "gpt-4o",
        "temperature": 0.7,
        "topP": 1,
        "maxTokens": 4096
      },
      "status": "active",
      "createdAt": "2026-01-15T10:00:00.000Z"
    }
  ]
}
```

## Get Agent

```
GET /api/client/v1/agents/:agentKey
```

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentKey` | string | Yes | Unique agent key |

### Response

```json
{
  "agent": {
    "key": "support-bot",
    "name": "Support Bot",
    "description": "Customer support agent",
    "config": {
      "modelKey": "gpt-4o",
      "temperature": 0.7,
      "topP": 1,
      "maxTokens": 4096
    },
    "status": "active",
    "createdAt": "2026-01-15T10:00:00.000Z"
  }
}
```

## Invoke Agent (Responses API)

Invoke an agent using the OpenAI Responses API format. The agent is identified by the `model` field.

Two equivalent endpoints are available:

```
POST /api/client/v1/responses
POST /api/client/v1/agents/responses
```

### Request

```json
{
  "model": "support-bot",
  "input": "How do I reset my password?",
  "previous_response_id": null,
  "version": 1
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Agent key (identifies the agent) |
| `input` | string \| array | Yes | User message — plain string or array of message items |
| `previous_response_id` | string | No | ID from a previous response for multi-turn conversations |
| `version` | number | No | Specific published version to use (positive integer) |

### Input Formats

**Simple string:**

```json
{
  "model": "support-bot",
  "input": "Hello, I need help"
}
```

**Message array:**

```json
{
  "model": "support-bot",
  "input": [
    {
      "role": "user",
      "content": "Hello, I need help"
    }
  ]
}
```

**Structured content array:**

```json
{
  "model": "support-bot",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Hello, I need help" }
      ]
    }
  ]
}
```

### Response

```json
{
  "id": "resp_64a1b2c3d4e5f6",
  "object": "response",
  "model": "support-bot",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "To reset your password, go to Settings > Security..."
        }
      ]
    }
  ],
  "status": "completed",
  "usage": {
    "input_tokens": 12,
    "output_tokens": 45,
    "total_tokens": 57
  },
  "created_at": 1709500000,
  "previous_response_id": null
}
```

### Multi-Turn Conversations

Use `previous_response_id` to continue a conversation:

```json
{
  "model": "support-bot",
  "input": "Can you elaborate on the security settings?",
  "previous_response_id": "resp_64a1b2c3d4e5f6"
}
```

The response ID follows the format `resp_{conversationId}`. The gateway automatically tracks conversation history and provides context to the agent.

## Agent Features

Agents configured in the dashboard can include:

| Feature | Description |
|---------|-------------|
| **System Prompt** | Base instructions for the agent |
| **Tools** | Bound tools from the unified tool system or MCP servers |
| **Guardrails** | Input/output validation rules |
| **RAG Modules** | Retrieval-augmented generation sources |
| **Temperature / Top-P** | Model parameter overrides |
| **Max Tokens** | Output length limit |
| **Versioning** | Publish and pin specific agent configurations |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing `model` or `input` field, or agent is not active |
| 401 | Invalid API token |
| 404 | Agent not found, or `previous_response_id` references invalid conversation |
| 500 | Internal error during agent execution |
