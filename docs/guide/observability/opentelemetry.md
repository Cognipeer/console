# OpenTelemetry

This is the route that covers everything the other pages do not: CrewAI,
LlamaIndex, Pydantic AI, Google ADK, AWS Strands, Semantic Kernel, Microsoft
Agent Framework, smolagents, Haystack, DSPy — anything that emits OpenTelemetry
spans, natively or through an OpenInference / OpenLLMetry instrumentor.

There are two ways in, and the difference matters:

| | [Span exporter](#option-1-the-span-exporter-recommended) | [Direct OTLP](#option-2-point-an-otlp-exporter-at-console) |
|---|---|---|
| Install | `cognipeer-observability` | nothing — you already have an OTLP exporter |
| Normalisation | in your process, before sending | on the Console, at ingest |
| Sessions | grouped per trace, with an idle timeout | derived per trace |
| Best for | agent frameworks | an existing OTel pipeline you do not want to touch |

Both understand the three competing attribute conventions in this ecosystem
(OpenInference, current OTel GenAI, legacy OpenLLMetry) and merge them when a
span carries more than one — which happens whenever an application has two
instrumentors installed.

## Option 1: the span exporter (recommended)

::: code-group

```python [Python]
# pip install "cognipeer-observability[otel]"
import cognipeer_observability as cognipeer
from cognipeer_observability.otel import CognipeerSpanExporter

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

cognipeer.init(api_key="cpeer_…")

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(CognipeerSpanExporter()))

# Then register whichever instrumentor your framework uses, e.g.:
from openinference.instrumentation.crewai import CrewAIInstrumentor
CrewAIInstrumentor().instrument(tracer_provider=provider)
```

```ts [TypeScript]
import { init } from '@cognipeer/observability';
import { CognipeerSpanExporter } from '@cognipeer/observability/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

init({ apiKey: 'cpeer_…' });

const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new CognipeerSpanExporter())],
});
provider.register();
```

:::

### Options

::: code-group

```python [Python]
CognipeerSpanExporter(
    client=None,                  # defaults to the process-wide client
    agent_name=None,              # overrides the derived agent name
    thread_id=None,               # overrides the derived conversation id
    session_idle_seconds=30.0,    # close a session after this much silence
    session_id_prefix="otel",
    mode="stream",
)
```

```ts [TypeScript]
new CognipeerSpanExporter({
  client: undefined,        // defaults to the process-wide client
  agentName: undefined,     // overrides the derived agent name
  threadId: undefined,      // overrides the derived conversation id
  sessionIdleMs: 30_000,    // close a session after this much silence
  sessionIdPrefix: 'otel-',
  maxOpenTraces: 1000,
  mode: undefined,          // inherits the client's delivery mode
  onError: undefined,
});
```

:::

### How a session is decided

OpenTelemetry has no "run started" or "run finished" signal — a trace is just
spans that share an id. So the exporter derives a session per trace id and
closes it when either:

- the trace's **root span ends** (the normal case), or
- **`sessionIdleMs` / `session_idle_seconds`** passes with no further spans.

Raise the idle timeout for agents that think for a long time between spans;
lower it if you want sessions to settle sooner in a batch job.

::: warning Identity is fixed when the session opens
Agent name and thread id are taken from the first batch of spans for a trace. If
the instrumentation stamps `session.id` on a span that arrives in a *later*
batch, it cannot be applied retroactively — pass `threadId` / `thread_id`
explicitly when you know it up front.
:::

## Option 2: point an OTLP exporter at Console

If you already run an OpenTelemetry pipeline, Console accepts OTLP/HTTP **JSON**
directly. No SDK, no code change:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://console.cognipeer.com/api/client/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_HEADERS="authorization=Bearer cpeer_…"
```

::: warning JSON, not protobuf
`/api/client/v1/traces` reads OTLP/HTTP **JSON**. Exporters default to protobuf
and several — n8n's, for one — cannot be switched. Set the protocol explicitly,
or put an OpenTelemetry Collector in front that receives protobuf and exports
JSON. The [n8n page](/guide/observability/n8n) has a working collector config.
:::

Spans are normalised at ingest using the same table as the exporter, so
prompts, completions, tool calls, tool definitions and token counts all land —
what you lose relative to Option 1 is client-side control over session
boundaries and redaction.

## LangSmith's OTel exporter

LangChain and LangGraph applications already wired for LangSmith can be pointed
here without touching the code, since `langsmith[otel]` speaks OTLP:

```bash
LANGSMITH_TRACING=true
LANGSMITH_OTEL_ENABLED=true
LANGSMITH_OTEL_ONLY=true       # do not also ship to LangSmith SaaS
OTEL_EXPORTER_OTLP_ENDPOINT=https://console.cognipeer.com/api/client/v1/traces
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer cpeer_…"
```

This is a convenient migration path, but the
[native LangChain integration](/guide/observability/langchain) captures strictly
more: LangChain filters `tools` out of the metadata its tracers receive, so the
OTel path carries **no tool definitions at all**.

## Framework notes

| Framework | Route | Notes |
|---|---|---|
| CrewAI | `openinference-instrumentation-crewai` | Also has a native event bus (`crewai.events`) that reports token usage more directly; a first-class integration is on the roadmap. |
| LlamaIndex | `openinference-instrumentation-llama-index` | Its own dispatcher exposes tool definitions that the OTel path does not; roadmap. |
| Pydantic AI | native (`InstrumentationSettings`) | OTel-native, emits current GenAI semconv. Nothing else needed. |
| Google ADK | native | OTel-native. |
| AWS Strands | native | OTel-native. |
| Semantic Kernel / Microsoft Agent Framework | native `ActivitySource` | .NET and Python both export OTLP — this is how C# applications reach Console today. |
| smolagents | `openinference-instrumentation-smolagents` | |
| Haystack | `opentelemetry-instrumentation-haystack` | |
| AutoGen / AG2 | runtime `tracer_provider` | OTel is the only real seam. |

## What is captured

Depends entirely on what the instrumentation emits. Across the three
conventions, when the instrumentor is doing its job:

| | |
|---|---|
| Prompts and completions | ✅ (see the redaction note below) |
| Token usage | ✅ input/output; cached only from OpenAI and Anthropic |
| Tool calls and results | ✅ |
| Tool definitions | ✅ from all three conventions, per model call |
| Model name | ✅ |
| Parent/child hierarchy | ✅ from the OTel span tree |
| Conversation id | ⚠️ only if the app opted in — see below |
| Cost | computed by Console from tokens; a reported `llm.cost.*` is kept in metadata for reconciliation |

### Conversation grouping needs an opt-in

No instrumentation emits a session id on its own. Each convention has its own
way to set one, and if the application does none of them, every run arrives as
its own unrelated session:

```python
# OpenInference
from openinference.instrumentation import using_session
with using_session(session_id="conv-42"):
    ...

# OpenLLMetry
from traceloop.sdk import Traceloop
Traceloop.set_association_properties({"session_id": "conv-42"})
```

Or skip all of that and pass `thread_id` / `threadId` to the exporter.

### Content may already be redacted upstream

Instrumentation has its own privacy switches —
`OPENINFERENCE_HIDE_LLM_TOOLS`, `TRACELOOP_TRACE_CONTENT=false` — and they
replace values with the literal `__REDACTED__`. Console recognises that
sentinel and does not render it as a message.

Also worth setting on a chatty agent: OTel truncates long attribute values by
default, and current conventions pack an entire conversation into one JSON
attribute, so one breach of the limit costs you the whole conversation rather
than one message.

```bash
OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT=131072
```

## Attribute mapping

The full three-convention table is in
[Data Model](/guide/observability/data-model#opentelemetry-attribute-mapping).
Two details worth repeating because they silently corrupt cost analysis:

- **The system prompt moved.** OpenLLMetry ≥ 0.55 strips it out of
  `gen_ai.input.messages` into `gen_ai.system_instructions`. Console reads both.
- **Cache-write is not cache-read.** `cachedInputTokens` is populated only from
  cache *read* counts; cache *creation* is a separately-priced number and is
  never folded in.
