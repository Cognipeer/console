# Vercel AI SDK

The AI SDK moved its telemetry seam twice in two majors, so the integration
ships three routes. Which one you use is decided by your `ai` version, not by
preference.

```ts
import { init } from '@cognipeer/observability';
import { installVercelAITracing } from '@cognipeer/observability/vercel-ai';

init({ apiKey: 'cpeer_…', agent: { name: 'support-bot' } });
await installVercelAITracing();
```

That is the whole integration on `ai@6` and newer. Every `generateText`,
`streamText`, `generateObject` and tool execution in the process is traced.

::: warning `ai@7` removed OpenTelemetry from the core package
There is no `experimental_telemetry.tracer` to inject into any more, and
`TelemetrySettings` no longer exists. If you are on v7 and following a guide
that tells you to pass a tracer, that guide predates the release. Use
`installVercelAITracing()`, or install `@ai-sdk/otel` if you specifically want
to stay on OTLP.
:::

## Which route

| Route | Versions | Use when |
|---|---|---|
| **Native telemetry integration** — `installVercelAITracing()` | `ai@6`, `ai@7` | Default. Best data available. |
| **Model middleware** — `withCognipeerTracing(model)` | every version | Pinned to an old major, or you want provider-level truth |
| **Tracer injection** — `cognipeerTelemetry()` | `ai@3` – `ai@6` | Legacy apps already passing `experimental_telemetry` |

The native integration is recommended wherever it exists because it is the
only seam that hands over the tool menu as a live structured array with full
JSON Schema, flat token usage with a cache-read breakdown, and per-tool
timings. The middleware is the only seam that is unchanged across every major,
but it wraps **one model call** — it sees no agent loop, no client-side tool
execution and no step hierarchy.

## Route 1 — native telemetry integration

Requires `ai@6` or newer.

```ts
import { init } from '@cognipeer/observability';
import { installVercelAITracing } from '@cognipeer/observability/vercel-ai';

init({ agent: { name: 'support-bot' } });
await installVercelAITracing({ threadId: 'conv-42' });

await generateText({
  model: openai('gpt-4.1-mini'),
  prompt: 'where is my order?',
  tools,
});
```

`installVercelAITracing` is async because it dynamically imports `ai` to find
the registration function (`registerTelemetry` on v7, singular
`registerTelemetryIntegration` on v6). Pass `register` yourself if your bundler
cannot resolve the dynamic import:

```ts
import { registerTelemetry } from 'ai';
await installVercelAITracing({ register: registerTelemetry });
```

| Option | Type | Meaning |
|---|---|---|
| `client` | `CognipeerObservability` | Send through a specific client instead of the process-wide one |
| `agent` | `{ name?, version?, model?, provider? }` | Agent identity for sessions this integration opens |
| `threadId` | `string` | Conversation id — see [Grouping a conversation](#grouping-a-conversation) |
| `metadata` | `Record<string, unknown>` | Attached to every event emitted |
| `register` | `(integration) => void` | The SDK's registration function, to skip the dynamic import |

Registration is guarded against running twice, which is trivially easy under
Next.js HMR or a warm serverless start — the SDK's registry is append-only and
would otherwise double every event. `resetVercelAITracing()` clears the guard
in tests.

::: warning A per-call `integrations` array replaces the global registry
`telemetry: { integrations: [...] }` on a single call does not merge with the
globally registered integrations — it replaces them for that call. A caller
passing their own array (or an empty one) silently opts out of Console
tracing. Include `CognipeerAISDKTelemetry` in that array to keep both:

```ts
import { CognipeerAISDKTelemetry } from '@cognipeer/observability/vercel-ai';

await generateText({
  model, prompt,
  telemetry: { integrations: [new CognipeerAISDKTelemetry(), myOwnIntegration] },
});
```
:::

## Route 2 — model middleware

Works on every major, with no OpenTelemetry and no registration.

```ts
import { init, trace } from '@cognipeer/observability';
import { withCognipeerTracing } from '@cognipeer/observability/vercel-ai';

init({ agent: { name: 'support-bot' } });
const model = withCognipeerTracing(openai('gpt-4.1-mini'), { threadId: 'conv-42' });

await trace({ name: 'support-bot', threadId: 'conv-42' }, async () => {
  await generateText({ model, prompt, tools });
});
```

`withCognipeerTracing` is a proxy: every property other than `doGenerate` and
`doStream` passes through untouched, including `specificationVersion`,
`modelId` and `provider`. It needs no runtime dependency on `ai`, which is why
it is a proxy rather than a call to `wrapLanguageModel`. If you would rather
use the SDK's own helper:

```ts
import { wrapLanguageModel } from 'ai';
import { cognipeerMiddleware } from '@cognipeer/observability/vercel-ai';

const model = wrapLanguageModel({ model: openai('gpt-4.1'), middleware: cognipeerMiddleware() });
```

The middleware object sets both version discriminators — `specificationVersion:
'v4'` for `ai@7` and `middlewareVersion: 'v2'` for `ai@5` — so one object
satisfies every major; each reads only the key it knows.

::: tip Wrap the request in `trace()`
This seam observes one model call at a time and has no way to know which run it
belongs to. Without a surrounding [`trace()`](/guide/observability/manual),
each call becomes its own single-event session.
:::

## Route 3 — tracer injection

For `ai@3` – `ai@6`, where `experimental_telemetry` still exists.

```ts
import { cognipeerTelemetry } from '@cognipeer/observability/vercel-ai';

await generateText({
  model: openai('gpt-4.1-mini'),
  prompt: 'where is my order?',
  experimental_telemetry: cognipeerTelemetry({
    functionId: 'chat-turn',
    threadId: 'conv-42',
  }),
});
```

`cognipeerTelemetry` sets `isEnabled: true` for you — it defaults to `false` in
the SDK, and forgetting it is the usual reason a first attempt produces no
traces at all. It also builds a `CognipeerAISDKTracer`, a minimal
OpenTelemetry `Tracer` that writes straight to Console: no provider, no
exporter, no `@opentelemetry/*` install.

| Option | Type | Meaning |
|---|---|---|
| `functionId` | `string` | The SDK's label for this operation |
| `threadId` | `string` | Written into `metadata` as well as used directly |
| `recordInputs` / `recordOutputs` | `boolean` | The SDK's own content switches |
| `metadata` | `Record<string, unknown>` | Only scalars survive — OTel attributes must be primitives |

On `ai@7` the same class still works through `@ai-sdk/otel`:

```ts
import { OpenTelemetry } from '@ai-sdk/otel';
import { CognipeerAISDKTracer } from '@cognipeer/observability/vercel-ai';

const telemetry = new OpenTelemetry({ tracer: new CognipeerAISDKTracer() });
```

::: tip Already running an OTel SDK?
Do not use `CognipeerAISDKTracer`. Point the AI SDK at your own tracer and
export to Console's [OTLP endpoint](/guide/observability/opentelemetry)
instead, so AI spans stay in the same trace as your HTTP and database spans.
:::

## Version matrix

| `ai` | Telemetry seam | Usage attribute names | Middleware discriminator |
|---|---|---|---|
| **3.x** | `experimental_telemetry` + `tracer` (OTel) | `promptTokens` / `completionTokens`, **no cached tokens** | — |
| **4.x** | same | same | — |
| **5.x** | same | both legacy and `inputTokens` / `outputTokens` / `cachedInputTokens` | `middlewareVersion: 'v2'` |
| **6.x** | OTel **and** `TelemetryIntegration` (6 callbacks, `registerTelemetryIntegration`) | modern | `middlewareVersion: 'v2'` |
| **7.x** | `Telemetry` only (~20 callbacks, variadic `registerTelemetry`); OTel moved to `@ai-sdk/otel` | modern, nested `{ total, cacheRead, … }` on provider results | `specificationVersion: 'v4'` (**required**) |

The v5 rename is the one that silently breaks a hand-rolled reader: a parser
written for `promptTokens` returns `undefined` on v7 and reports a zero-token
run. `normalizeAISDKUsage` — exported for reuse — accepts all three shapes.

In every shape the input figure is the **total including cache reads**, which
is what Console wants: it prices `cachedInputTokens` as a subset of
`inputTokens`. No arithmetic is applied.

## Grouping a conversation

The AI SDK has no session concept, so without a thread id every call becomes
its own unattached session. Three ways to supply one, checked in this order:

1. `threadId` in the integration options — `installVercelAITracing({ threadId })`,
   `withCognipeerTracing(model, { threadId })`, `cognipeerTelemetry({ threadId })`.
2. `runtimeContext` on the call (`ai@7`), which the SDK passes to `onStart`.
3. Telemetry metadata, under any of `threadId`, `thread_id`, `sessionId`,
   `session_id` or `conversationId`.

```ts
await generateText({
  model, prompt, tools,
  runtimeContext: { threadId: 'conv-42' },
  telemetry: { functionId: 'chat-turn', includeRuntimeContext: { threadId: true } },
});
```

`runtimeContext` is populated on the operation-start event only — it is
`undefined` on model-call and tool events — so the integration captures it once
and remembers it for the rest of the call.

## What is captured

| | Native integration | Middleware | Tracer |
|---|:---:|:---:|:---:|
| Prompts and system instructions | ✅ | ✅ | ✅ |
| Completions | ✅ | ✅ | ✅ |
| Token usage | ✅ | ✅ | ✅ |
| Cached-token breakdown | ✅ | ✅ (v5+) | ✅ (v5+) |
| Tool definitions with JSON Schema | ✅ | ✅ | ⚠️ stringified |
| Tool execution (args + result + timing) | ✅ | ❌ | ✅ |
| Step hierarchy in an agent loop | ✅ | ❌ | ✅ |
| Model id and provider | ✅ | ✅ | ✅ |
| Aborted streaming runs closed cleanly | ✅ | ✅ | ⚠️ |

Notes on the ❌s and ⚠️s:

- The middleware wraps the model, so **client-side tool execution happens
  outside it entirely** — you get the model's tool *call*, never its *result*.
- On `ai@3`/`ai@4` there is no cached-token attribute anywhere in the SDK, so
  `cachedInputTokens` is absent regardless of route.
- The run-level `usage` on the finish event is an **aggregate across every
  step**. It is deliberately not recorded: the session summary is already
  accumulated from the per-call events, and adding it would double every token
  count on a multi-step run.
- The SDK's error event carries no call id, so an `onError` fails every call
  still open on the integration rather than one.

## Mastra

Not covered yet. Mastra 1.x replaced its constructor `telemetry` option with a
separate `@mastra/observability` package whose `ObservabilityExporter`
interface gives better data than the AI SDK seam — real 32-hex trace ids, a
first-class `conversationId`, tool schemas — so it warrants its own exporter
rather than being bolted onto this one. It also emits a `MODEL_CHUNK` span per
streaming chunk, which must be filtered or a single response becomes hundreds
of events.

In the meantime, Mastra can export through
[OpenTelemetry](/guide/observability/opentelemetry) using
`@mastra/otel-exporter`.

## See also

- [Data Model](/guide/observability/data-model) — the ingest contract
- [Manual instrumentation](/guide/observability/manual) — `trace()` and `observe()`
- [Troubleshooting](/guide/observability/troubleshooting)
