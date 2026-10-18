# Agent Triggers

A **trigger** is a saved way of starting an agent: a prompt (with optional [variables](/api/agents#variables)) and a **type** that says what starts it, with that type's settings. Every time the trigger fires, it starts an ordinary [run](/guide/agent-background-execution) of the agent with that prompt. Triggers replace the per-agent schedules of earlier releases. An agent can have several triggers, each with one type: for example a schedule trigger for the nightly report and a webhook trigger for pull requests.

Several [agent templates](/guide/agent-templates) bring a suggested trigger (a weekly schedule, a GitHub or generic webhook). It is created **disabled**, so you can check it before it starts anything.

In Studio, **Ship → Triggers** lists an agent's triggers with their type, next and last fire; **Run now** fires one by hand and **Runs** opens its history. The same is on the API ([below](#api)).

For worked recipes (a pull request reviewer, a build triage agent, a nightly report) see the integration guides at [docs.cognipeer.com](https://docs.cognipeer.com), under **Integrations → Agents**. This page is the reference for what the platform does.

## Types

A trigger has a `type` and, except for `manual`, one settings object named after it: `schedule`, `once` or `webhook`. Only the object of the trigger's own type is present.

| `type` | Settings object | Fires | `next_fire_at` |
| --- | --- | --- | --- |
| `schedule` | `schedule: { cron, timezone }` | On a 5-field cron expression (minute hour day-of-month month day-of-week) evaluated in an IANA timezone (`Europe/Istanbul`; default `UTC`), so "09:00 on weekdays" stays 09:00 local across daylight-saving changes | The next slot |
| `once` | `once: { run_at }` or, when saving, `once: { delay_seconds }` | One time: `run_at` (ISO-8601 or unix seconds) or `delay_seconds` | The set time, until it fired; none after |
| `manual` | none | Only by **Run now** or the API (the default for a new trigger) | none |
| `webhook` | `webhook: { url, preset, auth, … }` | When an [incoming webhook](#webhook-triggers) delivery arrives | none |

One trigger has one type. Switching a trigger away from `webhook` drops its URL and its `webhook` object: the old address answers `404`.

### Schedule

The scheduler ticks every `AGENT_TRIGGER_TICK_MS` (30 seconds, minimum 5) **on every node**, and the database picks one winner for each slot, so a slot starts exactly one run however many replicas there are. A slot that was missed (the server was down) fires once to catch up if it is not older than `AGENT_TRIGGER_MISFIRE_GRACE_MS` (1 hour); older slots are skipped. A fire that is refused (run cap, spend limit, quota) is skipped, not retried: the next slot waits for its own time. A trigger whose saved variables no longer match what its agent declares records the fire as failed instead of starting a run.

## What a fire does

- It starts a **queued** run (`channel: "trigger"`, `trigger_id` naming this trigger, and `trigger` saying what started the fire: `"schedule" | "once" | "manual" | "webhook"`) in the trigger's `class`, `version` (a published version number; empty = the published one), `metadata`, `response_format` and `callback`. Nothing waits on it: its answer is the run.
- Its idempotency key is `trigger:<triggerId>:<slot>`, which is why one slot never starts two runs.
- Its **variables** are the trigger's own `variables`, checked against what the agent (the trigger's pinned `version`, else the published one) declares **at fire time**, with defaults applied. A trigger is the natural home for them: a schedule sends the same fixed values on every fire, a webhook trigger maps event fields onto them. Nothing is carried from one fire to the next: each fire is its own run in its own session. A fire whose variables no longer fit the declaration (a renamed variable, a new required one without a default) starts no run and records `last_error` as `invalid variables: <field>: <message>`.
- Every fire is a **new session**, owned by a synthetic actor (`system:trigger:<id>`, shown as *Trigger*), not by a person or a token.
- **Whose limits it counts against.** The session belongs to the trigger, but a fire is accountable to a person: its spend limits, quota, run limits and usage are counted against the trigger's **last updater** (whoever last changed it), or its **creator** until somebody changes it, for the `schedule`, `once` and `webhook` types. **Run now** counts against the person who pressed it, and the API token they used. Change who a trigger's spend shows up under by saving the trigger as that person. The session owner stays `system:trigger:<id>`.
- It is an **unattended** run: nobody is there to answer. A tool that would ask for approval follows the agent's *When nobody can answer* setting ([approvals](/guide/agent-approvals#unattended-runs)): denied by default, or paused in the session until someone answers it in Studio, or allowed. Client tools and questions are not offered.
- The result of the fire is on the trigger: `last_status` (`started` or `failed`), `last_run_id`, `last_error`, `last_fire_at`. A skipped, refused or duplicate fire does not change them.
- Webhook subscriptions get [`trigger.fired`](/guide/webhooks) when a run started, and `trigger.failed` when it could not (once per trigger and reason an hour).

## API

The client API (`/api/client/v1`, the **Agents** service) and the dashboard (`/api/agents/{agentId}/…`) have the same set:

| Call | |
| --- | --- |
| `GET`, `POST /agents/{agentKey}/triggers` | List, create. |
| `GET`, `PATCH`, `DELETE /agents/{agentKey}/triggers/{triggerId}` | Read, change, delete. A PATCH sends `type` together with its settings object (a settings object without its `type`, or one of another type, is `400`); sending the stored type and settings back unchanged keeps the timing. |
| `POST …/triggers/{triggerId}/run` | **Run now**: one fire (its run has `trigger: "manual"`). The body may override `variables` and `metadata`; `wait` (or `Prefer: wait=N`) holds the call like the [runs API](/guide/agent-background-execution#the-runs-api) does; the client API takes `Idempotency-Key`. Answers `200` with a finished run, `202` with a running one, `429` with `Retry-After` when a cap or limit refuses it. The wait stops if the client disconnects (the run carries on). |
| `GET /agents/runs?trigger_id=…` | History: the runs the trigger started. |

```bash
curl -X POST "$BASE/api/client/v1/agents/support-bot/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Weekday digest",
    "type": "schedule",
    "schedule": { "cron": "0 9 * * 1-5", "timezone": "Europe/Istanbul" },
    "prompt": "Summarize yesterday'\''s open tickets.",
    "class": "deferred",
    "metadata": { "team": "support" }
  }'
```

A trigger, as returned (timestamps are unix seconds):

```json
{
  "id": "6710…", "object": "agent.trigger", "agent": "support-bot", "name": "Weekday digest",
  "description": null, "enabled": true,
  "type": "schedule", "schedule": { "cron": "0 9 * * 1-5", "timezone": "Europe/Istanbul" },
  "prompt": "Summarize yesterday's open tickets.", "variables": null, "version": null, "class": "deferred",
  "metadata": { "team": "support" }, "callback": null, "response_format": null,
  "next_fire_at": 1760000000, "last_fire_at": null, "last_run_id": null, "last_status": null, "last_error": null,
  "created_at": 1759990000, "updated_at": 1759990000
}
```

The fields: `name` (at most 200 characters), `description`, `enabled`, `type` and its settings object (`schedule`, `once` or `webhook`; `manual` has none, and `type` defaults to `manual` on create), `prompt` (at most 32 000 characters; may be empty when the agent declares [variables](/api/agents#variables) and the trigger gives them), `variables`, `version`, `class` (`default` or `deferred`), `metadata`, `callback` (`{ url, secret? }`; the secret is write-only and the trigger shows `signed`) and `response_format`. A disabled trigger does not fire, and a fire for an agent that is not active fails (`last_error`: *agent is not active*). Deleting an agent deletes its triggers.

## Webhook triggers

A trigger of type `webhook` starts when something posts to its URL: a pull request opened on GitHub, a build that failed in GitLab or Azure DevOps, an alert from a monitoring tool, any system that can send an HTTP request.

```http
POST /api/public/hooks/{tenantId}/{hookId}
```

The URL is shown on the trigger, and **no API token is used**: the URL names the trigger and each delivery proves the trigger's **secret**. The secret is generated when the trigger becomes a webhook one and shown **once** (`webhook.secret` in the answer that created or replaced it); after that only its last four characters are (`webhook.secret_hint`). For the one case where the sender generates it (Standard Webhooks, `whsec_…`), you paste it in.

A webhook trigger is created with `type: "webhook"` and a `webhook` object; the answer carries the same object, with the URL and, once, the generated secret:

```bash
curl -X POST "$BASE/api/client/v1/agents/code-reviewer/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "PR reviewer",
    "type": "webhook",
    "webhook": {
      "preset": "github",
      "events": ["pull_request"],
      "filter": [{ "path": "payload.action", "op": "in", "value": ["opened", "reopened"] }]
    },
    "prompt": "Review pull request #{{payload.number}} in {{payload.repository.full_name}}."
  }'
```

```json
{
  "id": "6710…", "object": "agent.trigger", "name": "PR reviewer", "type": "webhook",
  "webhook": {
    "url": "https://console.example.com/api/public/hooks/<tenantId>/wh_…", "preset": "github", "auth": "github_signature",
    "header_name": null, "secret": "whsec_…", "secret_hint": "…", "secret_source": "generated",
    "previous_secret_valid_until": null, "events": ["pull_request"], "filter": [ … ], "include_payload": true
  },
  …
}
```

In a request the `webhook` object takes `preset` (required until the trigger is a webhook one), `auth` (the preset's first mode by default), `header_name` (for `auth: "header"`), `secret` (only for `standard_webhooks`: the sender's), `events`, `filter` and `include_payload`; fields left out keep their stored values on a PATCH. `webhook.secret` is in the answer that created or replaced a generated secret and nowhere else.

| Preset | Authentication | Event name | Delivery id |
| --- | --- | --- | --- |
| `github` | `github_signature`: `X-Hub-Signature-256` over the raw body | `X-GitHub-Event` | `X-GitHub-Delivery` |
| `gitlab` | `gitlab_token` (`X-Gitlab-Token`) or `standard_webhooks` | the payload's `object_kind` / `X-Gitlab-Event` | `webhook-id` / `Idempotency-Key` |
| `azure_devops` | `basic` (any user, the secret as password; needs HTTPS) or `header` | the payload's `eventType` | the payload's `id` |
| `generic` | `bearer`, `signature` (`x-cognipeer-signature: t=…,v1=…` over `"<t>.<body>"`, within 300 seconds), `header` or `standard_webhooks` | the payload's `event` / `type`, `X-Cognipeer-Event` | `X-Cognipeer-Event-Id`, `webhook-id`, `Idempotency-Key` |

The body must be JSON (`application/json`; GitHub's *Content type* has to be set to it): anything else is `415`.

**What starts a run.** After authentication a delivery passes, in order: the trigger and its agent must be active; the `events` allow-list (event names; empty = all) and the `filter` (up to 20 rules, all must match, each a `path`, an operator and a value over `payload.…`, `headers.…` and `event`; operators `eq`, `neq`, `in`, `not_in`, `exists`, `not_exists`, `contains`, `starts_with`, `glob`); de-duplication; the run rate. The event allow-list is a convenience: GitHub's event name travels in an unsigned header, so put every condition that matters (who opened it, which branch) in a `payload.…` filter rule.

**The turn.** The trigger's `prompt` is a template (Mustache; <span v-pre>`{{payload.pull_request.number}}`</span>, <span v-pre>`{{event}}`</span>, …; the other types send the prompt as written) over the event, with every inserted value written as JSON so it cannot add lines or fake sections. The message starts with a fixed notice that what follows comes from an external event and is information, not instructions, then the rendered prompt, then (with `include_payload`, the default) the payload as a JSON block of at most 32 KiB. `variables` map event values to the agent's declared variables (<span v-pre>`{{payload.number}}`</span>). Event-derived variables are never put into the agent's system prompt: they reach the model only in the message, after which the platform adds `End of external data.` The instructions still read what the platform supplied itself: the agent's declared defaults and the variables the trigger sets to a fixed value (a value that is not a tag), as <span v-pre>`{{variables.<name>}}`</span>. Each delivery starts a new session; runs get `trigger: "webhook"` and the metadata `webhook_event` and `webhook_delivery`. No request header is turned into the run's runtime context.

**What the sender is told.**

| Situation | Answer |
| --- | --- |
| Run started | `202 { "accepted": true, "run_id": "run_…", "status": "queued" }` |
| GitHub `ping`, Azure DevOps test notification | `200 { "ok": true, "event": … }`, no run |
| Disabled, event not selected, filtered, duplicate | `200 { "accepted": false, "reason": … }` |
| Bad or missing credentials | `401` (before the body is read for header modes) |
| Unknown or switched-off URL | `404` |
| Body too large, not JSON | `413` (above `AGENT_WEBHOOK_BODY_LIMIT_BYTES`, 5 MiB), `415`, `400 invalid_json` |
| Run rate, run cap, spend limit, quota | `429` with `Retry-After` for `github` and `generic`; `200 { "accepted": false, … }` for `gitlab` and `azure_devops`, whose senders switch a hook off after repeated failures |
| Variables or template do not resolve | `400` for `github` and `generic`; `200 accepted: false` for the other two |

**Duplicates.** A redelivery of a delivery that already started a run (or is still running) answers `200 duplicate` and starts nothing; a redelivery of one whose run **failed or was canceled** starts a new run, up to a small bound. Duplicates are recognised by the delivery id or the body (a generic sender without a delivery id is never de-duplicated). The window is the life of the run record (`AGENT_RUN_RETENTION_DAYS`, 30 days, counted from when the run finished).

**Limits.** `AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE` (60, `0` = off) caps the runs one webhook trigger starts a minute, counted per node unless `RATE_LIMIT_PROVIDER=redis`. A flood from many addresses is for your ingress or WAF to stop: the senders above share addresses. Use the **Deferred** class for busy hooks.

**Operating it.**

| Call | |
| --- | --- |
| `POST …/triggers/{id}/webhook/rotate-secret` | New secret, shown once. `grace_seconds` (0–86400, default 0) keeps the old secret accepted that long; for Standard Webhooks send the sender's new `secret`. Update the sender in the same step: a hook that starts failing can be disabled by its provider. |
| `POST …/triggers/{id}/run` with `payload` (and `headers`) | **Run with this payload**: builds the turn a delivery would (without applying events and filter, without de-duplication) and starts a `manual` run. With `dry_run: true` it only evaluates the events and filter and returns `{ matched, reason, event, prompt, variables, errors }`. Studio's **Test** tab uses it. |
| `GET …/triggers/{id}/deliveries` | The delivery log of the last 7 days, newest first (`limit` 1–100, `before` = a delivery id): time, `outcome` (`accepted`, `duplicate`, `filtered`, `ignored`, `unauthorized`, `rejected`, `failed`), HTTP status, event, run, a short reason (never payload text). |

Studio's trigger editor guides the same setup (preset cards, events and filter rows with examples, the prompt template, the **Connect** card with the URL and secret) and has the **Test** and **Deliveries** tabs.
