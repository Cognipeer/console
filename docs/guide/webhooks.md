# Webhooks

A webhook subscription sends signed events to a URL of yours when something happens in your agents: a session goes idle, a background run finishes, an approval is waiting, a session budget is reached, a schedule fires. Events are thin: ids and a few small fields. Fetch the details through the API when you need them.

Manage them under **Agents → Webhooks** in the dashboard (`/dashboard/agents/webhooks`; the old `/dashboard/webhooks` address redirects there), or through the API (`/api/webhooks` for the dashboard, `/api/client/v1/webhooks` with an API token). A token acts in its own project only: it manages that project's endpoints when its owner holds the `webhooks` permission (within the token's own scope), and never a tenant-wide endpoint or another project's, whoever owns it.

## Who can manage them

The **Webhooks** permission decides, and only that. A webhook is outbound network traffic with a signing secret, so `webhooks` is an administration service, like Portals or Single Sign-On: workspace owners and admins hold it by default, everybody else holds nothing until you grant it (**Authorization → People** or **Groups**, the Webhooks row).

| Level | What it allows |
| --- | --- |
| Read | list endpoints and their deliveries, read the event catalog |
| Admin | everything: create, edit, enable / disable, send a test event, rotate the secret, redeliver, delete |

There is no "write" in between: changing a webhook needs Admin. A project's own member permissions can lower the level inside that project, never raise it, and a deny policy on `webhooks` (**Authorization → Policies**) takes it away from whoever it names.

Where the permission is exercised decides what an endpoint can reach:

- An endpoint of the project the request is made in: anyone who passes the gate above.
- An endpoint for every project (`projectId: null`) and an endpoint of another project: only someone who holds the permission in the workspace itself, outside any project (a project's limits do not narrow it). A token never does: it is bound to one project.

Without the permission a route answers **403** with the engine's reason and a `decisionId` (also in the `X-Decision-Id` header; look it up in **Authorization → Access check**). The **404** is for someone who holds the permission when the endpoint is outside their reach: another project's, or a tenant-wide one.

Agents → Webhooks shows only what the person may do: without Admin the page is read-only, and the "every project" scope appears only with workspace-level Admin. The list response carries that as `capabilities` (`manage`, `workspaceScope`).

## Events

| Type | Data |
| --- | --- |
| `session.idled` | `conversationId`, `agentKey`, `stopReason` |
| `session.work_done` | `conversationId`, `agentKey` |
| `action.required` | `conversationId`, `agentKey`, `actionId`, `kind` |
| `budget.reached` | `conversationId`, `agentKey`, `spentUsd`, `maxCostUsd` |
| `agent_run.succeeded`, `agent_run.failed`, `agent_run.canceled`, `agent_run.requires_action` | `runId`, `conversationId`, `agentKey` |
| `schedule.fired`, `schedule.failed` | `scheduleId`, `agentKey`, `trigger`, `conversationId?`, `error?` |
| `webhook.test` | none (sent by **Send test event**) |

A subscription lists exact types and/or `prefix.*` patterns (`agent_run.*`); `*` subscribes to everything.

## What you receive

```http
POST /your/endpoint
content-type: application/json
x-cognipeer-event: session.idled
x-cognipeer-event-id: evt_0123456789abcdef01234567
webhook-id: evt_0123456789abcdef01234567
x-cognipeer-signature: t=1760000000,v1=<hex>

{ "id": "evt_…", "type": "session.idled", "createdAt": "…", "projectId": "…", "data": { … } }
```

Verify the signature: compute `HMAC-SHA256(secret, "<t>.<raw body>")` as hex and compare it to `v1`; reject timestamps that are too old. The scheme is the same one the agent-run `callback_url` uses. The secret is shown once, when the webhook is created or its secret is rotated.

Deliveries can repeat. Deduplicate on `webhook-id`.

## Delivery, retries and when an endpoint is switched off

Answer with any 2xx within the timeout. Anything else is retried on a schedule (default 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h: eight attempts in all). Retries are stored, so they survive restarts.

The schedule is a lower bound, not an exact timer. A retry becomes due at the time shown in `nextAttemptAt`, but due deliveries are picked up by a sweep that runs about every 30 seconds, so a retry lands between the scheduled wait and that wait plus roughly 30 seconds. With the default schedule (a minute or more) the difference is small; with a short custom schedule such as `5,10` the gaps can be several times longer than the numbers you set.

A delivery that gets no answer within the timeout is recorded with `lastError` of `Timed out after <ms> ms` (and no `lastStatusCode`), so a slow receiver is not mistaken for a refused one.

An endpoint is switched off, with the reason shown in the list, when:

- it answers with a redirect (3xx): redirects are not followed, update the URL;
- its address resolves to a private or blocked network;
- it fails continuously for longer than the auto-disable window (default 72 hours). Any 2xx resets the clock.

Enabling it again re-checks the address. Deliveries that were still queued when it was switched off are marked failed; **Redeliver** sends one again.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `WEBHOOK_TIMEOUT_MS` | `10000` | per-attempt timeout |
| `WEBHOOK_RETRY_SCHEDULE_SECONDS` | `60,300,1800,7200,21600,43200,86400` | minimum wait before each retry (due retries are sent by a sweep that runs about every 30 s) |
| `WEBHOOK_AUTO_DISABLE_HOURS` | `72` | continuous-failure window |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | settled deliveries are deleted after this |
| `WEBHOOK_CONCURRENCY` | `8` | deliveries sent at once per node |

## API

A receiver address is often a credential: a chat tool's incoming-webhook URL ends in its token, and an automation tool's catch-hook URL is one. **Webhooks · Read** is the right to look at subscriptions, not to use them, so a reader gets the address without its query string, fragment and userinfo, and with every path segment longer than eight characters replaced by `…` — `https://hooks.slack.com/services/T0000/B0000/…`, with `urlRedacted: true` on the endpoint. What stays tells the reader where the events go; a secret of eight characters or fewer is not hidden by this, so treat the full address as sensitive. Only **Webhooks · Admin** (where the endpoint lives: the project for a project's endpoint, the workspace for a tenant-wide one) sees it whole.

The endpoint and delivery objects use `camelCase` (`projectId`, `disabledReason`, `failingSince`, `eventType`, `nextAttemptAt`), like the other resource-management endpoints; errors are `{ "error": "…", "code": "…" }`. The agent endpoints you may call from a handler (runs, sessions, events) are `snake_case`.

| | |
| --- | --- |
| `GET /webhooks/events` | the event catalog |
| `GET /webhooks`, `POST /webhooks` | list; create (returns `secret` once) |
| `GET /webhooks/:id`, `PATCH /webhooks/:id`, `DELETE /webhooks/:id` | read; edit `url`, `description`, `events`, `status`; delete |
| `POST /webhooks/:id/rotate-secret` | new secret (returned once) |
| `POST /webhooks/:id/test` | send a `webhook.test` event now and return the delivery |
| `GET /webhooks/:id/deliveries` | `?limit=&skip=&status=` |
| `POST /webhooks/deliveries/:deliveryId/redeliver` | send a delivery again |
