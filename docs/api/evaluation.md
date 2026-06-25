# Evaluation API

Offline testing for models and agents. Define a **target** (what to test), a
**dataset** (the test cases), and a **suite** (binds a target + dataset + one or
more scorers), then **run** the suite to produce a scored result.

All endpoints are under `/api/evaluation/*` and are session-authenticated
(dashboard surface). Requests are tenant- and project-scoped from the session.

## Concepts

```
target   →  a model | agent | external endpoint under test
dataset  →  an ordered list of items { input messages, expected? }
suite    →  target + dataset + scorers[] (+ judge model)
run      →  one execution of a suite over its dataset, with aggregate + per-item scores
```

### Scorers

| Type | What it checks |
|---|---|
| `assertion` | Deterministic checks against `expected`: `mustContain`, `equals`, `regex`, `jsonSchema`, `jsonPath`. |
| `llm-judge` | An LLM grades the output against a `rubric` (0–1), backed by `judgeModelKey`. |

A run's per-item `score` is the weighted mean of its scorer scores; `passed` is
true when every scorer passes. The aggregate reports `passRate`, `avgScore`, and
`avgLatencyMs`.

## Targets

```http
GET    /api/evaluation/targets?kind=model&search=gpt
POST   /api/evaluation/targets
GET    /api/evaluation/targets/:id
PATCH  /api/evaluation/targets/:id
DELETE /api/evaluation/targets/:id
```

### Create

```json
{
  "name": "GPT-4o production",
  "kind": "model",
  "modelKey": "gpt-4o"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Display name; `key` is slugified from it. |
| `kind` | `model \| agent \| external` | yes | `model` is live; `agent`/`external` are recorded as per-item errors until their adapters ship. |
| `modelKey` | string | for `model` | Registered model key. |
| `agentKey` | string | for `agent` | Registered agent key. |

## Datasets

```http
GET    /api/evaluation/datasets?search=faq
POST   /api/evaluation/datasets
GET    /api/evaluation/datasets/:id
PATCH  /api/evaluation/datasets/:id
DELETE /api/evaluation/datasets/:id
```

### Create

```json
{
  "name": "FAQ regression",
  "items": [
    {
      "id": "q1",
      "input": [{ "role": "user", "content": "What is 2+2?" }],
      "expected": { "mustContain": ["4"] }
    }
  ]
}
```

`items[].input` is an array of `{ role, content }` chat messages. `expected` is
optional and consumed by the assertion scorer.

## Suites

```http
GET    /api/evaluation/suites?search=faq
POST   /api/evaluation/suites
GET    /api/evaluation/suites/:id
PATCH  /api/evaluation/suites/:id
DELETE /api/evaluation/suites/:id
```

### Create

```json
{
  "name": "FAQ accuracy",
  "targetKey": "gpt-4o-production",
  "datasetKey": "faq-regression",
  "scorers": [
    { "type": "assertion" },
    { "type": "llm-judge", "rubric": "Answer is correct and concise." }
  ],
  "judgeModelKey": "gpt-4o"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `targetKey` / `datasetKey` | string | yes | Keys of an existing target and dataset. |
| `scorers` | array | yes | Non-empty; each `{ type, weight?, rubric?, threshold? }`. |
| `judgeModelKey` | string | when an `llm-judge` scorer is present | Model used for grading. |
| `runConfig.concurrency` | number | no | Parallel items per run. |

## Runs

### Run a suite

```http
POST /api/evaluation/suites/:key/run
```

This dashboard-surface run is **asynchronous**: it loads the suite, target, and
dataset, enqueues the run, and returns immediately with HTTP `202 Accepted` and a
`pending` run. The background worker then executes the target over every item
with bounded concurrency, scores each output, and persists the result. Poll
`GET /api/evaluation/runs/:id` to watch it finish.

> The token-authenticated client surface
> (`POST /api/client/v1/evaluation/suites/{key}/run`, below) stays
> **synchronous** and returns `201` with the completed run.

#### Response — `202 Accepted`

```json
{
  "run": {
    "id": "…",
    "suiteKey": "faq-accuracy",
    "status": "pending",
    "aggregate": null,
    "items": []
  }
}
```

Once completed, the run carries its aggregate and per-item scores:

```json
{
  "run": {
    "id": "…",
    "suiteKey": "faq-accuracy",
    "status": "completed",
    "aggregate": { "total": 12, "completed": 12, "failed": 0, "passed": 11, "passRate": 0.916, "avgScore": 0.94, "avgLatencyMs": 410 },
    "items": [
      { "itemId": "q1", "passed": true, "score": 1, "scores": [ { "scorerType": "assertion", "score": 1, "passed": true, "weight": 1 } ], "output": { "text": "4", "latencyMs": 380 } }
    ]
  }
}
```

A target/judge error on an item is recorded on that item (`error`) and counted
in `aggregate.failed`; it does not abort the run.

### Generate a dataset

```http
POST /api/evaluation/datasets/generate
```

Synthesizes dataset items (e.g. from a prompt or seed) and returns the generated
dataset.

### List / get runs

```http
GET /api/evaluation/runs?suiteKey=faq-accuracy&limit=50
GET /api/evaluation/runs/:id
```

### Compare runs

```http
GET /api/evaluation/runs/:id/compare?baseline=<runId>
```

Returns a per-item and aggregate diff between run `:id` and the `baseline` run,
for tracking regressions across runs of the same suite.

## Client API (token-authenticated)

For CI / automation there is a second, **API-token-authenticated** surface under
`/api/client/v1/evaluation/*`. Authenticate with `Authorization: Bearer <token>`
(create one in **Settings → API Tokens**); calls are scoped to the token's
project and gated by the `evaluations` permission. Fields are **snake_case**,
like the other client modules.

This surface is read- and trigger-oriented: you **discover** suites, **run** one,
and **read** results. Authoring targets, datasets and suites stays on the
session-authenticated dashboard surface above.

### List suites

```http
GET /api/client/v1/evaluation/suites
```

```json
{
  "suites": [
    {
      "key": "faq-accuracy",
      "name": "FAQ Accuracy",
      "target_key": "gpt-target",
      "dataset_key": "faq-set",
      "judge_model_key": "judge-1",
      "scorers": [{ "type": "assertion" }, { "type": "llm-judge", "rubric": "…" }],
      "created_at": "…"
    }
  ]
}
```

### Run a suite

Runs the suite synchronously over its dataset and returns the scored result. The
suite, its target and its dataset must already exist.

```http
POST /api/client/v1/evaluation/suites/{key}/run
```

```json
{
  "run": {
    "id": "run_abc123",
    "suite_key": "faq-accuracy",
    "target_key": "gpt-target",
    "dataset_key": "faq-set",
    "status": "completed",
    "aggregate": {
      "total": 24, "completed": 24, "failed": 0, "passed": 22,
      "pass_rate": 0.9167, "avg_score": 0.94, "avg_latency_ms": 812
    },
    "items": [
      {
        "item_id": "q1", "passed": true, "score": 1, "latency_ms": 640,
        "output_text": "…",
        "scores": [{ "scorer_type": "assertion", "score": 1, "passed": true, "weight": 1 }]
      }
    ],
    "started_at": "…", "finished_at": "…"
  }
}
```

### List / get runs

`/runs` returns summaries (aggregate only); fetch a single run by id for the
full per-item breakdown.

```http
GET /api/client/v1/evaluation/runs?suite_key=faq-accuracy&limit=20
GET /api/client/v1/evaluation/runs/{id}
```

### CI example

```js
const BASE = 'https://your-cognipeer-host';
const headers = { Authorization: `Bearer ${process.env.COGNIPEER_API_TOKEN}` };

const { run } = await fetch(
  `${BASE}/api/client/v1/evaluation/suites/faq-accuracy/run`,
  { method: 'POST', headers },
).then((r) => r.json());

if ((run.aggregate?.pass_rate ?? 0) < 0.9) {
  console.error(`Evaluation gate failed: ${run.aggregate.passed}/${run.aggregate.total}`);
  process.exit(1);
}
```

## Alerting

Run aggregates feed the alert system through the `evaluation` module:

| Metric | Source |
|---|---|
| `evaluation_pass_rate` | `aggregate.passRate` × 100, averaged over completed runs in the window. |
| `evaluation_avg_score` | `aggregate.avgScore` × 100, same. |

Create an alert rule (module `evaluation`) such as `evaluation_pass_rate lt 80`
to be notified when quality regresses. See the
[Evaluation & Analysis guide](/guide/evaluation-and-analysis#automation).

## Errors

| Status | Cause |
|---|---|
| 400 | Missing `name`, bad `kind`, empty `scorers`, non-array `items`. |
| 404 | Target / dataset / suite / run not found (or unknown `suiteKey` on run). |
| 500 | Internal error. |
