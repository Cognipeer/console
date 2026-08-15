# Cost & Prescriptions API

The cost surfaces are **dashboard routes**, not client-API routes. Every other
page in this section documents `/api/client/v1` and a `cpeer_` bearer token;
these endpoints live directly under `/api` and are authenticated with the
browser session that the console UI already holds. A `cpeer_` token cannot
drive them.

| Route group | Backs | Edition |
|---|---|---|
| `/api/cost/*` | Model costs, Agent costs, Analysis, Pricing, Reports | **Enterprise** |
| `/api/prescriptions/*` | Prescriptions (automated reports) | **Enterprise** |
| `/api/abacus/*` | Recommendations, Parity tests, Model matrix | **Enterprise** |
| `/api/model-price-catalog*` | Market reference prices behind the Pricing page and the Model Hub | Community |

Cost & Optimization is an enterprise module in its entirety. The one exception
is the market price catalog: it also feeds the Model Hub, which is community, so
that route is not gated.

For the screens these endpoints back, see
[Cost & Optimization](/guide/cost-optimization). For the spend report that
*is* available to API tokens, see [Spend & Budgets](/api/spend).

## Authentication and scope

Requests carry the console session cookie. Tenant and project are resolved
server-side: the tenant comes from the session, the project from the
`active_project_id` cookie. There is no way to pass a project id in the
request.

RBAC maps the prefixes to two services:

| Prefix | RBAC service | Label |
|---|---|---|
| `/api/cost`, `/api/model-price-catalog`, `/api/prescriptions` | `cost` | Cost Management |
| `/api/abacus` | `abacus` | Abacus |

Both service groups are additionally gated per tenant by the enterprise access
rules — `/api/cost/` and `/api/prescriptions` under the `cost` module,
`/api/abacus/` under `abacus`. Without an active ENTERPRISE licence every route
answers **402**, naming the module it needs:

```json
{
  "error": "Payment Required",
  "message": "The \"abacus\" module requires an active ENTERPRISE license.",
  "module": "abacus",
  "requiresEnterprise": true
}
```

`/api/model-price-catalog*` is not gated — it backs the Model Hub as well.

Errors elsewhere are plain `{ "error": "…" }` bodies: 400 for invalid input,
404 for a missing record, 500 for an unexpected failure. The model price
catalog adds 502 when the upstream feed cannot be fetched.

### `scope=all`

Every `GET /api/cost/*` overview accepts `scope=all`, which widens the query
from the active project to all projects in the tenant (the "total" view).
`POST /api/cost/pricing/reprice` accepts the same flag in its body. The
pricing list, upsert and delete endpoints always work in the active project's
scope — `scope` on `PUT /api/cost/pricing` means something different (see
below).

## Cost

Spend is read from the `usage_daily` rollup for the models service, so it
covers gateway traffic (`source: "api"`) and observability-derived traffic
(`source: "tracing"`) alike. Each observed model resolves to one of three
pricing states:

| `status` | Meaning |
|---|---|
| `hub` | A Model Hub model, priced by the hub |
| `external` | Priced by the tenant's external pricing catalog |
| `unpriced` | Usage recorded with cost `0` |

The governing rule for pricing, stated in `costService.ts`: entering a price
prices ingests **from then on**. Recorded history is not rewritten — use
`POST /api/cost/pricing/reprice` to recompute it deliberately.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cost/models` | Observed models with pricing status |
| `GET` | `/api/cost/agents` | Per-agent spend with a per-model split |
| `GET` | `/api/cost/pricing/catalog` | Unified hub + external + observed catalog |
| `GET` | `/api/cost/reports` | Daily / weekly / monthly spend series |
| `GET` | `/api/cost/pricing` | External pricing entries |
| `PUT` | `/api/cost/pricing` | Upsert one effective-dated entry |
| `POST` | `/api/cost/pricing/reprice` | Recompute recorded spend for one model |
| `DELETE` | `/api/cost/pricing/:modelName` | Remove one entry |

### Observed models

```http
GET /api/cost/models?from=2026-07-01&to=2026-08-01&scope=all
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `from` | ISO date | none | Unparseable values are ignored, not rejected |
| `to` | ISO date | none | Same |
| `scope` | `all` | active project | `all` aggregates across projects |

Response:

| Field | Notes |
|---|---|
| `fromDay`, `toDay` | UTC days (`YYYY-MM-DD`) echoed from `from` / `to`; absent when the request set no bound |
| `totals.requests`, `totals.totalTokens`, `totals.costUsd` | Window totals |
| `totals.unpricedTokens`, `totals.unpricedModels` | Token volume and model count recorded with no pricing |
| `entries[]` | One row per observed model, cost descending |

Each entry carries `modelKey`, `modelName`, `status`, `providerKey`,
`requests`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `totalTokens`,
`costUsd`, `modelCalls` (trace model-call count), `costBySource` (spend keyed
by rollup source) and `pricing` when the model is priced.

```json
{
  "fromDay": "2026-07-01",
  "toDay": "2026-08-01",
  "totals": {
    "requests": 48210,
    "totalTokens": 91400000,
    "costUsd": 812.44,
    "unpricedTokens": 3100000,
    "unpricedModels": 2
  },
  "entries": [
    {
      "modelKey": "gpt-4o",
      "modelName": "GPT-4o",
      "status": "hub",
      "providerKey": "openai",
      "requests": 31200,
      "inputTokens": 61000000,
      "outputTokens": 9400000,
      "cachedInputTokens": 24000000,
      "totalTokens": 70400000,
      "costUsd": 690.12,
      "costBySource": { "api": 402.55, "tracing": 287.57 },
      "modelCalls": 33110,
      "pricing": { "currency": "USD", "inputTokenPer1M": 2.5, "outputTokenPer1M": 10, "cachedTokenPer1M": 1.25 }
    }
  ]
}
```

### Agent costs

```http
GET /api/cost/agents?from=2026-07-01&to=2026-08-01
```

Same three query parameters. Rows are grouped by the rollup's `agentKey`;
`agentKey` is `""` for usage with no agent attribution (gateway calls).

| Field | Notes |
|---|---|
| `totals` | `requests`, `totalTokens`, `costUsd` |
| `entries[].agentKey` | Tracing agent name, or `""` |
| `entries[].requests`, `.modelCalls`, `.inputTokens`, `.outputTokens`, `.totalTokens`, `.costUsd` | Per-agent figures |
| `entries[].models[]` | Per-model split (`modelKey`, `status`, `requests`, `totalTokens`, `costUsd`), cost descending |
| `entries[].hasUnpricedUsage` | `true` when any of the agent's models is unpriced — the agent's cost reads low |

### Pricing catalog

```http
GET /api/cost/pricing/catalog?from=2026-07-01&to=2026-08-01&scope=all
```

Merges three sources case-insensitively: every Model Hub model in scope, every
external pricing entry, and every model observed in usage in the range. Hub
status always wins a collision; a project-scoped external entry overrides a
tenant-wide one with the same name.

| Field | Notes |
|---|---|
| `totals` | `models`, `hub`, `external`, `unpriced` counts |
| `entries[].status` | `hub` \| `external` \| `unpriced` |
| `entries[].entryScope` | `project` or `tenant`, external entries only |
| `entries[].pricing` | Price effective today |
| `entries[].versions[]` | Effective-dated history, external entries only |
| `entries[].observed` | `true` when the model appeared in usage in the range |
| `entries[].requests`, `.totalTokens`, `.costUsd`, `.modelCalls`, `.lastUsedDay` | Observed volume |

### Spend reports

```http
GET /api/cost/reports?granularity=weekly&from=2026-06-01&to=2026-08-01
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `granularity` | `daily` \| `weekly` \| `monthly` | `daily` | Any other value falls back to `daily` |
| `from`, `to` | ISO date | none | |
| `scope` | `all` | active project | |

| Field | Notes |
|---|---|
| `granularity`, `fromDay`, `toDay` | Echo of the resolved window |
| `totals` | `requests`, `totalTokens`, `costUsd` |
| `series[]` | `bucket` (`YYYY-MM-DD` for daily, the week's Monday for weekly, `YYYY-MM` for monthly), `requests`, `errors`, `totalTokens`, `costUsd` |
| `topModels[]` | The ten costliest models: `modelKey`, `requests`, `totalTokens`, `costUsd` |
| `topAgents[]` | The ten costliest agents: `agentKey`, `requests`, `totalTokens`, `costUsd` |

### External pricing entries

```http
GET /api/cost/pricing
```

Returns `{ "entries": [...] }` with the active project's entries plus the
tenant-wide ones (`projectId: ""`). Each entry carries `modelName`,
`normalizedName` (the lowercased match key), `pricing`, `versions[]`,
`updatedBy` and timestamps.

#### Upsert

```http
PUT /api/cost/pricing
Content-Type: application/json

{
  "modelName": "llama-3.3-70b-instruct",
  "pricing": { "inputTokenPer1M": 0.6, "outputTokenPer1M": 0.8, "cachedTokenPer1M": 0.3 },
  "effectiveFrom": "2026-07-01",
  "scope": "all"
}
```

| Body field | Type | Required | Notes |
|---|---|---|---|
| `modelName` | string | yes | 400 when missing or blank |
| `pricing` | object | no | Defaults to `{ inputTokenPer1M: 0, outputTokenPer1M: 0 }`; `currency` defaults to `USD` |
| `effectiveFrom` | `YYYY-MM-DD` | no | Omitted means "since the beginning" (`""`). A non-day string is rejected with 400 |
| `scope` | `all` | no | `all` stores the entry tenant-wide so every project resolves it; otherwise the entry is project-scoped |

Prior versions are preserved, so past days keep resolving to the price valid
back then. Writing the same `effectiveFrom` twice replaces that version.

A name that collides with a Model Hub key is rejected with 400 — hub pricing
always wins for those, so a catalog entry would be dead weight. Negative or
non-numeric rates are rejected the same way. The response is
`{ "entry": { … } }` with the stored entry, its `pricing` set to the price
effective today.

#### Reprice

```http
POST /api/cost/pricing/reprice
Content-Type: application/json

{ "modelName": "llama-3.3-70b-instruct", "from": "2026-06-01", "to": "2026-08-01", "scope": "all" }
```

Recomputes recorded `usage_daily` spend for one externally priced model, using
the price effective on each row's own day. Rows keep their existing cost when
no version covers their day — an unknown price is not a free price. Hub models
are rejected with 400, as is a model with no pricing entry to reprice from.

| Response field | Notes |
|---|---|
| `modelName`, `fromDay`, `toDay` | Echo of the request |
| `rowsScanned`, `rowsUpdated` | Rollup rows examined and rewritten |
| `costBefore`, `costAfter` | Spend across the scanned rows |

#### Delete

```http
DELETE /api/cost/pricing/llama-3.3-70b-instruct
```

The path segment is URL-decoded before matching, so slashes in a model name
must be percent-encoded. Deletion matches the entry in the active project's
scope; 404 when there is none. Returns `{ "success": true }`.

### Worked example: price an unpriced model, then fix the history

```http
GET /api/cost/models?from=2026-07-01
→ entries[] contains { "modelKey": "llama-3.3-70b-instruct", "status": "unpriced", "costUsd": 0 }

PUT /api/cost/pricing
{ "modelName": "llama-3.3-70b-instruct",
  "pricing": { "inputTokenPer1M": 0.6, "outputTokenPer1M": 0.8 },
  "effectiveFrom": "2026-07-01" }
→ 200 { "entry": { … } }

POST /api/cost/pricing/reprice
{ "modelName": "llama-3.3-70b-instruct", "from": "2026-07-01" }
→ 200 { "rowsScanned": 62, "rowsUpdated": 62, "costBefore": 0, "costAfter": 41.87 }
```

Without the reprice call the entry would only price traffic ingested after it
was written.

## Model price catalog

Market reference prices imported from the community LiteLLM price file. The
catalog is process-global market data, not tenant data — project context is
required for authentication only. It is cached in memory for 24 hours and
refreshed lazily on read or explicitly through the refresh endpoint; there are
no timers.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/model-price-catalog` | Status, optionally a paged slice of entries |
| `POST` | `/api/model-price-catalog/refresh` | Force a refetch of the source file |
| `GET` | `/api/model-price-catalog/suggest` | Pricing suggestions for observed model names |

### Status and entries

```http
GET /api/model-price-catalog?entries=1&q=llama&offset=0&limit=50
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `entries` | `1` \| `true` | off | Without it only `status` is returned |
| `offset` | number | `0` | |
| `limit` | number | `50` | Capped at 500 |
| `q` | string | none | Substring filter over catalog key and provider |

`status` is `{ entries, fetchedAt, source }` — `fetchedAt` is absent until the
catalog has loaded once, and `source` is the upstream file URL. With
`entries=1` the response adds `total` (matches before paging) and `entries[]`,
key-sorted, each with `key`, `provider`, `mode`, `pricing` (USD per 1M
tokens), `maxInputTokens`, `maxOutputTokens` and the capability flags
`supportsFunctionCalling`, `supportsVision`, `supportsResponseSchema`. An
absent capability flag means unknown, never `false` — the recommendation
engine's hard gates depend on that distinction.

### Refresh

```http
POST /api/model-price-catalog/refresh
```

Returns `{ "status": { … } }`. Concurrent calls share one in-flight fetch.
When a refetch fails but a stale cache exists, the stale catalog keeps
serving; a fetch failure with no cache answers 502. Self-hosted deployments
that block public egress must allowlist the source host through
`OUTBOUND_HTTP_ALLOWED_HOSTS`.

### Suggestions

```http
GET /api/model-price-catalog/suggest?names=gpt-4o,llama-3.3-70b-instruct
```

`names` is a required comma-separated list; missing or empty answers 400. At
most 200 names are processed per call.

```json
{
  "status": { "entries": 1843, "fetchedAt": "2026-08-15T06:12:04.881Z", "source": "https://…" },
  "suggestions": [
    { "name": "gpt-4o", "match": { "catalogKey": "gpt-4o", "provider": "openai", "confidence": "exact", "pricing": { … } } },
    { "name": "llama-3.3-70b-instruct" }
  ]
}
```

| `confidence` | Match rule |
|---|---|
| `exact` | The name is a raw catalog key |
| `normalized` | Equal after name normalization (`gpt-4o` and `azure/gpt-4o` share one normalized name) |
| `fuzzy` | Normalized prefix/suffix overlap with exactly one best candidate |

A name that resolves ambiguously gets **no** `match` rather than a guess — a
missing suggestion is recoverable, a wrong price silently corrupts spend data.

## Prescriptions

Automated analysis over observed traffic. Deterministic detectors read the
tracing overview and cost rollups for a subject and emit findings, each with
evidence and a prescribed action. Numbers come from detectors only; the
optional narrative narrates the findings and is forbidden from introducing
figures of its own.

Generation is asynchronous: `POST` creates the report row with status
`pending` and answers **202**, a queue job runs the detectors, and the row
flips to `ready` or `failed`. The UI polls `GET /api/prescriptions/:id`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/prescriptions` | List reports |
| `POST` | `/api/prescriptions` | Enqueue one report → 202 |
| `POST` | `/api/prescriptions/auto-run` | Enqueue for every stale eligible subject → 202 |
| `GET` | `/api/prescriptions/eligibility` | Which subjects have enough data / a stale report |
| `GET` | `/api/prescriptions/:id` | One report |
| `DELETE` | `/api/prescriptions/:id` | Delete a report |
| `PATCH` | `/api/prescriptions/:id/findings/:findingId` | Finding lifecycle |
| `POST` | `/api/prescriptions/:id/narrative` | Generate the LLM narrative |

A subject is one of `agent`, `model` or `workspace`. `subjectName` is required
for `agent` and `model`; for `workspace` it is ignored and the report stores
`null`.

### Thresholds

| Env var | Default | Effect |
|---|---|---|
| `PRESCRIPTIONS_MIN_SESSIONS` | `50` | Sessions a subject needs in the window before it is eligible for automatic analysis |
| `PRESCRIPTIONS_STALE_DAYS` | `7` | A ready report older than this counts as stale |

Both fall back to their default when the value is not a positive number. The
analysis window (`windowDays`) is clamped to 3–90 days and defaults to 14.

### List reports

```http
GET /api/prescriptions?subjectKind=agent&subjectName=support-bot&limit=50&skip=0
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `subjectKind` | `agent` \| `model` \| `workspace` | none | Unknown values are ignored |
| `subjectName` | string | none | |
| `limit` | number | `50` | Capped at 200 |
| `skip` | number | `0` | |

Returns `{ "reports": [...], "total": n }`, newest first.

### Report object

| Field | Notes |
|---|---|
| `_id` | Report id |
| `subjectKind`, `subjectName` | `subjectName` is `null` for workspace reports |
| `windowDays`, `from`, `to` | Analysis window |
| `status` | `pending` \| `running` \| `ready` \| `failed` |
| `error` | Set when `status` is `failed` |
| `totals` | `sessions`, `requests`, `totalTokens`, `costUsd` — any of them `null` when the subject kind cannot supply it |
| `findings[]` | See below |
| `narrative` | `{ text, modelKey, generatedAt }` or `null` |
| `createdBy`, `createdAt`, `updatedAt`, `finishedAt` | |

### Finding object

```json
{
  "id": "cache-hit-low",
  "detector": "cache-hit-low",
  "category": "cost",
  "severity": "critical",
  "title": "Prompt cache barely used",
  "summary": "…",
  "evidence": [
    { "label": "Input tokens in window", "value": "42,000,000" },
    { "label": "Cached input tokens", "value": "1,700,000" },
    { "label": "Cache hit rate", "value": "4.05%" }
  ],
  "estMonthlySavingsUsd": 312.4,
  "prescription": {
    "action": "Move dynamic values (dates, IDs, timestamps) out of the prompt prefix …",
    "ctaLabel": "Open agent analysis",
    "ctaHref": "/dashboard/tracing/agents/support-bot"
  },
  "status": "open"
}
```

| Field | Values / notes |
|---|---|
| `id` | Unique within the report — this is the id the PATCH route takes. Today every detector emits one finding, so the id equals the detector key |
| `detector` | Detector key |
| `category` | `cost` \| `reliability` \| `performance` \| `hygiene` |
| `severity` | `info` \| `warn` \| `critical` |
| `title`, `summary` | Detector-written text |
| `evidence[]` | `{ label, value }` pairs, both strings |
| `estMonthlySavingsUsd` | Conservative monthly estimate, or **`null`** |
| `prescription.action` | The prescribed change |
| `prescription.ctaLabel`, `.ctaHref` | Optional deep link into the console |
| `status` | `open` \| `applied` \| `dismissed` |

`estMonthlySavingsUsd` is `null` whenever the problem is real but cannot be
priced from the available data — an unpriced model, for instance. It is never
guessed, and the narrative prompt forbids attaching a dollar figure to a
finding that carries `null`.

The detector battery and what each finding means are described in
[Cost & Optimization](/guide/cost-optimization).

### Create a report

```http
POST /api/prescriptions
Content-Type: application/json

{ "subjectKind": "agent", "subjectName": "support-bot", "windowDays": 14 }
```

| Body field | Type | Required | Notes |
|---|---|---|---|
| `subjectKind` | `agent` \| `model` \| `workspace` | yes | 400 otherwise |
| `subjectName` | string | for `agent` and `model` | 400 when missing |
| `windowDays` | number | no | Clamped to 3–90, default 14 |

```json
{ "reportId": "66be…", "status": "pending", "deduplicated": false }
```

Enqueue is idempotent per subject: while a `pending` or `running` report
already exists for the same subject, that report is returned with
`deduplicated: true` instead of a second job being queued.

### Auto-run

```http
POST /api/prescriptions/auto-run
Content-Type: application/json

{ "windowDays": 14 }
```

Enqueues a report for every subject that is both eligible and stale, in the
current tenant only. At most 10 agent subjects are enqueued per call, after
the workspace subject. Returns 202:

```json
{
  "enqueued": [
    { "subjectKind": "workspace", "reportId": "66bf…" },
    { "subjectKind": "agent", "subjectName": "support-bot", "reportId": "66c0…" }
  ],
  "skipped": 3
}
```

`skipped` counts due subjects that produced no new job — either a report was
already in flight for them, or they fell past the ten-agent cap.

### Eligibility

```http
GET /api/prescriptions/eligibility?windowDays=14
```

```json
{
  "windowDays": 14,
  "minSessions": 50,
  "staleDays": 7,
  "entries": [
    {
      "subjectKind": "workspace",
      "sessionsCount": 4120,
      "eligible": true,
      "lastReportId": "66bb…",
      "lastReportAt": "2026-08-01T09:14:22.000Z",
      "stale": true
    },
    { "subjectKind": "agent", "subjectName": "support-bot", "sessionsCount": 31, "eligible": false, "stale": true }
  ]
}
```

`eligible` is `sessionsCount >= minSessions`. `stale` is `true` when there is
no ready report or the latest one predates the staleness bar — and is forced
to `false` while a report for that subject is `pending` or `running`, so
auto-run cannot double-enqueue. Entries cover the workspace plus up to 100
recently active agents.

### Finding lifecycle

```http
PATCH /api/prescriptions/66be…/findings/cache-hit-low
Content-Type: application/json

{ "status": "applied" }
```

| `status` | Meaning |
|---|---|
| `open` | Reopened — the default state a detector emits |
| `applied` | The prescribed change was made |
| `dismissed` | Not going to act on it |

Any other value is rejected with 400. An unknown report id or finding id
answers 404. On success the **whole updated report** is returned, not just the
finding. Marking a finding `applied` is what makes the loop closable: the next
report on the same subject shows whether the metric moved.

### Narrative

```http
POST /api/prescriptions/66be…/narrative
Content-Type: application/json

{ "modelKey": "gpt-4o" }
```

`modelKey` is required (400 when blank) and must resolve to a Model Hub model.
The report must be `ready`; anything else is rejected with 400. The model
receives the subject, the window, the stored `totals` and the findings —
severity, category, title, summary, evidence, `estMonthlySavingsUsd` and the
prescribed action — and is instructed to use only figures that appear verbatim
in that payload. The updated report is returned with `narrative` populated.

### Worked example: analyse an agent end to end

```http
GET /api/prescriptions/eligibility
→ support-bot: { "eligible": true, "stale": true }

POST /api/prescriptions   { "subjectKind": "agent", "subjectName": "support-bot", "windowDays": 14 }
→ 202 { "reportId": "66be…", "status": "pending", "deduplicated": false }

GET /api/prescriptions/66be…        (poll)
→ { "status": "running", … } … → { "status": "ready", "findings": [ … ] }

PATCH /api/prescriptions/66be…/findings/cache-hit-low   { "status": "applied" }
→ 200 (updated report)
```

## Abacus

::: tip Enterprise module
Abacus is part of the enterprise edition. Every `/api/abacus/*` route is gated
per tenant and answers 402 without an active enterprise licence. See
[Licensing](/guide/licensing).
:::

Cost intelligence: static repricing, the optimization recommendation feed,
parity tests and the model matrix.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/abacus/whatif` | Reprice one target's observed usage against alternative models |
| `GET` | `/api/abacus/recommendations` | Optimization recommendation feed + diagnostics |
| `POST` | `/api/abacus/parity` | Enqueue a quality-parity test → 202 |
| `GET` | `/api/abacus/parity` | Parity tests, newest first |
| `GET` | `/api/abacus/parity/:id` | One parity test |
| `POST` | `/api/abacus/matrix` | Launch one dataset against many candidates → 202 |
| `GET` | `/api/abacus/matrix` | Matrix results for a dataset |

A **target** is `{ kind: "model" \| "agent", key }` — a Model Hub model key,
or a tracing agent name as it appears in the usage rollup.

What-if is static repricing: the observed token volume is assumed to transfer
1:1 to the candidate and no model is called. A parity test is a real replay
that measures the token ratio and the quality. Once parity evidence exists for
a pair, the recommendation engine stops using the 1:1 assumption and reprices
from the measured ratio, flagging the row `measured: true`.

### What-if

```http
GET /api/abacus/whatif?target_kind=agent&target_key=support-bot&from=2026-07-01&candidate_sources=hub,external
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `target_kind` | `model` \| `agent` | — | Required; 400 otherwise |
| `target_key` | string | — | Required |
| `from`, `to` | ISO date | last 30 days | A non-ISO value is rejected with 400 |
| `candidates` | comma-separated model keys | none | Narrows to specific candidate keys |
| `candidate_sources` | `hub`, `external`, `catalog` | `hub,external` | Tier selection; an unknown token is rejected with 400 |

Note the split: on this route `candidates` narrows by model key and
`candidate_sources` selects tiers. On `/api/abacus/recommendations` the tier
list is passed as `candidates`.

```json
{
  "object": "abacus.whatif",
  "target": { "kind": "agent", "key": "support-bot" },
  "fromDay": "2026-07-01",
  "toDay": "2026-07-31",
  "baseline": {
    "costUsd": 412.9,
    "requests": 18400,
    "inputTokens": 42000000,
    "outputTokens": 5100000,
    "cachedInputTokens": 16800000,
    "totalTokens": 47100000,
    "segments": [ { "modelKey": "gpt-4o", "agentKey": "support-bot", "requests": 18400, "priced": true, "avgLatencyMs": 2140, "tokensPerRequest": 2560, … } ]
  },
  "candidates": [
    { "kind": "hub", "modelKey": "gpt-4o-mini", "modelName": "GPT-4o mini", "providerKey": "openai",
      "projectedCostUsd": 91.2, "savingsUsd": 321.7, "savingsPct": 77.9, "openWeight": false }
  ]
}
```

Candidates are sorted by savings descending. `cachePricingAssumed: true` on a
candidate means it publishes no prompt-cache rate, so the cached slice of the
prompt was projected at the full input rate — the saving shown is real but
conservative.

### Recommendations

```http
GET /api/abacus/recommendations?objective=cost&candidates=hub,external,catalog&min_requests=100
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `objective` | `cost` \| `latency` | `cost` | Anything else is rejected with 400 |
| `from`, `to` | ISO date | last 30 days | |
| `candidates` | `hub`, `external`, `catalog` | `hub,external` | Tier list. `catalog` (market suggestions) is opt-in and cost-objective only — the market has no observed latency |
| `min_savings_pct` | number | `20` | Cost objective |
| `min_requests` | number | `50` | Both objectives |
| `min_latency_gain_pct` | number | `20` | Latency objective |
| `gpu_hourly_usd` | number > 0 | catalog rate | Overrides the indicative $/GPU-hour behind the self-hosting estimate |

There is deliberately no `tokens` objective: under a 1:1 transfer assumption
every candidate ties on tokens, so a static what-if cannot rank on it. Cost
needs pricing; latency works from observed averages and needs none. Token
savings cannot be estimated, only measured — which is what a parity test is
for.

The response is `{ "object": "abacus.recommendations", "recommendations": [...], "diagnostics": { … } }`.

Recommendation fields shared by both objectives:

| Field | Notes |
|---|---|
| `id` | Deterministic per (target, current, candidate) |
| `objective` | `cost` or `latency` |
| `target`, `currentModelKey`, `candidateModelKey`, `candidateModelName` | |
| `candidateKind` | `hub` (routable and parity-testable) \| `external` \| `catalog` (both advice-level) |
| `candidateOpenWeight` | Published open-weight family |
| `windowDays`, `requests`, `totalTokens`, `tokensPerRequest` | Observed volume |
| `confidence` | `low` \| `medium` \| `high`, volume-based |
| `evidenceTier` | `projected` \| `compatChecked` \| `parityProven` |
| `score`, `scoreBreakdown[]` | Explainable composite in [0,1]; each component records `source`: `projected`, `measured`, `evidence` or `tierPrior` |
| `workload` | Measured demands of the segment: `cacheRatio`, `requiredTierFloor`, `toolMenuSize`, `toolComplexity`, `language`, `avgTurns` |
| `compatibility` | Hard-gate results plus `excludedCandidates` |
| `evidence` | Matched parity run: `runId`, `passRate`, `avgScore`, `completedItems`, `measuredTokenRatio`, `measuredAvgLatencyMs`, `agentScoped` |
| `measured` | `true` when the figures came from the evidence-measured token ratio |
| `selfHost` | Self-hosting economics for open-weight candidates |
| `suggestedRouting` | Dynamic LLM routing change; present for `hub` candidates only |
| `alternativeHubCandidate` | The best routable option when the overall winner is not a hub model |

Cost-objective entries add `baselineCostUsd`, `projectedCostUsd`,
`savingsUsd`, `savingsPct` and `projectedMonthlySavingsUsd` (window savings
scaled to 30 days). Latency-objective entries add `baselineAvgLatencyMs`,
`candidateAvgLatencyMs` and `latencyGainPct`.

#### Hard gates

`compatibility.checks[]` reports the deterministic gates for the winning
candidate, each with status `pass` or `unknown`:

| Check `id` | UI label | Gate |
|---|---|---|
| `tools` | Tool calling | The workload calls tools and the candidate supports them |
| `contextWindow` | Context window | The candidate fits the observed input size |
| `outputTokens` | Output tokens | The candidate fits the observed response size |
| `qualityTier` | Quality tier | The candidate is not more than one size tier below |
| `promptCache` | Prompt cache | On a cache-dependent workload the candidate publishes a prompt-cache rate |
| `toolComplexity` | Tool complexity | The candidate clears the tier floor the workload's tool schemas demand |
| `language` | Language | The candidate is not documented English-first while the traffic demonstrably is not |

A candidate that **fails** a gate never appears in the feed — it is removed
from ranking and counted in `compatibility.excludedCandidates`. `unknown`
never excludes; only a known incompatibility does. Capability data comes from
the market price catalog, where an absent flag means unknown, not `false`.

Two gates have specific rules worth stating: the prompt-cache gate excludes a
candidate when at least 40% of the workload comes from cache and the candidate
publishes no cache price (parity evidence overrides this), and the language
gate excludes a candidate documented as English-first when the traffic is
evidenced non-English.

#### Diagnostics

`diagnostics` explains an empty or short feed. `segments`, `pricedSegments`
and `unpricedSegments` are classifications; the remaining buckets are filter
outcomes and each segment lands in at most one, in filter order — cost:
unpriced → zero-cost → below-volume → below-savings; latency: below-volume →
no-latency-data → below-latency-gain.

| Field | Meaning |
|---|---|
| `segments` | Total (model, agent) usage segments in the window |
| `pricedSegments` / `unpricedSegments` | Segments whose model resolves to pricing, and those with none |
| `zeroCostPricedSegments` | Priced, but recorded spend is $0 — history predates the pricing entry; reprice fixes these |
| `belowVolumeSegments` | Under `min_requests` |
| `belowSavingsSegments` | No candidate met `min_savings_pct` |
| `noLatencyDataSegments` | No recorded latency samples |
| `belowLatencyGainSegments` | No candidate cleared `min_latency_gain_pct` |
| `candidatePools` | Candidates available per enabled tier: `hub`, `external`, `catalog`, `catalogOpenWeight` |
| `evidencePairs` | Distinct (current, candidate) pairs with usable parity evidence |
| `cacheGatedCandidates` | Excluded by the prompt-cache gate |
| `languageGatedCandidates` | Excluded by the language gate |

#### Self-hosting block

`selfHost` answers whether running an open-weight candidate on the tenant's
own GPUs beats the token-priced API. An API candidate costs $/token and scales
with traffic; a GPU costs $/hour whether busy or idle, so the deciding number
is utilisation.

| Field | Notes |
|---|---|
| `entryId`, `modelName` | Model library entry that would be deployed |
| `gpuModel`, `gpusRequired`, `gpusAvailable` | `gpusAvailable` only on `source: "fleet"` |
| `gpuHourlyUsd`, `monthlyCostUsd` | 30-day cost of keeping the GPUs resident |
| `estimatedTokensPerSecond` | Sustained rate the roofline model expects |
| `breakEvenUtilization`, `observedUtilization`, `worthwhile` | Above 1 for break-even means self-hosting cannot win at this volume |
| `source` | `fleet` — sized on hardware the tenant owns; `reference` — an H100 PCIe stand-in because no fleet was readable |

The hourly rates are indicative public on-demand prices, **not a quote**.
Reserved capacity, spot and owned hardware all land below them, so the
estimate is conservative. Override them with `gpu_hourly_usd`. A `reference`
estimate answers "is this worth exploring", not "this is your bill". See
[GPU Fleet](/guide/gpu-fleet/overview).

### Parity tests

A parity test snapshots (or reuses) an evaluation dataset, builds a suite
targeting the candidate model, and runs it with an LLM judge. Validation is
synchronous — bad input fails the HTTP call — and the orchestration then runs
as a queue job, because the snapshot stage is far too slow to hold a request
open.

```http
POST /api/abacus/parity
Content-Type: application/json

{
  "target": { "kind": "agent", "key": "support-bot" },
  "currentModelKey": "gpt-4o",
  "candidateModelKey": "gpt-4o-mini",
  "judgeModelKey": "gpt-4o",
  "from": "2026-07-01",
  "to": "2026-07-31",
  "samplePct": 10,
  "maxItems": 100,
  "anonymize": { "categories": ["email", "phone", "iban"], "strategy": "pseudonym" }
}
```

| Body field | Type | Required | Notes |
|---|---|---|---|
| `target.kind` | `model` \| `agent` | yes | |
| `target.key` | string | yes | |
| `currentModelKey` | string | no | Display only; agent targets span models |
| `candidateModelKey` | string | yes | Must be an LLM in the Model Hub, and different from a `model` target |
| `judgeModelKey` | string | yes | Must be an LLM in the Model Hub |
| `datasetId` (or `dataset_id`) | string | — | Selects existing-dataset mode |
| `from`, `to` | ISO date | no | Snapshot mode only |
| `samplePct` | number | `10` | Snapshot mode only |
| `maxItems` | number | `100` | Snapshot mode only |
| `anonymize.categories` | string[] | in snapshot mode | At least one PII category id, e.g. `email`, `phone`, `iban`, `tc_kimlik` |
| `anonymize.strategy` | `mask` \| `pseudonym` | in snapshot mode | |

Two modes:

| Mode | Trigger | Behaviour |
|---|---|---|
| `snapshot` | no `datasetId` | Samples live traffic into a new dataset. `anonymize` is mandatory — snapshots must pass the anonymization gate |
| `existing-dataset` | `datasetId` present | Replays a dataset that already passed the gate at creation. No snapshot stage, no `anonymize` input; `samplePct` becomes 100 and `maxItems` the dataset's item count |

The pseudonym salt is generated server-side per request, travels only in the
transient job payload, and is never persisted or echoed back. A salt in the
request body is ignored.

Response is 202:

```json
{ "object": "abacus.parity", "parityId": "66c4…", "datasetId": "66c4…", "status": "pending" }
```

Invalid input — a candidate or judge that is not a hub LLM, a dataset with no
items, a dataset not resolvable in the current project, or a parity test
already pending on that dataset — answers 400.

#### Read parity tests

```http
GET /api/abacus/parity?limit=50
GET /api/abacus/parity/66c4…
```

`limit` defaults to 50 and is capped at 200; a non-positive value is rejected
with 400. The list responds `{ "object": "abacus.parity_tests", "parityTests": [...] }`
and the detail `{ "object": "abacus.parity_test", "parityTest": { … } }`; an
unknown id answers 404.

| Field | Notes |
|---|---|
| `id`, `datasetId` | The parity dataset's id doubles as the tracking id |
| `status` | `pending` \| `running` \| `ready` \| `failed` |
| `stage` | `snapshot` \| `suite` \| `run` — the stage in progress or where it failed |
| `error` | Set on failure; ids recorded before the failure stay valid |
| `mode`, `sourceDatasetKey` | `snapshot` or `existing-dataset`; the replayed dataset's key in the latter |
| `target`, `currentModelKey`, `candidateModelKey`, `judgeModelKey` | |
| `window`, `samplePct`, `maxItems` | |
| `suiteId`, `runId` | Links into [Evaluation](/api/evaluation) |
| `sampled`, `created`, `piiFindings` | Rows sampled, dataset items created, PII replacements made |
| `createdBy`, `enqueuedAt`, `startedAt`, `finishedAt` | |

Parity evidence is promoted to `parityProven` in the recommendation feed only
once a completed run has at least 50 completed items and a pass rate of 0.9 or
better.

### Model matrix

One evaluation dataset replayed against many candidate models, compared side
by side. Matrix runs are experiments, not tracked parity records: several
candidates can run on the same dataset concurrently and a re-run never
overwrites anything.

```http
POST /api/abacus/matrix
Content-Type: application/json

{
  "datasetId": "66c4…",
  "candidateModelKeys": ["gpt-4o-mini", "llama-3.3-70b-instruct", "claude-haiku"],
  "judgeModelKey": "gpt-4o"
}
```

| Body field | Type | Required | Notes |
|---|---|---|---|
| `datasetId` (or `dataset_id`) | string | yes | 400 when blank |
| `candidateModelKeys` | string[] | yes | Non-empty; duplicates are collapsed |
| `judgeModelKey` | string | yes | |
| `target` | `{ kind, key }` | no | Inferred from the dataset's provenance when omitted |
| `currentModelKey` | string | no | Accepted for symmetry with the parity route; the matrix launch does not use it |

202 response — partial failures do not abort the launch:

```json
{
  "object": "abacus.matrix",
  "datasetId": "66c4…",
  "datasetKey": "parity-support-bot-…",
  "target": { "kind": "agent", "key": "support-bot" },
  "launched": [ { "candidateModelKey": "gpt-4o-mini", "suiteId": "…", "suiteKey": "…", "runId": "…" } ],
  "errors": [ { "candidateModelKey": "claude-haiku", "error": "Candidate model \"claude-haiku\" is not an LLM in the Model Hub" } ]
}
```

```http
GET /api/abacus/matrix?dataset_id=66c4…
```

`dataset_id` (or `datasetId`) is required; an unknown or out-of-project
dataset answers 404. The view carries `dataset` (`id`, `key`, `name`,
`itemCount`), the inferred `target`, `judgeModelKey`, and one row per
candidate model sorted by pass rate:

| Row field | Notes |
|---|---|
| `candidateModelKey`, `suiteKey`, `runId` | Freshest run wins |
| `status` | Evaluation run status, or `none` when nothing has run |
| `runCount` | Runs ever executed for this candidate on this dataset |
| `items`, `completed`, `failed`, `passed`, `passRate` | |
| `judgeAvg`, `judgeScored` | Mean judge score, and how many items the judge actually scored |
| `toolAvg`, `toolTested` | Mean tool-call score, and how many items actually exercised tools |
| `avgLatencyMs`, `totalTokens`, `totalCostUsd`, `costPerItem` | `costPerItem` is `totalCostUsd / completed` |
| `finishedAt`, `error` | |

The judge and tool averages are taken over **only the items actually scored**
(`judgeScored`, `toolTested`), so they cannot be inflated. This matters for
the tool score in particular: the tool-call scorer returns 1.0 when an item
expects no tools, and averaging that blindly would flatter every candidate on
a dataset without trajectories.

When the judge model is also one of the candidates, its own row carries
self-judgement bias — the console warns about this, and the same caveat
applies to anything read from this endpoint.

Snapshot dataset items carry a `lang:<iso>` tag, so parity and matrix results
can be read per language.

### Worked example: from a recommendation to a proven switch

```http
GET /api/abacus/recommendations?objective=cost
→ { "id": "…", "target": { "kind": "agent", "key": "support-bot" },
    "currentModelKey": "gpt-4o", "candidateModelKey": "gpt-4o-mini",
    "savingsPct": 77.9, "evidenceTier": "compatChecked", "measured": false }

POST /api/abacus/parity
{ "target": { "kind": "agent", "key": "support-bot" },
  "currentModelKey": "gpt-4o", "candidateModelKey": "gpt-4o-mini", "judgeModelKey": "gpt-4o",
  "anonymize": { "categories": ["email", "phone"], "strategy": "pseudonym" } }
→ 202 { "parityId": "66c4…", "status": "pending" }

GET /api/abacus/parity/66c4…      (poll)
→ { "status": "ready", "suiteId": "…", "runId": "…", "created": 100, "piiFindings": 214 }

GET /api/abacus/recommendations?objective=cost
→ the same row now reports "evidenceTier": "parityProven", "measured": true,
  and its savings figures are repriced from the measured token ratio
```
