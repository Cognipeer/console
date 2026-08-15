# LangChain

LangChain routes every model call, tool call, retrieval and chain step through
its callback manager, so a `BaseCallbackHandler` sees the whole run without any
change to how your chain calls its models. That is the seam this integration
uses — no proxy, no wrapped model class, no base-URL swap. The same handler
also covers [LangGraph](/guide/observability/langgraph), which executes through
the same callback manager.

## Install and wire

::: code-group

```bash [Python]
pip install "cognipeer-observability[langchain]"
```

```bash [TypeScript]
npm install @cognipeer/observability
```

:::

::: code-group

```python [Python]
import cognipeer_observability as cognipeer
from cognipeer_observability.langchain import CognipeerCallbackHandler

cognipeer.init(agent={"name": "support-bot"})

chain.invoke(
    {"question": "where is my order?"},
    config={"callbacks": [CognipeerCallbackHandler(thread_id="conv-42")]},
)
```

```ts [TypeScript]
import { init } from '@cognipeer/observability';
import { CognipeerCallbackHandler } from '@cognipeer/observability/langchain';

init({ agent: { name: 'support-bot' } });

await chain.invoke(
  { question: 'where is my order?' },
  { callbacks: [new CognipeerCallbackHandler({ threadId: 'conv-42' })] },
);
```

:::

One handler instance produces **one session per root run**. Reusing the same
handler across several `invoke()` calls gives you one session per call, grouped
by thread id — which is what the Threads view expects.

## Options

Both SDKs take the same options; the Python names are snake_case.

| Option | Default | Meaning |
|---|---|---|
| `client` / `client` | process-wide | Send through a specific client instead of the one `init()` created |
| `session` / `session` | — | Write into an existing `TraceSession`. The handler never ends a session it did not create |
| `session_id` / `sessionId` | generated | Fixed session id. Pass the same value again to append to an existing run |
| `thread_id` / `threadId` | from run metadata | Conversation id — see below |
| `agent` / `agent` | from `init()` | `{"name": …, "version": …, "model": …}` for the session |
| `capture_chains` / `captureChains` | `true` | Record chain and graph-node runs as spans. Plumbing runnables are always skipped |
| `metadata` / `metadata` | `{}` | Extra metadata attached to every event |

Two module-level helpers:

| Function | Purpose |
|---|---|
| `cognipeer_config(thread_id, …)` / `cognipeerConfig(threadId, …)` | Build a `RunnableConfig` with the handler attached and the thread id plumbed correctly |
| `install_langchain_tracing(…)` / `installLangChainTracing(…)` | Attach a handler to every LangChain run in the process |

### Global installation

```python
from cognipeer_observability.langchain import install_langchain_tracing
install_langchain_tracing(agent={"name": "support-bot"})
```

```ts
await installLangChainTracing({ agent: { name: 'support-bot' } });
```

This uses LangChain's global configure hook, so no per-invoke `config` is
needed at all.

::: warning Not for concurrent servers
Every run in the process shares **one handler**, and a handler carries per-run
state. That is right for a script, a notebook or a batch job, and wrong for a
web server handling concurrent unrelated conversations — their spans will
interleave into the same session. There, pass a per-invocation handler via
`cognipeer_config()` / `cognipeerConfig()` instead.

The hook is backed by `contextvars` (Python) and `AsyncLocalStorage` (JS), so
it must be installed **before** the work you want traced is spawned. On
`@langchain/core` below 0.3.0 the `@langchain/core/context` entry point does
not exist; the call warns and returns the handler unattached.
:::

## Thread grouping

Pass `thread_id` / `threadId` to the handler, or use the config helper:

::: code-group

```python [Python]
from cognipeer_observability.langchain import cognipeer_config

agent.invoke(state, config=cognipeer_config("conv-42"))
```

```ts [TypeScript]
import { cognipeerConfig } from '@cognipeer/observability/langchain';

await agent.invoke(state, cognipeerConfig('conv-42'));
```

:::

The helper exists because of a real version cliff. Up to `langchain-core` 1.2.x
and `@langchain/core` 1.1.38, `ensure_config()` copied every primitive
`configurable` key — including LangGraph's `thread_id` — into `config.metadata`,
where any callback handler could read it. From `langchain-core` 1.3.0 and
`@langchain/core` 1.1.40 only `model` and `checkpoint_ns` are promoted; the rest
is routed to a channel applied exclusively to LangSmith's own tracer. A
third-party handler reading `metadata["thread_id"]` gets nothing on current
versions.

`cognipeer_config()` writes the thread id to **both** `configurable` (where
LangGraph's checkpointer needs it) and `metadata` (where the handler can still
see it), so it is correct on every version.

Without a thread id each run is its own orphan session. Everything else still
works — you just lose conversation grouping.

## What is captured

| Data | Captured | Notes |
|---|---|---|
| Prompts | ✅ | Full message list from `on_chat_model_start`, one section per message with its role |
| Completions | ✅ | Including assistant `tool_calls`, rendered as `tool_call` sections |
| Token usage | ✅ | `usage_metadata` first, legacy `llm_output.token_usage` as fallback |
| Cached input tokens | ✅ | From `usage_metadata.input_token_details.cache_read`. Its `input_tokens` already includes cached tokens, which is exactly what Console's pricing expects |
| Tool calls | ✅ | Arguments and results. Python gets structured `inputs`; JS receives a JSON string and parses it |
| Tool definitions | ✅ | Read from `invocation_params.tools` / `.functions`, normalised to `{name, description, parameters}`. Verified live against `ChatOpenAI().bind_tools([...])` |
| Model name | ✅ | `metadata.ls_model_name` → `invocation_params.model` → `llm_output.model_name` |
| Hierarchy | ✅ | Built from `run_id` / `parent_run_id`; skipped plumbing runs are remapped to the nearest recorded ancestor |
| Errors | ✅ | Exception attached to the failing step and the session marked failed |
| Retrieval | ✅ | Query plus the returned documents as a `retrieval` event |

::: tip Tool definitions are the interesting one
LangChain strips `tools` and `functions` out of the *tracing metadata* it
builds — but the unfiltered `invocation_params` still reaches handlers. That
makes a callback handler the only place a third-party integration can see the
tool menu the model was actually offered, which is frequently the largest single
line item in an agent's prompt bill.
:::

## Version support

The handler reads every payload defensively and works from LangChain 0.1
through 1.x. What changes with version:

| Version | Behaviour |
|---|---|
| **Python `langchain-core`** | |
| < 0.2.2 | No standardised token usage. Only provider-specific `llm_output`, so usage is often absent and cached tokens are unobtainable |
| 0.2.2 | `AIMessage.usage_metadata` lands — normalised usage across providers |
| 0.2.5 | `metadata["ls_model_name"]` / `ls_provider` become available |
| 0.3.x | `usage_metadata` gains `input_token_details.cache_read` |
| 1.2.0 | `tool_call_id` passed to `on_tool_start`, recorded as `toolExecutionId` |
| **1.3.0** | **`configurable` no longer copied into `metadata`** — use `cognipeer_config()` |
| **JS `@langchain/core`** | |
| < 0.2.9 | No `usage_metadata`; only `llmOutput.tokenUsage` |
| 0.2.0 | `ls_model_name` / `ls_provider` |
| 0.3.0 | `@langchain/core/context` appears, enabling `installLangChainTracing` |
| ~1.1.15 | `handleChainStart`'s `.d.ts` argument order diverges from runtime (handled) |
| ~1.1.25 | `toolCallId` appended to `handleToolStart` |
| **1.1.40** | **`configurable` no longer copied into `metadata`** — use `cognipeerConfig()` |

## Gotchas

**Streaming reports no tokens unless you ask for them.** Usage is read at
`on_llm_end`. On a streaming call the provider only reports it when explicitly
enabled — `ChatOpenAI(stream_usage=True)` / `new ChatOpenAI({ streamUsage: true })`
— and some providers never do. The integration deliberately leaves the token
fields **absent** rather than writing zero, so an unpriced call shows up as
unknown instead of silently under-reporting spend.

**Python: the handler sets `run_inline = True`.** Under an async run LangChain
otherwise dispatches sync handlers onto a ten-worker thread pool with a *copy*
of the context and no ordering guarantee, which reorders spans and breaks the
start/end pairing this handler depends on. Running inline costs a negligible
amount of time on the calling thread and makes the trace correct.

**JS: callbacks are fire-and-forget by default.** `awaitHandlers` defaults to
false, so LangChain queues handler bodies without awaiting them. The handler
opts in with `_awaitHandler: true`. On a platform that freezes the process the
moment a response is returned — Lambda, Vercel, Cloudflare Workers — also do
this before returning:

```ts
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { flush } from '@cognipeer/observability';

await awaitAllCallbacks();
await flush();
```

**Handler exceptions are swallowed by LangChain.** Both runtimes log and
continue unless `raise_error` is set, which means a broken exporter looks like
"tracing just doesn't work". The handler contains its own failures and reports
them through the client's logger — run with `COGNIPEER_DEBUG=1` to see them.

**`serialized` is not an identity.** It is frequently `{}`, `None`, or a
`not_implemented` stub, so labels come from `run_name` and `metadata` first.
Do not expect a node's class name to appear reliably.

**Multi-prompt batches fork run ids.** A `.batch()` or multi-prompt
`.generate()` produces N sibling runs sharing one parent, of which only the
first uses the caller-supplied run id. Each becomes its own event.

**Legacy agent callbacks never fire.** `on_agent_action` / `on_agent_finish`
(Python) and `handleAgentAction` / `handleAgentEnd` (JS) are `AgentExecutor`-only
and are never emitted by modern tool-calling agents or LangGraph. Tool
correlation is built from run ids, not from those.

## Differences between the two SDKs

| | Python | TypeScript |
|---|---|---|
| Tool-call id | First-class `toolExecutionId` on the event | Recorded as `metadata.toolCallId` |
| Global install | `install_langchain_tracing()` — synchronous | `installLangChainTracing()` — **async** (`@langchain/core/context` is dynamically imported) |
| Active session accessor | `handler.session` property | `handler.session` getter |

## Verify it worked

Run one invocation, then open **Tracing → Sessions**. You should see a session
named after `agent.name`, containing:

- one `ai_call` event per model call, labelled with the model id, carrying the
  prompt and completion as message sections and a **Tool Definitions** badge
  list when tools are bound;
- one `tool_call` event per tool, with Arguments and Result sections;
- token counts on each model call, and totals on the session header.

If nothing appears:

```bash
COGNIPEER_DEBUG=1 python your_agent.py
```

Debug mode logs every HTTP POST the exporter makes and its status code. See
[Troubleshooting](/guide/observability/troubleshooting) for what each failure
mode looks like.
