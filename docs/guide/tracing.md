# Agent Tracing

The tracing system records and visualizes AI agent execution sessions, including LLM calls, tool use, retrieval operations, and multi-agent workflows. The console exposes this under **Operate → Agent Observability**.

::: tip Tracing an agent you built elsewhere
Agents written in LangChain, LangGraph, the OpenAI Agents SDK, the Claude Agent
SDK, the Vercel AI SDK, n8n or anything OpenTelemetry-instrumented can send
traces here in two lines. See
[Observability Integrations](/guide/observability/overview).
:::

## Operator view

The overview screen consolidates every signal you need to triage a run: total sessions and tokens for the current window, the rolling event count, tool error rate, plus per-agent breakdowns, top models, and top token consumers. Recent traffic is summarised by day so anomalies in the last week stand out.

![Agent Observability overview](/screenshots/tracing/01-tracing-overview.png)

The left sidebar splits the surface into these views:

- **Overview** — the workspace-wide rollup pictured above.
- **Health** — the health scoreboard of agents, models, knowledge bases, MCP servers and tools (Enterprise; the community build shows an upgrade page).
- **Sessions** — the flat session log, filterable by date, agent, status, or thread.
- **Threads** — multi-turn conversations grouped by `threadId`; useful when reconstructing a user's full interaction.
- **Agents** — every agent that reported sessions, with its [health](#agent-health) against the previous period.

Clicking a session opens its event timeline — LLM calls, tool calls, retrieval steps, and child-agent invocations are rendered as nested spans with token usage and latency on each row.

### Who sees the threads of an agent

The thread of an agent is its [agent session](/guide/agent-sessions): whoever started it sees it, and anybody else needs the Agents service at Read (`agent.session_view_others`) - holding Tracing alone does not show other people's agent threads, they are left out of the lists and refused with `403` by id. Threads that other producers send (an SDK, an OpenTelemetry exporter) are not agent sessions and follow the Tracing service only. A caller who is held to their own sessions gets the Threads and Sessions lists filled from further pages and a `hasMore` / `nextSkip` pair in place of `total`. See [Authorization](/guide/authorization#sessions-and-approvals).

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
  status: string;          // success | error | in_progress | abandoned (a client may send others, e.g. completed)
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

## Session status

A session ends up in one of four statuses:

| Status | Meaning |
|--------|---------|
| `success` | The run finished and no error was recorded |
| `error` | The run finished and an error was recorded: a failed event, an error on the session that is not a tracing-sink failure, or a root span that ended in error |
| `in_progress` | The run has started and has not ended |
| `paused` | The run stopped to wait for a person (an approval or an answer) or for the calling app (a client tool result). The rest of the run lands in the same session when it resumes. A hosted agent's paused run that will not resume (a new message, a stop or a timeout ended the wait) is closed as `cancelled` or `expired` |
| `abandoned` | The run never reported an end and has been quiet for `TRACING_STALE_SESSION_MINUTES` (6 hours by default). An abandoned session is **not** counted as an error |

A client may send other final statuses (`completed`, `failed`, `partial`, `cancelled` and so on). They are stored and shown as sent. For the health numbers, `error` and `failed` are failures, and every status except `in_progress`, `paused` and `unknown` is a finished run.

An event is an error when its `status` is `error` or `failed`, or when it has no status and carries a non-empty `error`. `skipped` events (a policy or a cancellation), `pending` events (a request still waiting for its answer) and `retry` events are not errors, and skipped and pending calls are left out of the call counts behind the tool and model error rates.

### How the status is decided

**The status the client sends wins.** The console derives a status only when the client sends none (or `unknown`).

| How you send the session | Status |
|--------------------------|--------|
| Batch (`POST /tracing/sessions`) | The `status` you send is kept as is. Without one the session counts as finished: `error` when any event failed or the payload lists a non-sink error, otherwise `success`. Send `in_progress` to keep it open |
| Streaming | `/start` sets `in_progress`; starting an id that already exists reopens it and keeps its totals. `/end` stores the `status` you send; without one it is `error` when any event so far failed or the end payload lists an error, otherwise `success` |
| OTLP (`POST /traces`) | OTLP has no end signal except the root span (the span without a parent, or the `agent_session` span). The session stays `in_progress`, even while error spans arrive, until a request carries the root span with an end time. It then becomes `error` if any error was recorded (error spans, an exception or ERROR status on the root) and `success` otherwise |
| Hosted agents | The runtime's own status is kept; without one the batch rule above applies |

**Late events.** Events are posted in the background and can arrive after the session ended.

- **A status you sent is final.** A status sent on the batch API or on stream `/end` (anything but empty, `unknown` or `in_progress`) is never changed by a late event: a run you report as `success` stays `success`. The late failed event is still counted as an error event, so it shows in `agent_error_events` and in the tool and model error rates, but the session itself does not count as failed in the session error rate.
- **A derived status can still flip.** When no status was sent (or the session is OTLP), a failed event that arrives after the session finished as `success`, `completed` or `partial` turns it into `error`, and the health numbers are corrected.
- **Starting the session again resets this.** `/start` on a stream session id that already exists reopens it, and its status is derived again when it ends.

**Sessions that never end.** A background sweep runs every `TRACING_FINALIZER_INTERVAL_MS` (5 minutes by default):

- An **OTLP** session whose root span never arrives is closed after 10 minutes without activity (or after `TRACING_STALE_SESSION_MINUTES`, if that is shorter). It becomes `error` if any error was recorded and `success` otherwise, from the spans received so far.
- **Any other session** still `in_progress` `TRACING_STALE_SESSION_MINUTES` after its last activity becomes `abandoned`.

A late `/end` or root span revives such a session, gives it its real status and corrects the numbers that were already counted. Sessions that had been stranded for more than a day when the sweep first reaches them are closed as well, but they are treated as history and are not added to the health numbers.

### How a status reaches the health numbers

A session is counted **once**, when it reaches a final status. It counts as one request of its agent; an `error` session also counts as an error, and an `abandoned` one as abandoned (with no duration). If the status changes afterwards, only the difference is booked, so nothing is counted twice. Tokens and cost are booked with the first final status. Running sessions are not counted until they end, so a rule or chart can trail a long run by its duration. See [Monitoring](/guide/monitoring#metrics) for the metrics built on this.

A `paused` session is not counted either, since its run has not ended. It is counted once, when it finishes or is closed: its tokens and cost cover every part of the run, and its duration leaves out the time spent waiting for a person or for the calling app (overlapping waits count once). A run that was waiting the whole time is counted without a duration. A paused session is not swept as abandoned, so one that never resumes stays out of the health numbers.

The tool calls, model calls and error events of a session are counted as their events arrive. For an externally traced agent, the time an event is counted at is clamped into the window from 3 hours before to 5 minutes after the moment it is received: an event dated between 3 and 24 hours ago is counted in the bucket 3 hours back, and a future-dated one 5 minutes ahead (its counts are kept, only its time moves). Events dated more than 24 hours ago are not counted at all, and neither is a session that ended more than 24 hours ago (a session is counted at its end time), so a replay or a re-import of old traces does not change current health. Hosted agents, whose times come from the console itself, keep their real timestamps. The session timeline always shows the timestamps the client sent. One ingest request is counted for at most 50 distinct models and 50 distinct tools.

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
| `GET /api/tracing/dashboard` | Dashboard analytics |
| `GET /api/tracing/agents/:agentName/overview` | Per-agent summary |
| `GET /api/tracing/agents/health` | Health of every agent: totals, previous period, sparkline and alert state |
| `GET /api/tracing/agents/:agentName/health` | Health of one agent: bucketed series, normal-range band, markers and alert counts |

## Agent health

Every agent that reports sessions gets a health view built from the 5-minute entity rollups, which are kept for `ENTITY_METRICS_RETENTION_DAYS` (45 days by default). Sessions are counted when they reach a final status, so a running session shows up when it ends.

**Agents list.** **Agents** has one row per agent for the selected period (the last 24 hours by default): sessions, error rate, p95 duration, tool error rate, cost, a trend sparkline and the latest session status. Sessions, error rate, p95 duration and tool error rate show their change against the period before, signed (`+12%`, or `−0.8 pp` for a rate) and left out when the move is small (under 5 %, or under 0.5 points for a rate). Search by name and filter by latest status or by health. The health badge reads the alert rules of the agent:

| Badge | Meaning |
|-------|---------|
| Firing (with its severity) | An alert is firing for the agent. It links to the open incident |
| Pending | An alert condition is being met and has not fired yet |
| OK | At least one enabled alert rule covers the agent and none is firing |
| No alert rule | No enabled rule covers the agent, so nothing would fire if it failed. It links to a new rule for the agent |
| Unknown | The alert state could not be read right now. It is shown instead of OK |

OK reflects alert rules only. It does not mean the agent is healthy when no rule covers it.

**Agent detail.** The **Health** panel of an agent shows the same figures as tiles, each with its change against the previous period (signed and with an arrow for the direction, for example `+12%` or `−3.4 pp`; rates change in percentage points, other figures in percent), and three charts: sessions with error rate, duration (p50 and p95), and tool errors with abandoned runs. Markers on the charts show when a new agent version was first seen and when an incident opened. A marker is tagged with the version tag or with "Incident" and shows its full text when you hover it, and the **Markers** list under the charts names each one with its time and links it: an incident to its incident, a version to the sessions of the agent. With the Enterprise edition the error-rate and p95 charts also show a shaded band, the normal range learned from the previous 14 days (for the error rate it allows for how many sessions each bucket holds, so a quiet bucket gets a wider band). The panel counts the agent's firing and pending alerts, and offers **Create alert** and **View failing sessions** (the session list filtered to this agent and to errors).

### Agent health API

Both endpoints are dashboard APIs (session authentication) and read the active project.

| Parameter | Applies to | Description |
|-----------|-----------|-------------|
| `period` | both | `last_day` (default), `last_7_days`, `last_30_days` or `total`. Health data is a rolling rollup, so `total` is the last 30 days |
| `from`, `to` | both | ISO dates. When given they win over `period`; `to` is never later than now and `from` defaults to 24 hours before `to` |
| `limit` | list | Agents returned, 200 by default, at most 500 |

The start of the range is aligned down to the 5-minute rollup bucket and cannot be earlier than the retention window. Invalid dates, a `from` that is not earlier than `to`, or a range outside the retained data answer `400`.

`GET /api/tracing/agents/health` returns the agents ordered by sessions. Agents that went quiet for the whole range but have an active alert are included, with zero totals.

```json
{
  "range": { "fromMs": 1760400000000, "toMs": 1760486400000, "bucketMs": 3600000, "sparkFromMs": 1760400000000 },
  "alertsAvailable": true,
  "agents": [
    {
      "name": "pulse-main",
      "totals": {
        "requests": 412, "errors": 9, "errorRate": 2.18,
        "p50Ms": 1800, "p95Ms": 6400, "p99Ms": 11200, "avgMs": 2300, "maxMs": 18300,
        "costUsd": 3.41, "inputTokens": 910000, "outputTokens": 120000,
        "errorEvents": 14, "toolCalls": 1630, "toolErrors": 22, "toolErrorRate": 1.35,
        "aiCalls": 1204, "aiErrors": 6, "aiErrorRate": 0.5,
        "abandoned": 2, "abandonedRate": 0.49, "emptyResults": 0, "emptyResultRate": null
      },
      "previous": null,
      "spark": { "requests": [12, 18, 9], "errorRate": [0, 5.5, null], "p95Ms": [5200, 7100, null] },
      "alert": { "phase": "firing", "severity": "warning", "incidentId": "665f1c1a8b1d4c0012ab34ce", "covered": true }
    }
  ],
  "total": 1
}
```

- `range.bucketMs` is the size of one sparkline point (the range split into 24 points, rounded up to a multiple of 5 minutes); point `i` starts at `sparkFromMs + i * bucketMs`. `spark` has 24 points (3 are shown above).
- `totals` and `previous` carry the same fields. `previous` is the period of the same length just before the range, and `null` when retention does not cover all of it. Rates are percentages from 0 to 100, and `null` when there is nothing to divide by. Latencies are in milliseconds.
- `alert.phase` is `firing`, `pending` or `null`. `alert.covered` tells whether an enabled alert rule (module `agents`, target all agents or this agent) watches the agent, so `phase: null` with `covered: false` means unmonitored, not healthy. Rules without an entity target (older rules) do not count.
- `alertsAvailable` is `false` when the rules or their states could not be read. Every `alert` is then unknown, not OK.
- `alert.incidentId` is returned only to callers who may read alerts (the `alerts` service at read level). Other callers still get `phase` and `severity`.

`GET /api/tracing/agents/:agentName/health` returns one agent:

```json
{
  "range": { "fromMs": 1760400000000, "toMs": 1760486400000, "bucketMs": 3600000 },
  "buckets": [{ "t": 1760400000000, "requests": 12, "errors": 0, "errorRate": 0, "p95Ms": 5200 }],
  "totals": { "requests": 412, "errors": 9, "errorRate": 2.18 },
  "previous": null,
  "baseline": {
    "errorRate": [{ "t": 1760400000000, "median": 1.2, "lower": 0, "upper": 3.1 }],
    "p95Ms": [{ "t": 1760400000000, "median": 5000, "lower": 3800, "upper": 7400 }]
  },
  "markers": [
    { "t": 1760431200000, "type": "version", "label": "v1.5.0", "href": "/dashboard/tracing/sessions?agent=pulse-main" },
    { "t": 1760442000000, "type": "incident", "label": "Agent error rate", "href": "/dashboard/alerts/incidents/665f1c1a8b1d4c0012ab34ce" }
  ],
  "markersPartial": false,
  "alertsAvailable": true,
  "alerts": { "firing": 1, "pending": 0, "covered": true }
}
```

Each bucket and `totals` carry the same fields as in the list (trimmed above). The bucket size is 5 minutes for ranges up to 6 hours, 1 hour up to 48 hours, and 1 day beyond that. `baseline` is `null` outside the Enterprise edition or when it cannot be computed. `markers` are the first time each agent version was seen in the range and the incidents opened in it; incident markers are returned only to callers who may read alerts, and `markersPartial` is `true` when the session read behind the version markers hit its bound, so earlier versions may be missing.

## Built-in MCP — Console observability

Cognipeer ships a built-in MCP server that exposes the agent observability layer to agents themselves. This is how an agent can answer questions like "summarise my last 10 runs" or "look up session `sess-…` and tell me what failed" without any external integration.

The server is mounted under the client API as a normal MCP endpoint:

```
GET  /api/client/v1/mcp/console/sse
POST /api/client/v1/mcp/console/message
POST /api/client/v1/mcp/console/execute
```

Authentication is the same `Bearer cpeer_…` token used everywhere else; the project context is resolved from the token and applied to every tool call.

Tools exposed:

| Tool | Purpose |
|---|---|
| `list_recent_sessions` | Filter by status, agent (exact/partial), or free-text search on `sessionId`/`threadId`/agent name. Capped at 100 sessions per call. |
| `get_session` | Fetch a single session by `sessionId` including its event timeline. |
| `get_dashboard_overview` | Rolled-up analytics for an ISO time window (sessions, tokens, top agents, top models, status distribution, daily trend). |

Attach the console MCP to an agent the same way you'd attach any other MCP server — the [MCP API](../api/mcp.md) handshake (`initialize`, `tools/list`, `tools/call`) works identically.

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
