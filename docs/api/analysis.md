# Analysis API

Conversation analysis: extract structured fields from transcripts, judge
quality against a rubric, and score extraction accuracy against ground truth —
on demand or on a nightly cron. Built for use cases like IVR/call-center review.

All endpoints are under `/api/analysis/*` and are session-authenticated. Requests
are tenant- and project-scoped from the session.

## Concepts

```
definition    →  fieldSet + extraction prompt + modes (+ models, + schedule)
conversation  →  an ingested transcript { role, content }[] (+ referenceFields)
run           →  one execution of a definition over a set of conversations
```

### Modes

| Mode | Effect |
|---|---|
| `extract` | Always on — pulls the `fieldSet` out of each transcript as typed JSON. |
| `store` | Writes the extracted fields back onto each conversation (`extractedFields`, `lastAnalyzedAt`). |
| `judge` | An LLM grades each conversation against `judge.rubric` (0–1). |
| `accuracy` | Compares extracted fields to the conversation's `referenceFields`, per field. |

## Definitions

```http
GET    /api/analysis/definitions?search=intent
POST   /api/analysis/definitions
GET    /api/analysis/definitions/:id
PATCH  /api/analysis/definitions/:id
DELETE /api/analysis/definitions/:id
```

### Create

```json
{
  "name": "Call intent & resolution",
  "fieldSet": [
    { "key": "intent", "type": "enum", "enumValues": ["billing", "support"], "required": true },
    { "key": "resolved", "type": "boolean" }
  ],
  "extractionInstructions": "Focus on the caller's primary reason.",
  "modes": { "store": true, "accuracy": true, "judge": { "rubric": "Was the caller helped politely?" } },
  "extractionModelKey": "gpt-4o-mini",
  "judgeModelKey": "gpt-4o",
  "schedule": { "cron": "0 2 * * *", "enabled": true }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | `key` is slugified from it. |
| `fieldSet` | array | yes | Each `{ key, type, description?, enumValues?, required? }`; `type` ∈ `string \| number \| boolean \| enum`. `enum` needs `enumValues`. |
| `modes` | object | yes | `{ store?, accuracy?, judge?: { rubric, threshold? } }`. |
| `extractionModelKey` | string | recommended | Model used for extraction (required at run time). |
| `judgeModelKey` | string | when `modes.judge` | Model used for grading. |
| `schedule` | object | no | `{ cron, enabled }`. Validated with a standard 5-field cron expression (UTC). |

## Conversations

```http
GET    /api/analysis/conversations?search=refund&limit=100
POST   /api/analysis/conversations
GET    /api/analysis/conversations/:id
DELETE /api/analysis/conversations/:id
```

### Ingest

Accepts a single conversation or `{ "conversations": [...] }` for bulk import
(e.g. an external call export).

```json
{
  "conversations": [
    {
      "name": "Call 1042",
      "transcript": [
        { "role": "caller", "content": "I was charged twice." },
        { "role": "agent", "content": "I've issued a refund." }
      ],
      "referenceFields": { "intent": "billing", "resolved": true }
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `transcript` | array | yes | Non-empty `{ role, content }[]`. |
| `referenceFields` | object | no | Ground truth for the accuracy mode. |
| `name` | string | no | Display name; `key` is slugified/auto-generated. |
| `source` | `imported \| platform \| manual` | no | Defaults to `imported`. |

## Runs

### Run a definition

```http
POST /api/analysis/definitions/:key/run
```

```json
{ "conversationKeys": ["call-1042", "call-1043"] }
```

Omit `conversationKeys` to analyze the most recent corpus (up to 500
conversations). Extraction runs per conversation with bounded concurrency, then
optional judge and accuracy; the run is persisted with an aggregate.

#### Response

```json
{
  "run": {
    "id": "…",
    "definitionKey": "call-intent-resolution",
    "status": "completed",
    "aggregate": { "total": 120, "completed": 118, "failed": 2, "passed": 110, "passRate": 0.932, "avgJudgeScore": 0.88, "avgExtractionAccuracy": 0.91 },
    "items": [
      { "conversationKey": "call-1042", "passed": true, "extractedFields": { "intent": "billing", "resolved": true }, "missing": [], "judge": { "score": 0.9, "passed": true }, "accuracy": { "score": 1, "comparedCount": 2, "perField": { "intent": { "expected": "billing", "actual": "billing", "match": true } } } }
    ]
  }
}
```

`avgJudgeScore` / `avgExtractionAccuracy` are `null` when no item used that mode.

### List / get runs

```http
GET /api/analysis/runs?definitionKey=call-intent-resolution&limit=50
GET /api/analysis/runs/:id
```

## Scheduling

When a definition has `schedule.enabled` with a valid cron, the background
**analysis scheduler** fires it automatically (e.g. `0 2 * * *` = 02:00 UTC
nightly). Each cron slot fires at most once, decided against the most recent
run. See the [guide](/guide/evaluation-and-analysis#automation).

## Alerting

Run aggregates feed the alert system through the `analysis` module:

| Metric | Source |
|---|---|
| `analysis_pass_rate` | `aggregate.passRate` × 100, averaged over completed runs in the window. |
| `analysis_avg_judge_score` | `aggregate.avgJudgeScore` × 100. |
| `analysis_avg_accuracy` | `aggregate.avgExtractionAccuracy` × 100. |

A rule like `analysis_avg_accuracy lt 85` over 24h notifies you when extraction
quality drops on the nightly run.

## Errors

| Status | Cause |
|---|---|
| 400 | Missing `name`, empty/invalid `fieldSet`, enum without `enumValues`, bad cron, transcript missing `role`/`content`. |
| 404 | Definition / conversation / run not found (or unknown definition `key` on run). |
| 500 | Internal error. |
