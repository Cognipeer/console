# Alerts API

Alert rules, their notification channels and the alert history are managed through the dashboard API. The incidents that alerts open have their own page: [Incidents API](./incidents). What a rule evaluates, how it fires and resolves, and what each channel sends are described in [Monitoring](/guide/monitoring#alerts-incidents).

::: info
These endpoints are dashboard APIs, authenticated via JWT session (not API tokens). They are used by the Cognipeer Console UI. Reading needs **Read** on the Alerts & Incidents service (`alerts`); every change needs **Write**. Lists show the records of the active project. By id, a member reaches only records of the active project (another project's answers `404`); workspace owners and admins can open a record of any project by id.
:::

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/alerts/rules` | List rules with the metric catalog and per-rule state counts |
| `POST` | `/api/alerts/rules` | Create a rule |
| `GET` | `/api/alerts/rules/:ruleId` | One rule with its per-entity states |
| `PUT` | `/api/alerts/rules/:ruleId` | Update a rule (partial body) |
| `PATCH` | `/api/alerts/rules/:ruleId` | Enable or disable a rule |
| `DELETE` | `/api/alerts/rules/:ruleId` | Delete a rule |
| `POST` | `/api/alerts/rules/preview` | Evaluate a draft rule against current data |
| `GET` | `/api/alerts/entities` | Entities with data, for target pickers |
| `POST` | `/api/alerts/channels/test` | Send a test notification on one channel |
| `GET` | `/api/alerts/history` | Alert history |
| `PATCH` | `/api/alerts/history/:eventId/acknowledge` | Acknowledge an alert event |

Incident endpoints (`/api/alerts/incidents/*`) are on the [Incidents API](./incidents) page.

## The rule object

Create and update take these fields; reads return them together with `_id`, `tenantId`, `projectId`, `createdBy`, `updatedBy`, `lastTriggeredAt`, `createdAt` and `updatedAt`.

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Required on create, at most 120 characters |
| `description` | string | At most 1,000 characters. An empty string clears it |
| `module` | string | `agents`, `models`, `rag`, `mcp`, `tools`, `inference`, `guardrails`, `analysis`, `evaluation`, `redteam` or `ai-app-gateway`. A new rule cannot use the retired `aegis` module |
| `metric` | string | A metric of that module (`meta.moduleMetrics`) |
| `condition` | object | What counts as a breach (below) |
| `windowMinutes` | integer | Evaluation window: `5`, `15`, `30`, `60`, `120`, `240` or `1440` |
| `entity` | object or `null` | Target of a per-entity metric (below). Not accepted for the other metrics |
| `scope` | object | For the metrics that are not per entity only: `modelKey`, `serverKey`, `guardrailKey`, `ragModuleKey`, `mcpServerKey` (strings, at most 200 characters). Ignored for per-entity metrics |
| `cooldownMinutes` | integer | Minimum time between two firings of the same rule and entity, `0` to `10080`. Default `60` |
| `severity` | string or `null` | `auto` (default; derived from the breach), `info`, `warning` or `critical`. `null` resets to `auto` |
| `notifyOnResolve` | boolean | Send a recovery message when the alert resolves. Default `true` |
| `renotifyMinutes` | integer or `null` | `0` (never, the default) or `15` to `1440`: repeat the notification while the incident is `open`. `null` resets to `0` |
| `channels` | array | 1 to 10 notification channels (below). Omitted on create it is one email channel with no recipients, which goes to the workspace owners and admins; omitted on update the stored channels are kept |
| `enabled` | boolean | Default `true` |

Which metrics are per entity (`source: "entity"` in `meta.catalog`) and what each measures is listed in [Monitoring](/guide/monitoring#metrics).

### `condition`

| Field | Applies to | Description |
|-------|------------|-------------|
| `mode` | all | `threshold` (default), `absence`, `baseline` or `slo_burn`. The metric must support the mode (`modes` in `meta.catalog`) |
| `operator` | `threshold` | Required: `gt`, `gte`, `lt`, `lte` or `eq` |
| `threshold` | `threshold` | Required, a number in the metric's unit. `operator` and `threshold` are ignored by the other modes |
| `forMinutes` | all | Integer `0` to `1440`: the breach must hold this long before the alert fires. Default `0` |
| `minSamples` | all | Integer `1` to `1000000`: windows with fewer events are not judged. Defaults: `1` (threshold), `20` (baseline), `50` (SLO burn). `absence` ignores it |
| `absence` | `absence` | `lookbackHours` (integer `1` to `168`, default `24`) and `minExpectedPerWindow` (number of at least `0.001`, default `1`) |
| `baseline` | `baseline` | `direction` (`up` default, `down`, `both`), `minRatio` (`1` to `20`, default `2`), `minZ` (`0` to `20`, default `3`), `minDelta` (at least `0`, default `0`), `lookbackDays` (integer `3` to `45`, default `14`), `seasonality` (`daily` default, `weekly`, `trailing`). `weekly` needs `lookbackDays` of at least `21` |
| `slo` | `slo_burn` | `objectivePct` (`50` to `99.999`, default `99`), `windowDays` (integer `1` to `45`, default `30`), `burnRate` (`1` to `100`, default `14.4`), `longWindowMinutes` (default `60`), `shortWindowMinutes` (default `5`; the long window must be longer), and for the `*_p95_*` metrics `latencyThresholdMs`, required, one of `100`, `250`, `500`, `1000`, `2000`, `3000`, `5000`, `10000`, `20000`, `30000`, `60000`, `120000`, `300000`, `600000` |

`baseline` and `slo_burn` are Enterprise features. Without an Enterprise build or an active licence a create or update that uses them is refused with `402` (see [Errors](#errors)). `meta.modes` of the rule list tells which modes the workspace can use.

### `entity`

```json
{ "entityType": "agent", "mode": "selected", "keys": ["pulse-main", "support-bot"] }
```

| Field | Description |
|-------|-------------|
| `entityType` | `agent`, `model`, `tool`, `mcp` or `kb`. Must be the type of the metric (optional: it defaults to it) |
| `mode` | `all` (default): every entity of the type that has data, each on its own. `selected`: only `keys` |
| `keys` | Required for `selected`: 1 to 50 entity keys (agent name, model key, tool key, MCP server key or knowledge base key), each at most 200 characters. A key that has not reported yet is accepted |

Leaving `entity` out, or sending `null`, on a per-entity metric means `{ "entityType": <the metric's type>, "mode": "all" }`.

### `channels`

| `type` | Fields | Notes |
|--------|--------|-------|
| `email` | `recipients`: up to 50 addresses | Empty goes to the workspace owners and admins |
| `webhook` | `url`, optional `secret` | A signed JSON `POST` when a secret is set |
| `slack` | `url` | A Slack incoming-webhook URL |
| `teams` | `url` | A Teams workflow or incoming-webhook URL |
| `pagerduty` | `routingKey` | The 32-character Events API v2 integration key |

Webhook, Slack and Teams URLs are at most 2,048 characters, a webhook `secret` at most 512, and a PagerDuty `routingKey` is exactly 32 letters or digits. Webhook, Slack and Teams URLs must use `https`, must not contain credentials and must resolve to a public address; this is checked when the rule is saved and again on every delivery.

Every channel has an `id` (`ch_` and 12 hex characters) that the server assigns. Send it back on update to keep the channel: a `url`, `secret` or `routingKey` you leave out keeps the stored value for that id, and an empty `secret` on a webhook removes the signing secret. A channel whose `id` is not in the body is removed.

Credentials never leave the server. A read returns each channel masked:

| `type` | Returned |
|--------|----------|
| `email` | `id`, `type`, `recipients` |
| `webhook` | `id`, `type`, `urlHint` (for example `https://hooks.example.com/…/ab12`), `hasSecret` |
| `slack`, `teams` | `id`, `type`, `urlHint` |
| `pagerduty` | `id`, `type`, `keyHint` (the last four characters, `…wxyz`) |

## List Rules

```
GET /api/alerts/rules
```

Returns the rules of the project, the catalog the rule form is built from, and the state counts per rule.

```json
{
  "meta": {
    "moduleMetrics": { "agents": ["agent_sessions", "agent_error_rate", "..."], "models": ["..."] },
    "validMetrics": ["agent_sessions", "agent_error_rate", "..."],
    "validModules": ["models", "inference", "guardrails", "rag", "mcp", "analysis", "evaluation", "redteam", "ai-app-gateway", "agents", "tools"],
    "validWindows": [5, 15, 30, 60, 120, 240, 1440],
    "catalog": [
      {
        "id": "agent_error_rate",
        "module": "agents",
        "label": "Agent Error Rate",
        "unit": "%",
        "source": "entity",
        "entityType": "agent",
        "modes": ["threshold", "baseline", "absence", "slo_burn"],
        "goodDirection": "down"
      }
    ],
    "modes": {
      "threshold": { "available": true },
      "absence": { "available": true },
      "baseline": { "available": false, "reason": "license_required" },
      "slo_burn": { "available": false, "reason": "license_required" }
    },
    "channelTypes": ["email", "webhook", "slack", "teams", "pagerduty"]
  },
  "rules": [
    {
      "_id": "665f1c0e8b1d4c0012ab34cd",
      "name": "Agent error rate",
      "module": "agents",
      "metric": "agent_error_rate",
      "enabled": true
    }
  ],
  "states": {
    "665f1c0e8b1d4c0012ab34cd": { "ok": 1, "pending": 0, "firing": 2 }
  }
}
```

(`rules` entries are the full [rule object](#the-rule-object); they are abbreviated here.)

- `meta.catalog` has one entry per metric: `id`, `module`, `label`, `unit` (`%`, `ms`, `$`, `count`, `score` or empty), `source` (`entity` for the per-entity metrics, `legacy` for the others), `entityType` for per-entity metrics, `modes`, `goodDirection` (`down` when a lower value is better) and `zeroWhenEmpty` (`true` for the plain totals, which count as `0` in a window without data). Entries marked `hiddenForNewRules` are the module-wide metrics of earlier versions: the rule form does not offer them for new rules, and existing rules keep working.
- `meta.modes.<mode>.reason` is `not_enterprise_build` or `license_required` when `available` is `false`.
- `states` counts the stored per-entity states of each rule. An entity that has never breached has no stored state, so `ok` counts only entities that were pending or firing before.

## Create a Rule

```
POST /api/alerts/rules
```

```json
{
  "name": "Agent error rate",
  "module": "agents",
  "metric": "agent_error_rate",
  "condition": { "mode": "threshold", "operator": "gt", "threshold": 5, "forMinutes": 10, "minSamples": 20 },
  "windowMinutes": 15,
  "entity": { "entityType": "agent", "mode": "all" },
  "cooldownMinutes": 60,
  "severity": "auto",
  "renotifyMinutes": 60,
  "channels": [
    { "type": "slack", "url": "https://hooks.slack.com/services/T0000/B0000/XXXXXXXX" },
    { "type": "email", "recipients": ["oncall@example.com"] }
  ]
}
```

Returns `201` with `{ "rule": { ... } }`, channels masked. A baseline rule (Enterprise) replaces the condition:

```json
{
  "name": "Agent errors above normal",
  "module": "agents",
  "metric": "agent_error_rate",
  "condition": {
    "mode": "baseline",
    "baseline": { "direction": "up", "minRatio": 2, "minZ": 3, "lookbackDays": 14, "seasonality": "daily" }
  },
  "windowMinutes": 15,
  "channels": [{ "type": "pagerduty", "routingKey": "0123456789abcdef0123456789abcdef" }]
}
```

## Get a Rule

```
GET /api/alerts/rules/:ruleId
```

Returns `{ "rule": { ... }, "states": [ ... ] }`. `states` lists up to 200 per-entity states of the rule:

| Field | Description |
|-------|-------------|
| `entityKey`, `entityType` | The entity. `entityKey` is an empty string for a rule without an entity target |
| `phase` | `ok`, `pending` or `firing` |
| `phaseSince` | When the entity entered this phase |
| `lastValue`, `lastBaseline`, `lastSampleCount` | The latest judged value, the normal value (baseline rules), and the number of events behind the value |
| `lastEvaluatedAt` | When the entity was last evaluated |
| `incidentId`, `eventId` | The incident and alert event of the current firing |
| `firedAt`, `lastFiredAt`, `lastNotifiedAt`, `peakValue` | Timing and the highest value of the current firing |
| `detail` | Extra facts of the last evaluation, such as `insufficientData` or the baseline `ratio` and `z` |

## Update a Rule

```
PUT /api/alerts/rules/:ruleId
```

The body overlays the stored rule, so it may carry only the fields to change; the result is validated as a whole. An empty `description`, an empty `scope`, `entity: null`, `severity: null` or `renotifyMinutes: null` resets that field to its default. Changing the `metric` or `module` drops a stored `entity` of another entity type. Returns `{ "rule": { ... } }`.

Changing the metric, module, target, condition (including `forMinutes`), window or scope, or disabling the rule, forgets its per-entity states. Incidents that were open stay open and receive a system note. See [Monitoring](/guide/monitoring#from-breach-to-incident).

## Enable or Disable a Rule

```
PATCH /api/alerts/rules/:ruleId
```

```json
{ "enabled": false }
```

`enabled` must be a boolean. Returns `{ "rule": { ... } }`.

## Delete a Rule

```
DELETE /api/alerts/rules/:ruleId
```

Returns `{ "success": true }`. Open incidents of the rule stay open and receive a system note.

## Preview a Rule

```
POST /api/alerts/rules/preview
```

Evaluates a draft rule against current data without storing state or sending anything. The body is a rule object; `name` and `channels` are not needed. `module`, `metric`, `condition` and `windowMinutes` are.

```json
{
  "targets": [
    { "entityKey": "pulse-main", "value": 7.1, "sampleCount": 212, "breached": true, "baseline": 1.4 },
    { "entityKey": "support-bot", "value": 1.2, "sampleCount": 540, "breached": false, "baseline": 1.1 },
    { "entityKey": "new-agent", "value": 4.8, "sampleCount": 120, "breached": false, "baseline": null, "insufficientData": true }
  ],
  "notes": ["Showing 50 of 63 entities"]
}
```

At most 50 targets are returned, the ones that would fire first and then those with the most events. `value` is `null` when the entity could not be judged (too few samples or no data). `baseline` is present for baseline rules (for a percentage metric it is the pooled rate of the history windows, see [Monitoring](/guide/monitoring#condition-types)), and `insufficientData` is `true` when the entity has too little history for a baseline: its `value` is still shown, but it cannot breach. A rule without an entity target returns one target with an empty `entityKey`. `notes` carries explanations, such as why nothing was evaluated. The same `402` as on create applies to the Enterprise modes.

## List Entities

```
GET /api/alerts/entities
```

Entities that had data in the last 30 days, for target pickers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entityType` | string | Yes | `agent`, `model`, `tool`, `mcp` or `kb` |
| `q` | string | No | Case-insensitive substring of the key (at most 200 characters) |
| `limit` | number | No | Default `50`, at most `500` |

```json
{
  "entities": [
    { "key": "pulse-main", "requests": 18234, "lastSeenMs": 1760400000000 }
  ]
}
```

Entities are ordered by `requests` over the 30 days, highest first. `lastSeenMs` is the start (epoch milliseconds) of the last daily bucket with data.

## Test a Channel

```
POST /api/alerts/channels/test
```

Sends a clearly labelled test notification on one channel. Send either a channel as typed, or a channel of a saved rule:

```json
{ "channel": { "type": "slack", "url": "https://hooks.slack.com/services/T0000/B0000/XXXXXXXX" } }
```

```json
{ "ruleId": "665f1c0e8b1d4c0012ab34cd", "channelId": "ch_3f9a1c2b7d4e" }
```

```json
{ "result": { "type": "slack", "target": "https://hooks.slack.com/…/XXXX", "success": true } }
```

`target` names the destination without its credential: the recipient address, the URL hint, or `pagerduty …wxyz`. A failed delivery is still a `200` with `success: false` and an `error` message in `result`. An unsaved email channel can be tested against at most 5 recipients (`too_many_recipients`). Tests are limited to 5 per minute per user and 20 per minute per project; beyond that the answer is `429` with a `Retry-After` header. A test through a PagerDuty channel opens and immediately resolves its own throw-away incident.

## Alert History

```
GET /api/alerts/history
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | `fired`, `acknowledged` or `resolved` |
| `ruleId` | string | No | Only the events of this rule |
| `limit` | number | No | Default `50`, at most `100` |
| `skip` | number | No | Pagination offset (default `0`) |

```json
{
  "activeCount": 2,
  "events": [
    {
      "_id": "665f1c1a8b1d4c0012ab34cf",
      "ruleId": "665f1c0e8b1d4c0012ab34cd",
      "ruleName": "Agent error rate",
      "metric": "agent_error_rate",
      "threshold": 5,
      "actualValue": 7.1,
      "status": "fired",
      "entityType": "agent",
      "entityKey": "pulse-main",
      "baselineValue": null,
      "sampleCount": 212,
      "channels": [
        { "type": "slack", "target": "https://hooks.slack.com/…/XXXX", "success": true },
        { "type": "email", "target": "oncall@example.com", "success": false, "error": "Mailbox unavailable" }
      ],
      "firedAt": "2026-10-15T09:42:11.000Z"
    }
  ]
}
```

One event is created per firing and is updated when the alert resolves (`status: "resolved"` and `resolvedAt`). `channels` is the delivery result of the firing notification, one entry per recipient or destination. `activeCount` is the number of events of the project still in status `fired`. Events of rules created before per-entity alerting have `entityType` and `entityKey` set to `null` or absent.

## Acknowledge an Event

```
PATCH /api/alerts/history/:eventId/acknowledge
```

No body. Records who acknowledged the event and when, sets its status to `acknowledged` while it is `fired` (a `resolved` event keeps its status), and acknowledges the linked incident while that is still `open`. Returns `{ "event": { ... } }`.

## Errors

Errors are `{ "error": "<message>", "code": "<code>", "message": "<message>" }`. A missing rule or event has `{ "error": "Rule not found" }` or similar and no `code`; only a channel test names what it could not find (`rule_not_found`, `channel_not_found`).

| Status | Description |
|--------|-------------|
| 400 | Malformed JSON, or an invalid field. `code` names the problem: `invalid_body`, `invalid_name`, `invalid_description`, `invalid_module`, `invalid_metric`, `metric_module_mismatch`, `invalid_window`, `invalid_condition`, `invalid_mode`, `invalid_number`, `out_of_range`, `invalid_value`, `invalid_baseline`, `invalid_slo`, `invalid_scope`, `invalid_entity`, `invalid_renotify`, `invalid_channel`, `invalid_filter`, `invalid_entity_type`, `too_many_recipients` |
| 401 | Not authenticated |
| 402 | The `baseline` or `slo_burn` condition mode is not available: `code` is `not_enterprise_build` (the build does not include it) or `license_required` (no active Enterprise licence), and the body carries `requiresEnterprise: true`, `module: "alerts-advanced"` and `error: "Payment Required"` |
| 403 | The caller lacks the `alerts` permission |
| 404 | Rule, event or channel not found in the project |
| 429 | Too many channel tests (`rate_limited`, with a `Retry-After` header) |
| 500 | Internal server error |
