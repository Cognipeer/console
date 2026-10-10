# Agent sessions

A **session** is a conversation with an agent: its messages, its files, what it has spent, and what it is doing now. The Responses API starts one for you on the first message (`resp_{id}`: the `{id}` is the session id). The sessions API lets you start one **without a message** — to upload files to it first, give it a budget, or tag it — list the project's sessions, and delete one.

All calls take the same bearer token as the rest of `/api/client/v1` and see only the token's project.

## Start a session

```http
POST /api/client/v1/agents/sessions
Authorization: Bearer <token>
Content-Type: application/json

{
  "agent": "support-bot",
  "title": "Refund #4821",
  "metadata": { "ticket": "4821", "customer": "acme" },
  "budget": { "max_cost_usd": 2, "on_reach": "pause" },
  "runtime_context": { "metadata": { "tier": "gold" } }
}
```

Only `agent` (the agent's key) is required. The answer is `201` with the session:

```json
{
  "id": "6f1c…", "object": "agent.session", "agent": "support-bot", "title": "Refund #4821",
  "created_at": "2026-10-11T09:00:00.000Z", "updated_at": "2026-10-11T09:00:00.000Z",
  "metadata": { "ticket": "4821", "customer": "acme" },
  "runtime_status": "idle", "stop_reason": null, "pending_actions": [], "last_event_seq": 0,
  "budget": { "max_cost_usd": 2, "on_reach": "pause" }, "spent_usd": 0
}
```

Nothing runs and nothing is spent. The session belongs to the user that owns the token and is marked as coming from the API.

| Field | What it does |
| --- | --- |
| `agent` | Key of an active agent of the token's project. `404 agent_not_found` otherwise. |
| `title` | Up to 200 characters. Default `New conversation`; the first message names it after what was asked. |
| `metadata` | Up to 16 string pairs (keys up to 64 characters, values up to 512). Yours to use: returned as `metadata`, never read by the agent. `400 invalid_metadata` otherwise. |
| `budget` | A [session budget](/guide/agent-session-budgets); `null` for none, absent for the agent's default. The same rules as the first message of a Responses call, including `403 budget_override_forbidden` when the agent's own budget binds API clients. |
| `runtime_context` | Context entered once for the whole session and merged under every turn's own (`headers`, `metadata`, …) — the same object a Responses call takes. The HTTP headers of this request are not kept. |

## Send messages to it

Continue it with `session_id` on the Responses API (`conversation` is accepted too, the way OpenAI spells it — a string or `{ "id": "…" }`):

```http
POST /api/client/v1/agents/responses

{ "model": "support-bot", "session_id": "6f1c…", "input": "Where is my refund?" }
```

`session_id`, `conversation` and `previous_response_id` all name the same thing. Give one — or several, as long as they agree; naming two different sessions is `400`. A session of another agent or project is `404 session_not_found`. `input_file` parts may use a `file_id` with any of the three.

Files uploaded to the session before the first message go with it — see [Session files](/guide/session-files) for the whole flow (create → upload → ask).

## List sessions

```http
GET /api/client/v1/agents/sessions?agent=support-bot&status=requires_action&limit=20&after=<cursor>
```

| Query | |
| --- | --- |
| `agent` | Only this agent's sessions. |
| `status` | `idle`, `running`, `requires_action` or `budget_paused`. `idle` includes a session that has not run yet. |
| `limit` | 1 to 100, default 20. |
| `after` | The `next_cursor` of the previous page. |

Newest first:

```json
{
  "object": "list",
  "data": [
    {
      "id": "6f1c…", "object": "agent.session", "agent": "support-bot", "title": "Refund #4821",
      "created_at": "…", "updated_at": "…", "metadata": { "ticket": "4821" }, "message_count": 6,
      "runtime_status": "idle", "stop_reason": "end_turn", "last_event_seq": 41,
      "budget": null, "spent_usd": 0.0412
    }
  ],
  "has_more": true,
  "next_cursor": "WzE3NjA…"
}
```

A row is the session without its transcript (`message_count` instead) and without `pending_actions` — fetch one session to see those. The cursor marks the last row you read, so a session created while you page never shifts a row into or out of a page you already have. Which sessions a token sees follows the project, as for every other session call.

## Get, update, delete

```http
GET    /api/client/v1/agents/sessions/{id}      # the session resource (runtime state, pending requests, budget)
PATCH  /api/client/v1/agents/sessions/{id}      # change the budget — see Session budgets
DELETE /api/client/v1/agents/sessions/{id}
```

```json
{ "id": "6f1c…", "object": "agent.session", "deleted": true }
```

Deleting removes the session with its files (object, markdown and record), its event log and any open approvals. It is refused with `409 agent_run_conflict` while a run (synchronous or background) is queued or running on it — cancel or wait for it first.

The other calls on a session: [events](/guide/agent-session-events), [approvals and questions](/guide/agent-approvals), [files](/guide/session-files), [budget](/guide/agent-session-budgets) and [background runs](/guide/agent-background-execution).
