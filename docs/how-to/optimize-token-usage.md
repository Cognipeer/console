# Optimize token usage

This is the long one. It takes an agent you already run in production and walks the whole loop: connect
it, measure it, sample its real traffic into a dataset that is safe to keep, build a test you can re-run,
compare models honestly, cut tokens, and prove the cut did not cost you quality.

Nothing here requires rewriting your agent. The framework stays exactly as it is.

::: tip Who this is for
Both halves of the team. The click-paths are written so an operations lead can follow them without
touching code; each section then gives the engineer the endpoint, the payload and the trap.
:::

## What you end up with

```
your agent ──► traces ──► insights ──► traffic snapshot ──► dataset
                                                              │
                            ┌─────────────────────────────────┘
                            ▼
                     evaluation suite ──► baseline run
                            │
                            ├──► same suite, different model   → is the cheap one good enough?
                            └──► same suite, after your change → did the change break anything?
```

Be clear-eyed about the scope. This measures and reduces **your** token usage: the prompt you send, the
tool menu you attach, the calls your loop makes. It does not change what your framework sends on your
behalf, and it is not a magic compression layer.

## Before you start

| You need | Where |
|---|---|
| An API token with tracing enabled | **Settings → API Tokens → Create Token** |
| At least one model in the Model Hub | See [Create your first model](/how-to/first-model) |
| Pricing filled in on that model | Model Hub → the model → pricing fields |
| An agent that already runs | Any framework — LangChain, LangGraph, OpenAI Agents, your own loop |

::: warning Fill in pricing first
A model with zero pricing reports zero spend forever, and every cost number in this guide stays blank.
Pricing is applied at ingest time and history is never rewritten, so a price entered today does not
retro-price yesterday's traffic. Set it before you start collecting.
:::

---

## Act 1 — Connect the agent you already have

Two lines of setup. No proxy, no base-URL swap in your agent, no code restructuring.

::: code-group

```python [Python]
import cognipeer_observability as cognipeer
from cognipeer_observability.langchain import CognipeerCallbackHandler

cognipeer.init(agent={"name": "support-agent"})

result = agent.invoke(
    {"input": question},
    config={"callbacks": [CognipeerCallbackHandler(thread_id="conv-42")]},
)
```

```bash [Environment]
COGNIPEER_API_KEY=cpeer_…
COGNIPEER_BASE_URL=https://your-console-host      # host root, no /api/client/v1
COGNIPEER_CAPTURE_CONTENT=all                     # all | metadata | none
```

:::

Set `COGNIPEER_CAPTURE_CONTENT=all` for this exercise. You are going to build a dataset out of these
traces, and that needs the message bodies. `metadata` keeps structure and token counts but drops
content, which is the right setting for steady-state operation once you have your dataset.

Full SDK reference, and the wiring for LangGraph, OpenAI Agents, Claude Agent SDK, Vercel AI SDK, n8n
and plain OpenTelemetry, lives in [Observability Integrations](/guide/observability/quickstart). If your
framework is not covered, post sessions straight to the ingest endpoint —
see [Trace an existing agent](/how-to/trace-an-existing-agent).

::: danger Get the event types right, or half this guide goes blank
The deterministic insights in Act 3 key off **canonical event types**. A model call must be recorded as
`ai_call` and a tool invocation as `tool_call`. Anything else still draws a perfectly readable timeline —
and then Tool menu, AI calls per session, System prompt and Repeated tool calls all come back empty.
The SDK does this for you. Hand-rolled ingest is where people get caught; the correct shape is in
[Trace an existing agent](/how-to/trace-an-existing-agent#canonical-event-shape).
:::

## Act 2 — Watch it for a day

Let real traffic accumulate. You are looking for a representative window, not a big one.

Go to **Agent Observability**.

![Agent Observability landing](/screenshots/how-to/trace-agent/01-tracing-overview.png)

Open a single session to see what one conversation actually cost.

![One session's timeline](/screenshots/how-to/trace-agent/03-session-detail.png)

The thing to look at is the **Tool Definitions** card on each turn. That is the tool menu the model was
sent *on that call* — and it is re-sent on every call. A ten-tool menu on a six-call session is that
menu paid for six times.

Then switch to money: **Cost & Optimization → Agent costs** attributes spend to each agent from its
traces, and **Reports** gives you the trend line you will compare against later.

![Agent costs](/screenshots/how-to/optimize/02-cost-agents.png)

## Act 3 — Read the deterministic insights

**Cost & Optimization → Analysis**. Set the dimension toggle to **Agents** and pick your agent.

![Cost Analysis — deterministic insights](/screenshots/how-to/optimize/03-cost-analysis.png)

Everything on this screen is computed from raw trace events. No model is involved, so two people running
it an hour apart get the same answer.

The demo tenant used for these screenshots shows:

| Insight | Value | What it means |
|---|---|---|
| **AI calls / session** | 2.4 | Every extra call re-sends the whole context |
| **Tool calls / session** | 1.4 | More than one means loops — check the waste card |
| **Input tokens / AI call** | 370 | Context replayed on every turn |
| **Tool menu / call** | 1 tool, 100% of calls | The menu is paid on every call |
| **System prompt** | ~333 tokens | Multiply by AI calls per session |

Read it as a hit list, in this order:

1. **Tool menu × AI calls per session** is usually the single largest line item. It is also the easiest
   to cut, because most agents carry tools they never call.
2. **Repeated tool calls** is free money — see below.
3. **System prompt** is a fixed cost paid on every single call.

### System prompt checks

![System prompt checks and repeated tool calls](/screenshots/how-to/optimize/06-repeated-tool-calls.png)

The **System prompt checks** card runs deterministic lint rules against the live prompt pulled from your
traces. On the demo agent it returns 5 pass, 2 warn and 1 **fail**:

| Result | Check | Evidence |
|---|---|---|
| FAIL | Dynamic content in prefix (cache killer) | ISO date/time found in the first 600 characters |
| WARN | Duplicate sentences | 2 long sentences appear more than once |
| WARN | Placeholder / unfinished content | A `TODO` marker is still in the prompt |

The failure is the expensive one and it is extremely common. The demo prompt opens with
`Today is 2026-08-15T…`. A prefix that changes on every request invalidates the provider's prompt cache
every single time, so you pay full input price on every call forever. **Move dynamic content to the end
of the prompt.** That one edit is often the largest single saving available, and it costs nothing.

### Repeated tool calls

Identical calls — same tool, same arguments, same session. Every repeat pays the tool's latency *and*
another model turn to process a result the agent already had.

In the demo sample the badge reads **10 wasted of 17 analysed** — one order was looked up three times in
a single session. The table names the tool, the exact arguments, how many sessions are affected and the
worst case, which is usually enough to find the bug without opening a single trace. This is almost always
a fault in how tool results are fed back into the loop, not a model problem.

## Act 4 — Turn real traffic into a dataset you are allowed to keep

You cannot compare models on invented questions. You need the questions your users actually ask — and
you need them without the personal data attached.

**Evaluations → Create from traffic**, or **Agent Observability → Create snapshot from traffic**.

![Traffic Snapshots wizard](/screenshots/how-to/optimize/11-snapshot-wizard.png)

Four sections:

**1. Source.** **Gateway logs** (LLM gateway request/response logs) or **Agent traces** (tracing sessions
reconstructed into conversations). Filter by date range, status, and — importantly — by **Model**.

::: tip Filter to one model
If you are deciding whether to replace model X, snapshot *X's* traffic. A snapshot spanning three models
gives you reference answers from three different models, and then nothing you measure means anything.
:::

**2. Sampling.** **Sampling %** is deterministic: the same percentage always selects the same rows, so a
re-run of the snapshot is reproducible. **Max items** caps the result.

**3. Anonymization.** Not optional — *"Anonymization is required — every payload passes the PII gate
before it is stored"*. Creation is rejected outright without it. Pick your **PII categories**, then a
**Strategy**:

| Strategy | Output | Use when |
|---|---|---|
| **Mask** | `j***@domain.com` | You only need the shape of the data |
| **Pseudonym** | `<EMAIL_a1b2c3>` | You are going to evaluate on it |

Prefer **Pseudonym** here. The token is `HMAC-SHA256(salt, value)`, so the same person is the same token
everywhere in the conversation — "email `<EMAIL_a1b2c3>` … reply to `<EMAIL_a1b2c3>`" still reads as one
coherent exchange, which is what makes the dataset evaluable. The original value cannot be recovered
without the salt, and **the salt is never stored**. Supply your own **Stable salt** if you want tokens to
line up across several snapshots; leave it blank and the server generates a throwaway one for that run.

**4. Preview.** Run it before creating. You get **Matching**, **Would sample**, **Would create** and
**Scanned**, plus a per-model breakdown.

The demo snapshot: 518 matching gateway rows for `chat-small`, sampled at 40% → **186 items created, 0
skipped, 85 PII findings replaced**.

![The resulting dataset](/screenshots/how-to/optimize/13-datasets.png)

::: warning Read the skipped counters
"Not reconstructable" and "Payload budget reached" are not cosmetic. They mean your dataset is a biased
subset of your traffic. Report them alongside any result you publish.
:::

## Act 5 — Make it repeatable, and establish a baseline

**Evaluations** → **New target** (Kind = Model, pick the model) → **New suite** (target + the snapshot
dataset + scorers) → run it.

![Evaluations](/screenshots/how-to/optimize/10-evaluations.png)

Run the incumbent model **against its own recorded answers** first. This is your control, and it is the
step people skip.

::: danger Your control run tells you how much of your dataset is actually measurable
On the demo dataset the control scored **0.602**. That is not a quality problem — 112 of the 186 items
carry a reference answer, and the control passed every single one of them. `112 / 186 = 0.602`.

The other 74 items are turns where production answered with a *tool call*, not text. They have no
reference answer, so a similarity scorer scores them zero no matter which model you run.

If you had not run the control, you would have read 0.602 as "the model is 60% correct" and every
comparison after it would have been nonsense.
:::

Pick the scorer that matches what the item contains:

| Scorer | Grades | Needs |
|---|---|---|
| `semantic` | How close the answer is to the recorded one | An embedding model |
| `tool-call` | Whether the right tools were called, in order, with the right arguments | Nothing |
| `assertion` | Explicit checks you wrote | Assertions on the items |
| `llm-judge` | A rubric | A judge model |

::: warning An assertion scorer with no assertions reports a pass
Snapshot items carry no assertions. Point an `assertion` scorer at them and every item returns
`passed: true, score: 1` — a 100% pass rate that measured nothing. The first comparison run for this
guide did exactly that and reported two models as identical. They are not.
:::

## Act 6 — Compare models, honestly

One target per candidate, one suite per target, **the same dataset**, then read
**Evaluations → Runs**.

![Evaluation runs](/screenshots/how-to/optimize/14-runs.png)

The demo comparison, graded on answer similarity against what the default model actually returned:

| Model | Pass rate | Avg score | Avg latency | Cost |
|---|---|---|---|---|
| Default (Small) — control | **0.602** | 0.601 | 427 ms | $0.0336 |
| Candidate (Mini) | **0.113** | 0.435 | 214 ms | $0.0060 |
| Premium (Large) | 0.102 | 0.488 | 1,466 ms | $0.3548 |

Mini is 82% cheaper and twice as fast. It is also *wrong*: of the 112 gradeable items, only 21 answers
stayed close to what production returned. The cheap model changes roughly eight answers in ten.

This is the point of the whole exercise. The naive comparison — the one with the empty assertion
scorer — said "identical quality, 82% cheaper" and would have shipped a regression to every customer.
The measured comparison stopped it.

**The rule: never switch a model on price alone. Switch on pass-rate parity at a lower cost, measured on
your own traffic.**

::: info About these numbers
They come from a synthetic demo tenant whose upstream is a local stand-in, deliberately configured so the
cheaper tier answers more tersely. They are not a claim about any real model. The *method* is what
transfers — run it on your own traffic and your own candidates.
:::

Note also that evaluation runs deliberately do **not** write usage or spend logs. Testing twenty models
will not pollute your production cost reports; the per-run cost above is computed by the run itself.

## Act 7 — Cut the tokens

Four levers, in descending order of payoff.

### 1. Shrink the tool menu

Tool definitions are re-sent on every model call. Most agents carry tools they rarely or never use.

Disable them per tool on the MCP server's **Tools** tab, and in the agent's tool selection. Then re-check
**Tool menu / call** and **Input tokens / AI call** on the Analysis screen — the drop is immediate and
measurable.

### 2. Trim the system prompt

Work the **System prompt checks** table top to bottom. Start with any **fail**. Moving one timestamp out
of the prefix is worth more than any amount of word-trimming, because it restores prompt caching.

### 3. Kill repeated tool calls

The **Repeated tool calls** table gives you the tool, the exact arguments and the worst session. This is
almost always a loop bug — the result is not being fed back — and fixing it removes both the tool latency
and a model turn.

### 4. Cache and route

Enable **semantic cache** on the model for traffic with repeated questions, and split cheap from expensive
work with a [Dynamic LLM](/how-to/route-with-dynamic-llm).

::: warning What the cache does to your charts
A semantic-cache hit logs empty usage. Cached traffic disappears from your token and spend charts except
for the cache-hit counter, so your "savings" chart and your "traffic" chart will disagree. That is by
design, but it surprises everyone the first time.

The cache is also inert for streaming requests, and entries are partitioned by a hash of the resolved
model settings — changing a sampling parameter invalidates the whole cache for that model.
:::

## Act 8 — Prove it

Re-run the **identical** suite against the **same** dataset.

- Pass rate and average score versus your baseline run — did quality hold?
- **Cost & Optimization → Reports** over the same window — did spend actually fall?

![Cost reports](/screenshots/how-to/optimize/04-cost-reports.png)

A change that improves cost and holds pass rate is a result. A change that improves cost and drops pass
rate is a decision, and it needs a person to make it — which is exactly why you measured.

## Things that will bite you

| | |
|---|---|
| Pricing is not retroactive | Entering a price today does not price yesterday's traffic |
| Gateway logs carry no tool definitions | Gateway-sourced dataset items have no tool menu; only the tracing source can carry one |
| Tool-call turns have no reference answer | Grade them with the `tool-call` scorer, not a similarity scorer |
| An assertion scorer with no assertions passes | It reports 100% and measures nothing |
| Non-canonical event types | The timeline renders; every insight comes back empty |
| Semantic cache hits log no usage | Savings and traffic charts will disagree |
| A Dynamic LLM prices at zero | Cost is attributed to the child model, not the router |

## Where to go next

- [Build a dataset from production traffic](/how-to/dataset-from-production-traffic) — the snapshot and
  import wizards in full
- [Route requests with a Dynamic LLM](/how-to/route-with-dynamic-llm) — splitting cheap from expensive
- [Agent Tracing](/guide/tracing) — the trace data model
- [Evaluation & Analysis](/guide/evaluation-and-analysis) — scorers, suites and runs in detail
