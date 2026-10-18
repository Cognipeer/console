# Session budgets

A session is a conversation that can go on for days through many turns. The per-turn cost limit (Advanced settings → `maxCostUsd`) caps one turn; a **session budget** caps what the whole session spends, all turns together. When it is reached the turn stops where it is, and the session either waits for the budget to be raised or refuses further messages.

## Setting one

- **For an agent.** **Configure → Callback & budget → Session budget**: an amount in USD and what happens when it is reached. Every new session starts with it. Empty = no session budget.
- **For one session.** Give `budget` in the request that starts the session, or change it later. A budget can be added after the session started, raised, lowered or removed; unlike a fixed cap, it is a setting of the session.
- **In Studio.** The session header shows spent / budget. A session paused on its budget shows a banner with **New budget**, **Increase and continue** and **Remove budget**; a session whose budget *stops* offers **Increase budget** only, after which the message box is open again.

| When the budget is reached | |
| --- | --- |
| **Pause and wait** (default) | The turn stops where it is. The session is `budget_paused`. Once the budget is raised or removed, the turn carries on from where it stopped, with no new message. |
| **Stop** | The turn stops and new messages are refused until the budget is raised or removed. Raising it only reopens the session: nothing carries on by itself, the next message starts the next turn. |

The budget is checked before each model request of the agent against what the session has actually spent, so a turn can overshoot by at most one request. The requests of [sub-agents](/guide/agent-delegation) count as spend as soon as the sub-agent finishes, at the sub-agent's own model price; a sub-agent that is already running is not stopped midway, so a turn that delegates can overshoot by the sub-agents it had started. The per-turn limit still applies: a turn runs under the lower of the two.

A turn that finishes by itself but leaves the session at or past its budget (the common case for a plain chat turn, which is a single request) counts as reaching it: the answer is delivered, then the session is stopped exactly as above. Raising or removing the budget of such a session simply puts it back to idle, since its turn is already complete and there is nothing to continue.

## Over the API

Start a session with a budget:

```http
POST /api/client/v1/agents/responses

{ "model": "support-bot", "input": "Go through the backlog", "budget": { "max_cost_usd": 2, "on_reach": "pause" } }
```

`budget` is read when the request starts a session. On a request that continues one (`previous_response_id`) it is ignored altogether: not applied and not validated, so a client may send its default budget on every call without it being refused (`403`) or rejected (`400`) on a follow-up turn. Change the budget of a running session with the `PATCH` below. `"budget": null` starts the session with no budget, overriding the agent's default.

Read, change or remove it on the session:

```http
GET   /api/client/v1/agents/sessions/{conversationId}
PATCH /api/client/v1/agents/sessions/{conversationId}

{ "budget": { "max_cost_usd": 5, "on_reach": "pause" } }
```

`{ "budget": null }` removes it. The new `max_cost_usd` has to be above what the session has already spent (`400` otherwise). The session reports `budget`, `spent_usd` and `runtime_status` (`budget_paused` while it waits).

For a session that is paused on its budget, the `PATCH` also continues it: the turn runs as a [background run](/guide/agent-background-execution) and the answer is `202` with the run. Send `"resume": false` to change the budget only. A session whose turn had already finished when it reached the budget has nothing to continue: the `PATCH` returns it idle (`200`) instead of starting a run. The same goes for a budget that *stops* instead of pausing: the `PATCH` raises it and returns the session idle (`200`, `resume` has no effect), and the next message starts the next turn.

A message sent to a session whose budget is used up is refused with `402`:

```json
{ "error": { "type": "budget_reached", "code": "budget_reached", "message": "This session has reached its budget ($1.0200 of $1.0000). Raise or remove the budget to go on.", "spent_usd": 1.02, "max_cost_usd": 1 } }
```

A turn that hits the budget part-way is returned like any stopped run: `status: "incomplete"`, `stop_reason: "budget_reached"`, and the work done so far is kept.

### Who may change it

When an agent has a session budget, it binds its API clients: a client token can lower a session's budget but cannot remove it or raise it past the agent's amount (`403`, `budget_override_forbidden`). Turn on **Let API clients change the budget** next to it (`config.budget.allowClientOverride`) to allow it. Dashboard users are not affected.

### A paused session and API-only clients

A session that is `budget_paused` goes on only when its budget is raised or removed. For an agent with a session budget and **Let API clients change the budget** off, an API client can do neither: raising or removing is `403 budget_override_forbidden`, and lowering has to stay above what the session has spent, which a paused session has already passed (`400`). Such a session stays paused until someone with dashboard access continues it: in Studio, open the session and use the banner's **Increase and continue** (or **Remove budget**), which changes the budget and carries the turn on. Or turn on **Let API clients change the budget** for the agent, after which the `PATCH` above continues it (`202`).

Plan for this when an agent with a session budget is driven only through the API: either allow client overrides, or have an operator watch for `budget.reached` [webhooks](/guide/webhooks).

## Events and webhooks

Every turn of a session with a budget writes `session.usage` (`turn_cost_usd`, `spent_usd`, `budget`). Reaching the budget writes `budget.reached` followed by `session.status_idle` with `stop_reason: budget_reached`, and sends the `budget.reached` [webhook](/guide/webhooks). See [session events](/guide/agent-session-events).

## Tenant spend limits

A session budget is the agent's own cap. Separately, what agents spend now counts toward the tenant's daily and monthly spend limits, like model inference does: a turn does not start once a limit is used up (`429`, `spend_limit_exceeded`, from every channel: Studio, the API, portals, background runs, resumed and continued turns), and the cost of each priced model request is counted as it happens.
