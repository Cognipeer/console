# Claude Agent SDK

The Claude Agent SDK does not call the Anthropic API in your process — it spawns
the Claude Code CLI and talks JSON over stdio. HTTP monkeypatching,
OpenTelemetry auto-instrumentation of `http`, and `@anthropic-ai/sdk`
middleware all capture nothing. The **message stream** is the seam, and it is
the richest one the SDK has: model name, full assistant content (text, thinking
and `tool_use` blocks), per-call token usage with the cache breakdown, tool
results, subagent nesting and the final cost summary.

## Install and wire

::: code-group

```bash [Python]
pip install "cognipeer-observability[claude-agent-sdk]"
```

```bash [TypeScript]
npm install @cognipeer/observability
```

:::

`trace_query` / `traceQuery` is a drop-in replacement for the SDK's `query()`
— it yields the SDK's messages untouched, so existing consumer code keeps
working:

::: code-group

```python [Python]
import cognipeer_observability as cognipeer
from cognipeer_observability.claude_agent_sdk import trace_query

cognipeer.init()

async for message in trace_query(
    prompt="refactor the billing module",
    options=ClaudeAgentOptions(model="claude-opus-5"),
    thread_id="conv-42",
):
    print(message)
```

```ts [TypeScript]
import { init } from '@cognipeer/observability';
import { traceQuery } from '@cognipeer/observability/claude-agent-sdk';

init();

for await (const message of traceQuery({
  prompt: 'refactor the billing module',
  options: { model: 'claude-opus-5' },
  threadId: 'conv-42',
})) {
  console.log(message);
}
```

:::

Driving the stream yourself — `ClaudeSDKClient`, a queue consumer, your own
wrapper? Use the tracer directly and feed it each message in order:

::: code-group

```python [Python]
from cognipeer_observability.claude_agent_sdk import ClaudeMessageTracer

tracer = ClaudeMessageTracer(thread_id="conv-42")
async for message in client.receive_messages():
    tracer.handle(message)
    ...
tracer.close()          # only needed if the stream ended without a `result`
```

```ts [TypeScript]
import { ClaudeMessageTracer } from '@cognipeer/observability/claude-agent-sdk';

const tracer = new ClaudeMessageTracer({ threadId: 'conv-42' });
for await (const message of stream) {
  tracer.handle(message);
}
await tracer.close();
```

:::

A `result` message closes the session on its own, so `close()` is only needed
when the stream is abandoned early.

## Options

| Option | Default | Meaning |
|---|---|---|
| `client` / `client` | process-wide | Send through a specific client |
| `agent` / `agent` | `{"name": "claude-agent"}` | Agent identity for the session |
| `thread_id` / `threadId` | the SDK's `session_id` | Conversation id |
| `session_id` / `sessionId` | generated | Fixed session id |

`trace_query` / `traceQuery` additionally take `prompt` and `options`, which
are passed straight through to the SDK's `query()`.

## Thread grouping

If you pass nothing, the tracer falls back to the SDK's own `session_id`, which
is stable for the life of one CLI session — good enough that turns of a single
conversation group correctly out of the box.

Pass `thread_id` / `threadId` explicitly when your application has a better key
(a ticket id, a chat id) or when a conversation spans several CLI sessions.

## What is captured

| Data | Captured | Notes |
|---|---|---|
| Prompts | ✅ | The user turn you supplied and any replayed user messages |
| Completions | ✅ | Text and `thinking` blocks, each as its own section |
| Token usage | ✅ | Per assistant message, from `message.usage` |
| Cached input tokens | ✅ | `cache_read_input_tokens` — see the arithmetic below |
| Tool calls | ✅ | `tool_use` and its matching `tool_result` merged into **one** event |
| Tool results | ✅ | Structured `tool_use_result` preferred over the stringified block content |
| Tool definitions | ❌ | Not available from this seam — see below |
| Model name | ✅ | `message.model`, plus `system/init`'s model on the session |
| Hierarchy | ✅ | Subagents nest via `parent_tool_use_id` |
| Errors | ✅ | `is_error` on tool results; an error `result` fails the session |
| Cost | ✅ | `total_cost_usd` recorded in the result event's metadata |
| Session init | ✅ | Model, tool names, MCP servers, permission mode and cwd |

### Tool calls become one event

A `tool_use` block arrives inside an assistant message; its `tool_result`
arrives later, inside a user message. The tracer holds the call until the
result lands and emits a single `tool_call` event carrying both the Arguments
and the Result section — which is how it reads in the timeline.

Calls whose result never arrives (an interrupt, a permission denial, a crash)
are flushed as failed events when the stream ends, rather than being silently
dropped.

### The token arithmetic

This is the part worth checking yourself. Anthropic reports `input_tokens`
**exclusive** of cached tokens, while Console treats `cachedInputTokens` as a
**subset** of `inputTokens` when pricing a call. The integration therefore
translates:

```
inputTokens       = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
cachedInputTokens = cache_read_input_tokens
totalTokens       = inputTokens + output_tokens
```

Console then prices `(inputTokens - cachedInputTokens)` at the input rate and
`cachedInputTokens` at the cached rate. Leaving the cache buckets out would
under-report a cache-heavy agent's prompt volume by an order of magnitude.

`cache_creation_input_tokens` is also surfaced as
`metadata.cacheCreationInputTokens`, because cache writes are billed above the
normal input rate and Console's pricing model has no separate write rate.

::: warning The run-level total is deliberately ignored
`SDKResultMessage.usage` is a cumulative total for the whole run. Adding it on
top of the per-message usage would double every token count, so it is recorded
as metadata only.
:::

### Tool definitions are not available

The `system/init` message lists tool **names**, and those are recorded — but the
SDK never exposes their JSON input schemas through the message stream. The only
place they exist is Claude Code's OpenTelemetry `api_request_body` event, which
carries the serialised `/v1/messages` request; it is gated behind
`OTEL_LOG_RAW_API_BODIES=1` and is off by default.

So `toolDefinitions` is absent for this integration. Tool names still appear on
every tool call, and the prompt-cost analysis that depends on schema size is
not available here.

## Version support

| Version | Behaviour |
|---|---|
| **TypeScript `@anthropic-ai/claude-agent-sdk`** | |
| pre-0.1.0 | Published as `@anthropic-ai/claude-code`; that import path is dead |
| 0.1.x | Smaller `HookEvent` set, no `SessionStore` |
| 0.3.233 | 38-member `SDKMessage` union; `HOOK_EVENTS` exported for feature detection |
| **Python `claude-agent-sdk`** | |
| < 0.2.82 | Different options dataclass — 0.1.x → 0.2.x was a breaking bump |
| 0.2.139 | Current. `AssistantMessage` exposes `model`, `usage`, `message_id`, `session_id` and `parent_tool_use_id` as first-class typed fields |

The `SDKMessage` union is additive but large and grows with CLI releases. The
tracer switches on `type` with a default-ignore branch, so an unknown message
type is skipped rather than raising.

## Gotchas

**The message union grows weekly.** New CLI releases add message types. Anything
the tracer does not recognise is ignored — but if you consume the stream
yourself, do the same, or your own consumer will break before the tracing does.

**Python hooks cover far less than TypeScript's.** If you were considering the
hook seam instead: TypeScript has 31 `HookEvent` members, Python has 10, and
Python's `PostToolUseHookInput` has no `duration_ms` and its `BaseHookInput` no
`prompt_id`. That asymmetry is why this integration uses the message stream in
both languages.

**Hooks cannot give you tokens or the model anyway.** They carry tool names,
inputs, results and subagent lifecycle — but no usage and no model name. The
stream is strictly richer.

**An early `break` still closes the session.** `traceQuery` closes in the
generator's `finally`, which runs on normal completion, on throw, and on the
consumer's `break`. Python's `trace_query` does the same via its exception
handler.

## Differences between the two SDKs

| | Python | TypeScript |
|---|---|---|
| Active session accessor | `tracer.session` property | `tracer.getSession()` |
| `close()` | Synchronous | Returns a `Promise` |
| Repeated `message.id` | **Counted every time** | Counted once per `message.id` |

::: warning Known gap in the Python tracer
One API turn can produce several assistant messages sharing a single
`message.id`. The TypeScript tracer counts that turn's usage once; the Python
tracer currently adds it per message, which inflates token totals when the CLI
splits a turn. Until that is fixed, prefer the run's own `total_cost_usd`
(recorded in the result event's metadata) when reconciling Python-side cost.
:::

## Verify it worked

Run one query, then open **Tracing → Sessions**. You should see:

- a **Session init** span listing the model, tool names and MCP servers;
- one `ai_call` per assistant message, with its text and thinking blocks and
  token counts;
- one `tool_call` per tool, carrying both Arguments and Result;
- a **Result** span with the turn count, duration and `total_cost_usd`.

Subagent work should nest under the `Task` tool call that spawned it.

```bash
COGNIPEER_DEBUG=1 python your_agent.py
```

For a short-lived process, flush before exiting:

```python
import cognipeer_observability as cognipeer
cognipeer.flush()
```
