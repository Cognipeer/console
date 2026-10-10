# Webhooks

A webhook subscription sends signed events to a URL of yours when something happens in your agents: a session goes idle, a background run finishes, an approval is waiting, a session budget is reached, a schedule fires. Events are thin: ids and a few small fields. Fetch the details through the API when you need them.

Manage them in **Settings → Webhooks**, or through the API (`/api/webhooks` for the dashboard, `/api/client/v1/webhooks` with an API token).

## Who can manage them

- An endpoint for one project: that project's admins, and tenant owners / admins.
- An endpoint for every project (`projectId: null`): tenant owners / admins only.

Anyone else gets a 403 on the list and a 404 on an endpoint they may not see.

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

An endpoint is switched off, with the reason shown in the list, when:

- it answers with a redirect (3xx): redirects are not followed, update the URL;
- its address resolves to a private or blocked network;
- it fails continuously for longer than the auto-disable window (default 72 hours). Any 2xx resets the clock.

Enabling it again re-checks the address. Deliveries that were still queued when it was switched off are marked failed; **Redeliver** sends one again.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `WEBHOOK_TIMEOUT_MS` | `10000` | per-attempt timeout |
| `WEBHOOK_RETRY_SCHEDULE_SECONDS` | `60,300,1800,7200,21600,43200,86400` | wait before each retry |
| `WEBHOOK_AUTO_DISABLE_HOURS` | `72` | continuous-failure window |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | settled deliveries are deleted after this |
| `WEBHOOK_CONCURRENCY` | `8` | deliveries sent at once per node |

## API

| | |
| --- | --- |
| `GET /webhooks/events` | the event catalog |
| `GET /webhooks`, `POST /webhooks` | list; create (returns `secret` once) |
| `GET /webhooks/:id`, `PATCH /webhooks/:id`, `DELETE /webhooks/:id` | read; edit `url`, `description`, `events`, `status`; delete |
| `POST /webhooks/:id/rotate-secret` | new secret (returned once) |
| `POST /webhooks/:id/test` | send a `webhook.test` event now and return the delivery |
| `GET /webhooks/:id/deliveries` | `?limit=&skip=&status=` |
| `POST /webhooks/deliveries/:deliveryId/redeliver` | send a delivery again |
