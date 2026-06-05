# Tracing API

Endpoints for ingesting agent tracing sessions/events and OTLP traces.

## Batch Ingestion

Send a complete session with all events in one request:

```
POST /api/client/v1/tracing/sessions
```

```json
{
  "sessionId": "sess-abc123",
  "threadId": "thread-456",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "rootSpanId": "00f067aa0ba902b7",
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
      "id": "evt-1",
      "type": "llm_call",
      "label": "Generate response",
      "sequence": 1,
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "b7ad6b7169203331",
      "parentSpanId": "00f067aa0ba902b7",
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
{ "success": true, "sessionId": "sess-abc123", "eventsStored": 1 }
```

Processing happens asynchronously via `fireAndForget` — the response is immediate.

## Streaming Ingestion

For long-running sessions, stream events as they happen.

### Start Session

```
POST /api/client/v1/tracing/sessions/stream/:sessionId/start
```

```json
{
  "threadId": "thread-456",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "rootSpanId": "00f067aa0ba902b7",
  "agent": { "name": "research-agent", "version": "1.0.0" },
  "startedAt": "2025-01-15T10:00:00Z"
}
```

```json
{ "success": true, "sessionId": "sess-abc123", "status": "in_progress" }
```

### Send Event

```
POST /api/client/v1/tracing/sessions/stream/:sessionId/events
```

```json
{
  "event": {
    "id": "evt-2",
    "type": "tool_call",
    "label": "Search API",
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "5b8aa5a2d2d3e13c",
    "parentSpanId": "00f067aa0ba902b7",
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
{ "success": true, "sessionId": "sess-abc123", "totalEvents": 2 }
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
{ "success": true, "sessionId": "sess-abc123", "status": "completed", "durationMs": 3500 }
```

## OTLP/HTTP JSON Ingestion

Send OpenTelemetry traces directly:

```
POST /api/client/v1/traces
```

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "research-agent" } }
        ]
      },
      "scopeSpans": [
        {
          "scope": { "name": "agent-sdk", "version": "1.0.0" },
          "spans": [
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "00f067aa0ba902b7",
              "name": "agent_session:research-agent",
              "startTimeUnixNano": "1736935200000000000",
              "endTimeUnixNano": "1736935203500000000"
            }
          ]
        }
      ]
    }
  ]
}
```

### Response

```json
{
  "success": true,
  "sessionsIngested": 1,
  "spansProcessed": 1,
  "eventsStored": 0
}
```

## OTel Correlation Fields

| Field | Scope | Description |
|------|-------|-------------|
| `traceId` | Session + Event | W3C trace identifier (32 hex chars) |
| `rootSpanId` | Session | Root span identifier for the session |
| `spanId` | Event | Span identifier for the event |
| `parentSpanId` | Event | Parent span identifier (for hierarchy) |
| `source` | Session | Ingestion source: `custom` or `otlp` |

## Event Types

| Type | Description |
|------|-------------|
| `llm_call` | LLM completion request/response |
| `tool_call` | Tool/function invocation |
| `retrieval` | RAG/vector retrieval |
| `custom` | Application-defined event |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRACING_MAX_BODY_SIZE_MB` | `10` | Maximum request body size for tracing payloads |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing/invalid required fields |
| 401 | Invalid API token |
| 404 | Session not found (streaming mode) |
| 413 | Payload exceeds `TRACING_MAX_BODY_SIZE_MB` |
| 429 | Rate limit or quota exceeded |
