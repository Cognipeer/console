# Tracing API

Endpoints for ingesting agent tracing sessions and events.

## Batch Ingestion

Send a complete session with all events in one request:

```
POST /api/client/v1/tracing/sessions
```

```json
{
  "sessionId": "sess-abc123",
  "threadId": "thread-456",
  "agent": {
    "name": "research-agent",
    "version": "1.0.0",
    "model": "gpt-4"
  },
  "status": "completed",
  "startedAt": "2025-01-15T10:00:00Z",
  "endedAt": "2025-01-15T10:00:03Z",
  "durationMs": 3500,
  "summary": {
    "totalInputTokens": 500,
    "totalOutputTokens": 200,
    "totalCachedInputTokens": 0
  },
  "events": [
    {
      "type": "llm_call",
      "label": "Generate response",
      "sequence": 1,
      "sections": [
        { "type": "input", "content": "User query..." },
        { "type": "output", "content": "Assistant response..." }
      ],
      "inputTokens": 500,
      "outputTokens": 200
    }
  ]
}
```

### Response

```json
{ "sessionId": "sess-abc123", "status": "ingested" }
```

Processing happens asynchronously via `fireAndForget` — the response is immediate.

## Streaming Ingestion

For long-running sessions, stream events as they happen:

### Start Session

```
POST /api/client/v1/tracing/sessions/stream/:sessionId/start
```

```json
{
  "threadId": "thread-456",
  "agent": { "name": "research-agent", "version": "1.0.0" },
  "startedAt": "2025-01-15T10:00:00Z"
}
```

```json
{ "sessionId": "sess-abc123", "status": "started" }
```

### Send Event

```
POST /api/client/v1/tracing/sessions/stream/:sessionId/events
```

```json
{
  "event": {
    "type": "tool_call",
    "label": "Search API",
    "sections": [
      { "type": "input", "content": "{\"query\": \"...\"}" },
      { "type": "output", "content": "{\"results\": [...]}" }
    ],
    "inputTokens": 50,
    "outputTokens": 100
  }
}
```

```json
{ "sessionId": "sess-abc123", "totalEvents": 2 }
```

The session must exist (created via `/start`).

### End Session

```
POST /api/client/v1/tracing/sessions/stream/:sessionId/end
```

```json
{
  "status": "completed",
  "endedAt": "2025-01-15T10:00:03Z",
  "durationMs": 3500,
  "summary": {
    "totalDurationMs": 3500,
    "totalInputTokens": 500,
    "totalOutputTokens": 200
  }
}
```

```json
{ "sessionId": "sess-abc123", "status": "completed" }
```

## Event Types

| Type | Description |
|------|-------------|
| `llm_call` | LLM completion request/response |
| `tool_call` | Tool/function invocation |
| `retrieval` | RAG/vector retrieval |
| `custom` | Application-defined event |

## Event Sections

Each event can have multiple sections:

| Section Type | Purpose |
|-------------|---------|
| `input` | Input data/prompt |
| `output` | Output/response data |
| `metadata` | Additional context |
| `error` | Error information |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRACING_MAX_BODY_SIZE_MB` | `10` | Maximum request body size for tracing |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 401 | Invalid API token |
| 404 | Session not found (streaming mode) |
| 429 | Rate limit or quota exceeded |
