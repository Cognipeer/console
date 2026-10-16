# Monitoring & Observability

Cognipeer Console provides structured logging, health checks, alerting, and usage tracking for production observability. The operator-facing surfaces for this live under **Operate → Alerts & Incidents**, **Operate → Agent Observability** (agent health), **Configure → Audit Log**, and **Configure → License**.

## Alerts & Incidents

Alert rules watch a metric and open an **incident** when it goes wrong. Rules are grouped by module: Agents, Model Hub, Knowledge Engine, MCP Servers, Tools, Model Monitoring, Guardrails, Analysis, Evaluation, Red Team and AI App Gateway. For agents, models, knowledge bases, MCP servers and tools a rule is evaluated **per entity**: one rule can watch every agent, and each agent gets its own state, its own incident and its own notifications.

![Alerts list](/screenshots/monitoring/01-alerts-overview.png)

The counters at the top cover every rule of the project, whatever the filters: **Active Rules** (enabled, muted ones included), **Entities Firing Now** (the firing entities, added up over all rules), **Muted** and **Noisy · 7d** (rules that fired 10 times or more in the last 7 days). From here you can author a rule (**New Rule**), work through incidents (**Incidents**), manage the shared notification channels (**Channels**), or open the full audit timeline (**View History**). Rules, incidents and history belong to the project you are working in.

The list can be searched (rule name, description and metric id) and filtered by module, by status (**Firing**, **Pending**, **OK**, **Muted**, **No data**, **Disabled**) and by owner (**Created by me**, or another user when you may list users). It is sorted by **noisiest** (fires in the last 7 days) by default, or by **last fired** or **name**. Per rule:

- **State** counts the rule's entities that are firing (a link to their incidents), pending or OK. **No data** means the rule is enabled but none of its targets reported data in its last evaluation, and a muted rule shows until when (**Muted · in 3 hours**).
- **Fired · 7d** is the number of times the rule fired in the last 7 days (one per entity that fired), with a sparkline of the seven days. A rule that fired 10 times or more is marked **noisy**: consider a longer **Hold for**, a higher threshold or a [backtest](#condition-types). The counts are read from at most 5000 alert events; the footer says when that cap was reached.
- **Last fired**, **Mute** (below) and the **Enabled** switch.

### Metrics

The module you pick decides which metrics are offered. The metrics of the first five modules below are computed per entity from the 5-minute health rollups (the same data behind the health views); every other metric covers the whole project or one scope.

| Module | `module` | Entity | Counted from |
|--------|----------|--------|--------------|
| Agents | `agents` | agent | Sessions of traced agents and of hosted agents, counted once when they reach a final status (see [session status](/guide/tracing#session-status)) |
| Model Hub | `models` | model | Every model call through the gateway, plus the model calls of externally traced agents |
| Knowledge Engine | `rag` | knowledge base | Queries (unknown module keys and rejected filters are caller mistakes and are not counted) |
| MCP Servers | `mcp` | MCP server | Tool calls through the MCP proxy. A disabled tool and a guardrail block are policy outcomes, not server errors. A composite server's call is counted for the composite and again for each member server it calls |
| Tools | `tools` | tool | Tool executions, plus the tool calls of externally traced agents |

Hosted agents emit agent rows only: their model, tool and MCP calls are counted where they run. Externally traced agents also produce one model row per model call and one tool row per tool call.

Two rules from [Agent Tracing](/guide/tracing#how-a-status-reaches-the-health-numbers) decide what the agent metrics see. A session status that the client sent on the batch API or on stream `/end` is final: a late error event does not turn the session into `error` (it still counts in `agent_error_events` and in the tool and model error rates), whereas a status the console derived can still flip. And for externally traced agents the time an event is counted at is clamped into 3 hours before to 5 minutes after its arrival, and events older than 24 hours are not counted.

**Per-entity metrics.** Modes: **T** threshold, **A** absence, **B** baseline ([Enterprise](#condition-types)), **S** SLO burn (Enterprise). Percentages are 0 to 100. A window without data counts as 0 for the plain totals (requests, sessions, calls, error events and cost), so a "less than" rule can fire on silence; rates, averages, percentiles and ratios are not judged without data.

| Metric | Module | Unit | What it measures | Modes |
|--------|--------|------|------------------|-------|
| `agent_sessions` | Agents | count | Sessions that reached a final status (success, error or abandoned) in the window | T A B |
| `agent_error_rate` | Agents | % | Sessions with status `error` divided by sessions | T A B S |
| `agent_error_events` | Agents | count | Error events inside sessions (tool, model or other), whether or not the session itself failed | T A B |
| `agent_tool_error_rate` | Agents | % | Failed tool calls divided by executed tool calls | T A B |
| `agent_ai_error_rate` | Agents | % | Failed model calls (`ai_call`, `summarization`, `reflection`, `embedding`) divided by executed model calls | T A B |
| `agent_p95_duration_ms` | Agents | ms | 95th percentile of session duration (abandoned sessions have no duration) | T A B S |
| `agent_avg_duration_ms` | Agents | ms | Average session duration | T A B |
| `agent_abandoned_rate` | Agents | % | Abandoned sessions divided by sessions | T A B |
| `agent_cost` | Agents | $ | Model cost of the sessions (USD) | T A B |
| `agent_tokens_per_session` | Agents | count | Input plus output tokens divided by sessions | T A B |
| `model_requests` | Model Hub | count | Requests | T A B |
| `model_error_rate` | Model Hub | % | Failed requests divided by requests, cancelled requests excluded | T A B S |
| `model_p95_latency_ms` | Model Hub | ms | 95th percentile request latency | T A B S |
| `model_avg_latency_ms` | Model Hub | ms | Average request latency | T A B |
| `model_cost` | Model Hub | $ | Cost of the requests (USD) | T A B |
| `kb_queries` | Knowledge Engine | count | Queries | T A B |
| `kb_error_rate` | Knowledge Engine | % | Failed queries divided by queries | T A B S |
| `kb_p95_latency_ms` | Knowledge Engine | ms | 95th percentile query latency | T A B S |
| `kb_avg_latency_ms` | Knowledge Engine | ms | Average query latency | T A B |
| `kb_empty_result_rate` | Knowledge Engine | % | Queries that returned no match divided by queries that did not fail | T A B |
| `mcp_server_requests` | MCP Servers | count | Tool calls | T A B |
| `mcp_server_error_rate` | MCP Servers | % | Failed calls divided by calls | T A B S |
| `mcp_server_p95_latency_ms` | MCP Servers | ms | 95th percentile call latency | T A B S |
| `tool_calls` | Tools | count | Executions | T A B |
| `tool_error_rate` | Tools | % | Failed executions divided by executions | T A B S |
| `tool_p95_latency_ms` | Tools | ms | 95th percentile execution latency | T A B S |

Latency percentiles are read from a fixed histogram (bounds at 100, 250, 500 ms, 1, 2, 3, 5, 10, 20, 30 s, and 1, 2, 5, 10 min) and interpolated inside the bucket, so they are close approximations. Tokens and cost of an agent session are booked when the session first reaches a final status.

**Metrics that are not per entity** support threshold conditions only and are evaluated over the rule's window against the live source, with an optional scope (model, inference server, guardrail, Knowledge Engine module or MCP server).

| Module | Metrics |
|--------|---------|
| Model Monitoring (`inference`) | `gpu_cache_usage`, `request_queue_depth` |
| Guardrails (`guardrails`) | `guardrail_fail_rate`, `guardrail_avg_latency_ms`, `guardrail_total_evaluations`, `guardrail_block_rate`, `guardrail_avg_risk_score`, `guardrail_total_decisions`, `guardrail_approval_rate` (kept for compatibility; always 0) |
| Knowledge Engine (`rag`) | `rag_failed_documents` |
| Analysis, Evaluation, Red Team | `analysis_pass_rate`, `analysis_avg_judge_score`, `analysis_avg_accuracy`, `evaluation_pass_rate`, `evaluation_avg_score`, `redteam_attack_success_rate`, `redteam_resilience_score` (percentages averaged over the runs completed in the window) |
| AI App Gateway (`ai-app-gateway`) | `appgw_requests`, `appgw_block_rate`, `appgw_error_rate`, `appgw_requests_per_user` (collected by the Enterprise build) |

Rules created before per-entity alerting use the older module-wide metrics (`error_rate`, `avg_latency_ms`, `p95_latency_ms`, `total_cost`, `total_requests`, `rag_avg_latency_ms`, `rag_total_queries`, `mcp_error_rate`, `mcp_avg_latency_ms`, `mcp_total_requests` and the `aegis_*` spellings of the guardrail metrics). They keep working unchanged, with their scope and their channels, and are no longer offered for new rules. Create the per-entity equivalent to get one state and one incident per model, knowledge base or MCP server.

### Targets

A per-entity rule has a target:

- **All entities of the type** (the default): every agent, model, knowledge base, MCP server or tool that has data is evaluated, each on its own. Entities that start reporting later are picked up automatically. A rule evaluates at most its 2,000 busiest entities.
- **Selected entities**: 1 to 50 keys. The picker lists entities with data in the last 30 days, and you can type a key that has not reported yet.

Rules on the metrics that are not per entity have no entity target. They cover the whole project, or one resource through the rule's scope.

### Condition types

| Type | Fires when | Edition |
|------|------------|---------|
| **Threshold** | The metric over the evaluation window is `>`, `>=`, `<`, `<=` or `=` a fixed value | Core |
| **Absence** | An entity that normally has traffic had none in the window (it stopped sending traffic) | Core |
| **Baseline** | The metric deviates from its own normal for the same time of day by a configured ratio and number of standard deviations | Enterprise |
| **SLO burn** | The error budget of an objective burns faster than allowed over a long and a short window | Enterprise |

Settings every type shares:

| Setting | Meaning |
|---------|---------|
| Evaluation window | The period each evaluation looks at: 5, 15, 30, 60, 120, 240 or 1440 minutes. SLO burn uses its own long and short windows |
| Hold for | The condition must hold for this long before the alert fires (0 to 1440 minutes, default 0) |
| Minimum samples | Windows with fewer events than this are not judged. Defaults: 1 (threshold), 20 (baseline), 50 (SLO burn). Absence ignores it. For a baseline rule on a total such as sessions or requests it does not apply, so a drop to a few events is still seen |

**Absence** takes two settings. An entity counts as normally active when its average number of requests per window over the last *usual activity* hours (1 to 168, default 24) is at least *expected per window* (default 1). When such an entity has no requests in the window the alert fires, and it stays firing until traffic returns.

**Baseline** compares the current window with the same time of day on previous days. Settings: direction (above normal, below normal, or either), sensitivity, history, and where "normal" is taken from. The three sensitivity presets set a minimum ratio and a minimum deviation:

| Preset | Fires at | History |
|--------|----------|---------|
| Sensitive | 1.5× normal and 2 standard deviations | 14 days |
| Balanced (default) | 2× normal and 3 standard deviations | 14 days |
| Calm | 3× normal and 4 standard deviations | 14 days |

Custom values: minimum ratio 1 to 20, minimum deviation 0 to 20, minimum absolute change (in the metric's unit), history 3 to 45 days. "Normal" is taken from the same time on previous days (daily), the same weekday and time (weekly, needs at least 21 days of history), or the preceding windows (trailing). An entity without enough history is not judged. A baseline rule on a count or cost metric whose direction is below normal or either also covers an entity that had traffic in the last 24 hours but none now, so a drop to zero is caught.

**Percentage metrics** (every `*_error_rate` metric, `kb_empty_result_rate` and `agent_abandoned_rate`) are judged a little differently, so that a quiet entity does not alert on a single error. "Normal" is the pooled rate over the history windows: all failures divided by all requests. With 5 or more windows, the failures of each window are capped at the 90th-percentile window rate (never below one failure), so a past incident does not raise normal. The tolerance is the largest of the statistical noise expected at the current window's volume (the binomial standard error), the spread of the windows' rates and 0.5 percentage points. Latency, count and cost metrics use the median and the spread of the history windows.

**SLO burn** applies to the metrics marked S above: `*_error_rate` metrics count failed requests as bad events and the `*_p95_*` metrics count requests slower than a latency bound you choose (one of the histogram bounds). Settings: objective (50 to 99.999 %, default 99), SLO window (1 to 45 days, default 30), burn rate (1 to 100, default 14.4), long window (default 60 minutes) and short window (default 5 minutes; the long window must be longer). The burn rate is `(bad / total) / (1 − objective)`, and the alert fires only while both windows burn at least the configured rate, so a short spike does not page and a recovered incident stops paging quickly.

Baseline and SLO burn need an Enterprise build and an active Enterprise licence. Without them the rule cannot be created (the API answers `402`), and a rule that already exists keeps its settings but shows **Not evaluated** until the licence is back.

Before saving, **Preview now** evaluates the rule against current data without sending anything or storing state. It lists up to 50 entities, those that would fire first.

**Backtest · last 7 days** replays the rule as it stands in the form over the last 7 days, again without saving or sending anything. It shows how many times the rule would have fired, the median duration of the replayed incidents that recovered, and the five entities that would have fired most. When a **Threshold** rule would have fired more than twice (and its operator is not `=`), it also suggests the mildest threshold at which it would have fired at most twice; **Apply threshold** puts that value into the form, and nothing changes until you save. Only per-entity metrics with a **Threshold** or **Absence** condition can be replayed, and at most the 200 busiest entities are. A backtest is limited to 10 per minute per user and 30 per minute per project.

**Runbook URL** (optional, `http` or `https`) links the page your team follows when the rule fires. It appears as **Open the runbook** on the rule's incidents.

### From breach to incident

Each entity of a rule has its own state:

| State | Meaning |
|-------|---------|
| OK | The condition does not hold |
| Pending | The condition holds but the alert has not fired yet: it has not held for the **Hold for** time, or the rule is still inside its cooldown |
| Firing | The alert fired: one alert event and one incident were created and the channels were notified |

- **Cooldown** (0 to 10,080 minutes, default 60) is the minimum time between two firings of the same rule and entity. A breach inside the cooldown stays pending and fires when the cooldown is over if it still holds.
- **Remind every** (0 for never, or 15 to 1,440 minutes) repeats the notification while the incident is still **Open**. Acknowledging, investigating or resolving it stops the reminders, and [snoozing](#incidents) it or muting the rule holds them back.
- **Resolve:** a firing alert resolves after two consecutive evaluation windows in which the condition no longer holds (a window without data counts as not holding, except for absence alerts). Per-entity rules evaluate whole 5-minute buckets, so this takes about 10 minutes. The incident is resolved automatically (`autoResolved`) with a note, unless a person already resolved or closed it. With **Notify when resolved** (on by default) every channel receives a recovery message.
- Disabling, deleting or reshaping a rule (metric, module, target, condition, window or hold time) forgets its per-entity states. Incidents that were open stay open and receive a system note, so close them yourself.

**When it fires.** Per-entity rules evaluate whole, closed 5-minute buckets that are at least one flush interval old (`ENTITY_METRICS_FLUSH_MS`, 30 seconds by default), and the scheduler runs every minute. With the defaults an alert fires roughly 0.5 to 6.5 minutes after the data arrived, plus the **Hold for** time. Rules on the metrics that are not per entity read their source directly and are not delayed by the rollup.

### Severity

A rule's severity is **Automatic**, **Info**, **Warning** or **Critical**. With Automatic it is derived when the alert fires:

| Condition type | Critical | Warning | Info |
|----------------|----------|---------|------|
| Threshold | The value is at least 2× past the threshold (for `<` and `<=`, threshold ÷ value) | At least 1.25× | Less than 1.25×. A threshold of 0 or less and the `=` operator give Warning |
| Absence | Always | | |
| Baseline | The deviation is at least twice the configured minimum ratio or deviation, in the configured direction | Otherwise | |
| SLO burn | The short-window burn is at least twice the configured burn rate | Otherwise | |

### Notification channels

A rule has 1 to 10 channels. Every channel receives the alert when it fires, when it is re-notified, and (unless turned off) when it resolves.

| Channel | Configuration | What is sent |
|---------|---------------|--------------|
| Email | Up to 50 recipients. Left empty it goes to the workspace owners and admins; disabled accounts are skipped | An HTML email for fired, re-notified, resolved and test notifications |
| Webhook | HTTPS URL and an optional signing secret | A signed JSON `POST` (below) |
| Slack | A Slack incoming-webhook URL | A Block Kit message with a severity colour and a button to the incident |
| Microsoft Teams | A Teams workflow or incoming-webhook URL | An Adaptive Card (version 1.4) |
| PagerDuty | The 32-character Events API v2 integration key | `trigger` when it fires or is re-notified, `resolve` when it recovers |

PagerDuty events carry the deduplication key `cognipeer:<ruleId>:<entityKey>` (`_` for a rule without an entity), so a reminder updates the open PagerDuty incident and a recovery closes it. The resolve event is only sent when **Notify when resolved** is on.

**Shared channels.** A rule can also use a channel of the workspace's library instead of its own copy. **Alerts & Incidents → Channels** keeps each one once for every project, with a name (up to 80 characters, unique in the workspace), a type that cannot change after creation, and the destination. Change the Slack URL there and every rule that uses it sends to the new one from its next notification. The list shows the destinations masked and, under **Used by**, the rules that use each channel (the rules of the current project, or of every project for owners and admins). Workspace owners and admins create, edit, test and delete shared channels, up to 100; everyone who works with alerts can add them to a rule under **Shared channels**, where they count toward the rule's 10 channels. A channel that rules still use cannot be deleted. If a shared channel is gone anyway, its deliveries fail (the incident's **Notifications** card says the library channel no longer exists) and the rule's other channels are still notified.

**Webhook payload.** The body is `{ "type", "id", "occurredAt", "data" }`. `type` is `alert.fired`, `alert.resolved`, `alert.renotify` or `alert.test`, `id` starts with `alr_`, and `data` carries the rule, the entity, the value, the baseline, the severity, the links and the incident context:

```json
{
  "type": "alert.fired",
  "id": "alr_3f9a1c2b7d4e5f60a1b2c3d4",
  "occurredAt": "2026-10-15T09:42:11.382Z",
  "data": {
    "kind": "fired",
    "rule": {
      "id": "665f1c0e8b1d4c0012ab34cd",
      "name": "Agent error rate",
      "module": "agents",
      "metric": "agent_error_rate",
      "metricLabel": "Agent Error Rate",
      "unit": "%",
      "mode": "threshold",
      "windowMinutes": 15,
      "operator": "gt",
      "threshold": 5
    },
    "entity": { "type": "agent", "key": "pulse-main" },
    "value": 7.1,
    "baseline": null,
    "severity": "warning",
    "firedAt": "2026-10-15T09:42:11.000Z",
    "resolvedAt": null,
    "projectName": "Production",
    "companyName": "Acme",
    "dashboardUrl": "https://console.example.com/dashboard/alerts/incidents",
    "incidentUrl": "https://console.example.com/dashboard/alerts/incidents?highlight=665f1c1a8b1d4c0012ab34ce",
    "entityUrl": "https://console.example.com/dashboard/tracing/agents/pulse-main",
    "context": {
      "mode": "threshold",
      "windowMinutes": 15,
      "versionChange": { "from": "1.4.0", "to": "1.5.0", "firstSeenAt": "2026-10-15T09:24:00.000Z" },
      "errorSignatures": [{ "message": "tool timeout after <n>ms", "count": 12 }],
      "failingSessions": { "count": 14, "listPath": "/dashboard/tracing/sessions?agent=pulse-main&status=error&from=...&to=..." }
    },
    "summary": "Agent Error Rate for pulse-main is 7.1% over the last 15 minutes (condition: > 5%)."
  }
}
```

`entityUrl` links the entity's page in the console. An agent links to its page in Agent Observability. A model, knowledge base, MCP server or tool links to its health page in the Enterprise edition. Without it, they link to their own page, and `entityUrl` is absent for a model, MCP server or tool the console has no record of, such as a model that is only seen in traces.

The request has the headers `x-cognipeer-event` (the type), `x-cognipeer-event-id` (the `id`) and, when the channel has a signing secret, `x-cognipeer-signature: t=<unix seconds>,v1=<hex>`. The signature is `HMAC-SHA256(secret, "<t>.<raw body>")` as hex, the same scheme the [webhook subscriptions](/guide/webhooks#what-you-receive) use. Verify it against the raw request body, before parsing, and reject old timestamps:

```javascript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyAlertWebhook(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const given = parts.v1 ?? '';
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
```

Redirects are not followed, and a delivery that fails is not retried: for guaranteed delivery with retries subscribe to the `alert.fired` and `alert.resolved` events of [Agents → Webhooks](/guide/webhooks#events) instead.

**Secrets.** Webhook URLs and signing secrets, Slack and Teams URLs and PagerDuty keys are stored encrypted. The API and the dashboard show them masked: a short hint of the URL (`https://hooks.slack.com/…/abcd`), `hasSecret` for a webhook and the last four characters of a PagerDuty key. Leave a secret field empty when you edit a rule to keep the stored value. **Duplicate** does not copy these channels (only email channels and shared channels), so add them again on the copy.

**Destinations.** Webhook, Slack and Teams URLs must use `https`, must not contain credentials, and must resolve to a public address. This is checked when you save and again on every delivery. Redirects are not followed, and each delivery times out after `ALERT_CHANNEL_TIMEOUT_MS` (10 seconds by default).

**Send test** sends a clearly labelled test notification on one channel, either as typed or from a saved rule, and shows the result. Shared channels are tested on the **Channels** page, by workspace owners and admins. It is limited to 5 tests per minute per user and 20 per minute per project (`429` with a `Retry-After` header), and an unsaved email channel can be tested against at most 5 recipients. A PagerDuty test opens and immediately resolves its own throw-away incident.

### Incidents

An incident is created when an alert fires, one per rule and entity, and follows the alert through its life.

| Status | Meaning |
|--------|---------|
| `open` | Created when the alert fired |
| `acknowledged` | Someone has seen it |
| `investigating` | Someone is working on it |
| `resolved` | The cause is addressed, or the alert recovered by itself (shown as **Auto-resolved**) |
| `closed` | Done. A resolved or closed incident can be **Reopened** (with a bulk action, an acknowledged or investigating one too); it returns to `open` and shows how often it was reopened |

**The inbox.** **Incidents** opens on the open incidents of the project:

- **Summary.** **Open** and **Acknowledged** are live counts. **Fired**, **Resolved**, **Median time to acknowledge** and **Median time to resolve** cover the range you pick (**Last 24 h**, **Last 7 days** or **Last 30 days**), and each median says how many incidents it was taken over. An acknowledgement made before the incident was last reopened does not count, and an incident closed without being resolved has no time to resolve. The summary reads at most 5000 incidents of the range and says so when the range has more.
- **Tabs** per status (**Open**, **Acknowledged**, **Investigating**, **Resolved**, **Closed**, **All**), each with the project's count.
- **Search and filters.** Search matches the rule name, the entity and the metric id, ignoring case (a Turkish `ı` or `İ` matches `i` and `I`). Filter by severity, module, assignee (**Assigned to me**, **Unassigned**) and snooze, and sort by when the incident fired, when it was last updated, or its severity. **Group by rule** or **Group by entity** gathers the page into cards, worst severity first.
- **Views.** **All open**, **Assigned to me**, **Unassigned critical**, **Snoozed** and **Recently resolved** set the filters in one click. **Save current filters…** keeps your own views (up to 20) in this browser.
- **Preview.** Click a row to see the incident beside the list (under it on a narrow screen), with **Acknowledge**, **Resolve**, **Snooze** and **Assign to me**, and **View Detail** for the whole page.
- **Bulk actions.** Select incidents to **Acknowledge**, **Resolve**, **Close**, **Reopen**, **Assign…**, **Snooze…** or **Clear snooze**, up to 100 at once. Each action is sent only for the selected incidents that can make that move (when none can, nothing is sent), and the result says how many were updated and how many the server could not change. **Assign…** picks any user of the workspace; without access to the user list you can assign to yourself or clear the assignee.
- **Live.** While the tab is visible the inbox checks for changes every 15 seconds and reloads the page you are on when an incident of the project changed. Rows that are new or changed are marked for a few seconds. Turn **Live** off to hold the list still.

The link in a notification opens the incident highlighted in the inbox.

| Key | Action |
|-----|--------|
| `j` / `k` (or the arrow keys) | Next / previous incident |
| `x` | Select or deselect |
| `a`, `r`, `s`, `e` | Acknowledge, resolve, snooze, assign to me: the selected incidents, or the focused one |
| `/` | Search |
| `Enter` | Open the incident |
| `Esc` | Close the preview |
| `?` | Show the shortcuts |

Shortcuts are off while you type in a field. Resolving more than one incident asks for confirmation first.

**Snooze** stops the reminders of one incident (**For 1 hour**, **For 4 hours**, **Until tomorrow 09:00**, or a time up to 30 days ahead). Its status does not change and the resolve notification is still sent. Only an open, acknowledged or investigating incident can be snoozed, and resolving or closing it ends the snooze. To silence every notification of a rule, mute the rule instead.

**Muting a rule.** **Mute** in the rule list (1 hour, 4 hours, 24 hours, 7 days, or **Custom…** with an end up to 30 days ahead and an optional reason), or **Mute rule** on one of its incidents, silences the rule's channels: fired, reminder and resolve notifications are held back. The rule keeps evaluating, incidents are still opened and resolved, and [webhook subscriptions](/guide/webhooks#events) still receive `alert.fired` and `alert.resolved`. The mute ends by itself; **Unmute** ends it early.

**The incident page.** The toolbar under the header holds **Refresh**, the status moves, **Snooze**, **Mute rule** and **Assign to me** or **Unassign**. Badges show when the incident was auto-resolved or reopened, is snoozed, or its rule is muted. The page shows:

- **Detection**: condition type, entity, metric, value, peak, latest value, and the baseline when there is one.
- **Around the incident** (agents): the agent's health charts from 3 hours before the alert fired to an hour after it ended (or now, while it is open), at least 6 hours and at most 7 days, with a link to the failing sessions of that window.
- **Context** (below) and the **Activity** timeline: fired, acknowledged and resolved with the name of the person, closed, and every note.
- **Notifications**: every attempt to notify, per channel: **Sent**, **Failed** with its error, or **Held back** because the rule was muted or the incident snoozed. The newest 200 attempts are shown, and attempts are kept for 30 days.
- **Links**: **Open the rule**, **Open entity health**, **Related incidents** (the other incidents of the same rule and entity) and **Open the runbook** when the rule has a [runbook URL](#condition-types). **Open entity health**, like the entity in the inbox, leads to the entity's page, the same one as `entityUrl` in the [webhook payload](#notification-channels): an agent's page in Agent Observability, and for a model, knowledge base, MCP server or tool its health page in the Enterprise edition, otherwise its own page (none for one the console has no record of).
- **Similar incidents**: how often the same rule fired for the same entity in the last 30 days (counted up to 200), their median duration and the five most recent.

The **Context** card is gathered once, when the alert fires:

- **Version change** (agents): the version that most recently appeared among those running in the rule's window and the version it replaced (`1.4.0 → 1.5.0`), with how long before the alert fired it was first seen. The console looks back up to 6 hours before the alert, or twice the rule's window when that is longer, so a release that went out before the window is still found. When two versions run side by side it names the newer one. Nothing is shown for a new agent, a rollback, or a version that was already running when the lookback began.
- **Most common errors** (agents): the most frequent error messages of the failing sessions, with ids and numbers masked so equal failures group together.
- **Failing sessions** (agents): the number of failed sessions and a link to the session list filtered to them.
- **Related entities that also changed** (agents, Enterprise): the models and tools the agent used in the period (up to 10 of each) whose error rate or p95 latency is outside its own normal range, compared with the previous 7 days, worst first (at most 5). Dependencies with fewer than 5 events in the period are not judged.

The same context is sent to the channels (the top errors and the version change appear in the Slack, Teams and email messages; the version change reads like `1.4.0 → 1.5.0 (first seen 18 min before this fired)`). Context is best effort: an alert is never delayed or dropped because it could not be gathered.

### Alert history

The history view shows every alert event (fired, acknowledged, resolved) with the entity, the value, who acknowledged it and when it resolved. Filter by status, or by rule through the API, and use the search box to narrow the page you are looking at.

![Alerts history](/screenshots/monitoring/02-alerts-history.png)

Each row links back to the underlying signal — for an inference alert that's a model in [Model Hub](/guide/model-hub), for a guardrail alert that's the policy in [Guardrails](/guide/guardrails) — so triage stays one click away from the configuration that triggered it. Each row also shows how many of its notifications were delivered, and the error of the ones that were not.

The same events are available to your own systems as the `alert.fired` and `alert.resolved` [webhook events](/guide/webhooks#events). The REST API for rules, channels, incidents and history is in [Alerts API](/api/alerts) and [Incidents API](/api/incidents).

### Catching an agent that degrades

The agent `pulse-main` starts failing and slowing down after a new version is rolled out. To hear about it before users do:

1. Open **Alerts & Incidents → New Rule**. Pick the **Agents** module and the metric **Agent Error Rate**. Leave the target on all agents.
2. Choose the condition. With the Enterprise edition pick **Baseline**, direction **Above normal** and the **Balanced** preset: the rule fires when an agent's error rate is at least twice what is normal for that time of day, so a busy morning and a quiet night each have their own yardstick. Without it pick **Threshold**, `>` 5 over a 15-minute window, and set **Minimum samples** to 20 so a handful of sessions does not trigger it.
3. Set **Hold for** to 10 minutes and add a **Slack** channel. Use **Send test** to check the destination, then **Preview now** to see which agents would fire today. With a Threshold condition, **Run backtest** shows how often the rule would have fired over the last 7 days, and suggests a threshold when that is more than twice.
4. Add a second rule on **Agent P95 Duration**, so a slowdown that does not raise errors is caught as well.
5. When `pulse-main` degrades, the Slack message names the agent, the value and, from the incident context, the version that changed (`1.4.0 → 1.5.0`, and how long before the alert it first appeared), the most common errors and a link to the failing sessions. **Acknowledge** the incident so reminders stop.
6. After the fix, two clean 5-minute windows resolve the alert on their own, the incident is closed out as **Auto-resolved** and Slack receives the recovery message.

To be told when an agent goes quiet, add an **Absence** rule on **Agent Sessions**.

## Audit Log

Every state-changing action on the console — provider edits, model deployments, prompt promotions, token issuance, license updates, member changes — is recorded in the tenant audit log.

![Audit log](/screenshots/monitoring/03-audit-log.png)

Columns surface the actor, the action, the resource type and ID, and the timestamp. Use the filters at the top to narrow by actor, action, or resource type when responding to a compliance question or investigating a configuration drift.

### Refused requests

Every request the authorization engine refuses is written to the audit log, `GET` included: a `403` because the caller lacks a permission, and a `503` because the engine could not decide at all. The **Audit** tab of the **IAM center** lists them as **Denials** (last 30 days by default, CSV export included) next to the policy changes, and a refusal's decision id opens in the **Access check** with the rule that decided it. `GET /api/iam/engine/stats` returns the engine's health and counters (`enforce.unavailable`, `enforce.undeclaredDenies`) and the `authorization-engine` entry of `GET /api/health/ready` reports `ok`, `degraded` or `down`. See [Authorization](/guide/authorization#check-access).

## License

The License screen shows what the current installation is allowed to do — plan tier, configured project budget versus active projects, expiry, and the signed license key payload.

![License screen](/screenshots/monitoring/04-license.png)

In an offline-enterprise deployment you paste the signed token here; the runtime verifies it on every startup against the bundled public key and enforces the limits described in [Licensing](/guide/licensing). **Reset to free** drops back to the bundled FREE license — useful for evaluating, not for production.

## Cluster topology

Multi-node deployments add a second observability surface: the node registry and the per-entity instance assignments. The [Cluster](/guide/cluster) page in **Admin → Cluster** shows every running process, the queue provider in use (in-process vs BullMQ), and which agents, MCP servers, browsers, JS runtimes, inference servers, alert rules, and automations are pinned to which node. The same data is available programmatically via `GET /api/cluster/overview` and `GET /api/cluster/instances`.

## Structured Logging

All server-side code uses the Winston-based structured logger:

```typescript
import { createLogger } from '@/lib/core/logger';
const logger = createLogger('my-service');
```

### Log Format

**JSON (production):**

```json
{
  "timestamp": "2025-01-15 10:30:45.123",
  "level": "info",
  "scope": "inference",
  "requestId": "a1b2c3d4-5678-90ab-cdef",
  "tenantId": "tenant_acme",
  "message": "Chat completion",
  "model": "gpt-4",
  "tokens": 150,
  "latencyMs": 450
}
```

**Pretty (development):**

```
2025-01-15 10:30:45.123 info [inference](a1b2c3d4){tenant_acme} Chat completion {"model":"gpt-4","tokens":150}
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | `pretty` (dev) / `json` (prod) | `json` or `pretty` |
| `LOG_REQUEST_BODY` | `false` | Log request body (sanitized) |
| `LOG_RESPONSE_BODY` | `false` | Log response body (sanitized) |

### Log Aggregation

JSON logs are compatible with common aggregation tools:

- **ELK Stack** — Elasticsearch, Logstash, Kibana
- **Datadog** — Direct JSON log ingestion
- **Grafana Loki** — Label-based log aggregation
- **CloudWatch** — AWS native log ingestion

Per-request fields (`requestId`, `tenantId`, `scope`) enable filtering and correlation across services.

## Health Checks

### Endpoints

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /api/health/live` | Liveness (is process alive?) | Always 200 |
| `GET /api/health/ready` | Readiness (are dependencies healthy?) | 200 or 503 |

### Health Report

```json
{
  "status": "ok",
  "uptime": 86400,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "checks": {
    "mongodb": { "status": "ok", "latencyMs": 5 },
    "cache": { "status": "ok", "latencyMs": 2, "details": { "provider": "redis" } }
  }
}
```

### Status Values

| Status | Meaning |
|--------|---------|
| `ok` | Component is healthy |
| `degraded` | Component is working but with issues |
| `down` | Component is unavailable |

## Request Tracing

Every request gets a unique `requestId` (UUID) that flows through the entire processing chain:

```
Client → Middleware (set x-request-id)
       → Route Handler
         → Service Layer
           → Provider Call
             → All log entries include requestId
```

Clients can provide their own request ID via the `X-Request-Id` header or `request_id` body field.

## Circuit Breaker Monitoring

Circuit breaker states are available programmatically:

```typescript
import { getAllCircuitStates } from '@/lib/core/resilience';

const states = getAllCircuitStates();
// Map<string, { state: 'closed'|'open'|'half-open', failures: number }>
```

Monitor for `open` circuits to identify unhealthy providers.

## Usage Tracking

Every LLM inference request is logged with:

| Field | Description |
|-------|-------------|
| Model key | Which model was used |
| Provider | Which provider handled the request |
| Token counts | Input, output, total, cached |
| Latency | End-to-end request time (ms) |
| Status | Success or error |
| Tool calls | Any tool/function calls made |
| Request ID | For correlation |

Usage data is written asynchronously via `fireAndForget` to avoid impacting response latency.

## Runtime Pool Stats

```typescript
import { runtimePool } from '@/lib/core/runtimePool';

const { size, keys } = runtimePool.stats();
// size: number of cached provider SDK instances
// keys: list of cache keys
```

## Async Task Monitoring

```typescript
import { pendingTaskCount } from '@/lib/core/asyncTask';

const count = pendingTaskCount();
// Number of fire-and-forget tasks still running
```

## Prometheus metrics

`GET /api/metrics` returns the tenant's metrics in the Prometheus text format (`text/plain; version=0.0.4`). It needs an API token of the tenant, and the token must not carry a service scope: a scoped token is refused with `403` because the export is tenant-wide. Add it to a scrape job with the token as a bearer credential:

```yaml
scrape_configs:
  - job_name: cognipeer-console
    metrics_path: /api/metrics
    scheme: https
    authorization:
      credentials: <api token>
    static_configs:
      - targets: ['console.example.com']
```

The agent tracing and entity health gauges cover a rolling **24 hours** and are read from the same 5-minute rollups as the health views, in two grouped queries that are cached for 45 seconds per tenant, so a short scrape interval does not add database load. Per-entity alert states and incidents are not exported as metrics; use the [alert channels](#notification-channels) to be told when something fires.

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `console_tracing_sessions_total` | gauge | `status` (`success`, `error`, `abandoned`) | Agent sessions that reached a final status in the last 24 hours. Running sessions are not counted until they end |
| `console_tracing_agents_total` | gauge | | Distinct agents with at least one session in the last 24 hours (traced and hosted agents) |
| `console_tracing_input_tokens_24h` | gauge | | Input tokens of the sessions that finished in the last 24 hours |
| `console_tracing_output_tokens_24h` | gauge | | Output tokens of the sessions that finished in the last 24 hours |
| `console_entity_requests_24h` | gauge | `entity_type` (`agent`, `model`, `tool`, `mcp`, `kb`) | Requests per entity type in the last 24 hours. MCP counts include the calls a composite server makes to its members |
| `console_entity_errors_24h` | gauge | `entity_type` | Failed requests per entity type in the last 24 hours |
| `console_alert_rules_total` | gauge | `enabled` (`true`, `false`) | Alert rules per enabled state (unchanged) |
| `console_active_alerts_total` | gauge | | Alert events in status `fired`, that is not yet acknowledged or resolved (unchanged) |

**Changes from earlier versions.** If you have dashboards or alert rules on these series, update them:

- `console_tracing_input_tokens_total` and `console_tracing_output_tokens_total` are renamed to `console_tracing_input_tokens_24h` and `console_tracing_output_tokens_24h`. They are 24-hour window gauges, not monotonic counters, so they no longer carry the `_total` suffix and `rate()` or `increase()` queries on them give no meaningful result.
- `console_tracing_sessions_total` now has the `status` values `success`, `error` and `abandoned` only, and counts the sessions that **finished** in the last 24 hours. Before, its `status` label carried the raw status clients had sent (for example `in_progress`, `completed` or `failed`).
- `console_tracing_agents_total` counts the agents active in the last 24 hours, hosted agents included, instead of every agent ever traced.
- `console_entity_requests_24h` and `console_entity_errors_24h` are new.

The other `console_*` families (projects, users, items per module, usage) are unchanged.

## Recommended Monitoring Stack

| Component | Purpose |
|-----------|---------|
| **JSON Logs** | Log aggregation + search |
| **Health endpoints** | Kubernetes probes + uptime monitoring |
| **Alert rules** | Per-agent, model, knowledge base, MCP server and tool alerting to email, Slack, Teams, PagerDuty and webhooks |
| **Agent health views** | Error rate, latency and cost of every agent against the period before, with versions and incidents ([Agent Tracing](/guide/tracing#agent-health)) |
| **Prometheus `/api/metrics`** | Tenant-wide gauges for Grafana and existing alerting |
| **Usage tracking** | Dashboard analytics + billing |
| **Circuit breaker states** | Provider health monitoring |
| **Async task count** | Background processing health |
