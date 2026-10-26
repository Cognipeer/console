# Evaluation & Analysis

Two related "operate" services for measuring AI quality offline:

- **Evaluation** — regression-test a model or agent against a fixed dataset with
  deterministic and LLM-judge scorers. Answers *"did this change make the model
  better or worse?"*
- **Analysis** — extract structured fields from real conversations, judge their
  quality, and score extraction accuracy against ground truth — on demand or on
  a nightly schedule. Answers *"what is happening across yesterday's calls, and
  is quality holding?"*

They are independent services that share the same architectural shape and plug
into the same alerting pipeline.

**Evaluation** lives under **Operate → Evaluations**, organised into Targets, Datasets, Suites, and Runs:

![Evaluations](/screenshots/evaluation/01-evaluations.png)

**Analysis** lives under **Operate → Analysis**, organised into Definitions, Conversations, and Runs:

![Conversation Analysis](/screenshots/evaluation/02-analysis.png)

Both screens above show the empty state of a fresh project; the primary button (**New target** / **New definition**) bootstraps the first object.

## Architecture

Both services are built in the same four layers, each independently testable:

```
┌─ Dashboard UI ──────────────  /dashboard/evaluations, /dashboard/analysis
│   tabbed pages, create modals, run viewers
├─ REST API (Fastify plugin) ──  /api/evaluation/*, /api/analysis/*
│   validation, session + project scope
├─ Service ────────────────────  src/lib/services/{evaluation,analysis}/service.ts
│   tenant-scoped CRUD + run orchestration + live model adapters
└─ Engine core (pure, DI) ─────  runner / scorers / extraction / judge / accuracy
    no DB, queue, or model-runtime imports — the model is injected
```

The **engine core** is deliberately free of platform coupling: the model call is
passed in as an `invoker` function. This keeps scoring logic unit-testable
without a database or live model, and lets the service layer inject either the
real `handleChatCompletion` adapter or a fake in tests.

## Evaluation

### Data model

| Entity | Purpose |
|---|---|
| Target | What is under test: a `model`, `agent`, or `external` endpoint. |
| Dataset | Ordered test items: `input` messages + optional `expected`. |
| Suite | Binds a target + dataset + `scorers[]` (+ `judgeModelKey`). |
| Run | One execution of a suite: per-item scores + an aggregate. |

### Scorers

- **assertion** — deterministic checks against `expected`: `mustContain`,
  `equals`, `regex`, `jsonSchema`, `jsonPath`.
- **llm-judge** — an LLM grades the output against a `rubric`, normalised to
  0–1, backed by the suite's `judgeModelKey`.

Per-item `score` is the weighted mean of the scorers; the item `passed` when all
scorers pass. The run aggregate exposes `passRate`, `avgScore`, `avgLatencyMs`.

### Walkthrough

1. **Targets → New target** — pick `model` and a registered model key.
2. **Datasets → New dataset** — paste a JSON array of items.
3. **Suites → New suite** — choose the target and dataset, enable assertion
   and/or LLM-judge (with a rubric and judge model).
4. **Run** from the suite row → the run viewer shows pass/fail, score, the
   per-scorer breakdown, and the model output for each item.

> Model and agent targets are live. External targets can be created now; they are
> recorded as per-item errors until their adapter ships, so a run never aborts
> midway. A test of an agent can run its published version, a chosen version or its
> draft: see [Choosing the agent version for a test](#choosing-the-agent-version-for-a-test).

## Choosing the agent version for a test

An agent has a **draft**, the configuration you save in Studio, and **published
versions**, immutable snapshots of it (see
the [Agents API](/api/agents)). A test of
an agent can run any of them. This applies to an Evaluation suite on an **agent
target** and to a Red Team scan of an **agent campaign**; targets of any other kind,
and model campaigns, have no version.

| Version | What the test runs |
|---|---|
| **Published** (default) | The version that is published when the run starts. While nothing is published yet it runs the draft, as `POST /agents/responses` does, and the run says so |
| A version, for example `v3` | That published version, also after a newer one is published |
| **Draft** | The saved draft, to check a change before you publish it |

Typical uses: leave the default on **Published** for a suite or a campaign that
guards what is live; run once on the **Draft** before you publish a change; run the
same suite on `v3` and then on `v4`, and compare the two runs.

### The default of a target or a campaign

The target or the campaign keeps a default version, used by every run that does not
ask for another one. Choose it in the **Version** field, after the agent, of the
target form (**Operate → Evaluations → Targets**) or of the campaign form
(**Operate → Red Team → Campaigns**). Choosing another agent puts the field back on
**Published**, because a version number only means something for the agent it came
from; an API call that changes the agent without naming a version does the same. A target or a campaign that already exists keeps what it had: a pinned version
stays pinned, and the others follow the published version.

### Run once on another version

| Where | How |
|---|---|
| **Evaluations** | On the suite page, the arrow beside **Run now** opens **Run once on…**: **Published version**, **Draft** and the agent's versions (the newest 100). **Run now** and the **Run** action of the Suites list use the target's default. The arrow is shown for agent targets only |
| **Red Team** | **Run scan** opens the **Start scan** dialog, whose **Agent version** field offers **Campaign default**, **Published**, **Draft** and the agent's versions (the newest 100) |
| **API** | The optional `agentVersion` body field, or `agent_version` on the client API: [Evaluation API](/api/evaluation#run-a-suite) and its [client API](/api/evaluation#client-api-token-authenticated), [Red Team API](/api/redteam#launch-a-scan) |

The choice applies to that run only; the stored default does not change. A version
the agent never had is refused before any run exists, and so is a version asked for
a target or a campaign that is not an agent.

### What a run records

A run records which configuration answered, not only what it asked for:

| Asked for | Recorded |
|---|---|
| **Published** | The number that was published when the run started. Every item runs that one snapshot, even if someone publishes halfway through. With nothing published, the draft, shown as `draft (nothing published)` |
| A version | That version |
| **Draft** | `draft`, with a fingerprint of the draft configuration (a short hash), so two draft runs can be told apart |

The draft is read afresh for every item. If it is saved while a run on the draft is
going, the later items may have run another configuration. The run is then flagged
**The draft changed during this run** (**this scan** in Red Team) and its version tag
carries a warning icon; run it again to get a result for one configuration. A
version never changes under a run.

The version is shown next to the agent's name wherever a test shows one: on the
target and the campaign (their default), on the suite, in the **Agent** column of the
runs and scans lists, on the run and scan pages, and in the comparison, which names
the version of the baseline and of the run (and both agents, when the target was
pointed at another agent between the two). Beside a run the name is the agent that run
tested, even if its target has been pointed at another agent since. Beside a default the tag reads
`published`, `v3` or `draft`. Beside a run it reads the version that answered, `v4` or
`draft`, and `published` only until the run has started; hovering it says how the run
got there: `v4 (published)`, `v3`, `draft (nothing published)` or
`draft · 3f2a9c1b04de`.

A run on the draft is an ordinary completed run for the alert metrics
(`evaluation_pass_rate`, `redteam_resilience_score` and the others), which average the
completed runs of their window, and for the Red Team **Overview**, which adds up the
latest completed scans. Only the EU AI Act compliance report leaves draft scans out
(below).

### Runs at the same time

The same suite or campaign cannot run twice at once on the same version: the second
start is refused as *already in progress*, naming the version. Runs on different
versions can run side by side, for example the draft and the published version of one
suite. Versions are compared as they were asked for, so `published` and `v3` count as
different even when version 3 is the published one. A model target still allows one
run at a time.

### Red Team: schedules and the compliance report

- **A scheduled campaign cannot default to the draft.** A scan on a schedule runs
  unattended and guards what is live, so a campaign with an enabled schedule must
  follow **Published** or a version. Saving such a campaign on the draft is refused
  with `400`, so is switching a schedule on for a campaign that defaults to the draft,
  and the scheduler skips a campaign that got there some other way. A scan started by
  hand can still pick the draft.
- **The EU AI Act compliance report leaves out draft scans.** A scan that asked for the draft
  shows how a candidate holds up, not the system in service, so
  `GET /api/redteam/compliance/report` skips it and adds a line to the report's
  disclaimers with how many it left out. Every other scan stays in, and each evidence
  sample of an agent scan carries the version that answered (`agentVersion`, `null`
  when the draft did).

### Who can run an agent test

Running an agent test needs **Write on Agents** as well as Evaluations or Red Team,
whichever version it runs, the draft included: a test drives the agent the way chat
does, with its tools, its knowledge and its guardrails. Creating or changing an agent
target or an agent campaign needs it too, because a saved campaign can run the
agent later, unattended, on its schedule; targets follow the same rule.

- In the console, **Run now**, **Run**, **Run scan** and **Start scan** are switched
  off for someone without it, with the hint *Running an agent test needs Write access
  to Agents*, and so is saving an agent target or an agent campaign.
- Through the API the call is refused with `403` before any run is created. The body
  names `service: "agents"` and `required: "write"`. For an API token, the token's
  owner must hold the level and, if the token has a scope, the scope must include
  `agents` at `write`.
- A run is checked when it is started, for the target its suite names then. If the
  suite is pointed at another target while the run waits in the queue, the run stops
  with *start the run again*, so it never tests a target it was not checked for.
- Nothing changes for viewing targets, campaigns, runs and results, for deleting them,
  for editing suites, datasets and custom probes, or for tests of a model, a Knowledge
  Engine module or an external endpoint: those need Evaluations or Red Team only.

[Authorization](/guide/authorization#calls-that-need-a-second-service)
lists this with the other calls that need a second service.

## Analysis

### Data model

| Entity | Purpose |
|---|---|
| Definition | The recipe: `fieldSet`, extraction prompt, `modes`, models, optional `schedule`. |
| Conversation | An ingested transcript (`{ role, content }[]`) with optional `referenceFields`. |
| Run | One execution of a definition over a set of conversations + an aggregate. |

### The four modes

| Mode | Effect |
|---|---|
| **extract** | Always on. Pulls the `fieldSet` from each transcript as typed JSON; each field is coerced to its declared type (`string`/`number`/`boolean`/`enum`) and required fields are validated. |
| **store** | Writes the extracted fields back onto the conversation (`extractedFields`, `lastAnalyzedAt`) so they can be browsed and queried later. |
| **judge** | An LLM grades each conversation against a rubric (0–1). |
| **accuracy** | Compares extracted fields to the conversation's `referenceFields`, per field, returning a 0–1 score and a per-field match map. |

The aggregate exposes `passRate` (extraction success + judge pass), plus
`avgJudgeScore` and `avgExtractionAccuracy` (averaged only over items that used
those modes).

### Walkthrough

1. **Definitions → New definition** — build the field-set (key/type/required,
   enum values), choose modes, set the extraction model (and judge model +
   rubric if judging). Optionally set a cron `schedule`.
2. **Conversations → Ingest** — paste a JSON array of transcripts. Add
   `referenceFields` to any conversation you want to score for accuracy.
3. **Run analysis** from a definition row → the run viewer shows the extracted
   fields, judge score, and accuracy per conversation.

## Automation

The IVR use case — *"every night, analyze the day's calls and alert me if quality
drops"* — is covered by two independent, composable mechanisms.

### Scheduled runs

A definition with `schedule: { cron, enabled }` is fired automatically by the
background **analysis scheduler**:

- The scheduler runs on a 60s interval, guarded by a distributed lock (use
  `CACHE_PROVIDER=redis` for multi-instance deployments) so a single instance
  fires each tick. It is started from the server bootstrap.
- For each tenant it loads scheduled definitions and fires any that are **due**.
  "Due" is decided by the pure `schedulePlanner`: a cron slot fires at most once,
  compared against the definition's most recent run. So `0 2 * * *` runs once
  per night even though the scheduler ticks every minute.
- Scheduled runs analyze the recent conversation corpus with `createdBy:
  "system"`.

Cron expressions are standard 5-field, evaluated in **UTC**. Set the schedule via
the definition create/update API (`schedule`) or the dashboard.

### Threshold alerts

Both services expose their run aggregates to the existing alert pipeline as
metric collectors — no new alert logic is involved. Create an alert rule (in the
Alerts service) on the `analysis` or `evaluation` module:

| Module | Metric | Meaning (0–100) |
|---|---|---|
| `analysis` | `analysis_pass_rate` | Mean pass rate over completed runs in the window. |
| `analysis` | `analysis_avg_judge_score` | Mean judge score. |
| `analysis` | `analysis_avg_accuracy` | Mean extraction accuracy. |
| `evaluation` | `evaluation_pass_rate` | Mean pass rate. |
| `evaluation` | `evaluation_avg_score` | Mean weighted score. |

The collectors average the persisted run aggregate over completed runs in the
rule's window (excluding runs where the metric is null), honouring the project
scope. The existing alert scheduler/evaluator then applies the rule's condition
and fires through its channels.

**Putting it together:** a definition scheduled at `0 2 * * *` plus an alert rule
`analysis_avg_accuracy lt 85 over 1440 minutes` gives you a nightly analysis that
pages you when extraction quality slips below 85%.

## Multi-tenancy & persistence

Every entity is tenant-scoped and persisted through the dual-provider database
layer (MongoDB documents or SQLite JSON columns) with full parity. Dataset
items live in their own `evaluation_dataset_items` collection/table (one
document/row per item, ordered by position, unique per `(dataset, item id)`) —
the dataset record carries only a denormalised `itemCount`, so a dataset is no
longer bounded by a single 16MB document and item pages load without shipping
the whole set. Datasets created before the split are served transparently and
migrated on their first item write. Runs embed their per-item results and
aggregate. Reads and writes always go through `switchToTenant`, so one tenant
never sees another's targets, datasets, conversations, or runs.

## Where things live

| Area | Path |
|---|---|
| Evaluation engine | `src/lib/services/evaluation/` |
| Analysis engine | `src/lib/services/analysis/` |
| Schedule planner | `src/lib/services/analysis/schedulePlanner.ts` |
| Analysis scheduler | `src/lib/services/analysis/analysisScheduler.ts` |
| Alert collectors | `src/lib/services/alerts/metrics/{analysis,evaluation}Collector.ts` |
| DB mixins | `src/lib/database/{mongodb,sqlite}/{evaluation,analysis}.mixin.ts` |
| API plugins | `src/server/api/plugins/{evaluations,analysis}.ts` |
| Dashboard UI | `src/app/dashboard/{evaluations,analysis}/` |

See the API references for [Evaluation](/api/evaluation) and
[Analysis](/api/analysis).
