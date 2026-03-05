# Agent Tracing

The tracing system records and visualizes AI agent execution sessions, including LLM calls, tool use, retrieval operations, and multi-agent workflows.

## Concepts

| Concept | Description |
|---------|-------------|
| **Session** | A single agent execution (one conversation turn or task) |
| **Thread** | A group of related sessions linked by `threadId` |
| **Event** | An individual step within a session (LLM call, tool use, etc.) |
| **Agent** | The named agent that executed the session |

## Data Model

### Session Record

```typescript
interface IAgentTracingSession {
  sessionId: string;       // Unique session identifier
  threadId?: string;       // Cross-session correlation
  traceId?: string;        // W3C trace identifier
  rootSpanId?: string;     // Root span for the session
  source?: 'custom' | 'otlp';
  agentName: string;       // Agent identifier
  agentLabel?: string;     // Human-friendly label
  summary?: string;        // Session summary
  status: string;          // completed, failed, etc.
  durationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  eventCounts: Record<string, number>;
}
```

### Event Record

```typescript
interface IAgentTracingEvent {
  type: string;           // llm_call, tool_call, retrieval, etc.
  label?: string;         // Step description
  sequence: number;       // Ordering within session
  traceId?: string;       // Correlates to session trace
  spanId?: string;        // Unique span for this event
  parentSpanId?: string;  // Parent span (hierarchy)
  actor?: string;         // Agent/tool name
  sections: EventSection[];
  inputTokens?: number;
  outputTokens?: number;
}
```

## Ingestion Methods

### Batch Mode

Send a complete session with all events in one request:

```
POST /api/client/v1/tracing/sessions
Authorization: Bearer <token>
```

```json
{
  "sessionId": "sess-123",
  "threadId": "thread-456",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "rootSpanId": "00f067aa0ba902b7",
  "agent": { "name": "research-agent", "version": "1.0.0", "model": "gpt-4" },
  "status": "completed",
  "durationMs": 3500,
  "events": [
    {
      "type": "llm_call",
      "label": "Generate response",
      "sequence": 1,
      "sections": [
        { "type": "input", "content": "..." },
        { "type": "output", "content": "..." }
      ]
    }
  ]
}
```

### Streaming Mode

For long-running sessions, stream events as they happen:

```
POST /api/client/v1/tracing/sessions/stream/:sessionId/start
POST /api/client/v1/tracing/sessions/stream/:sessionId/events
POST /api/client/v1/tracing/sessions/stream/:sessionId/end
```

**Start a session:**

```json
{
  "agentName": "research-agent",
  "threadId": "thread-456"
}
```

### OTLP Mode

For OpenTelemetry-native producers (OTLP/HTTP JSON):

```
POST /api/client/v1/traces
```

This endpoint accepts `ExportTraceServiceRequest` payloads and maps spans into sessions/events automatically.

## Correlation Fields

Use these fields to connect traces across tools and dashboards:

| Field | Scope | Description |
|-------|-------|-------------|
| `traceId` | Session + Event | End-to-end trace correlation ID |
| `rootSpanId` | Session | Root span for the full session |
| `spanId` | Event | Span generated for each event |
| `parentSpanId` | Event | Parent-child span linkage |
| `source` | Session | Ingestion mode (`custom` or `otlp`) |

**Send an event:**

```json
{
  "type": "tool_call",
  "label": "Search API",
  "sequence": 2,
  "sections": [
    { "type": "input", "content": "{\"query\": \"...\"}" },
    { "type": "output", "content": "{\"results\": [...]}" }
  ]
}
```

**End the session:**

```json
{
  "status": "completed",
  "summary": "Successfully researched the topic"
}
```

## Dashboard APIs

| Endpoint | Purpose |
|----------|---------|
| `GET /api/tracing/sessions` | Paginated session listing |
| `GET /api/tracing/sessions/:sessionId` | Session detail with events |
| `GET /api/tracing/threads` | Group sessions by thread |
| `GET /api/tracing/threads/:threadId` | Thread detail |
| `GET /api/tracing/overview` | Dashboard analytics |
| `GET /api/tracing/agents` | Per-agent summary |

## Analytics

The `getDashboardOverview` method provides:

- Recent sessions and agents
- Total token usage
- Tool usage statistics
- Status distribution
- Model usage breakdown
- Daily usage trends

## Background Processing

Tracing ingestion uses `fireAndForget()` for non-blocking processing:

```typescript
fireAndForget('tracing-ingest', () =>
  ingestTracingSession(tenantDbName, sessionData)
);
```

This ensures the API response is not delayed by database writes.
