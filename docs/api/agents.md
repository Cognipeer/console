# Agents API

Manage and invoke AI agents via the client API. Agents combine a model, system prompt, tools, guardrails, and Knowledge Engine modules into a single deployable unit.

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

Two endpoints are available, and they are **not** equivalent — they differ in which agent version they execute:

```
POST /api/client/v1/agents/responses   # runs the PUBLISHED agent version
POST /api/client/v1/responses           # runs the DRAFT agent version
```

Use `/api/client/v1/agents/responses` for production traffic against the published version, and `/api/client/v1/responses` to test the current draft.

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
| `budget` | object \| null | No | Spend budget for the session this request starts: `{ "max_cost_usd": 2, "on_reach": "pause" }`. See [Session budgets](/guide/agent-session-budgets) |
| `background` | boolean | No | Run as a [background run](/guide/agent-background-execution) |

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

**With files** (`input_file`, `input_image`; see [Session files](/guide/session-files)):

```json
{
  "model": "support-bot",
  "previous_response_id": "resp_64a1b2c3d4e5f6",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Compare these" },
        { "type": "input_file", "file_data": "data:application/pdf;base64,…", "filename": "a.pdf" },
        { "type": "input_image", "image_url": "https://example.com/cat.png" }
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

`status` is `completed`, `incomplete` (a run limit, a cancellation or the session budget ended the run before a final answer; `stop_reason` and `incomplete_details.reason` say which) or `requires_action`.

### Waiting for an approval or an answer

An agent with [approvals & questions](/guide/agent-approvals) can pause. The response then has `status: "requires_action"`, `stop_reason: "requires_action"` and the requests to answer in `required_action`:

```json
{
  "id": "resp_64a1b2c3d4e5f6",
  "object": "response",
  "status": "requires_action",
  "stop_reason": "requires_action",
  "required_action": {
    "type": "agent_actions",
    "actions": [
      { "id": "act_0123456789abcdef01234567", "kind": "tool_approval", "tool_name": "sandbox_exec", "args": { "command": "ls" }, "status": "pending" }
    ]
  }
}
```

Answer with `POST /api/client/v1/agents/sessions/{conversationId}/actions/{actionId}` (the conversation id is the one inside `resp_{conversationId}`). An agent that does not use these features never returns this status.

### Sessions

The conversation a response belongs to is a session. Besides the Responses call, it has its own endpoints:

| Endpoint | |
|----------|---|
| `GET /agents/sessions/{conversationId}` | Runtime state: `idle`, `running`, `requires_action` or `budget_paused`; the pending requests; budget and spend |
| `PATCH /agents/sessions/{conversationId}` | Set, raise or remove the [spend budget](/guide/agent-session-budgets); continues a session paused on it |
| `GET /agents/sessions/{conversationId}/events` | The [event log](/guide/agent-session-events) (poll) |
| `GET /agents/sessions/{conversationId}/events/stream` | The event log as Server-Sent Events, resumable with `Last-Event-ID` |
| `POST /agents/sessions/{conversationId}/actions/{actionId}` | Answer an [approval or question](/guide/agent-approvals) |
| `POST`, `GET /agents/sessions/{conversationId}/files`, `GET …/files/{fileId}/content`, `DELETE …/files/{fileId}` | [Session files](/guide/session-files) |

[Webhooks](/guide/webhooks) (`/webhooks`) notify your service when a session goes idle, needs an answer or reaches its budget. Field names of these endpoints are `snake_case`. The full request and response shapes are in the [OpenAPI spec](/api/openapi).

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
| **Knowledge Engine Modules** | Retrieval-augmented generation sources |
| **Temperature / Top-P** | Model parameter overrides |
| **Max Tokens** | Output length limit |
| **Versioning** | Publish and pin specific agent configurations |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing `model` or `input` field, or agent is not active |
| 401 | Invalid API token |
| 402 | The session has reached its spend budget (`budget_reached`) |
| 404 | Agent not found, or `previous_response_id` references invalid conversation |
| 409 | Another run is active for the conversation, or the session is waiting for an approval or an answer (`pending_action`) |
| 429 | The tenant's spend limit is used up (`spend_limit_exceeded`) |
| 500 | Internal error during agent execution |
