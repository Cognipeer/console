# Session events

Every agent session keeps an append-only log of what happened in it: the messages, each tool call and its result, the requests it paused on, the cost. You can read it afterwards, or follow a turn while it runs from a client that did not start it: after a page reload, from another device, from a channel adapter.

Events are kept for 30 days (`AGENT_SESSION_EVENT_RETENTION_DAYS`) and go with the session when it is deleted.

## Session state

```http
GET /api/client/v1/agents/sessions/{conversationId}
```

```json
{
  "id": "6f1c…",
  "object": "agent.session",
  "agent": "support-bot",
  "runtime_status": "requires_action",
  "stop_reason": "requires_action",
  "pending_actions": [ { "id": "act_…", "kind": "tool_approval", "tool_name": "sandbox_exec", "status": "pending" } ],
  "last_event_seq": 41,
  "budget": { "max_cost_usd": 2, "on_reach": "pause" },
  "spent_usd": 0.4213
}
```

`runtime_status` is `idle`, `running`, `requires_action` (waiting for an [approval or an answer](/guide/agent-approvals)) or `budget_paused` (see [budgets](/guide/agent-session-budgets)). `stop_reason` says why the last turn stopped: `end_turn`, `requires_action`, `limit`, `cancelled`, `error` or `budget_reached`. `{conversationId}` is the id inside `resp_{conversationId}`.

## Reading events

```http
GET /api/client/v1/agents/sessions/{conversationId}/events?after=40&types=agent.message,session.status_idle&limit=100
```

Returns `{ "object": "list", "events": [...], "has_more": false, "last_seq": 41 }`. Events come oldest first; pass the `last_seq` of one page as `after` for the next. `types` is a comma-separated filter; `limit` is 100 by default and at most 1000.

Each event:

```json
{ "seq": 38, "type": "agent.tool_result", "data": { "tool_call_id": "call_1", "name": "sandbox_exec", "ok": true, "duration_ms": 812 }, "run_id": "run_3f9c…", "created_at": "2026-10-01T12:00:03.120Z" }
```

`run_id` is the run id as `GET /agents/runs/{runId}` and the 202 of a background call return it (`run_` plus the id), so an event joins to its run directly. A run that paused and was answered inline keeps its events across the resume: the continuation writes its events with the same `run_id`, so `GET /agents/runs/{runId}/events` does not stop at the pause. Events written outside a run carry none. `seq` is unique and ascending within the session. `data` larger than 16 KB is cut and carries `_truncated: true`. Field names are `snake_case`, like the rest of the agent endpoints; the tool `args` inside an event are the tool's own and are left as they are.

### Event types

| Type | `data` |
| --- | --- |
| `user.message` | `content` |
| `session.status_running` | `trigger`: `message`, `resume` (a person answered the request the turn paused on) or `timeout` (the request timed out and the agent's timeout policy, *deny* or *allow*, let the turn go on: recorded with the actor `system` and the channel `timeout`) |
| `agent.tool_use` | `tool_call_id`, `name`, `args`, `subagent?` |
| `agent.tool_result` | `tool_call_id`, `name`, `ok`, `duration_ms?`, `error?`, `subagent?`, `source?` (`client`: the page embedding the chat ran it) |
| `agent.compaction` | what a context compaction did (`at`, `messages_compressed`, `tokens_before`, `tokens_after`, …) |
| `action.required` | `action_id`, `kind` (`tool_approval`, `user_question` or `client_tool`), `tool_name?` (`tool_approval` and `client_tool`), `args?`, `questions?`, `allow_free_text?`, `timeout_seconds?` (`client_tool`), `expires_at?` |
| `action.resolved` | `action_id`, `kind`, `tool_name?` (`client_tool`), `decision?`, `cancelled?`, `expired?`, `ok?`, `duration_ms?`, `timed_out?` (`client_tool`), `resolved_by`, `channel` (`dashboard`, `api`, `portal`, `timeout` or `system`) |
| `agent.output_file` | a file the agent produced this turn (its sandbox `/outputs/`, or `session_files_create`), saved as a session file: `file_id`, `name`, `mime_type`, `size`, `download_url`. One event per file, just before `agent.message` |
| `agent.message` | `content`, `message_index?`, `stop_reason?`, `usage?` |
| `session.usage` | `turn_cost_usd`, `spent_usd`, `budget` (sessions with a [budget](/guide/agent-session-budgets)) |
| `budget.reached` | `spent_usd`, `max_cost_usd` |
| `session.status_idle` | `stop_reason`, `pending_action_ids?`, `detail?` |
| `session.error` | `message`, `code?` |
| `session.work_done` | none; right after an idle with `stop_reason: end_turn` |
| `session.truncated` | `reason` (`truncate`, `regenerate` or `edit`), `kept_messages`, `removed_messages`, `removed_from`, `cancelled_actions`, `by`, `channel`: messages were cut from the transcript ([details](/guide/agent-feedback)) |

A turn is bracketed by `session.status_running` and `session.status_idle`. A new event type can appear in a future version: ignore the ones you do not know.

## Following a turn live

```http
GET /api/client/v1/agents/sessions/{conversationId}/events/stream?after=41
Accept: text/event-stream
```

Server-Sent Events. The stream replays the stored events after `after` (or after the `Last-Event-ID` header a browser `EventSource` sends when it reconnects), then follows the session live. Each stored event is a frame:

```
id: 42
event: agent.tool_use
data: {"seq":42,"type":"agent.tool_use","data":{"tool_call_id":"call_2","name":"web_search","args":{"query":"…"}},"run_id":"run_…","created_at":"…"}
```

`data` has the same shape as an item of the event list. Besides the stored events, the stream carries `agent.message.delta` frames (`data: { "text": "…" }`) with the model's text as it is written. They have no `id` and are not stored, so a client that reconnects gets the finished `agent.message` instead.

`agent.message.delta` frames exist only for a turn whose starter streams. A turn started without `stream` (a synchronous call, a background run, a trigger) does not stream the model, so a follower sees the finished `agent.message` arrive at once, without deltas. Deltas appear when the caller that starts the turn asks for a streamed answer, for example the dashboard's chat stream in Studio. Do not wait for deltas: build a follower around the stored events, and treat deltas as a bonus when they come.

A `: ping` comment is sent every 15 seconds. The stream ends after an hour, when you close it, or when the server shuts down (open streams are ended during a graceful shutdown); reconnect with the last `id` to pick up where you left off.

With Redis configured, the stream follows a turn that runs on another node.

A client that only needs to know when something happened can use [webhooks](/guide/webhooks) (`session.idled`, `action.required`, …) instead of holding a stream open.

## The dashboard

The same log is available to the dashboard under `/api/agents/{agentId}/sessions/{sessionId}/events` and `…/events/stream`, plus `GET …/actions` for the session's approvals and questions. The dashboard stream's frames keep the dashboard's own field names and values (`runId`, the bare id without the `run_` prefix, and `createdAt`). When you open a session that is running, Studio follows it from `last_event_seq`.
