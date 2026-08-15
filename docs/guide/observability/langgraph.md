# LangGraph

LangGraph executes its graph through LangChain's callback manager, so the
[LangChain handler](/guide/observability/langchain) already captures every
node, model call, tool call and retrieval. What this module adds is the three
things LangGraph does differently — threading, interrupts, and node replay on
resume — each of which changes how a run should be read in Console.

## Install and wire

::: code-group

```bash [Python]
pip install "cognipeer-observability[langgraph]"
```

```bash [TypeScript]
npm install @cognipeer/observability
```

:::

::: code-group

```python [Python]
import cognipeer_observability as cognipeer
from cognipeer_observability.langgraph import graph_config

cognipeer.init(agent={"name": "booking-agent"})

result = agent.invoke(
    {"messages": [("user", "book me a flight to Rome")]},
    config=graph_config("conv-42"),
)
```

```ts [TypeScript]
import { init } from '@cognipeer/observability';
import { langgraphConfig } from '@cognipeer/observability/langgraph';

init({ agent: { name: 'booking-agent' } });

const result = await agent.invoke(
  { messages: [['user', 'book me a flight to Rome']] },
  langgraphConfig('conv-42'),
);
```

:::

Or bind tracing to a compiled graph once, so every later call is traced:

::: code-group

```python [Python]
from cognipeer_observability.langgraph import trace_graph

graph = trace_graph(workflow.compile(checkpointer=checkpointer), "conv-42")
graph.invoke({"messages": [("user", "hi")]})
```

```ts [TypeScript]
import { withCognipeerTracing } from '@cognipeer/observability/langgraph';

export const graph = withCognipeerTracing(workflow.compile({ checkpointer }));
await graph.invoke(state, { configurable: { thread_id: 'conv-42' } });
```

:::

## Options

| Function | Signature | Notes |
|---|---|---|
| `graph_config(thread_id, *, agent=None, base=None, **handler_options)` | Python | Returns a `RunnableConfig` |
| `trace_graph(graph, thread_id, *, agent=None, **handler_options)` | Python | Uses `Runnable.with_config`, so `stream`, `astream` and `astream_events` keep working |
| `langgraphConfig(threadId?, options?)` | TypeScript | `options` accepts `base` plus every handler option |
| `withCognipeerTracing(graph, options?)` | TypeScript | Proxy over `invoke`, `stream`, `streamEvents`, `streamLog`, `batch`; the graph's type is preserved |

Every handler option from the [LangChain page](/guide/observability/langchain#options)
— `agent`, `capture_chains`, `metadata`, `session_id`, `client` — passes
through.

## Thread grouping

::: warning One conversation is many sessions — this is not a bug
Every `invoke` starts a **fresh root run with a fresh trace id**, and so does
every resume after an interrupt. Nothing but `thread_id` ties them together.

So a LangGraph conversation is one **thread** of many sessions in Console, never
one long session. Read it back under **Tracing → Threads**, not
**Tracing → Sessions**.
:::

Both helpers write the thread id to `configurable` (where the checkpointer
needs it) and to `metadata` (where the callback handler can still read it on
`langchain-core` ≥ 1.3.0 / `@langchain/core` ≥ 1.1.40). `withCognipeerTracing`
additionally lifts the thread id out of each call's own
`configurable.thread_id`, so you can keep passing config the way you already do:

```ts
await graph.invoke(state, { configurable: { thread_id: 'conv-42' } });
```

Set the thread id to whatever your application already uses as a conversation
key — the checkpointer thread id is usually exactly right.

## Interrupts are not failures

`interrupt()` pauses a graph by **raising** a `GraphInterrupt`, which reaches
the handler through the same path as a real exception. Mapping that straight to
a failed session would mark every human-in-the-loop approval as an error.

The handler recognises LangGraph's `GraphBubbleUp` family — `GraphInterrupt`,
`NodeInterrupt`, `ParentCommand` — by class identity rather than by importing
`langgraph.errors`, so it keeps working in a LangChain-only install. An
interrupted node is closed as successful and carries `interrupted: true` in its
metadata; the session is not marked failed.

Here is a real trace of an interrupt and its resume, from the integration's own
test run:

```
request 1 · thread=conv-77 · status=success
  span  step_one    parent=root
  span  ask_human   parent=root   metadata={interrupted: true, interruptType: GraphInterrupt}
  span  LangGraph   parent=root

request 2 · thread=conv-77 · status=success
  span  ask_human   parent=root
  span  LangGraph   parent=root
```

Two sessions, one thread, no false failure.

## Resume replays the node

Resuming re-runs the interrupted node **from its start** — everything before
the `interrupt()` call executes again. A model call or a tool call placed
before the interrupt is genuinely made twice, costs money twice, and is
therefore recorded twice.

That is the run, not a tracing artefact, and hiding the replay would
under-report spend. Both replays carry `langgraph_step` and `checkpoint_ns` in
their metadata so you can identify them. If you do not want side effects
counted twice, put them **after** the `interrupt()` call.

## What is captured

Everything the [LangChain integration](/guide/observability/langchain#what-is-captured)
captures, plus:

| Data | Captured | Notes |
|---|---|---|
| Graph nodes | ✅ | One `span` event per node, labelled with `metadata.langgraph_node` |
| Node input/output | ✅ | Graph state, with `messages` flattened to a role/content list so the conversation is not repeated once per node |
| Step number | ✅ | `langgraph_step` on every event |
| Subgraph namespace | ✅ | `checkpoint_ns` on every event |
| Interrupts | ✅ | Recorded as control flow, not as errors |
| Plumbing runnables | ❌ *by design* | `ChannelRead`, `ChannelWrite`, `RunnableSequence`, `__start__`, `__end__` and friends are skipped, and their children remapped to the nearest recorded ancestor |

::: tip Why the noise filter matters
A single `create_react_agent` turn emits dozens of chain runs. Recording all of
them buries the two or three model and tool calls you actually came to look
at. Set `capture_chains=False` / `captureChains: false` to drop node spans
entirely and keep only model, tool and retrieval events.
:::

## Version support

| Version | Behaviour |
|---|---|
| langgraph ≥ 0.2.x | `langgraph_node`, `langgraph_step`, `langgraph_triggers`, `langgraph_path`, `checkpoint_ns` metadata keys — stable in both languages |
| **langchain-core ≥ 1.3.0** | **`configurable.thread_id` stops reaching handlers** — use `graph_config()` |
| **@langchain/core ≥ 1.1.40** | Same cliff in JS — use `langgraphConfig()` or `withCognipeerTracing()` |

Verified against langgraph 1.0.7 (Python) and `@langchain/langgraph` 1.3.0 /
1.4.10 (JS).

## Gotchas

**Node spans are flat children of the root, not nested per superstep.** Every
task config is built from the root Pregel run manager, so a node at step 1 and a
node at step 5 are siblings. The step number lives in `langgraph_step`, not in
the tree shape.

**A new run on the same thread is not necessarily a resume.** You cannot assume
every root run on a thread continues an interrupt — check whether the previous
run ended in an interrupt before treating it as one.

**Python `trace_graph` binds one handler for all invocations.** A handler
carries per-run state, so a graph traced this way and then invoked concurrently
will interleave those runs into shared handler state. For a concurrent server,
call `graph_config()` per invocation instead. The TypeScript
`withCognipeerTracing` does not have this limitation — it creates a fresh
handler per call, including one per entry for `batch`.

**`stream_mode` does not change what is traced.** Tracing runs off callbacks,
not off the stream, so `values`, `updates`, `messages` and `custom` all produce
the same trace.

## Verify it worked

Run one invocation, then open **Tracing → Threads** and click your thread id.
You should see the run's sessions listed in order, and inside each one the node
spans with the model and tool calls nested under them.

For a graph with an interrupt, confirm the paused session shows
`status: success` with an `interrupted` node — not a failure.

```bash
COGNIPEER_DEBUG=1 python your_graph.py
```
