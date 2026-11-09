# Evaluation API

Offline testing for models and agents. Define a **target** (what to test), a
**dataset** (the test cases), and a **suite** (binds a target + dataset + one or
more scorers), then **run** the suite to produce a scored result.

All endpoints are under `/api/evaluation/*` and are session-authenticated
(dashboard surface). Requests are tenant- and project-scoped from the session.

Testing an agent also needs **write access to Agents**, on top of Evaluations:
running a suite whose target is an agent (any version, the draft included), and
creating or changing an agent target, are refused with `403` without it. See
[Who can run an agent test](/guide/evaluation-and-analysis#who-can-run-an-agent-test).

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

A run's per-item `score` is the weighted mean of the scorers that applied to the
item; `passed` is true when every applicable scorer passes. A scorer that does not
apply is `skipped`; a scorer that errors makes the item errored. See
[Item outcomes](#item-outcomes) and [Aggregate](#aggregate).

Every scorer config also accepts these optional fields:

| Field | Type | Notes |
|---|---|---|
| `weight` | number | Finite and `>= 0`; default `1`. |
| `threshold` | number | Finite, between 0 and 1. For `llm-judge`, the score at or above which the scorer passes (default `0.5`). |
| `applyWhen` | `"has-reference" \| "has-expected-tool-calls"` | Apply the scorer only to items that have a reference answer or expected tool calls. Otherwise it is skipped for that item. |
| `allowExtraCalls` | boolean | `tool-call` scorer. Default `true`; `false` fails the item when a call matches no expected call. |
| `strict` | boolean | `json-shape` scorer. Default `false`; `true` counts keys missing from the reference as problems. |

An invalid `weight` or `threshold` answers `400` and names the scorer by index.

#### LLM judge

The judge returns `{"score": <0..1>, "reasoning": "<short>"}`. `score` must be a
number from 0 to 1 (no rescaling); `passed` is `score >= threshold`, and a `passed`
sent by the judge is kept only as `detail.judgePassed`. An unparseable answer is
retried up to two more times, then the scorer errors. Retryable transport errors
(408, 429, 5xx, timeouts, connection resets) are retried twice, with a timeout of
`EVALUATION_JUDGE_TIMEOUT_MS` (default 120000). The judge sees the input, the
reference, the output, the assistant's tool calls and the expected tool calls; each
block is delimited with nonce tags and treated as data, never as instructions.

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
| `kind` | `model \| agent \| external` | yes | `model` and `agent` are live; `external` is recorded as per-item errors until its adapter ships. |
| `modelKey` | string | for `model` | Registered model key. |
| `agentKey` | string | for `agent` | Registered agent key. |
| `agentVersion` | `"published" \| "draft" \| integer \| null` | no | `agent` targets: the version of the agent a run tests by default. See [Agent versions](#agent-versions). Ignored on other kinds. |

### Agent versions

An agent target has a default version for its runs; a single run can ask for another
(see [Run a suite](#run-a-suite)).

| `agentVersion` | A run tests |
|---|---|
| absent, `null` or `"published"` | The version published when the run starts (the draft while nothing is published yet) |
| An integer `>= 1`, or digits in a string (`3`, `"3"`) | That published version |
| `"draft"` | The saved draft |

Anything else answers `400` with `agentVersion must be "published", "draft" or a
version number (1 or more)`. A target that follows the published version stores
nothing for it, so `agentVersion` is absent or `null` in its responses.

Creating an agent target needs write access to Agents (`403` otherwise).

### Update

```http
PATCH /api/evaluation/targets/:id
```

A `PATCH` changes only the fields it carries. A field left out keeps its value, and
`null` clears an optional one (`description`, `systemPrompt`, `maxTokens`, …). A
field that cannot be empty, such as `name`, answers `400` when it is sent blank.

For the version: `agentVersion: null` (or `"published"`) takes the pin off so the
target follows the published version again, `"draft"` or a number sets it, and
leaving the key out keeps what is there. A version number belongs to one agent, so
a `PATCH` that moves the target to another `agentKey` without an `agentVersion` puts
it back on the published version; send `agentVersion` with the new key to pin one.
Changing an agent target needs write access to Agents (`403` otherwise), whatever the
body changes; the stored kind decides, so a `PATCH` cannot turn a target into an agent
target.

## Datasets

```http
GET    /api/evaluation/datasets?search=faq
POST   /api/evaluation/datasets
GET    /api/evaluation/datasets/:id
PATCH  /api/evaluation/datasets/:id
DELETE /api/evaluation/datasets/:id
```

Dataset items are stored in their own collection (`evaluation_dataset_items`,
one document/row per item) — dataset responses carry an `itemCount` instead of
an inline `items` array, and items are read/written through the item endpoints
below. Deleting a dataset cascades to its items. A dataset that a suite in the
same project still uses cannot be deleted: the call answers `409` and names the
suites.

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
optional and consumed by the assertion scorer. The inline `items` array on
create (and a full-replace `items` array on `PATCH /:id`) is still accepted —
the server routes it into the item collection.

### Items

```http
GET    /api/evaluation/datasets/:id/items?limit=50&skip=0&search=refund
POST   /api/evaluation/datasets/:id/items
PATCH  /api/evaluation/datasets/:id/items/:itemId
DELETE /api/evaluation/datasets/:id/items/:itemId
```

- `GET …/items` returns `{ items, total }`, ordered by position; `limit` caps
  at 500. `search` filters by item id, input content, or tag (case-insensitive
  substring).
- `POST …/items` appends `{ "items": [ … ] }` after the current last item and
  returns `{ added, total }`. Item ids are unique per dataset — a duplicate id
  responds `409`.
- `PATCH …/items/:itemId` updates one item in place (`input`, `expected`,
  `tools`, `toolResults`, `tags`; the id itself is immutable). Passing `null`
  for an optional field clears it.
- All item routes are project-scoped: a dataset id from another project
  responds `404`.

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
| `scorers` | array | yes | Non-empty; each `{ type, weight?, rubric?, threshold?, applyWhen?, allowExtraCalls?, strict? }`. |
| `judgeModelKey` | string | when an `llm-judge` scorer is present | Model used for grading. |
| `runConfig.concurrency` | integer | no | Parallel items per run. Clamped to 1-32. |

Deleting a target answers `409` the same way while a suite still uses it, and
deleting a suite answers `409` while it has a `pending` or `running` run.

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
> (`POST /api/client/v1/evaluation/suites/{key}/run`, below) is **synchronous** by
> default and returns `201` with the completed run; send `wait: false` to get the
> asynchronous `202` behaviour there too.

A dataset with no items answers `400` (`Dataset "<key>" has no items to evaluate`)
and starts nothing. If the run cannot be queued, it is marked `failed` and the call
fails.

#### Request body

The body is optional. For an agent target it can name the version of the agent this
run tests, instead of the target's default:

```json
{ "agentVersion": "draft" }
```

| Field | Type | Notes |
|---|---|---|
| `agentVersion` | `"published" \| "draft" \| integer` | `"published"` follows the published version, `"draft"` tests the saved draft, an integer (or digits in a string, `"3"`) a published version. Leave it out, or send `null`, to use the target's default. Agent targets only. |

No body, `{}` and a literal `null` all mean no override. A body that is not a JSON
object, or an `agentVersion` that is none of the above, answers `400` and starts
nothing; so does an `agentVersion` sent for a target that is not an agent target.

Running a suite whose target is an agent needs write access to Agents. The call is
refused with `403` before any run is created, and before the answer says whether the
version exists:

```json
{
  "error": "Forbidden: agents requires write permission",
  "message": "Forbidden: agents requires write permission",
  "code": "forbidden",
  "service": "agents",
  "required": "write",
  "decisionId": "7c0f6b2e-5d1a-4c1e-9a53-0d9b8a1f2e44"
}
```

If the authorization engine cannot decide, the answer is `503` with
`code: "authorization_unavailable"` and a `Retry-After` header. See
[Decision ids](/guide/authorization#decision-ids).

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
    "aggregate": { "total": 12, "completed": 12, "failed": 0, "skipped": 0, "passed": 11, "passRate": 0.916, "avgScore": 0.94, "errorRate": 0, "avgLatencyMs": 410 },
    "items": [
      { "itemId": "q1", "passed": true, "score": 1, "scores": [ { "scorerType": "assertion", "score": 1, "passed": true, "weight": 1 } ], "output": { "text": "4", "latencyMs": 380 } }
    ]
  }
}
```

A target/judge error on an item is recorded on that item (`error`) and counted
in `aggregate.failed`; it does not abort the run.

#### Item outcomes

| Outcome | When | Counted as |
|---|---|---|
| Scored | At least one scorer applied and none errored | `completed`; `passed` when every applicable scorer passed |
| Errored | The target threw, or a scorer errored. A scorer error reads `Scoring failed — <type>: <message>` | `failed` |
| Skipped | No scorer applied to the item (`skipped: true`, `score: 0`, no `error`) | `completed` and `skipped` |

A skipped score has `skipped: true`, `score: 0`, `passed: false` and a `detail.reason`.
It is ignored when the item score is computed. Each score may carry `usage` (judge
spend), and the item carries `scoringUsage`, their sum.

#### Aggregate

| Field | Meaning |
|---|---|
| `total` | Items in the run. |
| `completed` | Items with no `error`, skipped ones included. |
| `failed` | Items with an `error`, from the target or from scoring. |
| `skipped` | Completed items where no scorer applied. |
| `passed` | Items that passed. |
| `passRate` | `passed / (completed - skipped)`. Errored and skipped items are not in it. |
| `avgScore` | Mean score over the same items. |
| `errorRate` | `failed / total`; `0` for an empty run. Runs recorded before it existed lack it: use `failed / total`. |
| `avgLatencyMs` | Mean over completed items. |
| `totalCostUsd`, `totalTokens` | Target spend only. |
| `scoringCostUsd`, `scoringTokens` | Judge spend, kept apart from the target spend; present only when a score reported usage. |
| `truncatedCount` | Completed items whose output was cut off (`output.truncated`). |
| `usageItems` | Items that reported usage; the divisor for per-item averages. |

#### Stored size

Stored items are bounded: `output.text` at 20,000 characters, `error` at 2,000,
score `detail` at about 4 KB, at most 32 tool calls per output or turn with `args`
over 4 KB replaced by `{ "__truncated": true, "preview": "..." }`. If the items of a
run are still too large, details are dropped step by step, and the run carries
`itemsTruncated: true`. The aggregate is always kept.

#### Multi-turn items

With `perTurn`, each user turn is run in order. Recorded tool exchanges are replayed
in place, and the model is called again after a trailing tool result. Output turns
are kept in `output.turns`, with `usage` per turn. For an **agent target**, the item's
earlier user and assistant text turns are given to the agent as conversation history
(recorded tool exchanges are not), and each item runs in its own conversation, which
is deleted once the item finishes.

#### Cancel a run

```http
POST /api/evaluation/runs/:id/cancel
```

| Run status | Result |
|---|---|
| `pending` | `200 { "run": ..., "outcome": "cancelled" }`. The run is `cancelled` at once. |
| `running` | `200 { "run": ..., "outcome": "cancel_requested" }`. `cancelRequestedAt` is set; no new items start, items in flight finish, and the run ends `cancelled` with the items processed so far. |
| `completed`, `failed`, `cancelled` | `409 { "error": "Run already finished", "run": ... }`. |

An unknown run, or one from another project, answers `404`.

A running run records a heartbeat (`heartbeatAt`). If the server restarts, or no
heartbeat arrives for `EVALUATION_RUN_STALE_MS` (default 10 minutes), the run is
marked `failed` with an explanatory `error`. A run that stays `pending` for more
than 24 hours is failed too.

#### Which version answered

A run of an agent target carries `agentRevision`: what it asked for, and, once it
starts, what answered. A run of any other target has none, and so does a run recorded
before agent versions existed.

```json
{
  "run": {
    "id": "…",
    "suiteKey": "support-agent-regression",
    "status": "completed",
    "agentRevision": { "requested": "published", "agentKey": "support-agent", "version": 4 }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `requested` | `"published" \| "draft" \| integer` | What the run asked for: the override, else the target's default. Set when the run is created, so a `pending` run has only this and `agentKey`. |
| `agentKey` | string | The agent the run tested. Kept with the run, so a run still names that agent after its target is pointed at another one. |
| `version` | integer \| `null` | The published version that answered. `null` when the draft answered, because it was asked for or because nothing is published yet. Absent until the run starts. |
| `draftFingerprint` | string | When the draft answered: a short hash of the draft configuration the run started on. |
| `draftChanged` | boolean | `true` when the draft was saved while the run was going, so later items may have run another configuration. Absent otherwise. |

`published` is turned into a number once, as the run starts, so every item runs one
snapshot even if a version is published halfway through. A version that was never
published answers `404`, and nothing is created.

A run tests the target its suite named when the run was created. If the suite is
pointed at another target while the run still waits in the queue, the run fails with
`Suite "…" now points at target "…", not at "…" this run was started for; start the run again`,
so a run never tests a target it was not checked for.

Only one run of a suite per agent version can be in progress: a second start of the
same version answers `409` (`A run for suite "…" is already in progress on draft`),
while a run of another version starts normally. Versions are compared as they were
asked for, so `"published"` and `3` differ even when version 3 is the published one.
A suite on a model target still allows one run at a time.

### Generate a dataset

```http
POST /api/evaluation/datasets/generate
```

Synthesizes dataset items (e.g. from a prompt or seed) and returns the generated
dataset.

Limits: `count` is an integer from 1 to 200, `maxChunks` an integer from 1 to 500,
and the source text or file is capped at 5 MB; values outside them answer `400`.
Generation counts against the evaluation quota like a run. If fewer items than
`count` could be generated, the dataset has a `metadata.generation.warning` string
saying so.

### List / get runs

```http
GET /api/evaluation/runs?suiteKey=faq-accuracy&limit=50&skip=0
GET /api/evaluation/runs/:id
```

`GET /runs` returns `{ "runs": [...], "total": 123 }`. The runs are summaries: the
aggregate and metadata, with `items` empty. Fetch one run by id for its items.
`limit` defaults to 50 (maximum 200) and `skip` to 0; a value that is not a number
answers `400`.

### Compare runs

```http
GET /api/evaluation/runs/:id/compare?baseline=<runId>
```

Returns a per-item and aggregate diff between run `:id` and the `baseline` run,
for tracking regressions across runs of the same suite. Both runs must be
`completed` and use the same dataset, otherwise the call answers `409`. An item that
errored or was skipped in either run has status `not_comparable` (counted in
`summary.not_comparable`); `regressed` and `fixed` are only reported between two
scored outcomes.

## Client API (token-authenticated)

For CI / automation there is a second, **API-token-authenticated** surface under
`/api/client/v1/evaluation/*`. Authenticate with `Authorization: Bearer <token>`
(create one in **Settings → API Tokens**); calls are scoped to the token's
project and gated by the `evaluations` permission. Running a suite whose target is
an agent also needs write access to Agents: the token's owner must hold it, and the
token's scope, if it has one, must include `agents` at `write`. Fields are
**snake_case**, like the other client modules.

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

Runs the suite over its dataset and returns the scored result. By default the call
waits for the run to finish. The suite, its target and its dataset must already
exist.

```http
POST /api/client/v1/evaluation/suites/{key}/run
```

#### Request body

The body is optional. For an agent target, `agent_version` picks the version of the
agent this run tests, instead of the target's default:

```json
{ "agent_version": "draft" }
```

| Field | Type | Notes |
|---|---|---|
| `agent_version` | `"published" \| "draft" \| integer` | `"published"` follows the published version, `"draft"` tests the saved draft, an integer (or digits in a string, `"3"`) a published version. Leave it out, or send `null`, to use the target's default. Agent targets only. |
| `wait` | boolean | Default `true`: the call returns `201` with the finished run. `false` queues the run and returns `202` with the `pending` run straight away; poll `GET /runs/{id}` until it ends. Same quota and agent authorisation either way. |

No body, `{}` and a literal `null` all mean no override. A body that is not a JSON
object, an invalid `agent_version`, or an `agent_version` sent for a target that is
not an agent target, answers `400` and runs nothing. A suite whose target is an
agent answers `403` (with `service: "agents"` and `required: "write"`) when the
token's owner lacks write access to Agents, for any version and before a run is
created; `503` with a `Retry-After` header when the authorization engine cannot
decide. An agent or a version that does not exist answers `404`. The run records
which version answered, as the [dashboard run](#which-version-answered) does. A suite
cannot run twice at once on the same version: the second call answers `409`
(`A run for suite "…" is already in progress on draft`), while a run of another version
starts normally.

#### Response — `201 Created` (`202 Accepted` with `wait: false`)

With `wait: false` the run has status `pending` and no aggregate yet. Otherwise:

```json
{
  "run": {
    "id": "run_abc123",
    "suite_key": "faq-accuracy",
    "target_key": "gpt-target",
    "dataset_key": "faq-set",
    "status": "completed",
    "aggregate": {
      "total": 24, "completed": 24, "failed": 0, "skipped": 0, "passed": 22,
      "pass_rate": 0.9167, "avg_score": 0.94, "error_rate": 0, "avg_latency_ms": 812
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

The run of an agent target also carries `agent_revision`, next to `target_key`:

```json
"agent_revision": { "requested": "draft", "version": null, "draft_fingerprint": "3f2a9c1b04de", "draft_changed": true }
```

| Field | Type | Notes |
|---|---|---|
| `requested` | `"published" \| "draft" \| integer` | What the run asked for: `agent_version`, else the target's default. |
| `version` | integer \| `null` | The published version that answered; `null` when the draft answered, because it was asked for or because nothing is published yet. |
| `draft_fingerprint` | string | When the draft answered: a short hash of the draft configuration the run started on. |
| `draft_changed` | boolean | `true` when the draft was saved while the run was going. Absent otherwise. |

The field is absent for any other kind of target, and on runs recorded before agent
versions existed.

The aggregate has the same fields as the [dashboard run](#aggregate) in snake_case
(`skipped`, `error_rate`, `scoring_cost_usd`, ...). `status` can also be `cancelled`.

### List / get runs

`/runs` returns summaries (aggregate only); fetch a single run by id for the
full per-item breakdown. Both carry `agent_revision` for an agent target (runs recorded
before agent versions existed have none).

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

const agg = run.aggregate;
// The pass rate leaves out errored and skipped items, so gate on the status and on
// the error rate too: a run where most items errored must not pass.
if (run.status !== 'completed' || !agg || (agg.error_rate ?? 0) > 0.05 || agg.pass_rate < 0.9) {
  console.error(`Evaluation gate failed: ${run.status}, ${agg?.passed}/${agg?.total} passed, ${agg?.failed} failed`);
  process.exit(1);
}
```

For a long suite, send `{ "wait": false }`, then poll `GET /runs/{id}` until `status`
is `completed`, `failed` or `cancelled` and apply the same checks.

To check a change before you publish it, run the suite on the saved draft and on the
published version. Runs of different versions can overlap, and each call returns when
its run is done:

```js
async function runSuite(agentVersion) {
  const res = await fetch(`${BASE}/api/client/v1/evaluation/suites/support-agent-regression/run`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_version: agentVersion }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${body.error}`);
  return body.run;
}

const [draft, live] = await Promise.all([runSuite('draft'), runSuite('published')]);

console.log(`draft ${draft.aggregate.pass_rate} vs v${live.agent_revision.version} ${live.aggregate.pass_rate}`);
if (draft.aggregate.pass_rate < live.aggregate.pass_rate) process.exit(1);
```

To compare against a fixed release instead of whatever is live, send a version number:
`{ "agent_version": 3 }`. The token's owner needs write access to Agents for both
runs (`403` otherwise).

## Alerting

Run aggregates feed the alert system through the `evaluation` module:

| Metric | Source |
|---|---|
| `evaluation_pass_rate` | `aggregate.passRate` × 100, averaged over completed runs in the window. |
| `evaluation_avg_score` | `aggregate.avgScore` × 100, same. |
| `evaluation_error_rate` | `aggregate.errorRate` × 100, same. Runs without `errorRate` use `failed / total`. |

Pass rate and average score leave out errored and skipped items, so use
`evaluation_error_rate` to catch runs where items fail to execute or to score.

A run on the draft or on an older version counts like any other completed run.

Create an alert rule (module `evaluation`) such as `evaluation_pass_rate lt 80`
to be notified when quality regresses. See the
[Evaluation & Analysis guide](/guide/evaluation-and-analysis#automation).

## Errors

| Status | Cause |
|---|---|
| 400 | Missing `name`, bad `kind`, empty `scorers`, non-array `items`, a scorer `weight` or `threshold` out of range, a non-numeric `limit`/`skip`, generation limits exceeded, malformed dataset items, a dataset with no items on run. On a run: an `agentVersion` (`agent_version` on the client API) that is not `"published"`, `"draft"` or a version number, a body that is not a JSON object, or a version asked for a target that is not an agent target. |
| 403 | Write access to Agents is missing: running a suite on an agent target, or creating or changing an agent target. The body has `code: "forbidden"`, `service: "agents"` and `required: "write"`. |
| 404 | Target / dataset / suite / run not found (or unknown `suiteKey` on run). On a run of an agent target: an agent, or a version of it, that does not exist. |
| 409 | A run of the suite on the same agent version is already in progress; a dataset item id already exists; deleting a target or dataset that a suite uses, or a suite with an active run; cancelling a run that already finished; comparing runs that are not completed or use different datasets. |
| 500 | Internal error. |
| 503 | The authorization engine could not decide (`code: "authorization_unavailable"`); retry after the `Retry-After` header. |
