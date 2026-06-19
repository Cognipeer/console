# Spend & Budgets API

Cost control for a project: read what was spent (rolled up from the per-model usage logs) and manage budget policies that the quota guard enforces on the live inference, batch, and embedding paths.

All endpoints live under `/api/client/v1` and are authenticated with a `cgt_` API token:

```
Authorization: Bearer cgt_…
```

Budgets are stored as quota policies with `limits.budget` set, so a budget created here is enforced by the same guard (`checkBudget`) that protects the sync inference and batch paths. The spend report is the read side — it never enforces anything.

## Spend report

### Get spend report

```http
GET /api/client/v1/spend/report?from=2026-05-01&to=2026-06-01&group_by=day&model=gpt-4o
Authorization: Bearer cgt_…
```

Rolls the per-model usage logs into totals, a per-model breakdown, and a merged timeseries for the calling token's project.

| Query param | Type | Required | Notes |
|---|---|---|---|
| `from` | ISO date string | no | Window start. Invalid value → 400. |
| `to` | ISO date string | no | Window end. Invalid value → 400. |
| `group_by` | `hour \| day \| month` | no | Timeseries bucket granularity. Defaults to `day`. |
| `model` | string | no | Restrict the report to a single model key. |

#### Response

```json
{
  "object": "spend.report",
  "from": "2026-05-01T00:00:00.000Z",
  "to": "2026-06-01T00:00:00.000Z",
  "group_by": "day",
  "currency": "USD",
  "total_cost": 42.18,
  "total_calls": 1280,
  "total_input_tokens": 980000,
  "total_output_tokens": 210000,
  "total_tokens": 1190000,
  "by_model": [
    {
      "model_key": "gpt-4o",
      "model_name": "GPT-4o",
      "category": "llm",
      "provider_key": "openai",
      "calls": 900,
      "input_tokens": 740000,
      "output_tokens": 160000,
      "total_tokens": 900000,
      "cost": 33.40,
      "currency": "USD"
    }
  ],
  "timeseries": [
    { "period": "2026-05-01", "calls": 120, "total_tokens": 98000, "cost": 3.41 },
    { "period": "2026-05-02", "calls": 140, "total_tokens": 102000, "cost": 3.88 }
  ]
}
```

Notes:

- `by_model` is sorted by `cost` descending; models with zero calls in the window are omitted.
- `currency` is taken from the highest-cost model entry (falls back to `USD`).
- `timeseries` points are merged across all models for the same `period` and sorted ascending by period.

## Budgets

A budget is a quota policy with a daily and/or monthly USD spend limit. Use `-1` for a limit value to mean "unlimited".

### Budget status

```http
GET /api/client/v1/budgets/status?domain=llm&model=gpt-4o&scope=token
Authorization: Bearer cgt_…
```

Returns current usage versus the configured limits for each window (day / month), keyed the same way enforcement counts spend.

| Query param | Type | Required | Notes |
|---|---|---|---|
| `domain` | enum | no | One of `global, llm, embedding, vector, file, tracing, stt, tts, ocr`. Defaults to `llm`. Invalid value → 400. |
| `model` | string | no | Narrows the counter to a single resource (model) key. |
| `scope` | string | no | `scope=token` narrows the counter to the calling API token. Any other value reports the tenant-level window. |

#### Response

```json
{
  "object": "budget.status",
  "domain": "llm",
  "configured": true,
  "per_day": { "limit_usd": 50, "used_usd": 12.40, "remaining_usd": 37.60 },
  "per_month": { "limit_usd": 1000, "used_usd": 312.80, "remaining_usd": 687.20 },
  "alert_thresholds": [0.5, 0.8, 1.0]
}
```

When a window has no configured limit, `limit_usd` and `remaining_usd` are `null` while `used_usd` still reports actual spend. `configured` is `false` when no budget exists for the resolved scope.

### List budgets

```http
GET /api/client/v1/budgets
Authorization: Bearer cgt_…
```

Returns every quota policy in the project that has a daily or monthly spend limit set (other quota policies are filtered out).

#### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "665f…",
      "object": "budget",
      "label": "Production LLM cap",
      "description": "Hard monthly ceiling for prod",
      "domain": "llm",
      "scope": "tenant",
      "scope_id": null,
      "project_id": "6650…",
      "daily_limit_usd": 50,
      "monthly_limit_usd": 1000,
      "alert_thresholds": [0.5, 0.8, 1.0],
      "enabled": true,
      "priority": 100,
      "created_at": "2026-05-01T09:00:00.000Z",
      "updated_at": "2026-05-10T11:30:00.000Z"
    }
  ]
}
```

### Create budget

```http
POST /api/client/v1/budgets
Authorization: Bearer cgt_…
Content-Type: application/json
```

Requires an **owner** or **admin** API token (otherwise 403). At least one of `daily_limit_usd` or `monthly_limit_usd` must be supplied.

```json
{
  "label": "Production LLM cap",
  "description": "Hard monthly ceiling for prod",
  "domain": "llm",
  "scope": "tenant",
  "scope_id": null,
  "daily_limit_usd": 50,
  "monthly_limit_usd": 1000,
  "alert_thresholds": [0.5, 0.8, 1.0],
  "priority": 100,
  "enabled": true
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `daily_limit_usd` | number | conditional | Daily USD cap. Must be ≥ 0, or `-1` for unlimited. Required if `monthly_limit_usd` is absent. |
| `monthly_limit_usd` | number | conditional | Monthly USD cap. Same rules. Required if `daily_limit_usd` is absent. |
| `domain` | enum | no | One of `global, llm, embedding, vector, file, tracing, stt, tts, ocr`. Defaults to `llm`. |
| `scope` | enum | no | One of `tenant, user, token, resource, provider`. Defaults to `tenant`. |
| `scope_id` | string | no | Identifier the scope binds to (e.g. a token id when `scope=token`). |
| `alert_thresholds` | number[] | no | Fractions of the limit (e.g. `0.8`) at which to alert. Non-numeric entries are dropped. |
| `label` | string | no | Display name. Defaults to `"Budget"`. |
| `description` | string | no | Free-text note. |
| `priority` | number | no | Policy priority. Defaults to `100`. |
| `enabled` | boolean | no | Defaults to `true` (anything other than `false` enables it). |

#### Response

`201 Created` with the budget object (same shape as a list entry).

### Update budget

```http
PATCH /api/client/v1/budgets/:budgetId
Authorization: Bearer cgt_…
Content-Type: application/json
```

Requires an **owner** or **admin** token. Only the supplied fields are changed; omitted fields keep their existing value. Accepts `daily_limit_usd`, `monthly_limit_usd`, `alert_thresholds`, `label`, `description`, and `enabled`. The same `-1`-for-unlimited rule applies to the limit fields.

```json
{
  "monthly_limit_usd": 1500,
  "alert_thresholds": [0.75, 0.9, 1.0],
  "enabled": true
}
```

#### Response

`200 OK` with the updated budget object. A `budgetId` that does not resolve to a budget policy in the project returns 404.

### Delete budget

```http
DELETE /api/client/v1/budgets/:budgetId
Authorization: Bearer cgt_…
```

Requires an **owner** or **admin** token.

#### Response

```json
{ "deleted": true, "id": "665f…" }
```

Returns 404 if the id is not a budget policy in the project.

## Errors

| Status | Cause |
|---|---|
| 400 | Invalid `from`/`to` date, bad `group_by`, unknown `domain`/`scope`, non-negative-number rule violated, or neither limit supplied on create. |
| 401 | Missing or invalid API token. |
| 403 | Budget create/update/delete attempted without an owner/admin token. |
| 404 | `budgetId` is not a budget policy in the project. |
| 500 | Internal error. |

## Example

Create a budget, then check its status:

```bash
# Create a tenant-wide monthly cap with alerts at 80% and 100%
curl -X POST https://your-console.example.com/api/client/v1/budgets \
  -H "Authorization: Bearer cgt_…" \
  -H "Content-Type: application/json" \
  -d '{
        "label": "Prod LLM cap",
        "domain": "llm",
        "scope": "tenant",
        "monthly_limit_usd": 1000,
        "alert_thresholds": [0.8, 1.0]
      }'

# Current usage vs limits for this token's LLM spend
curl https://your-console.example.com/api/client/v1/budgets/status?domain=llm \
  -H "Authorization: Bearer cgt_…"

# Spend report grouped by day for May
curl "https://your-console.example.com/api/client/v1/spend/report?from=2026-05-01&to=2026-06-01&group_by=day" \
  -H "Authorization: Bearer cgt_…"
```
