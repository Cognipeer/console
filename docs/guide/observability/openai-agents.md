# OpenAI Agents SDK

The Agents SDK has a first-class tracing bus: a `TracingProcessor` receives
every trace and span the runtime produces — agent turns, model calls, tool
calls, handoffs, guardrails and MCP tool listings. This integration registers
one, so nothing about how your agent runs has to change.

## Install and wire

::: code-group

```bash [Python]
pip install "cognipeer-observability[openai-agents]"
```

```bash [TypeScript]
npm install @cognipeer/observability
```

:::

::: code-group

```python [Python]
import cognipeer_observability as cognipeer
from cognipeer_observability.openai_agents import install_openai_agents_tracing

cognipeer.init()
install_openai_agents_tracing()

from agents import Runner, RunConfig
await Runner.run(agent, "book me a flight", run_config=RunConfig(group_id="conv-42"))
```

```ts [TypeScript]
import { init } from '@cognipeer/observability';
import { installOpenAIAgentsTracing } from '@cognipeer/observability/openai-agents';

init();
await installOpenAIAgentsTracing();

await run(agent, 'book me a flight', { groupId: 'conv-42' });
```

:::

One SDK trace becomes one Console session; every span becomes one event, linked
by `parent_id` so the agent, handoff and tool tree renders as it ran.

## Replacing versus adding

`install_openai_agents_tracing()` calls `set_trace_processors([...])` by
default, which **replaces** the SDK's processor list:

- traces stop going to OpenAI's own tracing dashboard;
- the SDK no longer needs `OPENAI_API_KEY` for tracing;
- no prompt data leaves for a second destination.

Pass `keep_openai_exporter=True` / `keepOpenAIExporter: true` to keep both.

::: warning Dual export is a data-egress decision
With the OpenAI exporter kept, every prompt and completion goes to OpenAI's
tracing backend as well as to Console. For an enterprise customer that is
usually a decision someone else needs to make, which is why it is off by
default.
:::

## Options

| Option | Default | Meaning |
|---|---|---|
| `client` / `client` | process-wide | Send through a specific client |
| `agent_name` / `agentName` | trace's workflow name | Session agent name |
| `thread_id` / `threadId` | `RunConfig.group_id` | Conversation id |
| `capture_agent_tools` / `captureAgentTools` | `true` | Emit the agent's tool **names** as a tool-definitions section on agent spans, even when schemas are unavailable |
| `keep_openai_exporter` / `keepOpenAIExporter` | `false` | Install alongside OpenAI's exporter instead of replacing it |

The processor class itself — `CognipeerTracingProcessor` — is exported if you
want to register it yourself:

```python
from agents.tracing import add_trace_processor
from cognipeer_observability.openai_agents import CognipeerTracingProcessor

add_trace_processor(CognipeerTracingProcessor(agent_name="booking"))
```

## Thread grouping

`RunConfig.group_id` / `groupId` is the SDK's **only** conversation identifier,
and nothing sets it for you — not even an SDK `Session` or `SQLiteSession`. Its
session id is not copied into `group_id`.

```python
await Runner.run(agent, prompt, run_config=RunConfig(group_id=chat_id))
```

```ts
await run(agent, prompt, { groupId: chatId });
```

Without it every run is an orphan session. If you cannot set it at the call
site, pass `thread_id` / `threadId` to the processor instead — it wins over
`group_id`.

## What is captured

| Data | Captured | Notes |
|---|---|---|
| Prompts | ✅ | `ResponseSpanData` input and `GenerationSpanData.input` |
| Completions | ✅ | Including the assistant's tool calls |
| System instructions | ✅ | From `response.instructions` on the Responses path; position 0 of the message array on Chat Completions |
| Token usage | ✅ | Per model call, from `response.usage` / `GenerationSpanData.usage` |
| Cached input tokens | ✅ | From `input_tokens_details.cached_tokens` |
| Tool calls | ✅ | `FunctionSpanData` name, arguments (parsed from the raw JSON string) and result |
| Tool definitions | ⚠️ partial | **Full JSON schemas only on the Responses API path**, where the API echoes the tool array back on the `Response` object. On the Chat Completions path the SDK's traceable-settings allowlist excludes `tools`, so only tool *names* are recoverable — those are still emitted, schema-less |
| Model name | ✅ | Hoisted from the child response/generation span; the agent span never carries one |
| Agent version | ❌ | Does not exist anywhere in the SDK. Set it yourself via `agent={"version": …}` on `init()` |
| Hierarchy | ✅ | From `parent_id`, including handoffs and subagents |
| Handoffs | ✅ | `from_agent → to_agent` as a `span` event |
| Guardrails | ✅ | Name and `triggered` flag as a `guardrail` event |
| MCP tool listings | ✅ | Server name and returned tool names |
| Errors | ✅ | `span.error` message and data |

### Token counting

Since 0.14.0 the SDK emits **three overlapping usage sources**: per-call
(`response` / `generation` spans), per-turn (`turn`) and per-run (`task`).
Summing all three triples a session's token totals.

The integration counts tokens **only from leaf `response` and `generation`
spans**. `task` and `turn` spans are still recorded as structure, with no token
fields.

## Version support

| Version | Behaviour |
|---|---|
| Python `openai-agents` ≥ 0.9 | `TracingProcessor` interface is byte-stable from here; safe floor |
| **< 0.14.0** | **No `ResponseSpanData.usage`** — no per-call token usage on the Responses path at all, and no task/turn spans. Require ≥ 0.14.0 if session token totals matter |
| ≥ 0.14.0 | `TaskSpanData`, `TurnSpanData`, `ResponseSpanData.usage`, `RunConfig.tracing` |
| ≥ 0.21.0 | `Span.trace_metadata`, `TraceState` / `ReattachedTrace` resume support |
| JS `@openai/agents` | Versions are lock-stepped across `agents`, `agents-core`, `agents-openai` and `agents-realtime`; `TaskSpanData`/`TurnSpanData` from 0.14.0 |

Verified against `openai-agents` 0.21.0 and `@openai/agents` 0.16.0.

## Gotchas

**Resumed runs never re-fire `on_trace_start`.** `ReattachedTrace.start()`
deliberately skips it. The integration creates sessions lazily on the first
span, so a resumed run is not dropped — but any code of your own that hooks
`on_trace_start` will miss it.

**Processor exceptions are swallowed.** The SDK wraps every callback in
try/except and routes failures to its own error logger, so a broken exporter
looks like "tracing just doesn't work". The integration catches and logs its
own failures at ERROR level — run with `COGNIPEER_DEBUG=1` to see them.

**Do not block in the callbacks.** Python's `TracingProcessor` methods are
synchronous and are invoked inline on the agent's own thread; JS's are awaited
by `MultiTracingProcessor`. Either way, network I/O there adds latency to every
model call. The integration only records — delivery happens on the client's
background transport.

**`span.export()` drops the payload.** `ResponseSpanData.export()` returns only
`{type, response_id, usage}`; the prompt and response live on the in-memory
attributes (`.response` / `._response`). Read those, never the export.

**Task and turn spans masquerade as `custom`.** `export()['type']` reports
`custom` for them. Discriminate on `span_data.type` / `spanData.type` instead.

**Span ids are not W3C-shaped.** The SDK produces `trace_<32hex>` and
`span_<24hex>` — 24 hex characters, not 16. The integration strips the prefix
and folds the remainder deterministically to a valid 16-hex span id.

**`OPENAI_AGENTS_DISABLE_TRACING` is read once and cached.** Changing
`os.environ` after the first `get_trace_provider()` call has no effect.

**Sensitive data is on by default.** `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA`
defaults to true, so prompts and completions are captured out of the box. On the
JS non-streaming Responses path the SDK's own `'enabled_without_data'` guard is
a truthiness check on a non-empty string, so it captures payloads even when the
integrator asked for none. Do not rely on the SDK to redact — set
`capture: 'metadata'` on the Cognipeer client, which is enforced in this
integration.

## Differences between the two SDKs

| | Python | TypeScript |
|---|---|---|
| `install_…` | Synchronous | **Async** — `await installOpenAIAgentsTracing()`, because the SDK is dynamically imported as an optional peer |
| Processor methods | snake_case, synchronous | camelCase, return `Promise<void>` |
| Response payload fields | `span_data.response` / `.input` / `.usage` | `spanData._response` / `._input`, and **no `usage` field** — read `_response.usage` |
| `trace.group_id` / `.metadata` | Only on `TraceImpl`; accessed via `getattr` | Public fields on `Trace` |

## Verify it worked

Run one agent turn, then open **Tracing → Sessions**. You should see a session
named after the workflow, containing an `agent` span, one `ai_call` per model
call with prompt and completion sections and token counts, and one `tool_call`
per function call with its arguments and result.

If a handoff happened, the receiving agent's spans should nest under it.

```bash
COGNIPEER_DEBUG=1 python your_agent.py
```

For a short-lived process, flush before exiting — the SDK's own `atexit` hook
has a five-second budget and covers only the process-exit path:

```python
import cognipeer_observability as cognipeer
cognipeer.flush()
```
