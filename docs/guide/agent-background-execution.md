# Agent Runs and Background Execution

Every agent call made through the API is a **run**: a recorded turn with an id (`run_…`), a status, a result and a place in the history. A call that finishes quickly answers with the answer. A call that takes longer answers `202` with the run while the run **keeps going**, and you follow it on the [runs API](#the-runs-api), with a callback or with a webhook. The same engine serves the runs API, the Responses API, chat completions, A2A, the sessions API and [triggers](/guide/agent-triggers).

There is no per-agent switch and no setting to choose a mode: the caller decides how it wants to wait, and the operator sets the limits ([Configuration](#configuration)).

## How a call becomes a run

| Kind | Started by | Where it executes | The caller |
| --- | --- | --- | --- |
| **Inline** | A plain `/responses`, chat completions, A2A or session call | In the request, recorded as it goes | Waits for the answer, up to the [wait window](#the-wait-window) |
| **Queued** | `background: true` or the `X-Cognipeer-Background: true` header, `POST …/runs`, a trigger, a `scheduled` or `deferred` run | In a queue worker, on any node | Gets `202` at once (or waits as long as it asks to) |
| **Streamed** | `stream: true` | Inline, as events | Receives the turn; nothing to wait for |

The dashboard's own Studio and portal chats reserve the conversation while a turn runs and leave no run behind.

A call that is refused before its run exists (a cap, a conflict, the quota, a spend limit) leaves nothing behind: the session that the same request created is removed again, so a client retrying a refusal does not pile up empty sessions. A session the request continued is kept.

A conversation holds **one active run at a time**. A second message to a session that is still running is refused with `409 agent_run_conflict`; a session that waits on an [approval or a question](/guide/agent-approvals) answers `409 pending_action`.

## The wait window

A plain call waits for the run for at most `AGENT_SYNC_TIMEOUT_MS` (default 10 minutes; a tenant quota can lower it). Three things can end the wait:

- **The run finishes first:** `200` with the answer, in the dialect's own shape.
- **The window ends first (detach):** `202` with the run in the dialect's shape (`status: "in_progress"` on `/responses`, an empty `chat.completion` whose `cognipeer` object names the run on chat completions, a `working` task on A2A), plus `Location: /api/client/v1/agents/runs/run_<id>` and `Retry-After: 2`. The run is **not** stopped. It carries on in the background, bounded by `AGENT_BACKGROUND_MAX_DURATION_MS`, and from then on it notifies like a queued run: the `agent_run.*` [webhook](/guide/webhooks) events and a callback, if it has one.
- **The caller leaves first:** a plain call that drops its connection leaves the run going (it becomes detached). A `/responses` **stream** that loses its reader stops the run, unless the request said `background: true`. A runs-API stream keeps the run going unless it said `"on_disconnect": "cancel"`. An A2A `message/stream` client that disconnects does not stop the task either: it reattaches with `tasks/resubscribe` (one resubscribe stream follows a task for up to 60 minutes; resubscribe again after that).

A waited call whose run is **ended elsewhere** before it finishes (the server shut down and handed its runs over, or the run's worker was lost) does not get the partial answer its turn may have produced. It gets `503` `agent_run_interrupted` (`retryable: true`, `side_effects_possible: true`; a stream gets an `error` event and `response.failed`). Read the run to see how it ended, or send the request again. A long-poll (`?wait=`, `Prefer: wait=N`, a trigger's Run now) also stops waiting when its client disconnects; the run is not affected.

Keep `AGENT_SYNC_TIMEOUT_MS` below the shortest timeout of anything between the caller and the server (load balancer, API gateway, serverless function): a connection that an intermediary cuts first never sees the `202`.

A run that is still running when it reaches `AGENT_BACKGROUND_MAX_DURATION_MS` is stopped and ends `failed` with the error type `max_duration_exceeded`. Stopping is cooperative: the run does not start another step, but a tool or model call already in flight is not interrupted, so side effects of that call may still happen.

## The runs API

The canonical surface, and the most complete one. Everything is under `/api/client/v1`, needs the **Agents** service, and sees only the runs of the token's project.

| Call | |
| --- | --- |
| `POST /agents/{agentKey}/runs` | Start a run. |
| `GET /agents/runs` | List runs. Filters: `agent`, `status` (comma separated), `class`, `session_id`, `trigger_id` (the runs one saved trigger started), `channel`, `trigger` (what started the run), `metadata[key]=value` (up to 3), `created_after`, `created_before` (unix seconds or ISO-8601), `limit` (1–100, default 20), `after` (a run id). Newest first; the dashboard's own reservations are not listed. |
| `GET /agents/runs/queue` | [Queue visibility](#queue-visibility). |
| `GET /agents/runs/{runId}` | One run. `?wait=<seconds>` holds the call until the run finishes, pauses or the wait ends (at most the wait window). |
| `POST /agents/runs/{runId}/cancel` | [Cancel](#cancel). |
| `GET /agents/runs/{runId}/events`, `…/events/stream` | The [session events](/guide/agent-session-events) this run wrote: JSON (`?after_seq=`) or Server-Sent Events that resume with `Last-Event-ID`. |
| `POST /agents/runs/{runId}/actions/{actionId}` | Answer an [approval or question](/guide/agent-approvals) the run is paused on. |

```bash
curl -X POST "$BASE/api/client/v1/agents/support-bot/runs" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3f1c9a2e-7b1d-4c55-9a51-0d6c2f1e8b7a" \
  -d '{
    "input": "Research this topic in depth and summarize the findings",
    "metadata": { "ticket": "OPS-12" },
    "callback": { "url": "https://your-server.com/hooks/agent-run", "secret": "a-shared-secret-of-16-plus-chars" }
  }'
```

A body that is not a JSON object (malformed, empty, an array or a string) is `400 invalid_json`. The create call is **async-first**: it answers `202` with the run at once (`wait` defaults to 0). Send `"wait": 30` (or `Prefer: wait=30`) to hold the call for up to 30 seconds and get `200` with the finished run when it ends sooner. `Prefer: respond-async` is the same as `wait: 0`. The body takes:

| Field | |
| --- | --- |
| `input` | A string, or [Responses input items](/api/agents#input-formats) (`input_text`, `input_file`, `input_image`). May be empty when `variables` is given. |
| `variables` | Values for the agent's declared [variables](/api/agents#variables): named, typed values sent next to the message and checked before the model is called. The natural fit for a run a program starts. |
| `session_id` | Continue that session; without it a new session starts and its id comes back on the run. |
| `version` | A published version number, or `"draft"`. The default is the published version (the draft while nothing is published). |
| `class` | `default` (the default) or `deferred`. |
| `run_at`, `delay_seconds` | [Scheduled start](#scheduled-runs). One of them. |
| `wait` | Seconds to hold the call (see above). |
| `stream`, `on_disconnect` | `stream: true` answers with the turn as Responses events; `on_disconnect` is `continue` (the default) or `cancel`. Not with `deferred` or a scheduled start. |
| `metadata` | Up to 16 string pairs (keys `[A-Za-z0-9_.-]`, at most 64 characters; values at most 512). Kept on the run, returned by every read, filterable on the list. |
| `callback` | `{ "url", "secret"? }`, see [Callbacks](#callbacks-and-webhooks). |
| `response_format` | Structured output for this run (`json_schema` or `json_object`). |
| `runtime_context`, `reasoning`, `agent_model`, `budget` | As on [`/responses`](/api/agents#parameters). `reasoning` applies to a streamed run only: a queued run (the default, `deferred`, scheduled) runs with the agent's own effort. |

A run, as every read returns it:

```json
{
  "id": "run_6710…", "object": "agent.run", "status": "succeeded", "class": "default",
  "agent": "support-bot", "version": 3, "session_id": "6f1c…", "conversation_id": "6f1c…",
  "channel": "runs", "trigger": "request", "trigger_id": null, "metadata": { "ticket": "OPS-12" },
  "stop_reason": "end_turn", "result": { "…": "Responses-shaped" },
  "output_text": "…", "output_parsed": null, "output_error": null, "error": null,
  "scheduled_for": null, "created_at": 1760000000, "started_at": 1760000001, "completed_at": 1760000042,
  "detached_at": null, "cancel_requested_at": null, "max_duration_ms": 1800000,
  "callback": { "url": "https://…", "status": "delivered", "attempts": 1, "signed": true }
}
```

`channel` is `runs`, `responses`, `chat_completions`, `a2a` or `trigger`; `trigger` (what started the run) is `request`, `schedule`, `once`, `manual` or `webhook`, and `trigger_id` names the saved [trigger](/guide/agent-triggers) when `channel` is `trigger`. The callback secret and runtime headers never appear.

### Statuses

| Status | Meaning |
| --- | --- |
| `scheduled` | Waiting for its `run_at`. Holds no conversation lock yet. |
| `queued` | Accepted, waiting for a worker (or, for `deferred`, for a slot). |
| `running` | Executing. |
| `requires_action` | Paused for an approval or a question. **Not terminal**: answer it and the run continues. A client that polls until the end must stop here too, or it waits for a person. |
| `succeeded`, `failed`, `canceled` | Terminal. `succeeded` includes a run that a limit stopped; `stop_reason` (`end_turn`, `limit`, `requires_action`, `cancelled`, `error`, `budget_reached`) says how the turn ended. A structured-output failure does not fail the run: read `output_error`. |

A failed or canceled run carries `error: { type, message }`. The types: `agent_error`, `max_duration_exceeded`, `worker_lost` (the node died; not retried, because a half-done turn may have had side effects), `interrupted` (the server shut down, see [below](#shutdown-and-crashes)), `expired` (a deferred or scheduled run that never started in time) and `canceled_by_caller`.

## Run classes

| | `default` | `deferred` |
| --- | --- | --- |
| For | Interactive and ordinary work | Bulk, batch and background work that may wait |
| Chosen with | Nothing | `"class": "deferred"` on the runs API, `service_tier: "flex"` on `/responses` and chat completions, `class` on a trigger |
| Cap | At most `AGENT_RUN_MAX_ACTIVE_PER_TENANT` (250) runs queued or running per tenant, **every mode counted**: inline calls and the dashboard's own turns included. `AGENT_RUN_MAX_ACTIVE_PER_PROJECT` (0, off) caps a project. A tenant quota (`maxConcurrentAgentRuns`) can lower both. | At most `AGENT_DEFERRED_MAX_RUNNING_PER_TENANT` (2) run at once and `AGENT_DEFERRED_MAX_QUEUED_PER_TENANT` (10000) wait, queued and scheduled together |
| Over the cap | `429 agent_run_concurrency_limit` (`class`, `scope`, `limit` in the error) | The same code for the waiting cap; a run over the running cap simply waits its turn |
| Workers | `AGENT_RUN_CONCURRENCY` (4) per node | `AGENT_DEFERRED_CONCURRENCY`, half of that by default |
| Waiting too long | Republished if no worker took it (`AGENT_RUN_REQUEUE_AFTER_MS`) | Fails as `expired` when it has not started `AGENT_DEFERRED_MAX_WAIT_MS` (24 hours) after it was due |

A deferred run never executes inline and cannot be streamed. A `/responses` or chat completions call with `service_tier: "flex"` still waits for it like a plain call, up to the wait window, and answers `202` when the window ends first.

A run that **continues accepted work** (the answer to an approval, a session continued after its budget was raised) is not turned away by the cap, and keeps its class, channel, metadata and structured-output format.

### Queue visibility

`GET /api/client/v1/agents/runs/queue`:

```json
{
  "object": "agent.run_queue",
  "default":  { "running": 3, "queued": 0, "scheduled": 1, "limit": 250 },
  "deferred": { "running": 2, "queued": 140, "scheduled": 0, "running_limit": 2, "queued_limit": 10000, "oldest_queued_at": 1760000000 },
  "project":  { "id": "…", "default": { "running": 1, "queued": 0, "scheduled": 0 }, "deferred": { "running": 0, "queued": 12, "scheduled": 0 } }
}
```

The first two blocks count the whole tenant; `project` counts the token's project (with its own `limit` when one is set).

## Scheduled runs

`run_at` (ISO-8601 or unix seconds) or `delay_seconds` on a run makes it `scheduled` when the time is more than a second ahead, at most **30 days** out; a time already past just starts the run. The run is promoted to `queued` by the reconciler when it is due (it ticks every 30 seconds), and it holds the conversation only from then on. If the session is busy at that moment, or the tenant (or project) is already at its default-class active-run cap, the run stays `scheduled` and is tried again on the next tick: a scheduled run can therefore start later than its `run_at` while the cap is full, and one more is promoted as soon as a slot frees up. A scheduled or deferred run that has not started `AGENT_DEFERRED_MAX_WAIT_MS` after it was due fails as `expired`. A scheduled run can be [canceled](#cancel) like any other.

For repeating or recurring work use a [trigger](/guide/agent-triggers).

## Idempotency

`Idempotency-Key` (at most 255 characters) works on **every** call that starts a run: runs API, `/responses`, chat completions and A2A alike.

- The same key with the same request answers with the stored run: `200` once it has finished; while it is still going the retry waits like a new call would (up to the window), then `200` or `202`. No second run starts. A retry of a `stream: true` request is answered as a stream too (the Responses events of the run as it stands: the stored terminal event of a finished run, a further `response.in_progress` for one that is still going), not as JSON. Two identical requests that arrive together do not fail with a conflict: the second waits briefly for the first one's run and replays it.
- The same key with a different request (another agent, session, message, version or named file) answers `409 idempotency_key_conflict`.
- A key that starts with `trigger:` or `hook:` is refused (`400 idempotency_key_reserved`): those name the runs triggers start themselves.
- A key does not undo the side effects of a first attempt. It stops a *retried* attempt from repeating them.

## Cancel

Four routes, one meaning. Pick the one that matches the identifier you hold; the older routes keep working with the same behavior.

| Surface | Route |
| --- | --- |
| Runs API (canonical) | `POST /api/client/v1/agents/runs/{runId}/cancel` |
| Session | `POST /api/client/v1/agents/sessions/{sessionId}/cancel` (also under `/agents/conversations/{id}/cancel`) |
| OpenAI Responses | `POST /api/client/v1/responses/{responseId}/cancel` (also under `/agents/responses/…`) |
| A2A | JSON-RPC `tasks/cancel` with `{ "id": "run_…" }` |

What it does, by status:

- `scheduled` or `queued`: canceled now.
- `running`: the run is asked to stop (`cancel_requested_at` is set) and stops before its next step; the run turns `canceled` once the turn has actually ended, a moment later. The turn keeps the text it had already streamed as its answer.
- `requires_action`: ended now, its open approvals and questions are cancelled and the session goes idle. This is answering them "no", so it needs the right to answer them (`403 action_forbidden` otherwise); see [who may answer](/guide/agent-approvals#who-may-answer-the-approve-permission). A paused run ends the same way, `canceled` with the reason `canceled_by_caller`, its callback and the `agent_run.canceled` webhook event, whenever its pause is dropped by something else: a new message to an agent that is set to cancel pending requests, a session truncate, or a timeout of the agent's `onTimeout: cancel`.
- Already finished: the runs API answers `409 agent_run_already_terminal` (with the final `status`); the Responses route answers `200` with the finished Response, as OpenAI does; A2A answers the error `-32002` (`TaskNotCancelable`).

The session route stops whatever the session is doing and answers `{ "object": "agent.session.cancel", "cancelled": true|false, "run_ids": […] }`; nothing running is `cancelled: false`, not an error. Cancelling needs the right to act on the session ([Authorization](/guide/authorization#sessions-and-approvals)).

## Callbacks and webhooks

A run that nobody is waiting on reports itself in two ways:

- **A callback** you give the run: `callback: { url, secret? }` on the runs API, `callback_url` and `callback_secret` on `/responses`, or the agent's own default under **Configure → Callback & budget** (`config.callback`, used when the request gives none). The URL must be `http` or `https` and resolve to a public address (`400 invalid_callback` otherwise); a secret needs a URL and is 16–256 characters. A `callback_url` without a secret is delivered unsigned: the agent's secret goes only with the agent's URL.
- **Webhook subscriptions**: [`agent_run.succeeded`, `.failed`, `.canceled` and `.requires_action`](/guide/webhooks) go to every matching subscription whether or not the run has a callback. Their data carries `runId`, `sessionId`, `agentKey`, `status`, `class`, `metadata` and `triggerId`.

Both fire only for **async runs**: a queued run, and a plain call that detached. A call answered inline sends nothing.

A callback is a `POST` with `x-cognipeer-event: agent_run.succeeded | agent_run.failed | agent_run.canceled | agent_run.requires_action`, a stable `x-cognipeer-event-id` (deduplicate retries on it; `evt_<runId>_<event>`, and `evt_<runId>_<event>_<generation>` for the second and later outcomes of a run that paused and was resumed, so each one has its own id), and, with a secret, `x-cognipeer-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`:

```json
{ "id": "evt_…", "event": "agent_run.succeeded", "createdAt": "…", "runId": "run_…", "sessionId": "…", "conversationId": "…", "data": { "result": { … } } }
```

`data` is `{ result }` on success, `{ errorReason, message }` on failure and empty on cancel. Delivery goes through its own queue (`AGENT_RUN_CALLBACK_CONCURRENCY` workers a node), up to five attempts with exponential backoff from 2 seconds, and the state is on the run (`callback.status`: `pending`, `delivered` or `failed`; `attempts`). A late delivery of an older event never overwrites the state of a newer one. A callback that never settled, because a node died or the queue lost the job, is queued again by the reconciler. To remove an agent's default callback, clear its URL in **Configure → Callback & budget**: the stored secret is removed with it. The run's own status is the source of truth: poll it if a callback does not arrive.

## Shutdown and crashes

- **Draining.** On `SIGTERM` a node stops taking new queue work, waits up to `AGENT_RUN_DRAIN_TIMEOUT_MS` (10 seconds, kept 3 seconds below `SHUTDOWN_TIMEOUT_MS`) for the runs executing on it, and marks what is left `failed` with the error type `interrupted`: *"The server restarted while this run was in progress. It was not completed; retry it."* Their callbacks and webhooks fire. This happens **before** the HTTP server starts waiting for its open connections: a caller that is waiting on such a run gets its `503 agent_run_interrupted` (a stream, its `error` event) and ends, so no open stream holds the shutdown up. Open session event streams are ended too; their clients reconnect (with `Last-Event-ID`) to the next node. They are **not** retried automatically, because a half-done turn may have had side effects. Queued and scheduled runs are untouched; another node, or this one after the restart, picks them up.
- **A node that dies.** A running run whose heartbeat is older than `AGENT_RUN_HEARTBEAT_STALE_MS` (45 seconds) is failed as `worker_lost`, also not retried. A queued run no worker took within `AGENT_RUN_REQUEUE_AFTER_MS` is published again, with a job id of its own for each requeue window, so a job that failed before it claimed its run is tried again instead of being lost; a job is never run twice (a run is claimed once). On MongoDB an idempotency lock that was never bound to a run (the node died between the lock and the insert) is reclaimed after 60 seconds.
- **Retention.** Run records are kept `AGENT_RUN_RETENTION_DAYS` (30), counted from when the run **finished**, whichever way it ended (a run scheduled 20 days ahead is kept 30 days after it ran, not 10). Until it has run, a scheduled run's record is kept for the retention days after its due time (a deferred run's also after `AGENT_DEFERRED_MAX_WAIT_MS`). A run that is queued, running, scheduled or paused is never deleted, and an idempotency key lives as long as its run.

## Triggers

A [trigger](/guide/agent-triggers) starts an agent with a saved prompt on a cron schedule, once, by hand or when an incoming webhook arrives. Every fire is a queued run (`channel: "trigger"`), so its history is `GET /agents/runs?trigger_id=…` and its limits, classes, callbacks and webhooks are the ones on this page.

## Configuration

Set in the environment ([Configuration](/guide/configuration#agent-runs) lists them all with their minimums); every one is read through `getConfig()`.

| Variable | Default | What it sets |
| --- | --- | --- |
| `AGENT_SYNC_TIMEOUT_MS` | `600000` | The wait window (minimum 5000). |
| `AGENT_BACKGROUND_MAX_DURATION_MS` | `1800000` | Longest wall-clock of any run. |
| `AGENT_RUN_MAX_ACTIVE_PER_TENANT` | `250` | Default-class cap per tenant (`0` = none). |
| `AGENT_RUN_MAX_ACTIVE_PER_PROJECT` | `0` | Default-class cap per project (`0` = off). |
| `AGENT_RUN_CONCURRENCY` | `4` | Default-class queue workers per node. |
| `AGENT_DEFERRED_MAX_RUNNING_PER_TENANT` | `2` | Deferred runs executing at once per tenant. |
| `AGENT_DEFERRED_MAX_QUEUED_PER_TENANT` | `10000` | Deferred runs waiting per tenant. |
| `AGENT_DEFERRED_CONCURRENCY` | half of `AGENT_RUN_CONCURRENCY`, at least 1 | Deferred queue workers per node. |
| `AGENT_DEFERRED_MAX_WAIT_MS` | `86400000` | How long a deferred or scheduled run may wait after it was due (minimum 60000). |
| `AGENT_RUN_CALLBACK_CONCURRENCY` | `4` | Callback delivery workers per node. |
| `AGENT_RUN_DRAIN_TIMEOUT_MS` | `10000` | The shutdown drain. |
| `AGENT_RUN_REQUEUE_AFTER_MS` | `120000` | When an untaken queued run is published again. |
| `AGENT_RUN_HEARTBEAT_INTERVAL_MS` | `15000` | How often a running run writes its heartbeat. |
| `AGENT_RUN_HEARTBEAT_STALE_MS` | `45000` | When a run without a heartbeat counts as lost. |
| `AGENT_RUN_RETENTION_DAYS` | `30` | Run record retention. |
| `AGENT_TRIGGER_TICK_MS`, `AGENT_TRIGGER_MISFIRE_GRACE_MS` | `30000`, `3600000` | The [trigger scheduler](/guide/agent-triggers#schedule). |

Tenant quotas can lower the wait window, the maximum duration and the active-run cap (`maxAgentSyncTimeoutSeconds`, `maxAgentBackgroundDurationMinutes`, `maxConcurrentAgentRuns`); they never raise them above the environment. An agent has no run limits of its own except the ones inside a turn (`runtime.limits`).

## Errors

| Status | Code | When |
| --- | --- | --- |
| `400` | `invalid_json`, `invalid_callback`, `invalid_schedule`, `invalid_wait`, `invalid_metadata`, `invalid_variables`, `invalid_response_format`, `invalid_version`, `idempotency_key_reserved` | The request is malformed (`invalid_json`: the body is not a JSON object); the message says which field. |
| `400` | `attachment_unreachable` | A remote `file_url` / `image_url` (or A2A `file.uri`) could not be fetched, or did not arrive within the outbound timeout (30 seconds by default; headers and body together). |
| `404` | `agent_run_not_found` | No such run in this project. |
| `409` | `agent_run_conflict` | The session already has an active run. |
| `409` | `idempotency_key_conflict` | The key was used for another request. |
| `409` | `agent_run_already_terminal` | Cancel of a finished run. |
| `429` | `agent_run_concurrency_limit` | A cap is full. `Retry-After: 30`. |
| `429` | `spend_limit_exceeded`, `agent_quota_exceeded` | The tenant's spend limit or quota is used up (`Retry-After: 60` for the quota). The agent-run quota counts a run only once it is admitted: a call refused for a conflict or a cap uses no unit. |
| `503` | `agent_run_interrupted` | The run a call was waiting on was ended elsewhere (shutdown, lost worker) before it finished. Retryable; tool side effects may have happened (`side_effects_possible`). |
| `504` | `agent_run_max_duration_exceeded` | A call that was still waiting when the run reached its maximum duration. `side_effects_possible` is `true` and `retryable` `false`: do not retry blindly. |

A **stream** (`stream: true`, `/responses`, chat completions) is checked against the active-run caps and the agent quota **before it opens**: over a limit the answer is the plain JSON `429` above with its `Retry-After`, and no session is created. Only a limit that is reached in the instant between that check and the run's start still ends the open stream with an `error` event.

Errors on the runs API and the sessions API are `{ "error": { "type", "message", "code" } }`; the OpenAI-shaped routes use OpenAI's envelope (`message`, `type`, `param`, `code`) and A2A uses JSON-RPC errors.

## What changed from earlier releases

- A synchronous call past its ceiling no longer fails with `504`: it answers `202` and the run continues.
- The agent's **Execution** settings are gone (`syncTimeoutSeconds`, `backgroundEnabled`, `backgroundMaxDurationMinutes`, `defaultMode`). Any call can run in the background, so `agent_background_disabled` and `idempotency_key_sync_not_supported` no longer exist. The callback moved to **Callback & budget**; the session budget is `config.budget` (an old `execution` block is ignored and removed on the next save).
- `AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_TENANT` and `…_PER_PROJECT` became `AGENT_RUN_MAX_ACTIVE_PER_TENANT` and `…_PER_PROJECT`, and now count synchronous calls too.
