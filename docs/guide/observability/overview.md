# Observability Integrations

Console's [Agent Tracing](/guide/tracing) shows what an agent did — every model
call, tool call and retrieval, with tokens, latency and cost. This section is
about getting an agent you did **not** build on Console to send that data.

The integrations live in a separate open-source package,
[`cognipeer-observability`](https://github.com/Cognipeer/cognipeer-observability),
published as `@cognipeer/observability` (npm) and `cognipeer-observability`
(PyPI). Nothing about it is Console-specific beyond the endpoint it posts to,
and it is MIT licensed so customers can read and fork it.

## The premise

A customer arrives with an agent already written — in LangGraph, in the OpenAI
Agents SDK, in n8n, in whatever their team picked six months ago. The
integration must be two lines and must not change how their agent calls its
models. No proxy, no base-URL swap, no rewrite.

```python
import cognipeer_observability as cognipeer
from cognipeer_observability.langchain import CognipeerCallbackHandler

cognipeer.init(api_key="cpeer_…", agent={"name": "support-bot"})
agent.invoke(state, config={"callbacks": [CognipeerCallbackHandler()]})
```

```ts
import { init } from '@cognipeer/observability';
import { CognipeerCallbackHandler } from '@cognipeer/observability/langchain';

init({ apiKey: 'cpeer_…', agent: { name: 'support-bot' } });
await agent.invoke(state, { callbacks: [new CognipeerCallbackHandler()] });
```

## What is supported

| Framework | Python | TypeScript | Seam |
|---|:---:|:---:|---|
| [LangChain](/guide/observability/langchain) | ✅ | ✅ | Callback handler, 0.1 → 1.x |
| [LangGraph](/guide/observability/langgraph) | ✅ | ✅ | Same handler + thread & interrupt handling |
| [OpenAI Agents SDK](/guide/observability/openai-agents) | ✅ | ✅ | `TracingProcessor` |
| [Claude Agent SDK](/guide/observability/claude-agent-sdk) | ✅ | ✅ | Message-stream tracer |
| [Vercel AI SDK](/guide/observability/vercel-ai) | — | ✅ | Telemetry integration or model middleware |
| [n8n](/guide/observability/n8n) | — | ✅ | Execution bridge or external hook |
| [Any OpenTelemetry agent](/guide/observability/opentelemetry) | ✅ | ✅ | Span exporter / OTLP endpoint |
| [Anything else](/guide/observability/manual) | ✅ | ✅ | `@observe` and the session API |

The OpenTelemetry route is what covers the long tail — CrewAI, LlamaIndex,
Pydantic AI, Google ADK, AWS Strands, Semantic Kernel, smolagents, Haystack,
DSPy. Most of them are OTel-native or have a maintained OpenInference /
OpenLLMetry instrumentor, and Console understands all three of the competing
attribute conventions those emit.

## How it fits together

```
   your agent                       cognipeer-observability            Console
┌───────────────────┐            ┌──────────────────────────┐      ┌──────────┐
│ LangChain callback│──────────▶ │                          │      │          │
│ Agents processor  │──────────▶ │  session / event model   │─────▶│ /api/    │
│ Claude msg stream │──────────▶ │  redaction · capping     │ HTTP │ client/  │
│ AI SDK middleware │──────────▶ │  batching · retry        │      │ v1/      │
│ n8n run data      │──────────▶ │                          │      │ tracing  │
└───────────────────┘            └──────────────────────────┘      └────┬─────┘
                                                                        │
   any OTel agent ── OTLP/HTTP JSON ────────────────────────────────────▶│
   (OpenInference · OTel GenAI · OpenLLMetry)                            ▼
                                                              Tracing · Threads
                                                              Cost · Evaluation
```

Every integration is a **mapping** onto one internal model — sessions
containing events containing sections — documented in
[Data Model](/guide/observability/data-model). Adding a framework means
writing that mapping and nothing else.

## What lands in Console

Once traces arrive, everything Console already does with its own agents
applies to the integrated one:

- **[Tracing](/guide/tracing)** — the run timeline, with prompts, completions,
  tool arguments and results, nested by parent/child.
- **Threads** — several runs grouped into one conversation.
- **Cost** — trace-derived token usage is priced against Model Hub or your
  external pricing catalogue, and shows up in spend reports as
  `source: tracing`, separable from gateway-served traffic.
- **[Evaluation](/guide/evaluation-and-analysis)** — build datasets from real
  traced runs and replay them against other models.
- **Analysis** — prompt linting and per-agent cost/latency breakdowns.

## Configuration

The SDK reads its configuration from the environment, so the same code runs
unchanged in every environment:

| Variable | Default | Meaning |
|---|---|---|
| `COGNIPEER_API_KEY` | — | Console API token. Without it, tracing disables itself and warns once — it never throws. |
| `COGNIPEER_BASE_URL` | `https://console.cognipeer.com` | Your Console for self-hosted installs |
| `COGNIPEER_AGENT_NAME` | — | Default agent name on every session |
| `COGNIPEER_CAPTURE_CONTENT` | `all` | `all`, `metadata` (structure and tokens, no message bodies) or `none` |
| `COGNIPEER_TRACING_ENABLED` | `true` | Master switch |
| `COGNIPEER_TRACING_MODE` | `auto` | `auto`, `stream` or `batch` — see [Data Model](/guide/observability/data-model#delivery) |
| `COGNIPEER_DEBUG` | `false` | Log what the exporter is doing |

Create the API token under **Settings → API Tokens**; it needs the tracing
service enabled on its permissions.

## Guarantees

These are properties of the package, not aspirations — its test suite checks
them, and they are the reason it is safe to put in front of a customer's
production agent:

- **Tracing never breaks the traced application.** Every export path swallows
  its own failures and reports them through an error callback. A missing API
  key disables the exporter rather than raising.
- **Tracing never blocks it either.** Exports run on a background thread
  (Python) or a promise chain (JS). No integration awaits network I/O on a
  framework's hot path.
- **No dependency surprises.** The core is standard-library only in both
  languages; every framework import is lazy and optional.
- **Secrets and blobs stay put.** API-key-shaped strings in prompts are
  redacted, base64 data URLs are stripped, and content is capped before it is
  sent.
- **Honest data.** When a framework cannot report something — token usage on a
  streaming call, tool schemas on a chat-completions path — the field is
  absent rather than zero, and each integration page says exactly what its
  framework can and cannot see.

## Next

- [Quickstart](/guide/observability/quickstart) — first trace in five minutes
- [Data Model](/guide/observability/data-model) — the ingest contract
- [Troubleshooting](/guide/observability/troubleshooting) — when nothing shows up
