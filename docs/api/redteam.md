# Red Team API

Adversarial safety scanning for your agents and models. A campaign drives a set of probes (prompt injection, jailbreak, data extraction, …) against a target, an LLM judge decides each attempt, and the run reports an attack-success / resilience score per OWASP-LLM category — so a CI pipeline can fail when an agent regresses on safety.

The client surface (`/api/client/v1/redteam/*`) is read-and-trigger only: it lists the built-in probe catalog and configured campaigns, launches scans, and reads runs. Authoring campaigns and custom probes stays on the dashboard surface (`/api/redteam/*`). All client endpoints are API-token authenticated with a `cgt_` bearer token and are scoped to the token's project.

```
GET  /api/client/v1/redteam/probes               – built-in probe catalog
GET  /api/client/v1/redteam/campaigns            – list configured campaigns
POST /api/client/v1/redteam/campaigns/:key/scan  – launch a scan (async)
GET  /api/client/v1/redteam/runs                 – list runs
GET  /api/client/v1/redteam/runs/:id             – one run + per-attempt verdicts
```

## Concepts

- **Probe** — a generator for one vulnerability class (e.g. `prompt-injection`, `jailbreak`). Each probe carries an OWASP-LLM `category` and a `severity` (`low | medium | high | critical`).
- **Custom probes** — user-authored probes (created on the dashboard) are referenced with a `custom:` key prefix (e.g. `custom:my-leak-test`). This client surface lists only **built-in** probes; custom probes still run when selected on a campaign.
- **Campaign** — a named, reusable scan config: target (agent or model), the `probe_keys` to run, and the judge model.
- **Run** — one execution of a campaign. Each **attempt** gets a three-state verdict: `safe`, `vulnerable`, or `needs_review`. The run **aggregate** rolls those up into an `attackSuccessRate` (`vulnerable / completed`) and `resilienceScore` (`1 - attackSuccessRate`), broken down by severity and OWASP category.

### List probes

```http
GET /api/client/v1/redteam/probes
Authorization: Bearer cgt_…
```

Returns the built-in probe catalog. `custom` is `false` for every entry here (custom probes are not advertised on the client surface).

#### Response

```json
{
  "probes": [
    {
      "key": "prompt-injection",
      "name": "prompt-injection",
      "family": "prompt-injection",
      "category": "LLM01-prompt-injection",
      "severity": "high",
      "description": "Attempts to override the system prompt via injected instructions.",
      "custom": false
    },
    {
      "key": "sensitive-info-disclosure",
      "name": "sensitive-info-disclosure",
      "family": "pii-leak",
      "category": "LLM06-sensitive-information-disclosure",
      "severity": "high",
      "description": "...",
      "custom": false
    }
  ]
}
```

Built-in probe keys: `prompt-injection`, `encoding-injection`, `jailbreak`, `sensitive-info-disclosure`, `pii-generation`, `data-extraction`, `insecure-output-handling`, `excessive-agency`, `overreliance-hallucination`.

OWASP-LLM categories used by the catalog: `LLM01-prompt-injection`, `LLM02-insecure-output-handling`, `LLM04-model-dos`, `LLM05-supply-chain`, `LLM06-sensitive-information-disclosure`, `LLM07-system-prompt-leakage`, `LLM08-excessive-agency`, `LLM09-overreliance`.

### List campaigns

```http
GET /api/client/v1/redteam/campaigns
Authorization: Bearer cgt_…
```

Lists the campaigns configured in the token's project.

#### Response

```json
{
  "campaigns": [
    {
      "key": "nightly-agent-scan",
      "name": "Nightly agent scan",
      "description": "Full OWASP sweep against the support agent",
      "target_kind": "agent",
      "agent_key": "support-agent",
      "model_key": null,
      "probe_keys": ["prompt-injection", "jailbreak", "custom:my-leak-test"],
      "judge_model_key": "gpt-4o",
      "created_at": "2026-06-01T09:00:00.000Z"
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `key` | string | Campaign identifier; used in the scan path. |
| `target_kind` | `agent \| model` | What the campaign tests. |
| `agent_key` / `model_key` | string \| null | The target reference (one is set, per `target_kind`). |
| `probe_keys` | string[] | Selected probes. Empty means all built-ins run. `custom:`-prefixed keys reference custom probes. |
| `judge_model_key` | string \| null | LLM judge for the campaign (also drives adaptive attacker turns). |

### Launch a scan

```http
POST /api/client/v1/redteam/campaigns/:key/scan
Authorization: Bearer cgt_…
```

Enqueues an asynchronous scan for the campaign identified by `:key` and returns immediately with a `pending` run. No request body is required. Poll the run-detail endpoint to watch it finish.

| Param | In | Required | Notes |
|---|---|---|---|
| `key` | path | yes | Campaign key. |

#### Response — `202 Accepted`

```json
{
  "run": {
    "id": "665f1a2b3c4d5e6f70819a2b",
    "campaign_key": "nightly-agent-scan",
    "target_kind": "agent",
    "target_ref": "support-agent",
    "status": "pending",
    "aggregate": null,
    "started_at": null,
    "finished_at": null,
    "created_at": "2026-06-15T12:00:00.000Z"
  },
  "status": "pending"
}
```

If a scan for the same campaign is already running, the request is rejected with `409 Conflict`.

### List runs

```http
GET /api/client/v1/redteam/runs?campaign_key=nightly-agent-scan&limit=20
Authorization: Bearer cgt_…
```

Returns run summaries (no per-attempt detail), newest first.

| Query | Type | Notes |
|---|---|---|
| `campaign_key` | string | Filter to one campaign. |
| `limit` | int | Max rows; clamped to `1..200`. |

#### Response

```json
{
  "runs": [
    {
      "id": "665f1a2b3c4d5e6f70819a2b",
      "campaign_key": "nightly-agent-scan",
      "target_kind": "agent",
      "target_ref": "support-agent",
      "status": "completed",
      "aggregate": {
        "total": 48,
        "completed": 48,
        "failed": 0,
        "vulnerable": 3,
        "safe": 43,
        "needsReview": 2,
        "attackSuccessRate": 0.0625,
        "resilienceScore": 0.9375,
        "bySeverity": { "low": 0, "medium": 1, "high": 2, "critical": 0 },
        "byCategory": {
          "LLM01-prompt-injection": { "total": 12, "vulnerable": 2, "needsReview": 0 },
          "LLM06-sensitive-information-disclosure": { "total": 8, "vulnerable": 1, "needsReview": 1 }
        },
        "avgLatencyMs": 742.0
      },
      "started_at": "2026-06-15T12:00:01.000Z",
      "finished_at": "2026-06-15T12:03:20.000Z",
      "created_at": "2026-06-15T12:00:00.000Z"
    }
  ]
}
```

`status` is one of `pending`, `running`, `completed`, `failed`, `cancelled`. `aggregate` is `null` until the run completes.

### Run detail

```http
GET /api/client/v1/redteam/runs/:id
Authorization: Bearer cgt_…
```

Returns the run summary plus `progress`, any fatal `error`, and the per-attempt verdicts.

#### Response

```json
{
  "run": {
    "id": "665f1a2b3c4d5e6f70819a2b",
    "campaign_key": "nightly-agent-scan",
    "target_kind": "agent",
    "target_ref": "support-agent",
    "status": "completed",
    "aggregate": { "...": "see List runs" },
    "started_at": "2026-06-15T12:00:01.000Z",
    "finished_at": "2026-06-15T12:03:20.000Z",
    "created_at": "2026-06-15T12:00:00.000Z",
    "progress": { "total": 48, "completed": 48, "failed": 0 },
    "error": null,
    "attempts": [
      {
        "probe_key": "prompt-injection",
        "attempt_id": "pi-003",
        "family": "prompt-injection",
        "category": "LLM01-prompt-injection",
        "severity": "high",
        "outcome": "vulnerable",
        "machine_outcome": "vulnerable",
        "decided_by": "deterministic-canary",
        "confidence": 0.97,
        "reviewed": false,
        "latency_ms": 810,
        "error": null
      }
    ]
  }
}
```

| Attempt field | Type | Notes |
|---|---|---|
| `outcome` | `safe \| vulnerable \| needs_review` | Effective verdict — a human review override, if present, wins. |
| `machine_outcome` | `safe \| vulnerable \| needs_review` | The engine's original verdict before any review. |
| `decided_by` | string | Which decision rule fired (audit trail). |
| `confidence` | number | Verdict confidence in `[0, 1]`. |
| `reviewed` | boolean | True when a human reviewed this attempt on the dashboard. |
| `latency_ms` | number | Target invocation latency. |
| `error` | string \| null | Set when the target invocation itself threw (counts toward `failed`). |

## Errors

| Status | Cause |
|---|---|
| 400 | Missing campaign `key` on a scan request. |
| 401 | Missing or invalid API token. |
| 404 | Campaign or run not found. |
| 409 | A scan for this campaign is already in progress. |
| 500 | Internal error. |

## Example

```bash
# Launch a scan and capture the run id
RUN_ID=$(curl -s -X POST \
  https://api.cognipeer.com/api/client/v1/redteam/campaigns/nightly-agent-scan/scan \
  -H "Authorization: Bearer cgt_your_token" | jq -r '.run.id')

# Poll until it finishes, then read the resilience score
curl -s https://api.cognipeer.com/api/client/v1/redteam/runs/$RUN_ID \
  -H "Authorization: Bearer cgt_your_token" \
  | jq '{status: .run.status, resilience: .run.aggregate.resilienceScore, vulnerable: .run.aggregate.vulnerable}'
```
