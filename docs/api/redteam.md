# Red Team API

Adversarial safety scanning for your agents and models. A campaign drives a set of probes (prompt injection, jailbreak, data extraction, …) against a target, an LLM judge decides each attempt, and the run reports an attack-success / resilience score per OWASP-LLM category — so a CI pipeline can fail when an agent regresses on safety.

The client surface (`/api/client/v1/redteam/*`) is read-and-trigger only: it lists the built-in probe catalog and configured campaigns, launches scans, and reads runs. Authoring campaigns and custom probes stays on the dashboard surface (`/api/redteam/*`). All client endpoints are API-token authenticated with a `cpeer_` bearer token and are scoped to the token's project.

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
- **Agent version** — an agent campaign has a default version for its scans: `published` (follows the published version), `draft`, or a pinned version number. A scan can ask for another for that run only (`agent_version`). Scanning needs write access to Agents. See [Choosing the agent version for a test](/guide/evaluation-and-analysis#choosing-the-agent-version-for-a-test).
- **Run** — one execution of a campaign. Each **attempt** gets a three-state verdict: `safe`, `vulnerable`, or `needs_review`. The run **aggregate** rolls those up into an `attackSuccessRate` (`vulnerable / completed`) and `resilienceScore` (`1 - attackSuccessRate`), broken down by severity and OWASP category. A run of an agent campaign records which version answered (`agent_revision`).

### List probes

```http
GET /api/client/v1/redteam/probes
Authorization: Bearer cpeer_…
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

OWASP-LLM categories used by the catalog: `LLM01-prompt-injection`, `LLM02-insecure-output-handling`, `LLM06-sensitive-information-disclosure`, `LLM08-excessive-agency`, `LLM09-overreliance`.

### List campaigns

```http
GET /api/client/v1/redteam/campaigns
Authorization: Bearer cpeer_…
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
      "agent_version": "published",
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
| `agent_version` | `"published" \| "draft" \| integer` | Agent campaigns only (left out for a model campaign): the version a scan attacks unless it asks for another. `"published"` follows the published version, `"draft"` is the saved draft, an integer is a pinned published version. A campaign with an enabled schedule is never `"draft"`. |
| `probe_keys` | string[] | Selected probes. Empty means all built-ins run. `custom:`-prefixed keys reference custom probes. |
| `judge_model_key` | string \| null | LLM judge for the campaign (also drives adaptive attacker turns). |

### Launch a scan

```http
POST /api/client/v1/redteam/campaigns/:key/scan
Authorization: Bearer cpeer_…
```

Enqueues an asynchronous scan for the campaign identified by `:key` and returns immediately with a `pending` run. The body is optional: an agent campaign scans its default version unless the body names another. Poll the run-detail endpoint to watch it finish.

| Param | In | Required | Notes |
|---|---|---|---|
| `key` | path | yes | Campaign key. |
| `agent_version` | body | no | `"published"`, `"draft"`, an integer `>= 1`, or digits in a string (`"3"`). Scans that version for this scan only, instead of the campaign's `agent_version`. Leave it out, or send `null`, to scan the campaign's default. Agent campaigns only. |

```json
{ "agent_version": "draft" }
```

No body, `{}` and a literal `null` all mean no override. A body that is not a JSON object, an invalid `agent_version`, or an `agent_version` sent for a campaign that targets a model, is rejected with `400` and starts nothing. An agent, or a version of it, that does not exist is `404`.

Scanning an agent campaign needs write access to Agents, whichever version it attacks and the draft included. The token's owner must hold it and the token's scope, if it has one, must include `agents` at `write`. Without it the request is refused with `403` before any run is created:

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

If the authorization engine cannot decide, the answer is `503` with `code: "authorization_unavailable"` and a `Retry-After` header. See [Decision ids](/guide/authorization#decision-ids).

#### Response — `202 Accepted`

```json
{
  "run": {
    "id": "665f1a2b3c4d5e6f70819a2b",
    "campaign_key": "nightly-agent-scan",
    "target_kind": "agent",
    "target_ref": "support-agent",
    "agent_revision": { "requested": "published" },
    "status": "pending",
    "aggregate": null,
    "started_at": null,
    "finished_at": null,
    "created_at": "2026-06-15T12:00:00.000Z"
  },
  "status": "pending"
}
```

`agent_revision` is on runs of agent campaigns only; see [Which version answered](#which-version-answered).

If a scan of the same campaign on the same agent version is already running, the request is rejected with `409 Conflict` (`A run for campaign "…" is already in progress on draft`). A scan of another version starts normally, so the draft and the published version can be scanned side by side. Versions are compared as they were asked for: `"published"` and `3` differ even when version 3 is the published one. A model campaign allows one scan at a time.

### List runs

```http
GET /api/client/v1/redteam/runs?campaign_key=nightly-agent-scan&limit=20
Authorization: Bearer cpeer_…
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
      "agent_revision": { "requested": "published", "version": 4 },
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

`status` is one of `pending`, `running`, `completed`, `failed`, `cancelled`. `aggregate` is `null` until the run completes. `agent_revision` is on runs of agent campaigns only; see [Which version answered](#which-version-answered).

### Run detail

```http
GET /api/client/v1/redteam/runs/:id
Authorization: Bearer cpeer_…
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
    "agent_revision": { "requested": "published", "version": 4 },
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

### Which version answered

A run of an agent campaign carries `agent_revision`, in the run list as well as in the detail: what the scan asked for and, once it starts, what answered. A run of a model campaign has none, and so does a run recorded before agent versions existed.

```json
"agent_revision": { "requested": "draft", "version": null, "draft_fingerprint": "3f2a9c1b04de", "draft_changed": true }
```

| Field | Type | Notes |
|---|---|---|
| `requested` | `"published" \| "draft" \| integer` | What the scan asked for: the `agent_version` of the request, else the campaign's default. Set when the run is created, so a `pending` run has only this. |
| `version` | integer \| `null` | The published version that answered. `null` when the draft answered, because it was asked for or because nothing is published yet. Absent until the run starts. |
| `draft_fingerprint` | string | When the draft answered: a short hash of the draft configuration the scan started on. |
| `draft_changed` | boolean | `true` when the draft was saved while the scan was going, so later attempts may have hit another configuration. Absent otherwise. |

`published` is turned into a number once, as the scan starts, so every attempt hits one snapshot even if a version is published halfway through. A pipeline can log `agent_revision.version` next to the score it gates on, and repeat a scan that ends with `draft_changed: true`.

A scan of the draft or of an older version counts like any other completed scan for the alert metrics (`redteam_resilience_score` and the others) and for the Red Team **Overview**. Only the EU AI Act compliance report leaves draft scans out; see [Red Team: schedules and the compliance report](/guide/evaluation-and-analysis#red-team-schedules-and-the-compliance-report).

## Default version of a campaign

A campaign's default version is what a scan attacks when its request names none. The client API only reads it (`agent_version` in [List campaigns](#list-campaigns)). It is set where campaigns are authored, on the dashboard API (`POST /api/redteam/campaigns` and `PATCH /api/redteam/campaigns/:id`, session-authenticated), with the `agentVersion` field:

| `agentVersion` | Default it stores |
|---|---|
| left out on create | Follows the published version |
| `"published"` or `null` | Follows the published version. On a PATCH this removes a pin or a draft default |
| an integer, or digits in a string (`"3"`) | That published version |
| `"draft"` | The saved draft |

Any other value is a `400` (`agentVersion must be "published", "draft" or a version number (1 or more)`). Only an agent campaign stores a version; the field is ignored for a model campaign.

- **A scheduled campaign cannot default to the draft.** Creating a campaign with an enabled `schedule` and `agentVersion: "draft"` answers `400` (`A scheduled scan guards what is published: pick Published or a version for agentVersion, or turn the schedule off.`). A PATCH is checked against the campaign as it will be after the change, so switching a schedule on for a campaign that defaults to the draft is refused too. A scan started by hand can still name the draft.
- **A PATCH changes only the fields it carries.** A field the body leaves out keeps its value. `null` clears `description`, `judgeModelKey` (a blank string clears it too) and `schedule`. `name`, `agentKey` and `modelKey` cannot be cleared: when sent, each must be non-empty text, or the answer is `400`.
- **Moving a campaign to another agent puts it back on the published version.** A version number belongs to one agent, so a PATCH with a new `agentKey` and no `agentVersion` stores `null` (follow the published version), and the schedule check above sees that. Send `agentVersion` with the new key to pin one.
- **Saving an agent campaign needs write access to Agents.** Creating or changing a campaign that targets an agent is refused with the same `403` as a scan, because a saved campaign can run the agent later on its schedule. On a PATCH the stored target decides, not the body. Deleting a campaign, and creating or changing a model campaign, need Red Team access only.
- **The scan endpoint of the dashboard** (`POST /api/redteam/campaigns/:key/scan`) takes the override as `agentVersion`, in camelCase (left out or `null`: the campaign's default), next to the other per-scan settings of the **Start scan** dialog. Its body is optional: no body, `{}` and a literal `null` override nothing, and a body that is not a JSON object answers `400`. It answers `202` with the raw run, `{ "run": { …, "agentRevision": { … } }, "status": "pending" }`.

See [Who can run an agent test](/guide/evaluation-and-analysis#who-can-run-an-agent-test) for the rule behind the `403`.

## Errors

| Status | Cause |
|---|---|
| 400 | Missing campaign `key` on a scan request. A body that is not a JSON object. An `agent_version` that is none of `"published"`, `"draft"` or a version number, or one sent for a campaign that targets a model. |
| 401 | Missing or invalid API token. |
| 403 | A scan of an agent campaign by a caller without write access to Agents (`code: "forbidden"`, `service: "agents"`, `required: "write"`). Nothing is created. |
| 404 | Campaign or run not found. The campaign's agent, or the `agent_version` asked for, does not exist (`Version 7 not found for agent "support-agent"`). |
| 409 | A scan of this campaign is already in progress on the same agent version. |
| 500 | Internal error. |
| 503 | The authorization engine could not decide (`code: "authorization_unavailable"`). Retry after the `Retry-After` header. |

## Example

```bash
# Launch a scan and capture the run id
RUN_ID=$(curl -s -X POST \
  https://console.cognipeer.com/api/client/v1/redteam/campaigns/nightly-agent-scan/scan \
  -H "Authorization: Bearer cpeer_your_token" | jq -r '.run.id')

# Poll until it finishes, then read the resilience score
curl -s https://console.cognipeer.com/api/client/v1/redteam/runs/$RUN_ID \
  -H "Authorization: Bearer cpeer_your_token" \
  | jq '{status: .run.status, resilience: .run.aggregate.resilienceScore, vulnerable: .run.aggregate.vulnerable}'
```

### In CI: scan the draft before you publish it

For an agent campaign the scan above attacks the campaign's default version. To check a change before publishing it, scan the saved draft instead and fail the build when it is less resilient than you accept. The override applies to this scan only, and the token's owner needs write access to Agents (see [Launch a scan](#launch-a-scan)).

```bash
# Scan the saved draft of the campaign's agent
RUN_ID=$(curl -s -X POST \
  https://console.cognipeer.com/api/client/v1/redteam/campaigns/nightly-agent-scan/scan \
  -H "Authorization: Bearer cpeer_your_token" \
  -H "Content-Type: application/json" \
  -d '{"agent_version": "draft"}' | jq -r '.run.id')

# Poll until the scan is over
while true; do
  RUN=$(curl -s https://console.cognipeer.com/api/client/v1/redteam/runs/$RUN_ID \
    -H "Authorization: Bearer cpeer_your_token")
  case "$(echo "$RUN" | jq -r '.run.status')" in completed|failed|cancelled) break ;; esac
  sleep 10
done

# Log what answered, then gate on the score
echo "$RUN" | jq '{status: .run.status, answered: .run.agent_revision, resilience: .run.aggregate.resilienceScore}'
echo "$RUN" | jq -e '.run.status == "completed" and .run.aggregate.resilienceScore >= 0.9' > /dev/null
```

To keep guarding one version while a newer one is prepared, pin it instead (an integer, or digits in a string). The scan then runs that version also after another is published:

```bash
curl -s -X POST \
  https://console.cognipeer.com/api/client/v1/redteam/campaigns/nightly-agent-scan/scan \
  -H "Authorization: Bearer cpeer_your_token" \
  -H "Content-Type: application/json" \
  -d '{"agent_version": 3}'
```

A scan of the draft and a scan of the published version can run side by side; a second scan of the same version while one is running answers `409`.
