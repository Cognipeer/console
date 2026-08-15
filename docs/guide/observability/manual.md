# Manual instrumentation

For code no framework integration covers — a hand-rolled orchestration loop, a
retrieval helper, a business rule worth seeing in the timeline next to the
model calls — or for a language the SDK does not ship yet.

Three levels, in increasing order of effort and control:

1. [`observe`](#observe) — wrap a function, get an event
2. [`trace`](#trace) — group a run into one session
3. [the session API](#the-session-api) — emit events yourself
4. [plain HTTP](#no-sdk-at-all) — no SDK at all

## `observe`

Wrap a function and every call becomes one event.

::: code-group

```python [Python]
import cognipeer_observability as cognipeer
from cognipeer_observability import observe

cognipeer.init(agent={"name": "research-agent"})

@observe(type="tool_call", tool_name="search")
def search(query: str) -> list[str]:
    return index.query(query)

@observe(type="retrieval")
async def fetch_context(topic: str) -> str:
    ...
```

```ts [TypeScript]
import { init, observe } from '@cognipeer/observability';

init({ agent: { name: 'research-agent' } });

const search = observe(
  async (query: string) => index.query(query),
  { type: 'tool_call', toolName: 'search' },
);
```

:::

Nesting is automatic: a wrapped function called from inside another becomes its
child span in the timeline. And when no session is active, the outermost call
opens one and closes it when it settles — so wrapping a single entry point is
enough to get a complete trace.

| Option | Default | Meaning |
|---|---|---|
| `name` | the function's name | Event label |
| `type` | `span` | Event type — `ai_call`, `tool_call`, `retrieval`, `embedding`, `guardrail`, `span` |
| `tool_name` / `toolName` | — | Renders the event as a tool invocation |
| `capture_input` / `captureInput` | `true` | Record the arguments as an Input section |
| `capture_output` / `captureOutput` | `true` | Record the return value as an Output section |
| `metadata` | — | Extra key/values on the event |

The Python decorator handles sync, `async def`, generator and async-generator
functions. For the two generator forms the event closes when the generator is
exhausted, and the yielded chunks are collected into the Output section — so a
streaming helper produces one event with the whole stream, not one per chunk.

::: tip Turn off `capture_input` for noisy arguments
A function taking a whole conversation history or a large dataframe will put
all of it in the Input section. `@observe(capture_input=False)` keeps the
timing and the structure without the payload.
:::

## `trace`

Opens a session and binds it as the ambient one, so everything inside — nested
`observe` calls, framework integrations, the session API — lands in it.

::: code-group

```python [Python]
from cognipeer_observability import trace

with trace(name="research-agent", thread_id="conv-42") as session:
    context = fetch_context("quarterly results")
    answer = summarize(context)
```

```ts [TypeScript]
import { trace } from '@cognipeer/observability';

await trace({ name: 'research-agent', threadId: 'conv-42' }, async (session) => {
  const context = await fetchContext('quarterly results');
  return summarize(context);
});
```

:::

On an exception the session is marked `error` and the exception is re-thrown
untouched — tracing never swallows an application error.

| Option | Meaning |
|---|---|
| `name` | Shorthand for `agent: { name }` — what the Agents screen groups by |
| `thread_id` / `threadId` | Conversation id, grouping runs in **Tracing → Threads** |
| `session_id` / `sessionId` | Fixed session id; re-posting the same one updates that session |
| `agent` | Full agent identity — `{ name, version, model, provider }` |
| `session_config` / `config` | Free-form run configuration, shown on the session header |
| `mode` | `auto`, `stream` or `batch` — see [Delivery](/guide/observability/data-model#delivery) |

## The session API

When you want events the wrappers cannot express — a model call whose tokens
you know, a tool menu you want recorded, an explicit parent/child structure.

A span is opened under a **key** of your choosing and closed later; the key is
what links a child to its parent, and it is folded deterministically into a
span id, so a child can name a parent it never held a reference to.

::: code-group

```python [Python]
import cognipeer_observability as cognipeer

cognipeer.init()
client = cognipeer.get_client()

session = client.start_session(
    agent={"name": "research-agent", "version": "2.1.0"},
    thread_id="conv-42",
)

# One model call, with the tool menu it was actually offered.
session.open_span(
    "turn-1",
    type="ai_call",
    label="gpt-4.1-mini",
    model="gpt-4.1-mini",
    actor={"scope": "model", "name": "gpt-4.1-mini"},
    sections=[
        {"kind": "message", "role": "system", "content": "You are a researcher."},
        {"kind": "message", "role": "user", "content": "summarise Q3"},
    ],
    tool_definitions=[
        {
            "name": "search",
            "description": "Search the index",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
        }
    ],
)
session.close_span(
    "turn-1",
    sections=[{"kind": "message", "role": "assistant", "content": "Calling search…"}],
    input_tokens=1200,
    output_tokens=64,
    cached_input_tokens=1024,
)

# The tool the model asked for, as a child of that call.
session.open_span(
    "turn-1-search",
    type="tool_call",
    label="search",
    parent_key="turn-1",
    tool_name="search",
    tool_execution_id="call_abc123",
    sections=[{"kind": "tool_call", "tool": "search", "content": {"q": "Q3 revenue"}}],
)
session.close_span(
    "turn-1-search",
    sections=[{"kind": "tool_result", "tool": "search", "content": results}],
)

session.end()
```

```ts [TypeScript]
import { getClient, init } from '@cognipeer/observability';

init();
const session = getClient().startSession({
  agent: { name: 'research-agent', version: '2.1.0' },
  threadId: 'conv-42',
});

session.openSpan('turn-1', {
  type: 'ai_call',
  label: 'gpt-4.1-mini',
  model: 'gpt-4.1-mini',
  actor: { scope: 'model', name: 'gpt-4.1-mini' },
  sections: [
    { kind: 'message', role: 'system', content: 'You are a researcher.' },
    { kind: 'message', role: 'user', content: 'summarise Q3' },
  ],
  toolDefinitions: [
    {
      name: 'search',
      description: 'Search the index',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    },
  ],
});
session.closeSpan('turn-1', {
  sections: [{ kind: 'message', role: 'assistant', content: 'Calling search…' }],
  inputTokens: 1200,
  outputTokens: 64,
  cachedInputTokens: 1024,
});

session.openSpan('turn-1-search', {
  type: 'tool_call',
  label: 'search',
  parentKey: 'turn-1',
  toolName: 'search',
  toolExecutionId: 'call_abc123',
  sections: [{ kind: 'tool_call', tool: 'search', content: { q: 'Q3 revenue' } }],
});
session.closeSpan('turn-1-search', {
  sections: [{ kind: 'tool_result', tool: 'search', content: results }],
});

await session.end();
```

:::

A few properties worth knowing:

- The event is emitted on **close**, not on open, so one start/end pair in your
  loop becomes exactly one Console event carrying both sides. Duration is
  measured for you.
- `record()` / `session.record()` emits a complete event directly, for steps
  that have no duration to measure.
- An error closes the span as failed: `close_span(key, error=exc)` /
  `closeSpan(key, { error })`. Spans still open when the session ends are
  closed automatically.
- `tool_definitions` belongs on the **model call** that was offered the menu,
  never on the session — the menu can change between turns, and it is often
  the largest single line item in an agent's prompt bill.
- `cachedInputTokens` is a **subset** of `inputTokens`. See
  [Tokens](/guide/observability/data-model#tokens) if your provider reports
  them separately.

`open_span` / `openSpan` also accepts `metadata`, `started_at` and an `actor`;
`close_span` / `closeSpan` accepts `status`, `total_tokens`, `model` and
`label` overrides.

## No SDK at all

The ingest API is plain HTTP with a bearer token, so a language the SDK does
not ship for — C#, Go, Java, Ruby — can post to it directly.

```bash
curl -X POST https://console.cognipeer.com/api/client/v1/tracing/sessions \
  -H "Authorization: Bearer $COGNIPEER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "sess-abc123",
    "threadId": "conv-42",
    "agent": { "name": "research-agent", "version": "2.1.0" },
    "status": "success",
    "startedAt": "2026-08-15T10:00:00Z",
    "endedAt": "2026-08-15T10:00:03Z",
    "durationMs": 3500,
    "summary": { "totalInputTokens": 1200, "totalOutputTokens": 64 },
    "events": [
      {
        "id": "evt-1",
        "type": "ai_call",
        "label": "gpt-4.1-mini",
        "sequence": 1,
        "model": "gpt-4.1-mini",
        "inputTokens": 1200,
        "outputTokens": 64,
        "cachedInputTokens": 1024,
        "durationMs": 900,
        "sections": [
          { "kind": "message", "role": "user", "content": "summarise Q3" },
          { "kind": "message", "role": "assistant", "content": "Revenue rose 12%…" }
        ],
        "toolDefinitions": [{ "name": "search", "description": "Search the index" }]
      }
    ]
  }'
```

```json
{ "success": true, "sessionId": "sess-abc123", "eventsStored": 1 }
```

Re-posting the same `sessionId` replaces that session's events, so the call is
idempotent. For long-running runs there is a streaming trio
(`/stream/:id/start`, `/events`, `/end`) that appends instead.

[Data Model](/guide/observability/data-model) is the full contract: every
field, every event type, the section kinds, the identifier rules and the two
delivery shapes. An implementation in a new language is a mapping onto that and
nothing else — and is very welcome as a contribution to the
[open-source repository](https://github.com/Cognipeer/cognipeer-observability).

## Flushing

Exports run in the background — on a worker thread in Python, on a promise
chain in JavaScript — so tracing never blocks the traced application. A
long-running service needs nothing further.

A **short-lived process** must wait for delivery before it exits, or the tail
of the session is lost:

::: code-group

```python [Python]
import cognipeer_observability as cognipeer

def handler(event, context):
    with cognipeer.trace(name="lambda-agent"):
        ...
    cognipeer.flush(timeout=10.0)   # or shutdown() to also close open sessions
```

```ts [TypeScript]
import { flush, shutdown } from '@cognipeer/observability';

export async function handler(event) {
  await trace({ name: 'lambda-agent' }, async () => { /* … */ });
  await flush();          // or shutdown() to also close open sessions
}
```

:::

`flush` waits for what is queued; `shutdown` ends every still-open session
first, then flushes. Both are safe to call more than once.

This applies to Lambda handlers, cron jobs, CI steps and scripts. Node's
`beforeExit` hook is installed automatically and covers the common case, but a
runtime that freezes the process — as serverless platforms do between
invocations — can cut it off, so call `flush` explicitly there.

## See also

- [Data Model](/guide/observability/data-model) — the full ingest contract
- [Overview](/guide/observability/overview) — the framework integrations
- [Troubleshooting](/guide/observability/troubleshooting)
