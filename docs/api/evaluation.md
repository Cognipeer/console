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
below. Deleting a dataset cascades to its items.

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
    "aggregate": { "total": 12, "completed": 12, "failed": 0, "passed": 11, "passRate": 0.916, "avgScore": 0.94, "avgLatencyMs": 410 },
    "items": [
      { "itemId": "q1", "passed": true, "score": 1, "scores": [ { "scorerType": "assertion", "score": 1, "passed": true, "weight": 1 } ], "output": { "text": "4", "latencyMs": 380 } }
    ]
  }
}
```

A target/judge error on an item is recorded on that item (`error`) and counted
in `aggregate.failed`; it does not abort the run.

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

Runs the suite synchronously over its dataset and returns the scored result. The
suite, its target and its dataset must already exist.

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

#### Response — `201 Created`

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

if ((run.aggregate?.pass_rate ?? 0) < 0.9) {
  console.error(`Evaluation gate failed: ${run.aggregate.passed}/${run.aggregate.total}`);
  process.exit(1);
}
```

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

A run on the draft or on an older version counts like any other completed run.

Create an alert rule (module `evaluation`) such as `evaluation_pass_rate lt 80`
to be notified when quality regresses. See the
[Evaluation & Analysis guide](/guide/evaluation-and-analysis#automation).

## Errors

| Status | Cause |
|---|---|
| 400 | Missing `name`, bad `kind`, empty `scorers`, non-array `items`. On a run: an `agentVersion` (`agent_version` on the client API) that is not `"published"`, `"draft"` or a version number, a body that is not a JSON object, or a version asked for a target that is not an agent target. |
| 403 | Write access to Agents is missing: running a suite on an agent target, or creating or changing an agent target. The body has `code: "forbidden"`, `service: "agents"` and `required: "write"`. |
| 404 | Target / dataset / suite / run not found (or unknown `suiteKey` on run). On a run of an agent target: an agent, or a version of it, that does not exist. |
| 409 | A run of the suite on the same agent version is already in progress; a dataset item id already exists. |
| 500 | Internal error. |
| 503 | The authorization engine could not decide (`code: "authorization_unavailable"`); retry after the `Retry-After` header. |
