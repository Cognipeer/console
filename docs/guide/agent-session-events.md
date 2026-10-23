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

`run_id` is the run id as `GET /agents/runs/{runId}` and the 202 of a background call return it (`run_` plus the id), so an event joins to its run directly. A run that paused keeps its events across the pause: the answer (`action.resolved`, also when a timeout denies or ends the request, and a client tool's `agent.tool_result`) and the continuation, inline or in the background, carry the same `run_id`, so `GET /agents/runs/{runId}/events` reads `action.required`, `action.resolved` and what follows in order and does not stop at the pause. Events written outside a run carry none (the pause of a dashboard turn, for instance). `seq` is unique and strictly increasing within the session, and it may skip numbers: some events of the log are not exposed to API clients, so a gap is not a lost event. Use it as a position to resume from (`after`, `Last-Event-ID`), never as a count. `data` larger than 16 KB is cut and carries `_truncated: true`. Field names are `snake_case`, like the rest of the agent endpoints; the tool `args` inside an event are the tool's own and are left as they are.

### Event types

| Type | `data` |
| --- | --- |
| `user.message` | `content` |
| `session.status_running` | `trigger`: `message`, `resume` (a person answered the request the turn paused on) or `timeout` (the request timed out and the agent's timeout policy, *deny* or *allow*, let the turn go on: recorded with the actor `system` and the channel `timeout`) |
| `agent.tool_use` | `tool_call_id`, `name`, `args`, `subagent?` (the sub-agent that made the call, or the one a delegation call went to) |
| `agent.tool_result` | `tool_call_id`, `name`, `ok`, `duration_ms?`, `error?` (also the reason a delegated child failed: `ok` is `false` then), `subagent?`, `source?` (`client`: the page embedding the chat ran it) |
| `agent.compaction` | what a context compaction did (`at`, `messages_compressed`, `tokens_before`, `tokens_after`, …) |
| `action.required` | `action_id`, `kind` (`tool_approval`, `user_question` or `client_tool`), `tool_name?` (`tool_approval` and `client_tool`), `subagent?` (the request comes from a [sub-agent](/guide/agent-delegation)), `args?`, `questions?`, `allow_free_text?`, `timeout_seconds?` (`client_tool`), `expires_at?` |
| `action.resolved` | `action_id`, `kind`, `tool_name?` (`client_tool`), `decision?`, `cancelled?`, `expired?`, `ok?`, `duration_ms?`, `timed_out?` (`client_tool`), `resolved_by`, `channel` (`dashboard`, `api`, `portal`, `timeout` or `system`) |
| `agent.output_file` | a file the agent produced this turn (its sandbox `/outputs/`, or `session_files_create`), saved as a session file: `file_id`, `name`, `mime_type`, `size`, `download_url`. One event per file, just before `agent.message` |
| `agent.message` | `content`, `message_index?`, `stop_reason?`, `usage?` |
| `session.usage` | `turn_cost_usd`, `spent_usd`, `budget` (sessions with a [budget](/guide/agent-session-budgets)) |
| `budget.reached` | `spent_usd`, `max_cost_usd` |
| `session.status_idle` | `stop_reason`, `pending_action_ids?`, `detail?`, `usage?` (only when the turn ended without a usage of its own — cancelled, timed out: what its model calls cost by the usage ledger, `source: ledger`) |
| `session.error` | `message`, `code?`, `usage?` (what the failed turn's model calls had cost, from the usage ledger; absent when it made none) |
| `session.work_done` | none; right after an idle with `stop_reason: end_turn` |
| `session.truncated` | `reason` (`truncate`, `regenerate` or `edit`), `kept_messages`, `removed_messages`, `removed_from`, `cancelled_actions`, `by`, `channel`: messages were cut from the transcript ([details](/guide/agent-feedback)) |

`agent.message` carries the usage of the whole turn: when a turn paused for an approval, a question or a client tool and was resumed, the resumed turn's `usage` adds up every leg. The keys of `directive_sources` inside an `agent.compaction` summary are the directives' own text and are not re-cased.

### Context compaction and agents without tools

Context summarization compresses **tool results**. An agent that has no tools (no tool bindings, knowledge, sub-agents, skills, memory, sandbox or client tools) never summarizes, so no `agent.compaction` event is emitted for it. With the default `hybrid` context policy such an agent keeps only the last `lastTurnsToKeep` turns once the context grows, and older turns are dropped without a summary: facts from them are lost. Saving an agent configured this way returns a warning. Give the agent a tool, raise `lastTurnsToKeep`, or use the `raw` policy if older turns must stay.

A turn is bracketed by `session.status_running` and `session.status_idle`. Every model call a turn makes writes its own usage row the moment it settles (`model_usage_logs`, stamped with the agent, conversation, turn, run and trace session), so what a turn spent is known even when the turn failed or was cut off; the `usage` on `session.error` / `session.status_idle` is the sum of those rows. A new event type can appear in a future version: ignore the ones you do not know.

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

A turn the platform ends from outside, because the server shut down while it ran or because its worker was lost, is closed in the log like a turn that failed: `session.error` with `code: agent_run_interrupted`, then `session.status_idle` with `stop_reason: error`. Both carry the run's `run_id`, the session is no longer `running`, and a follower on a node that is shutting down receives them before its stream is ended. So waiting for `session.status_idle` is enough to know a turn is over, however it ended; read the run (`GET /agents/runs/{runId}`) for `interrupted` or `worker_lost`.

With Redis configured, the stream follows a turn that runs on another node.

A client that only needs to know when something happened can use [webhooks](/guide/webhooks) (`session.idled`, `action.required`, …) instead of holding a stream open.

## The dashboard

The same log is available to the dashboard under `/api/agents/{agentId}/sessions/{sessionId}/events` and `…/events/stream`, plus `GET …/actions` for the session's approvals and questions. The dashboard stream's frames keep the dashboard's own field names and values (`runId`, the bare id without the `run_` prefix, and `createdAt`). When you open a session that is running, Studio follows it from `last_event_seq`.
