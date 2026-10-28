# Agent Triggers

A **trigger** is a saved way of starting an agent: a prompt (with optional [variables](/api/agents#variables)) and a **type** that says what starts it, with that type's settings. Every time the trigger fires, it starts an ordinary [run](/guide/agent-background-execution) of the agent with that prompt. Triggers replace the per-agent schedules of earlier releases. An agent can have several triggers, each with one type: for example a schedule trigger for the nightly report and a connector trigger for pull requests.

Several [agent templates](/guide/agent-templates) bring a suggested trigger (a weekly schedule, a generic webhook, an event of a connector such as GitHub). It is created **disabled**, so you can check it before it starts anything.

In Studio, **Ship → Triggers** lists an agent's triggers with their type, next and last fire; **Run now** fires one by hand and **Runs** opens its history. The same is on the API ([below](#api)).

For worked recipes (a pull request reviewer, a build triage agent, a nightly report) see the integration guides at [docs.cognipeer.com](https://docs.cognipeer.com), under **Integrations → Agents**. This page is the reference for what the platform does.

## Types

A trigger has a `type` and, except for `manual`, one settings object named after it: `schedule`, `once`, `webhook` or `connector`. Only the object of the trigger's own type is present.

| `type` | Settings object | Fires | `next_fire_at` |
| --- | --- | --- | --- |
| `schedule` | `schedule: { cron, timezone }` | On a 5-field cron expression (minute hour day-of-month month day-of-week) evaluated in an IANA timezone (`Europe/Istanbul`; default `UTC`), so "09:00 on weekdays" stays 09:00 local across daylight-saving changes | The next slot |
| `once` | `once: { run_at }` or, when saving, `once: { delay_seconds }` | One time: `run_at` (ISO-8601 or unix seconds) or `delay_seconds` | The set time, until it fired; none after |
| `manual` | none | Only by **Run now** or the API (the default for a new trigger) | none |
| `webhook` | `webhook: { url, preset, auth, … }` | When an [incoming webhook](#webhook-triggers) delivery arrives | none |
| `connector` | `connector: { connector_id, trigger, params, … }` | When a [connector](#connector-triggers) reports an event (the service pushes it, or the connector finds it by polling). Needs the Connectors module | none |

One trigger has one type. Switching a trigger away from `webhook` drops its URL and its `webhook` object: the old address answers `404`. Switching one away from `connector` releases its subscription at the connector (the vendor hook is removed when no other trigger uses it).

### Schedule

The scheduler ticks every `AGENT_TRIGGER_TICK_MS` (30 seconds, minimum 5) **on every node**, and the database picks one winner for each slot, so a slot starts exactly one run however many replicas there are. A slot that was missed (the server was down) fires once to catch up if it is not older than `AGENT_TRIGGER_MISFIRE_GRACE_MS` (1 hour); older slots are skipped. A fire that is refused (run cap, spend limit, quota) is skipped, not retried: the next slot waits for its own time. A trigger whose saved variables no longer match what its agent declares records the fire as failed instead of starting a run.

## What a fire does

- It starts a **queued** run (`channel: "trigger"`, `trigger_id` naming this trigger, and `trigger` saying what started the fire: `"schedule" | "once" | "manual" | "webhook" | "connector"`) in the trigger's `class`, `version` (a published version number; empty = the published one), `metadata`, `response_format` and `callback`. Nothing waits on it: its answer is the run.
- Its idempotency key is `trigger:<triggerId>:<slot>`, which is why one slot never starts two runs.
- Its **variables** are the trigger's own `variables`, checked against what the agent (the trigger's pinned `version`, else the published one) declares **at fire time**, with defaults applied. A trigger is the natural home for them: a schedule sends the same fixed values on every fire, a webhook or connector trigger maps event fields onto them. Nothing is carried from one fire to the next: each fire is its own run in its own session. A fire whose variables no longer fit the declaration (a renamed variable, a new required one without a default) starts no run and records `last_error` as `invalid variables: <field>: <message>`.
- Every fire is a **new session**, owned by a synthetic actor (`system:trigger:<id>`, shown as *Trigger*), not by a person or a token.
- **Whose limits it counts against.** The session belongs to the trigger, but a fire is accountable to a person: its spend limits, quota, run limits and usage are counted against the trigger's **last updater** (whoever last changed it), or its **creator** until somebody changes it, for the `schedule`, `once`, `webhook` and `connector` types. **Run now** counts against the person who pressed it, and the API token they used. Change who a trigger's spend shows up under by saving the trigger as that person. The session owner stays `system:trigger:<id>`.
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

The fields: `name` (at most 200 characters), `description`, `enabled`, `type` and its settings object (`schedule`, `once`, `webhook` or `connector`; `manual` has none, and `type` defaults to `manual` on create), `prompt` (at most 32 000 characters; may be empty when the agent declares [variables](/api/agents#variables) and the trigger gives them), `variables`, `version`, `class` (`default` or `deferred`), `metadata`, `callback` (`{ url, secret? }`; the secret is write-only and the trigger shows `signed`) and `response_format`. A disabled trigger does not fire, and a fire for an agent that is not active fails (`last_error`: *agent is not active*). Deleting an agent deletes its triggers.

## Webhook triggers

A trigger of type `webhook` starts when something posts to its URL: a build that failed in your CI, an alert from a monitoring tool, a form, any system that can send an HTTP request and that you set up yourself. For a service that has a [connector](#connector-triggers) (GitHub, GitLab, Azure DevOps and others), use a connector trigger instead: it registers the hook at the service for you and knows the service's events.

```http
POST /api/public/hooks/{tenantId}/{hookId}
```

The URL is shown on the trigger, and **no API token is used**: the URL names the trigger and each delivery proves the trigger's **secret**. The secret is generated when the trigger becomes a webhook one and shown **once** (`webhook.secret` in the answer that created or replaced it); after that only its last four characters are (`webhook.secret_hint`). For the one case where the sender generates it (Standard Webhooks, `whsec_…`), you paste it in.

A webhook trigger is created with `type: "webhook"` and a `webhook` object; the answer carries the same object, with the URL and, once, the generated secret:

```bash
curl -X POST "$BASE/api/client/v1/agents/incident-bot/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Ticket created",
    "type": "webhook",
    "webhook": {
      "preset": "generic",
      "auth": "bearer",
      "events": ["ticket.created"],
      "filter": [{ "path": "payload.ticket.priority", "op": "in", "value": ["high", "urgent"] }]
    },
    "prompt": "Triage ticket {{payload.ticket.id}}: {{payload.ticket.title}}."
  }'
```

```json
{
  "id": "6710…", "object": "agent.trigger", "name": "Ticket created", "type": "webhook",
  "webhook": {
    "url": "https://console.example.com/api/public/hooks/<tenantId>/wh_…", "preset": "generic", "auth": "bearer",
    "header_name": null, "secret": "whsec_…", "secret_hint": "…", "secret_source": "generated",
    "previous_secret_valid_until": null, "retired": false, "events": ["ticket.created"], "filter": [ … ], "include_payload": true
  },
  …
}
```

In a request the `webhook` object takes `preset` (`generic`, the only one), `auth` (`bearer` by default), `header_name` (for `auth: "header"`), `secret` (only for `standard_webhooks`: the sender's), `events`, `filter` and `include_payload`; fields left out keep their stored values on a PATCH. `webhook.secret` is in the answer that created or replaced a generated secret and nowhere else.

| `auth` | How the sender proves itself |
| --- | --- |
| `bearer` | `Authorization: Bearer <secret>` |
| `signature` | `x-cognipeer-signature: t=…,v1=…`, an HMAC-SHA256 of `"<t>.<body>"` with the secret, within 300 seconds |
| `header` | the secret in the header named by `header_name` (default `x-cognipeer-token`) |
| `standard_webhooks` | [Standard Webhooks](https://www.standardwebhooks.com) headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) signed with the sender's `whsec_…` secret |

The event name is the payload's `event` or `type`, else the `X-Cognipeer-Event` header; the delivery id is `X-Cognipeer-Event-Id`, `webhook-id` or `Idempotency-Key`. The body must be JSON (`application/json`): anything else is `415`.

**What starts a run.** After authentication a delivery passes, in order: the trigger and its agent must be active; the `events` allow-list (event names; empty = all) and the `filter` (up to 20 rules, all must match, each a `path`, an operator and a value over `payload.…`, `headers.…` and `event`; operators `eq`, `neq`, `in`, `not_in`, `exists`, `not_exists`, `contains`, `starts_with`, `glob`); de-duplication; the run rate. The event allow-list is a convenience: an event name that travels in an unsigned header can be set by anyone who has the secret, so put every condition that matters (who opened it, which branch) in a `payload.…` filter rule.

**The turn.** The trigger's `prompt` is a template (Mustache; <span v-pre>`{{payload.ticket.id}}`</span>, <span v-pre>`{{event}}`</span>, …; the other types send the prompt as written) over the event, with every inserted value written as JSON so it cannot add lines or fake sections. The message starts with a fixed notice that what follows comes from an external event and is information, not instructions, then the rendered prompt, then (with `include_payload`, the default) the payload as a JSON block of at most 32 KiB. `variables` map event values to the agent's declared variables (<span v-pre>`{{payload.number}}`</span>). Event-derived variables are never put into the agent's system prompt: they reach the model only in the message, after which the platform adds `End of external data.` The instructions still read what the platform supplied itself: the agent's declared defaults and the variables the trigger sets to a fixed value (a value that is not a tag), as <span v-pre>`{{variables.<name>}}`</span>. Each delivery starts a new session; runs get `trigger: "webhook"` and the metadata `webhook_event` and `webhook_delivery`. No request header is turned into the run's runtime context.

**What the sender is told.**

| Situation | Answer |
| --- | --- |
| Run started | `202 { "accepted": true, "run_id": "run_…", "status": "queued" }` |
| Disabled, event not selected, filtered, duplicate | `200 { "accepted": false, "reason": … }` |
| Bad or missing credentials | `401` (before the body is read for header modes) |
| Unknown or switched-off URL | `404` |
| Retired vendor preset ([below](#vendor-presets-were-retired)) | `410 webhook_preset_retired`, before authentication |
| Body too large, not JSON | `413` (above `AGENT_WEBHOOK_BODY_LIMIT_BYTES`, 5 MiB), `415`, `400 invalid_json` |
| Run rate, run cap, spend limit, quota | `429` with `Retry-After` |
| Variables or template do not resolve | `400` |

**Duplicates.** A redelivery of a delivery that already started a run (or is still running) answers `200 duplicate` and starts nothing; a redelivery of one whose run **failed or was canceled** starts a new run, up to a small bound. Duplicates are recognised by the delivery id or the body (a generic sender without a delivery id is never de-duplicated). The window is the life of the run record (`AGENT_RUN_RETENTION_DAYS`, 30 days, counted from when the run finished).

**Limits.** `AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE` (60, `0` = off) caps the runs one webhook trigger starts a minute, counted per node unless `RATE_LIMIT_PROVIDER=redis`. A flood from many addresses is for your ingress or WAF to stop. Use the **Deferred** class for busy hooks.

**Operating it.**

| Call | |
| --- | --- |
| `POST …/triggers/{id}/webhook/rotate-secret` | New secret, shown once. `grace_seconds` (0–86400, default 0) keeps the old secret accepted that long; for Standard Webhooks send the sender's new `secret`. Update the sender in the same step. |
| `POST …/triggers/{id}/run` with `payload` (and `headers`) | **Run with this payload**: builds the turn a delivery would (without applying events and filter, without de-duplication) and starts a `manual` run. With `dry_run: true` it only evaluates the events and filter and returns `{ matched, reason, event, prompt, variables, errors }`. Studio's **Test** tab uses it. |
| `GET …/triggers/{id}/deliveries` | The delivery log of the last 7 days, newest first (`limit` 1–100, `before` = a delivery id): time, `outcome` (`accepted`, `duplicate`, `filtered`, `ignored`, `unauthorized`, `rejected`, `failed`), HTTP status, event, run, a short reason (never payload text). |

Studio's trigger editor guides the same setup (authentication, events and filter rows, the prompt template, the **Connect** card with the URL and secret) and has the **Test** and **Deliveries** tabs.

### Vendor presets were retired

Earlier releases had `github`, `gitlab` and `azure_devops` presets with their own signature checks. They are gone: the only preset is `generic`, and a vendor is reached through its [connector](#connector-triggers) instead, which also registers the hook at the vendor.

A trigger saved with one of the old presets stays in the list, read-only, so nothing is lost:

- It is marked `webhook.retired: true` (Studio shows a **Retired** badge) and receives nothing: its URL answers `410` `{ "error": { "type": "gone", "code": "webhook_preset_retired", … } }` before authentication, and **Run now** and **rotate-secret** answer `410` too.
- A write that names a retired `preset` or `auth` (`github_signature`, `gitlab_token`, `basic`) is `400`.
- **Migrate it** by changing its type: PATCH it to `type: "connector"` with the `connector` object (keep `prompt`, `variables`, `filter` and `include_payload`: they carry over as they are, but rewrite the filter paths and the template tags for the connector's event: its `payload` is the package's flat data (`payload.draft`, not the vendor's `payload.pull_request.draft`) and a connector event has no vendor `headers` or `preset`). Studio does this with **Convert to connector trigger**, which opens the editor with those fields filled in and marks the carried-over filter rows that read `headers` or `preset`: a rule that can never match a connector event, and a rule that matches every connector event and so filters nothing (for example a header that must not exist, or `preset` equal to `connector`). Or PATCH it to `type: "webhook"` with `webhook: { "preset": "generic", … }` to turn it into a generic webhook with a new URL and secret (the old URL stops existing).
- Delete it when it is no longer wanted.

**Which events the connectors cover.** A retired preset took any event its vendor sent; a connector trigger takes the events its package declares, and the events are picked again from that list when you convert. The packages that replace the presets offer these triggers (the connector page lists the fields of each; `name.{a, b}` stands for the event types `name.a` and `name.b`):

| Retired preset | Package | Triggers and their event types |
| --- | --- | --- |
| `github` | GitHub (`cognipeer.github`) | `pull_request.{opened, edited, closed, reopened, synchronize, ready_for_review, converted_to_draft, labeled, unlabeled, assigned, unassigned, review_requested, review_request_removed}`, `issues.{opened, edited, closed, reopened, labeled, unlabeled, assigned, unassigned, deleted, transferred}`, `issue_comment.{created, edited, deleted}`, `push`, `workflow_run.{requested, in_progress, completed}` |
| `gitlab` | GitLab (`cognipeer.gitlab`) | `merge_request.{open, update, close, reopen, merge, approved, unapproved, approval, unapproval}`, `push`, `pipeline.{created, pending, running, success, failed, canceled, skipped, manual}`, `note` |
| `azure_devops` | Azure DevOps (`cognipeer.azure-devops`) | The triggers `pull_request_created` (event `git.pullrequest.created`), `pull_request_updated` (`git.pullrequest.updated`), `build_completed` (`build.complete`) and `code_pushed` (`git.push`) |

Any other event of these vendors (for example GitHub's `pull_request_review`, `check_run` or `release`, GitLab's `issue` and `tag_push`, or the work item events of Azure DevOps) has no connector trigger yet: it cannot be picked, and a PATCH that names an event the trigger does not report is `400` on `connector.events`. A **generic** webhook trigger remains for any sender that can use one of its authentication modes (`bearer`, `header`, `signature` or `standard_webhooks`). Those modes do not read a vendor's own signature or token (GitHub's `X-Hub-Signature-256`, GitLab's `X-Gitlab-Token`, the basic credentials of Azure DevOps), so they are not a way to receive these vendors' own deliveries.

## Connector triggers

A trigger of type `connector` starts when a connector reports an event: a pull request opened in GitHub, an issue changed in a tracker, a new row in a table. The connector's package declares its **triggers** (what can be listened to, with which parameters and which event types); the trigger on the agent says which connector, which package trigger, with what parameters, and what to do with the event. Connector triggers need the **Connectors** module (Enterprise): without it they can be read but not created.

There are two kinds, set by the package trigger:

| Kind | How events arrive | Registration |
| --- | --- | --- |
| `webhook` | The service **pushes** the event to the connector's callback URL. | Automatic when the package can register the hook at the service with the connector's account; otherwise **manual**: the trigger shows the callback URL and a secret (once) and the steps to paste them into the service's settings. |
| `poll` | The connector **checks** the service on a cron `schedule` (default from the package, never more often than the package allows) and reports what is new. | None. The first check only notes where it is; events from before it are not reported. Editing only the schedule of a trigger does not start over: the new schedule goes on from where the check was, so nothing that happened meanwhile is lost. Changing the connector, the trigger or its parameters is another source and takes a new first check, and so does switching every trigger on the poll off (see below). |

**The schedule of a poll.** A connector `schedule` takes a five-field cron expression (minute, hour, day of month, month, day of week), read in the schedule's IANA `timezone` (default `UTC`). Each field accepts `*`, numbers, ranges (`9-17`), lists (`1,15`) and steps (`*/10`, `9-17/2`); the month and the day of week also accept names (`jan`, `mon-fri`), and `7` is Sunday as well as `0`. When both day fields are restricted, a day matches when either does. Syntax that some cron dialects add is not accepted here: `L`, `W`, `#` and `?`, macros such as `@daily`, and a seconds field. The cron must not fire more often than the package allows (the shortest gap over a year is compared with the package's minimum interval). A trigger of type `schedule` is not affected: it keeps the cron rules of its own type (see [Schedule](#schedule)).

A cron a connector schedule cannot take is `400` on `connector.schedule.cron`, and nothing is stored. The Connectors module judges it first, before the console's own cron reader does, and its message says what is wrong:

| The cron | The message of the `400` |
| --- | --- |
| Is not five fields: a macro (`@daily`), a seconds field (`0 0 9 * * *`), four, six or seven fields, words | `cron must be a five-field cron expression (minute hour day-of-month month day-of-week)` |
| Has five fields and an item of another dialect: `L`, `W`, `#` or `?` (`0 9 L * *`, `0 9 15W * *`, `0 9 * * 5#2`, `0 9 ? * 1`) | `cron uses syntax connector schedules do not support (L, W, # or ?); use numbers, ranges, lists, steps and month or weekday names` |
| Has a value that is out of range or not a name (`60 * * * *`, `0 9 * * 8`, `*/0 * * * *`, `0 9 * * 5-1`, `0 9 * * funday`) | `cron has a value that is out of range or not a name: minute 0-59, hour 0-23, day 1-31, month 1-12 or jan-dec, weekday 0-7 or sun-sat` |
| Is read, but runs more often than the package allows | `cron runs every N minutes, below the M minutes this trigger allows` (N is its shortest gap, M the package's minimum) |
| Is read, but has no run in the timezone (`0 0 31 2 *`, the 31st of February) | `cron cannot be evaluated in this timezone` |

Studio's schedule field shows the same problems while you type, in the language of the page, and the server's sentence after a refused save. The console's own cron reader, which runs the schedule, reads the cron once more after the module took it. The module refuses what that reader cannot read, so you get the sentences above, and only an expression that reader still refuses is answered in its own words (`invalid cron expression: …`).

**Editing a poll's schedule.** A PATCH that leaves `schedule` out keeps the stored schedule. `schedule: null` returns the poll to the package's own schedule, in UTC, which is also what a new trigger gets when it names none. Studio sends `null` when you clear the schedule field of a saved poll trigger, and shows the schedule that was stored after each save. The place of the check is carried over in the memory of the node that handles the edit, for two minutes. If the new schedule cannot be set up at once and **Retry** reaches another node, or comes after more than two minutes, the poll takes a new first check instead. One narrow limit remains: an edit that lands while the check of the old schedule is handing out a page of events can run that page's events once more, because a run is de-duplicated per subscription and the new schedule is a new subscription. A page held for a run limit (see *Duplicates and limits* below) moves with the edit and starts nothing twice.

**Switching a poll off and on.** A trigger that is switched off ignores what happens, as a webhook trigger does, and a poll looks only while a trigger on it is switched on. When a scheduled check finds every trigger on the poll switched off, it calls nothing and the poll forgets its place (and a page it was holding for a run limit). A trigger switched on after that starts from then: its first check, taken at the next tick of the poller (a minute by default) and not at the next slot of the `schedule`, only notes where the service is, so nothing from before is reported. A trigger switched off and on again before the next scheduled check keeps the place, and that check reports what happened meanwhile, because it is the check that forgets. A poll that another trigger still has switched on keeps its place whatever the others do, and a `paused` poll keeps its place and catches up when it is back.

A trigger is created with `type: "connector"` and a `connector` object; the connector must be in the same project:

```bash
curl -X POST "$BASE/api/client/v1/agents/code-reviewer/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "PR reviewer",
    "type": "connector",
    "connector": {
      "connector_id": "6710…",
      "trigger": "pull_request",
      "params": { "repository": "acme/api" },
      "events": ["pull_request.opened", "pull_request.synchronize"],
      "filter": [{ "path": "payload.draft", "op": "eq", "value": false }],
      "include_payload": true
    },
    "prompt": "Review pull request {{payload.number}} in {{payload.repository}}."
  }'
```

**The event's data is the package's, not the vendor's.** A package shapes what it reports: the GitHub package's `pull_request` event is the flat `{ action, repository, number, title, body, draft, url, author, baseBranch, headBranch, headSha, labels … }` (`repository` is the text `owner/name`), its `workflow_run` event is `{ action, repository, runId, name, conclusion, branch, headSha, url … }`; it is not GitHub's own request body, so `payload.pull_request.draft` or `payload.repository.full_name` do not exist. The connector page lists the fields of each trigger, and the Studio **Test** tab shows the sample event you can write the `filter` and the `prompt` against. A path the event does not carry is absent, and an absent path matches only `not_exists`: a filter on a wrong name lets no event through.

| `connector` field | |
| --- | --- |
| `connector_id`, `trigger` | The connector (id) and one trigger its package declares. Required. |
| `params` | The trigger's parameters, as the package declares them (a repository, a project, a board). No secrets. Checked against the package: a missing or wrong value is `400` on `connector.params.<key>`. |
| `events` | Allow-list of the package's event types; empty = every event. |
| `schedule` | `{ cron, timezone }`, `poll` triggers only. Default: the package's schedule, in UTC; `schedule: null` on a PATCH returns a saved trigger to it, and leaving it out keeps the stored one. The cron syntax and its messages are described under *The schedule of a poll*. |
| `filter` | The same rules as a webhook's (up to 20, all must match) over `payload.…` (the event's data), `event`, `delivery_id`, `received_at`, `trigger`, `agent` and `connector` (`headers` is always empty and `preset` is `connector`). |
| `include_payload` | Append the event data to the message as external data (JSON, at most 32 KiB). Default `true`. |

The answer carries the same object plus what the connector filled in (`subscription_id`, `package_id`, `kind`, `label` such as *GitHub · Pull request*), `connector_available` (false when the Connectors module is not there) and, on read, create, update, retry and rotate, `connector_subscription`:

```json
"connector_subscription": {
  "subscription_id": "…", "status": "manual", "kind": "webhook",
  "callback_url": "https://console.example.com/api/public/connector-hooks/<tenantId>/ch_…",
  "secret": "…", "secret_hint": "…", "previous_secret_valid_until": null, "auto_registered": false,
  "reason": "This trigger cannot be registered at the vendor automatically. Set the webhook up with the URL and the secret.",
  "reason_code": "no_subscribe",
  "setup": "1. Open the repository settings …", "bindings": 1, "last_event_at": null, "last_error": null
}
```

Add `?locale=tr` or `?locale=en` to a create, update, read, rotate or retry call to have the Connectors module write the `setup` steps of the subscription (and the sentence that says a secret was shown once) in that language (the Studio does; without it the module's default is used). `reason` is not translated: it is one fixed English sentence for every reader, and `reason_code` is the key to put into the reader's own words, as the Studio does. The `label` of a connector trigger is stored in English (`GitHub · Pull request`) whatever the language of the call, so everyone reads the same text; a screen that knows the reader's language names the trigger from the connector catalog (`GET /api/connectors/trigger-catalog?locale=`) instead, as the Studio does.

Triggers that listen to the same connector, package trigger and parameters **share one subscription**, so one vendor hook (or one poll) serves them all; `bindings` counts them. `status` is `active`, `pending` (the hook is being registered), `manual` (set up by hand; `reason` says why it was not registered automatically), `paused` (the connector is disabled, or its account is disconnected and the subscription needs it, as a poll and a hook the module registered at the service do; it resumes when the connector does) or `failed` (a rotation could not register the hook again, or the module could not bind the stored trigger; `last_error` says why; **Retry** tries again). `reason` is a fixed English sentence; `reason_code` is the same reason as a stable code (`no_subscribe`, `subscribe_failed`, `rotate_failed`, `account`, `connector_disabled`, `package_missing`, `unreachable`, `attach_failed`) to build your own text on.

**Without an account.** A hook set up by hand needs no account to receive, so it goes on receiving when the connector's account is disconnected. If it was waiting for the account, because its registration at the service had failed or a rotation had stopped (`reason_code` `subscribe_failed`, `unreachable` or `rotate_failed`), it then reads `manual` with `reason_code: account`, and connecting the account tries the registration again. A hook the package cannot register at all keeps `no_subscribe`. Polls and hooks the module registered at the service pause instead, and resume when the account is back.

**Secrets.** In manual mode the full `secret` is in the answer that created or rotated it and nowhere else; rotating a hook set up by hand with `grace_seconds` keeps the old secret accepted until `previous_valid_until` (also `previous_secret_valid_until` on the subscription, on every read until it passes), and `null` means it stopped at once. The grace period is for the person who has to paste the new secret into the service: rotating a hook the module registered registers it again with the new secret, and the old one stops at once whatever `grace_seconds` says. The same holds once the module registers a hook that was set up by hand at the service (**Retry**, or connecting the account): the earlier secret stops at once and `previous_secret_valid_until` reads `null`.

**When registering fails.** A failure to register never blocks saving: the trigger is stored and reads `manual` with the reason and the steps to set the hook up by hand (**Retry** registers it again, unless the package cannot register hooks at all, `reason_code: no_subscribe`, or the connector has no connected account, `reason_code: account`, where connecting the account tries again; Studio offers no Retry for those two); a registration that is still `pending` after five minutes (the process stopped in the middle) turns `failed`, so Retry is there. A rotation of a registered hook that stopped in the middle (after the old registration was taken off the service and before the new one was written down) ends the same way, and the hook is then handled like one set up by hand: it shows the steps to set it up, **Retry** registers it again, and rotating it answers with a new secret to paste. A stored trigger whose subscription is gone (it could not be bound when it was saved, or the subscription was removed) reads `failed` with `reason_code: attach_failed` and the sentence *The connection to the connector could not be set up. Retry.*, on every read as in the answer that saved it; **Retry** binds it again. A poll that fails stays `active` with `last_error` and a back-off, so check `last_error` and `last_poll_at` as well as the status.

**The turn.** Like a webhook trigger's: the `prompt` is a template over the event (<span v-pre>`{{payload.…}}`</span>, <span v-pre>`{{event}}`</span>, <span v-pre>`{{delivery_id}}`</span>, <span v-pre>`{{connector.name}}`</span>, <span v-pre>`{{connector.trigger}}`</span>, <span v-pre>`{{trigger.name}}`</span>, <span v-pre>`{{agent.key}}`</span>; a connector event has no headers), `variables` map event values to the agent's declared variables, and everything taken from the event reaches the model as external data. The message begins with a notice that the run was started by a connector trigger and names the package, the trigger and the event. Runs get `trigger: "connector"` and the metadata `connector_id`, `connector_trigger`, `event_type` and `event_id`; with `include_payload` the event is kept on the run.

**Unattended.** A connector event starts an unattended run, like every trigger fire. A tool that changes something needs approval, nobody is there to give it, so the call follows the agent's *When nobody can answer* setting ([approvals](/guide/agent-approvals#unattended-runs)): denied by default. Set a tool to *Never ask* to let it run on its own, and keep a `filter` on who or what may start the run.

**Duplicates and limits.** Each event has an id; the same event reported twice (a redelivery, an overlapping poll) starts one run per trigger, with the same retry rule for failed runs as webhooks. The run rate is the webhook trigger's (`AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE`). A poll whose trigger is over a run limit (the run rate, concurrency, spend or quota) loses nothing: the check stays on that page, reads it again after a back-off (or the limit's own retry-after, if longer) and starts only the events the trigger has not taken yet, so no event runs twice. Several agent triggers can listen to one poll (they share its subscription), and then the one over its limit does not hold the others back: once another enabled trigger has nothing left on the page (each event ran, was filtered out or left out by its event list, or was a duplicate) and every refusal on it is a limit, the check moves on. A second trigger that never matches, because its `events` or `filter` rejects every event, has nothing left on the page either, so it lets the page go too. The trigger that was over its limit misses the events it refused and is not offered them again; the subscription's `last_error` names those triggers (up to three, then "and N more") and how many events they missed, and the server logs a warning. A poll with a single trigger, or one whose triggers all still have events left on the page, keeps its place until the limit passes, as above. The service is always answered `2xx` once its delivery is authenticated, so it never disables the hook because of a refusal.

**Operating it.**

| Call | |
| --- | --- |
| `POST …/triggers/{id}/connector/retry` | Registers the hook again (a `failed` trigger, or a `manual` one other than `no_subscribe` and `account`: the package cannot register hooks at all, or the connector has no connected account and connecting it tries again; Retry changes nothing for those two), resumes a paused poll, or binds a trigger whose subscription is gone (`reason_code: attach_failed`) to a new one. `409 connector_triggers_unavailable` without the module, `409 connector_subscription_missing`, `402` or `403` `service_unavailable` while the Connectors licence or switch, or the Agents service, is off, `409 not_active` when the trigger has no subscription yet and its connector or the package's trigger is gone, `502 connector_retry_failed`. |
| `POST …/triggers/{id}/webhook/rotate-secret` | For a `webhook`-kind trigger: a new secret (shown once in manual mode; an automatically registered hook is registered again with it). `400 connector_no_secret` when there is none, `402` or `403` `service_unavailable` as for retry, `409 account_required` or `not_active` when a hook the module registered cannot be taken off the service first (the connector has no connected account or is disabled) or the package no longer offers the trigger, `502 connector_rotate_failed`. |
| `POST …/triggers/{id}/run` | **Run now** with an event. `payload` is the event data, `event` its type, `dry_run: true` only evaluates and returns what the turn would be. Without `payload` the package's **sample event** is used. Events and filter are not applied and nothing is de-duplicated. `headers` is refused. Studio's **Test** tab uses it. |
| `GET …/triggers/{id}/deliveries` | The delivery log, as for webhooks. |

On retry and rotate-secret, a refusal the Connectors module makes with a 4xx status of its own (the connector's service refusing the credential, for one) is answered with that status, its message and its code; a failure without one is the `502`.

**Without the Connectors module** creating or updating a connector trigger is `400 invalid_trigger` on the field `type`; a stored one is listed with `connector_available: false` and does not fire; **Run now** answers `409 connector_triggers_unavailable`.

**While the Connectors licence or switch, or the Agents service, is off** for the workspace, a connector trigger can still be read and deleted, but nothing new is bound: creating a trigger or changing its connector, trigger, parameters or schedule is `400 invalid_trigger` on the field `connector.connector_id`, and retry and rotate-secret are `402` or `403` `service_unavailable` (the error says which). Saving the same binding again still works: a new name, prompt or events, or switching the trigger on or off, is accepted and the answer's `connector_subscription` is the subscription as it is stored. The exception is a subscription that is `paused` or being removed: the module cannot keep it while it is off (waking it would be a change), so that save is stored too, but its answer reads `failed` with `reason_code: attach_failed`, and the subscription itself stays as it was. The polls do not run and the callback URL answers `404 webhook_not_found`, like a URL that names nothing; both go on when it is back.

In Studio the **When** step offers **Connector** when the module is there: pick the connector, the trigger and its parameters, the events (and the schedule for a poll), then the filter, the payload switch and the prompt. A saved connector trigger has the tabs **Settings** (the subscription: state, callback URL and secret, setup steps, retry), **Test** (a sample event: **Preview** is a dry run, **Run** starts the trigger) and **Deliveries**. In the list a connector trigger shows its connector and trigger name, and an icon for push or poll.
