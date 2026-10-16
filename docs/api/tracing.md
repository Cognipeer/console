# Tracing API

Endpoints for ingesting agent tracing sessions/events and OTLP traces, and for
reading them back.

::: tip Sending from an existing agent
Prebuilt integrations for LangChain, LangGraph, the OpenAI Agents SDK, the
Claude Agent SDK, the Vercel AI SDK, n8n and any OpenTelemetry-instrumented
framework live in
[`cognipeer-observability`](/guide/observability/overview) and speak the
contract below for you.
:::

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

### Tool definitions (per model call)

An event may carry a first-class `toolDefinitions` array describing the tool
menu offered to the model **on that call** (the menu can change between turns,
so it is captured per event, never per session):

```json
{
  "id": "evt-1",
  "type": "ai_call",
  "toolDefinitions": [
    {
      "name": "search_flights",
      "description": "Search flights by city",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
    }
  ]
}
```

The server normalizes this into a `{"kind": "tool_definitions", "tools": [...]}`
section on the stored event (accepted on both the batch and streaming paths;
malformed input is ignored silently). Oversized schemas are capped: entries
keep `name`/`description` and drop `parameters` with `"truncated": true`.
Senders may also encode the section themselves inside `sections`. OTLP ingestion
synthesizes the same section from `llm.request.functions.{i}.*` /
`gen_ai.request.functions.{i}.*` indexed attributes and from a
`gen_ai.request.tools` / `llm.request.tools` JSON-array attribute.

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

## Session Status

The `status` of a session decides how it counts in the agent health numbers and in alerts. **A status the client sends wins**; the console derives one only when the client sends none (or `unknown`).

| Ingest path | Status |
|-------------|--------|
| Batch (`POST /sessions`) | The `status` you send is kept as is. Without one the session counts as finished: `error` when any event failed or the payload lists a non-sink error, otherwise `success`. Send `in_progress` to keep it open |
| Stream `/start` | `in_progress`. Starting an id that already exists reopens it, keeps its totals and makes the status derivable again |
| Stream `/end` | The `status` you send is kept as is. Without one: `error` when any event so far failed or the end payload lists an error, otherwise `success` |
| OTLP (`POST /traces`) | `in_progress` until a request carries the root span (no parent, or the `agent_session` span) with an end time, even while error spans arrive. Then `error` if any error was recorded, otherwise `success` |

Other final statuses (`completed`, `failed`, `partial`, `cancelled`, ...) are stored as sent. For the health numbers `error` and `failed` are failures, and every status except `in_progress` and `unknown` is a finished run.

- **A status you sent is final.** Events are posted in the background and can arrive after the session ended. A late failed event is still counted as an error event (agent error events, tool and model error rates) but does not turn a session whose status you sent on batch or `/end` into `error`. When the status was derived, or the session is OTLP, a late failed event does flip a finished `success`, `completed` or `partial` session to `error`.
- **Sessions that never end.** A sweep runs every `TRACING_FINALIZER_INTERVAL_MS`. An OTLP session whose root span never arrives is closed after 10 minutes without activity as `error` or `success`; any other session still `in_progress` after `TRACING_STALE_SESSION_MINUTES` becomes `abandoned`, which is not an error. A late `/end` or root span revives it.
- **Counting.** A session is counted once, when it reaches a final status, and later corrections are booked as differences. Tokens and cost are booked with the first final status. For an externally traced agent an event is counted at its arrival time clamped into 3 hours before to 5 minutes after; events dated more than 24 hours ago, and sessions that ended more than 24 hours ago, are not counted. The timeline keeps the timestamps you sent.

Details and the metrics built on this: [Agent Tracing](/guide/tracing#session-status).

## Reading Traces Back

### Client API

```
GET /api/client/v1/tracing/threads?agent=&status=&threadId=&from=&to=&limit=50&skip=0
GET /api/client/v1/tracing/threads/:threadId
```

Threads group sessions by `threadId` and return aggregated totals per thread.
`404` when the thread does not exist.

### Dashboard API

Session-authenticated, used by the Console UI. Useful when scripting against
your own workspace:

| Endpoint | Purpose |
|---|---|
| `GET /api/tracing/dashboard` | Workspace rollup: sessions, tokens, error rate, per-agent and per-model breakdowns |
| `GET /api/tracing/sessions` | Session list, filterable by agent, status, thread, date |
| `GET /api/tracing/sessions/:sessionId` | One session with its event timeline |
| `GET /api/tracing/sessions/:sessionId/events/:eventId` | One event in full |
| `GET /api/tracing/threads` · `/:threadId` | Threads and thread detail |
| `GET /api/tracing/agents` · `/:agentName/overview` | Per-agent metrics and insights |
| `GET /api/tracing/agents/health` | Health of every agent: totals, previous period, sparkline and alert state (see [Agent health](#agent-health)) |
| `GET /api/tracing/agents/:agentName/health` | Health of one agent: bucketed series, normal-range band, markers and alert counts |
| `GET /api/tracing/models/:modelName/overview` | Per-model metrics and insights |

#### `?includeEventContent=false`

On the session and thread detail endpoints, this drops every event's
`sections` and `metadata` from the response, leaving the timeline skeleton —
type, label, status, timing, tokens, span ids. A session whose events carry
large prompts can be megabytes; the Console uses this for the initial timeline
render and fetches full content per event on expand.

```
GET /api/tracing/sessions/sess-abc123?includeEventContent=false
```

#### `insights`

The agent and model overview endpoints include an `insights` object computed
deterministically from a bounded sample of the most recent sessions — no model
calls involved. It is `null` when there is nothing to sample.

```json
{
  "insights": {
    "sampledSessions": 40,
    "perCall": {
      "aiCalls": 312, "toolCalls": 190,
      "avgAiCallsPerSession": 7.8, "avgToolCallsPerSession": 4.75,
      "avgInputTokensPerAiCall": 18904
    },
    "toolMenu": {
      "available": true, "coveragePct": 96.4,
      "avgMenuSize": 14, "maxMenuSize": 22, "distinctTools": 31
    },
    "promptProfile": {
      "found": true,
      "sourceSessionId": "sess-abc123",
      "capturedAt": "2026-01-15T10:00:00Z",
      "lint": { "…": "PASS/WARN checks on the recovered system prompt" },
      "preview": "You are a support agent…"
    },
    "errorPatterns": [
      { "message": "tool timeout", "count": 12, "lastSeen": "2026-01-15T09:12:00Z" }
    ],
    "waste": {
      "repeatedToolCalls": {
        "callsAnalyzed": 190, "wastedCalls": 23,
        "topOffenders": [
          { "tool": "search_flights", "maxRepeatsInOneSession": 4,
            "sessionsAffected": 6, "totalWasted": 11, "argsPreview": "{\"city\":\"Rome\"}" }
        ]
      }
    }
  }
}
```

Two fields depend on what the producer recorded:

- **`toolMenu.available`** is `false` when no sampled `ai_call` carried a
  `tool_definitions` section — the tracer predates per-turn tool capture, or
  its framework cannot expose the menu. `coveragePct` is the share of `ai_call`
  events that did carry one.
- **`waste.repeatedToolCalls`** hashes each `tool_call` event's arguments,
  reading the first present of `arguments`, `args`, `input` or `content` on the
  `tool_call` section. Calls whose arguments cannot be read are excluded from
  `callsAnalyzed`.

#### Agent health

The two health endpoints read the 5-minute entity rollups, which are kept for `ENTITY_METRICS_RETENTION_DAYS` (45 days by default). Sessions are counted when they reach a final status (see [Session Status](#session-status)).

| Parameter | Applies to | Description |
|-----------|-----------|-------------|
| `period` | both | `last_day` (default), `last_7_days`, `last_30_days` or `total` (the last 30 days) |
| `from`, `to` | both | ISO dates. When given they win over `period`; `to` is never later than now and `from` defaults to 24 hours before `to` |
| `limit` | list | Agents returned: 200 by default, at most 500 |

Invalid dates, a `from` that is not earlier than `to` and a range outside the retained data answer `400`. The list returns, per agent, `totals`, `previous` (the period of the same length just before, or `null`), a 24-point `spark` and an `alert` object (`phase`, `severity`, `incidentId`, `covered`); the detail returns `buckets` (5 minutes up to 6 hours, 1 hour up to 48 hours, 1 day beyond), `totals`, `previous`, `baseline` (Enterprise; `null` otherwise), `markers` (agent versions and incidents) and the agent's alert counts. `alert.incidentId` and the incident markers are returned only to callers who may read the `alerts` service. Both responses carry `alertsAvailable: false` when the alert rules could not be read, in which case no agent is reported as covered or OK. The response fields are described in [Agent Tracing](/guide/tracing#agent-health-api).

## OTel Correlation Fields

| Field | Scope | Description |
|------|-------|-------------|
| `traceId` | Session + Event | W3C trace identifier (32 hex chars) |
| `rootSpanId` | Session | Root span identifier for the session |
| `spanId` | Event | Span identifier for the event |
| `parentSpanId` | Event | Parent span identifier (for hierarchy) |
| `source` | Session | Ingestion source: `custom` or `otlp` |

## Token & Finish Reason Fields

| Field | Scope | Description |
|------|-------|-------------|
| `reasoningTokens` | Event | Reasoning/thinking tokens the model spent before its answer (e.g. OpenAI's `completion_tokens_details.reasoning_tokens`). A **subset** of `outputTokens` — never billed on top of it. |
| `finishReason` | Event | Normalized (trim + lowercase) raw provider stop reason — `stop`, `length`, `tool_calls`, etc. |
| `totalReasoningTokens` | Session | Running total of the session's event `reasoningTokens`. Already counted within `totalOutputTokens` — never add it again in cost math. |
| `truncatedEvents` | Session | Count of events whose `finishReason` signalled a token/length cutoff (`length`, `max_tokens`, …) rather than the model stopping on its own terms. |

## Event Types

Console aggregates per type, so producers should use these names rather than
inventing their own. Anything else is accepted and shown verbatim, but only
these get first-class treatment in the UI and in cost accounting.

| Type | Description |
|------|-------------|
| `ai_call` | A model call. The only type that should carry `model` and token counts. |
| `tool_call` | Tool/function invocation. Set `toolName`. |
| `retrieval` | RAG/vector retrieval |
| `embedding` | Embedding call |
| `summarization` | History compaction |
| `guardrail` | Policy or safety check |
| `span` | Anything else — a graph node, a chain step, custom work |

## Section Kinds

`sections[]` is the renderable body of an event. `kind` drives the badge colour
in the detail UI; every other key is rendered generically as a labelled field,
so extra keys are safe.

| `kind` | Shape |
|---|---|
| `message` | `{ role: 'system' \| 'user' \| 'assistant' \| 'tool', content }` |
| `tool_call` | `{ tool, content }` — the arguments |
| `tool_result` | `{ tool, content }` — the result |
| `tool_definitions` | `{ tools: [{ name, description?, parameters? }] }` |
| `metadata` | `{ content }` — anything structural |

Downstream consumers depend on this shape: the traffic-snapshot mapper skips
sessions it cannot map, and the deterministic insights read `tool_call` and
`tool_definitions` sections directly.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TRACING_MAX_BODY_SIZE_MB` | `10` | Maximum request body size for tracing payloads |
| `TRACING_STALE_SESSION_MINUTES` | `360` | Quiet time after which a session that never ended becomes `abandoned` (minimum 5) |
| `TRACING_FINALIZER_INTERVAL_MS` | `300000` | How often the sweep for sessions that never ended runs (minimum 10000) |
| `ENTITY_METRICS_FLUSH_MS` | `30000` | How often the health rollup is written (minimum 1000) |
| `ENTITY_METRICS_RETENTION_DAYS` | `45` | How long the 5-minute rollups are kept |

The other health and alerting settings are listed under [Entity Health & Alerting](/guide/configuration#entity-health-alerting).

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing/invalid required fields |
| 401 | Invalid API token |
| 404 | Session not found (streaming mode) |
| 413 | Payload exceeds `TRACING_MAX_BODY_SIZE_MB` |
| 429 | Rate limit or quota exceeded |
