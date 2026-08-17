# Troubleshooting

Ordered by how often each one is actually the cause.

## Nothing appears in Tracing

Run once with debug logging on. It prints every request the exporter makes and
every failure it swallowed:

```bash
COGNIPEER_DEBUG=1 python your_agent.py
COGNIPEER_DEBUG=1 node your-agent.js
```

### 1. No API key, so tracing disabled itself

The SDK never throws for a missing key — it warns once and becomes a no-op, so
that a misconfigured environment cannot take down a production agent. The
warning looks like:

```
cognipeer: no API key — tracing disabled. Set COGNIPEER_API_KEY or pass api_key to init().
```

Check the variable is exported in the process that actually runs the agent —
not just in your shell — and that `init()` runs before the agent is created.

### 2. The process exited before the export landed

Exports are asynchronous by design. A script, a Lambda handler or a CI job can
finish and exit while the last request is still in flight.

```python
cognipeer.flush()      # blocks until the queue drains
```

```ts
await flush();
```

Long-running servers do not need this — the background worker drains
continuously, and a `beforeExit` hook covers ordinary shutdown.

### 3. The token cannot write traces

A 401 or 403 in the debug output means the token is wrong or lacks the tracing
service. Under **Settings → API Tokens**, confirm the token has **tracing**
enabled and belongs to the project you are looking at — sessions are
project-scoped, and a token for project A never shows up under project B.

A 429 means a quota or rate limit; the message names which one.

### 4. `COGNIPEER_BASE_URL` points at the wrong place

For self-hosted Console, pass the **host root** — the SDK appends the API path
itself:

```bash
COGNIPEER_BASE_URL=https://console.acme.internal        # correct
COGNIPEER_BASE_URL=https://console.acme.internal/api/client/v1   # also accepted, trimmed
```

### 5. The handler was never attached

Easy to check: the framework integrations expose the session they created.

```python
handler = CognipeerCallbackHandler()
agent.invoke(state, config={"callbacks": [handler]})
print(handler.session.session_id if handler.session else "handler never fired")
```

For LangChain specifically, a handler passed to the constructor of a component
is not inherited by a chain built from it — pass it in the `config` of the
`invoke` call, or use `cognipeer_config()`.

## Traces appear but are empty or thin

### Token counts are missing on streaming calls

Most providers only report usage on a streaming response if you ask them to.
This is a provider setting, not something an observability SDK can work around:

```python
ChatOpenAI(model="gpt-4.1-mini", stream_usage=True)
```

```ts
new ChatOpenAI({ model: 'gpt-4.1-mini', streamUsage: true });
```

The SDK deliberately leaves the field **absent** rather than sending zero, so an
unpriced call is visible as unknown instead of quietly under-reporting spend.

### Prompts and completions are missing

Check `COGNIPEER_CAPTURE_CONTENT`. With `metadata` the run structure, tool
names, tokens and latency are recorded but no message bodies; with `none` the
exporter is off entirely.

Some instrumentation also redacts content on its own — OpenInference's
`OPENINFERENCE_HIDE_LLM_TOOLS`, OpenLLMetry's `TRACELOOP_TRACE_CONTENT=false` —
and replaces values with the literal `__REDACTED__`, which Console does not
render as a message.

### Tool definitions are missing

Not every seam exposes them. The integration page for your framework states
which case you are in; briefly:

- LangChain / LangGraph — captured, from `invocation_params`.
- OpenAI Agents SDK — full schemas only on the Responses API path; on Chat
  Completions only names are recoverable.
- Claude Agent SDK — names only; schemas are not on that seam at all.
- n8n — reconstructed from the workflow definition, and labelled as such.

### Long content is cut off

A single section is capped (50 000 characters by default) so one oversized
message cannot blow the 10 MB ingest limit for the whole session. Raise it with
`max_content_chars` / `maxContentChars` if you need to, and note that base64
data URLs are stripped regardless — a multimodal prompt would otherwise be
mostly image bytes.

## The tree looks wrong

### Everything is a child of the root

The framework did not give the integration a parent relationship, or the parent
step was filtered as plumbing. LangChain/LangGraph integrations skip
infrastructure runnables (`RunnableSequence`, `ChannelWrite`, …) and re-parent
their children onto the nearest recorded ancestor, so a flat tree there usually
means the run genuinely was flat.

### One conversation is split across many sessions

That is expected, and it is what `threadId` is for. Every `invoke` — and every
resume after a LangGraph interrupt — is a separate run. Set a thread id and read
the conversation in **Tracing → Threads**.

If you set one and it still does not group: on langchain-core ≥ 1.3.0 and
`@langchain/core` ≥ 1.1.39, `configurable.thread_id` is no longer copied into
the metadata a third-party handler can see. Use `cognipeer_config()` /
`cognipeerConfig()`, which writes it to both places, or pass `thread_id=` to the
handler directly.

### The same model call appears twice

Two common causes, both real rather than artefacts:

- **A LangGraph resume re-runs the node from the top.** Everything before the
  `interrupt()` call executes again — including model and tool calls. Those
  cost real money and are recorded because they happened.
- **Two exporters are attached.** A globally installed handler plus one passed
  per invoke. Python de-duplicates by `isinstance`; the JS path does not always.

## Interrupts are reported as failures

They should not be — LangGraph's `GraphInterrupt` is control flow, and the
integrations recognise the `GraphBubbleUp` family and record the step as
successful with `metadata.interrupted`. If you see interrupts marked failed,
you are probably on a custom handler rather than the shipped one.

## OTLP traces arrive but look generic

Console normalises OpenInference, current OTel GenAI and legacy OpenLLMetry
attributes. A span that maps to a bare `span` event with only a "Span
Attributes" block carried none of them — the instrumentation emitted plain
OTel. Check that the instrumentor is actually installed and registered, and
see the mapping table in [Data Model](/guide/observability/data-model#opentelemetry-attribute-mapping)
for which attributes are read.

For n8n specifically, its exporter speaks OTLP **protobuf** while `/traces`
accepts OTLP **JSON** — that route needs a collector in between, and the
[n8n page](/guide/observability/n8n) has a working config. The bridge is the
easier path.

## Getting help

Open an issue at
[Cognipeer/console-observability](https://github.com/Cognipeer/console-observability/issues)
with the debug output, your framework and its version, and the SDK version. The
package is MIT licensed, so a patch is welcome too.
