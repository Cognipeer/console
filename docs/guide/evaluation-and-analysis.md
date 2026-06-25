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

> Model targets are live today. Agent and external targets can be created now;
> their execution adapters are recorded as per-item errors until they ship, so a
> run never aborts midway.

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
layer (MongoDB documents or SQLite JSON columns) with full parity. Runs embed
their per-item results and aggregate. Reads and writes always go through
`switchToTenant`, so one tenant never sees another's targets, datasets,
conversations, or runs.

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
