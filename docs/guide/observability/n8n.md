# n8n

n8n has no seam for injecting a callback into its AI Agent node, so this
integration works from **execution run data** instead — which turns out to be
the richest source n8n has. Prompts, completions, per-call token usage, tool
inputs and outputs, per-node durations and errors all live there.

The fastest path needs nothing installed on the n8n side:

```bash
npx --package=@cognipeer/observability cognipeer-n8n \
  --n8n-url https://n8n.acme.com \
  --n8n-api-key "$N8N_API_KEY" \
  --api-key "$COGNIPEER_API_KEY" \
  --once
```

That mirrors the most recent executions into Console and exits. Drop `--once`
to keep watching.

## Which route

| Route | Where it runs | n8n Cloud | Community licence | Latency |
|---|---|:---:|:---:|---|
| **A — Bridge** (recommended) | anywhere with network access to n8n | ✅ | ✅ | poll interval |
| **B — External hook** | inside n8n | ❌ | ✅ | immediate |
| **C — n8n's OpenTelemetry** | inside n8n | ✅ | ⚠️ partial | immediate |

Route C is deliberately last — see [why](#route-c-n8ns-own-opentelemetry).

## Route A — the bridge

Polls n8n's public REST API (`GET /api/v1/executions?includeData=true`) and
mirrors each finished execution into Console. It works on **n8n Cloud** and on
self-hosted **Community** with no licence, and needs only an n8n API key
(**Settings → n8n API → Create API key**).

```bash
export N8N_URL=https://n8n.acme.com
export N8N_API_KEY=n8n_api_…
export COGNIPEER_API_KEY=cpeer_…

npx --package=@cognipeer/observability cognipeer-n8n
```

Every flag has an environment variable, so a container needs no arguments:

| Flag | Environment variable | Default | Meaning |
|---|---|---|---|
| `--n8n-url` | `N8N_URL` | — | n8n base URL (required) |
| `--n8n-api-key` | `N8N_API_KEY` | — | n8n API key (required) |
| `--api-key` | `COGNIPEER_API_KEY` | — | Console API token (required) |
| `--base-url` | `COGNIPEER_BASE_URL` | `https://console.cognipeer.com` | Your Console, if self-hosted |
| `--workflow-id` | `N8N_WORKFLOW_ID` | all workflows | Mirror only this workflow. Repeat the flag for several; the env var takes a comma-separated list |
| `--interval` | `COGNIPEER_N8N_INTERVAL` | `15` | Poll interval in seconds |
| `--page-size` | `COGNIPEER_N8N_PAGE_SIZE` | `50` | Executions per poll (n8n caps at 250) |
| `--since` | `COGNIPEER_N8N_SINCE` | process start | Ignore runs that finished earlier |
| `--once` | — | — | Mirror one page and exit |
| `--debug` | — | — | Log the exporter's activity |

Executions are de-duplicated by id, so a restart re-mirrors nothing. Workflow
JSON is fetched once per workflow and cached — that is what supplies node
types, model names and the tool menu, so the API key needs read access to
workflows as well as executions.

By default only runs that finish **after the bridge starts** are mirrored. Use
`--since` to backfill:

```bash
cognipeer-n8n --since 2026-08-01T00:00:00Z --once
```

### Verifying

Run the workflow once in n8n, then:

```bash
npx --package=@cognipeer/observability cognipeer-n8n --once --debug
# [cognipeer] mirrored n8n-exec-1481 (7 events)
```

If it prints `mirrored 0 execution(s)`, the execution finished before the
bridge's cutoff — add `--since`.

### As a container

```yaml
services:
  cognipeer-n8n:
    image: node:22-alpine
    command: npx --yes --package=@cognipeer/observability cognipeer-n8n
    environment:
      N8N_URL: http://n8n:5678
      N8N_API_KEY: ${N8N_API_KEY}
      COGNIPEER_API_KEY: ${COGNIPEER_API_KEY}
      COGNIPEER_BASE_URL: https://console.acme.internal
    restart: unless-stopped
```

## Route B — the external hook

Self-hosted only, but push-based: traces land the moment a run finishes, with
no polling and no API key on the n8n side.

Create a hook module:

```js
// /opt/cognipeer/n8n-hook.js
const { init } = require('@cognipeer/observability');
const { createN8nExternalHook } = require('@cognipeer/observability/n8n');

init({
  apiKey: process.env.COGNIPEER_API_KEY,
  baseUrl: process.env.COGNIPEER_BASE_URL,
});

module.exports = createN8nExternalHook();
```

Then point n8n at it:

```bash
EXTERNAL_HOOK_FILES=/opt/cognipeer/n8n-hook.js
```

`@cognipeer/observability` must be resolvable from that file — install it into
the image, or mount `node_modules` alongside the hook.

| Option | Default | Meaning |
|---|---|---|
| `productionOnly` | `false` | Skip manual/test runs. Left off so a **Test workflow** click verifies the wiring |
| `threadId` | — | Fixed conversation id for every run |
| `agentName` | workflow name | Session agent name |
| `client` | process-wide | Send through a specific client |

The hook runs inside n8n's own process, so an export failure is caught and
logged rather than surfaced as a workflow error.

## Route C — n8n's own OpenTelemetry

n8n can export OTLP spans itself (`N8N_OTEL_*`), and it is the obvious-looking
route — but for **agent** observability it is the weakest of the three:

- `workflow.execute` and `node.execute` spans carry **no prompts, completions
  or model names**. `node.execute` carries item counts.
- LLM token usage reaches OTel only through `n8n.node.custom.*` span
  attributes, which are **dropped unless the instance is Enterprise-licensed**.
  On Community you get spans with no token data at all.
- n8n's exporter speaks **OTLP protobuf** (`@opentelemetry/exporter-trace-otlp-proto`,
  with no switch to JSON), while Console's `/api/client/v1/traces` accepts
  **OTLP JSON**. An OpenTelemetry Collector is required in between.

Use it when you already run a collector and want n8n's workflow-level spans
alongside everything else. For agent traces, use Route A or B.

### Collector configuration

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  otlphttp/cognipeer:
    # Set traces_endpoint, not endpoint: the exporter would otherwise append
    # its own /v1/traces to the URL.
    traces_endpoint: https://console.cognipeer.com/api/client/v1/traces
    encoding: json
    headers:
      authorization: "Bearer ${env:COGNIPEER_API_KEY}"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/cognipeer]
```

### n8n configuration

```bash
N8N_OTEL_ENABLED=true
# BASE url only — n8n appends N8N_OTEL_EXPORTER_OTLP_TRACING_PATH (/v1/traces)
N8N_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
N8N_OTEL_EXPORTER_SERVICE_NAME=n8n
# Off by default, so a "Test workflow" click produces nothing until you set it
N8N_OTEL_TRACES_PRODUCTION_ONLY=false
```

::: warning The two traps that generate support tickets
1. `N8N_OTEL_EXPORTER_OTLP_ENDPOINT` is a **base URL**. Pasting the full
   `…/v1/traces` produces `…/v1/traces/v1/traces` and nothing arrives.
2. `N8N_OTEL_TRACES_PRODUCTION_ONLY` defaults to **true**, so clicking **Test
   workflow** in the editor to check the integration traces nothing at all —
   which reads exactly like a broken setup.
:::

`N8N_OTEL_EXPORTER_OTLP_HEADERS` takes a comma-separated `key=value` string, so
a value containing a comma cannot be expressed; use the `_FILE` variant for
secrets. In queue mode, set these variables on **every** instance type — main,
workers and webhook processors — or worker spans lose their parent context and
arrive as orphaned trees.

::: tip `N8N_AGENTS_TRACING_ENABLED` is a different feature
It instruments n8n's **native Agents module** (the *Message an Agent* node),
not the classic `n8n-nodes-langchain.agent` node most workflows use. Enabling
it on a workflow built with the classic AI Agent node produces no `gen_ai.*`
spans. It is also inert unless `N8N_OTEL_ENABLED=true`.
:::

## How n8n maps onto Console

| n8n | Console |
|---|---|
| Execution | Session, id `n8n-exec-<executionId>` |
| Workflow name | Agent name |
| Node run (one task) | Event |
| `ai_languageModel` sub-node run | `ai_call` |
| `ai_tool` sub-node run | `tool_call` |
| `ai_embedding` sub-node run | `embedding` |
| `ai_vectorStore` / `ai_retriever` sub-node run | `retrieval` |
| `ai_memory` sub-node run | `span` |
| Any other node run | `span` |
| `executionTime` | `durationMs` |
| `tokenUsage.promptTokens` / `.completionTokens` | `inputTokens` / `outputTokens` |
| Node error | Event `status: error` + `error.message` |

Sub-nodes are parented to the agent node that consumes them, read from the
workflow's `ai_*` connections — those point *outwards* from the sub-node to the
agent, the opposite direction from a normal `main` connection.

## What is captured, and what is not

Stated plainly, because these affect what Console can show:

**No cached-token counts.** n8n's LLM tracing records prompt and completion
tokens only, so `cachedInputTokens` is always absent. Cache-heavy agents will
look more expensive here than they are.

**Token estimates are common.** When a provider reports no usage — streaming
responses, cancelled runs — n8n substitutes a tiktoken estimate modelled as
`gpt-4o`. Those events are marked `metadata.tokensEstimated: true` so a cost
report can exclude them.

**Tool definitions are reconstructed, not observed.** They are read from the
workflow JSON (each `ai_tool` node's `toolDescription`, `inputSchema` or
`jsonSchemaExample`) and attached to the agent node's event with
`metadata.toolDefinitionsSource: 'n8n-workflow-json'`. That is the workflow's
*declared* tool set — not the array the model was handed on a given call, which
n8n does not record.

**There is no first-class conversation id.** `$execution.id` is per run. The
integration falls back, in order, to:

1. `threadId` passed to the bridge or hook;
2. `execution.customData.threadId` / `.sessionId` / `.conversationId`;
3. a memory sub-node's `sessionKey` parameter, if it is a literal rather than
   an expression.

The reliable option is the second — set it from a Code node at the top of the
workflow:

```js
// Code node, before the AI Agent
$execution.customData.set('threadId', $json.chatId);
return $input.all();
```

Runs then group into one conversation in **Tracing → Threads**.

## See also

- [Data Model](/guide/observability/data-model) — the ingest contract
- [OpenTelemetry](/guide/observability/opentelemetry) — the generic OTLP route
- [Troubleshooting](/guide/observability/troubleshooting)
