# Data Model

Every integration is a mapping from a framework's own telemetry onto the model
below. This page is the contract: what Console stores, what each field does to
the UI and to cost accounting, and what a new integration — or a language we
do not ship an SDK for yet — has to produce.

For the raw endpoint shapes see the [Tracing API reference](/api/tracing).

## Session → event → section

```
session   one agent run  ──────────────────────  Tracing → Sessions
  ├── event   one step of that run  ────────────  a row in the run timeline
  │     └── section   one renderable block  ────  the expanded row body
  └── event …
```

**Threads** sit above sessions: several sessions sharing a `threadId` are one
conversation in **Tracing → Threads**. That is how a chat agent's turns, or a
LangGraph run that pauses for human input and resumes, are reassembled — each
resume is a fresh run with a fresh trace id, and `threadId` is the only thing
tying them together.

## Session

| Field | Type | What it does |
|---|---|---|
| `sessionId` | string | Identity. Posting the same id again updates the session rather than creating another. |
| `threadId` | string | Conversation key — drives the Threads view. Set it whenever your framework has a conversation concept. |
| `traceId` | 32 hex | W3C trace id, so a run can be correlated with another OTel backend. |
| `rootSpanId` | 16 hex | Parent of every top-level event. |
| `agent` | `{name, version, model, provider}` | `name` is what the Agents screen and cost reports group by. `version` is what makes a before/after comparison possible after a prompt change. |
| `status` | `success` \| `error` \| `in_progress` | |
| `startedAt` / `endedAt` | ISO 8601 | |
| `durationMs` | number | |
| `summary` | totals | `totalInputTokens`, `totalOutputTokens`, `totalCachedInputTokens`, `totalDurationMs`, `eventCounts` |
| `config` | object | Free-form run configuration, shown on the session header. |
| `errors` | array | A non-empty list marks the session failed. |

::: tip Session totals only grow
A session's totals are monotonic server-side. An SDK that reports one run in
several legs — a summarization pass, a tool retry, a resume after an
interrupt — sends several `end` calls, each describing only its own leg. Console
takes the larger of what it already has and what the leg reports, so a later
leg can never shrink a run's totals, and a retried `end` is idempotent.
:::

## Event types

Console aggregates per type, so use these rather than inventing names:

| `type` | Use for |
|---|---|
| `ai_call` | A model call. The only type that should carry `model` and token counts. |
| `tool_call` | A tool or function invocation. Set `toolName`. |
| `retrieval` | RAG or vector search. |
| `embedding` | An embedding call. |
| `summarization` | History compaction. |
| `guardrail` | A policy or safety check. |
| `span` | Anything else — a graph node, a chain step, a block of your own work. |

## Event

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable per event; used to de-duplicate on re-ingest. |
| `label` | string | The timeline row's title. Node name, tool name or model name. |
| `spanId` / `parentSpanId` | 16 hex | Builds the tree. See [Identifiers](#identifiers). |
| `sequence` | number | Timeline ordering. |
| `timestamp` | ISO 8601 | Start of the step. |
| `durationMs` | number | |
| `status` | `success` \| `error` | |
| `error` | string or object | Attached to a failed step. |
| `model` | string | **The provider's model id** (`gpt-4.1-mini`), not a nickname — see [Cost](#cost-and-double-counting). |
| `inputTokens` / `outputTokens` / `cachedInputTokens` / `totalTokens` | number | See [Tokens](#tokens). |
| `toolName` / `toolExecutionId` | string | `toolExecutionId` correlates the run with the model's tool-call id. |
| `toolDefinitions` | array | The tool menu offered on this call. See below. |
| `actor` | `{scope, name}` | `scope` is `agent`, `model`, `tool`, `retriever` or `user`; drives the actor column. |
| `sections` | array | The expanded row body. |
| `metadata` | object | Anything else worth keeping; rendered as a key/value block. |

## Sections

`kind` drives the badge colour in the tracing detail UI. Every other key is
rendered generically as a labelled field, so extra keys are safe and are a
reasonable place to put framework-specific detail.

| `kind` | Shape | Rendered as |
|---|---|---|
| `message` | `{role, content}` | A chat bubble with a role badge |
| `tool_call` | `{tool, content}` | The arguments, JSON-tree if parseable |
| `tool_result` | `{tool, content}` | The result |
| `tool_definitions` | `{tools: [{name, description?, parameters?}]}` | A name badge list plus collapsible schemas |
| `metadata` | `{content}` | A labelled value block |

```json
{
  "kind": "message",
  "label": "User message",
  "role": "user",
  "content": "book me a flight to Rome"
}
```

## Tool definitions

`toolDefinitions` records **the menu the model was offered on that call** — not
the tool set the agent was configured with. The menu changes between turns, and
a large one is frequently the biggest single line item in an agent's prompt
bill, which is why it is captured per event rather than per session.

```json
{
  "type": "ai_call",
  "toolDefinitions": [
    { "name": "search_flights",
      "description": "Search flights by city",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } }
  ]
}
```

Console normalises this into a `tool_definitions` section, accepts the OpenAI
`{type: 'function', function: {…}}` envelope and Anthropic's `input_schema`
alias, and caps oversized schemas — entries then keep `name` and `description`
and drop `parameters` with `"truncated": true`. Malformed input is ignored
silently rather than failing the ingest.

Not every framework can report this. Where it cannot, the integration page says
so instead of inventing a menu.

## Tokens

`cachedInputTokens` is a **subset** of `inputTokens`, matching OpenAI's
`prompt_tokens_details.cached_tokens` and LangChain's standardised
`input_token_details.cache_read`. Cost is computed as

```
(inputTokens − cachedInputTokens) × input rate
+ cachedInputTokens              × cached rate
+ outputTokens                   × output rate
```

Anthropic reports it the other way round — its `input_tokens` **excludes** cache
reads — so the Claude integrations add the cache buckets back in:

```
inputTokens       = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
cachedInputTokens = cache_read_input_tokens
```

::: warning Absent is not zero
When a framework reports no usage — a streaming call without usage opt-in, a
cancelled run — the fields are **omitted**. A zero would silently under-report
spend; an absent value shows up as unknown and can be chased.
:::

## Cost and double counting

Trace-derived token usage is priced and rolled into spend reporting as
`service: models, source: tracing`, keyed by agent name — separable from
gateway-served traffic (`source: api`) in every report. Pricing resolves
`model` against Model Hub keys, then provider model ids, then your external
pricing catalogue, all case-insensitively. An unmatched model still records its
tokens at zero cost so the Cost page can surface it as unpriced rather than
dropping it.

A trace event describing a model call **that Console's own gateway served** is
already billed at serving time. Mark those with `metadata.gateway = true` (or a
`metadata.gatewayRequestId`) and the cost pipeline skips them. Direct-to-provider
calls — the normal case for these integrations — need no marker.

## Identifiers

`traceId` is 32 lower-hex characters, `spanId` is 16, per W3C. Framework run ids
are usually UUIDs, so the SDK folds them deterministically:

- an input that is already exactly 16 (or 32) hex characters passes through;
- anything else is hashed.

Truncation is deliberately not used. LangChain run ids are UUIDv7, whose first
16 hex digits are a millisecond timestamp plus 12 bits of entropy — two runs
started in the same millisecond would collide, and colliding span ids silently
corrupt the tree. Because the fold is deterministic, a child can compute its
parent's span id from a parent run id it never saw as an event of its own.

## Delivery

Two wire shapes, chosen by `mode`:

| Mode | Requests | Use for |
|---|---|---|
| `batch` | one, at the end | Short runs, serverless, cron. The endpoint **replaces** the session's event list, so re-posting is idempotent. |
| `stream` | `/start`, one per event, `/end` | Long runs you want to watch live. Events **append**. |
| `auto` (default) | either | Buffers, then switches to streaming once the run passes `streamAfterMs` (2 s) or `streamAfterEvents` (25). One request for a quick run, live updates for a slow one. |

A session commits to one shape the first time it delivers anything and never
switches back — a batch post would otherwise wipe already-streamed events.

## Endpoints

All under `POST /api/client/v1`, with `Authorization: Bearer <token>`:

| Path | Purpose |
|---|---|
| `/tracing/sessions` | Batch: a whole session in one request |
| `/tracing/sessions/stream/:id/start` | Open a streaming session |
| `/tracing/sessions/stream/:id/events` | Append one event |
| `/tracing/sessions/stream/:id/end` | Close, with final totals |
| `/traces` | OTLP/HTTP **JSON** `ExportTraceServiceRequest` |
| `GET /tracing/threads` | Read threads back |

The body limit is `TRACING_MAX_BODY_SIZE_MB` (10 MB by default), which is why
the SDK caps section content and strips base64 data URLs before sending.

## OpenTelemetry attribute mapping

Traces arriving at `/traces` from third-party instrumentation are normalised
from whichever convention they use. Console reads all of them, and merges when
a span carries two:

| Internal field | OpenInference (Arize) | OTel GenAI / OpenLLMetry ≥ 0.55 | OpenLLMetry ≤ 0.54 |
|---|---|---|---|
| event type | `openinference.span.kind` | `gen_ai.operation.name` | `traceloop.span.kind` |
| `model` | `llm.model_name` | `gen_ai.response.model` → `gen_ai.request.model` | `gen_ai.request.model` |
| `inputTokens` | `llm.token_count.prompt` | `gen_ai.usage.input_tokens` | `gen_ai.usage.prompt_tokens` |
| `outputTokens` | `llm.token_count.completion` | `gen_ai.usage.output_tokens` | `gen_ai.usage.completion_tokens` |
| `cachedInputTokens` | `llm.token_count.prompt_details.cache_read` | `gen_ai.usage.cache_read.input_tokens` | `gen_ai.usage.cache_read_input_tokens` |
| message sections | `llm.input_messages.N.message.*`, `llm.output_messages.N.message.*` | `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` | `gen_ai.prompt.N.*`, `gen_ai.completion.N.*` |
| `toolDefinitions` | `llm.tools.N.tool.json_schema` | `gen_ai.tool.definitions` | `llm.request.functions.N.*` |
| `toolName` | `tool.name` | `gen_ai.tool.name` | `traceloop.entity.name` |
| `threadId` | `session.id` | `gen_ai.conversation.id` | `traceloop.association.properties.session_id` |
| tool input / result | `input.value` / `output.value` | message parts, `gen_ai.tool.call.result` | `traceloop.entity.input` / `.output` |

Two details worth knowing when reading traces from these sources:

- **The system prompt moved.** OpenLLMetry ≥ 0.55 strips it out of
  `gen_ai.input.messages` into `gen_ai.system_instructions`. Console reads both;
  a backend that reads only the former loses the largest part of the prompt.
- **`__REDACTED__` is a sentinel, not content.** Instrumentation replaces
  redacted values with that literal, and Console does not render it as a message.
