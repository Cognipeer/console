# Data Retention

Every log the console writes ages out under one policy: model calls, tool and MCP calls, guardrail evaluations, Knowledge Engine and web search queries, agent traces, browser sessions, crawl results, batch and OCR items, alerts, usage totals and the audit log. A duration belongs to a **data class**, not to a table. The prompt stored with a model call is `content` and is cleared early. The call record itself is `telemetry` and is deleted later.

Every class has a built-in default, and every registered collection belongs to a class, so nothing is kept forever unless a policy says so.

## Data classes

| Class | What it covers | Default | Range | Expired rows are |
|-------|----------------|---------|-------|------------------|
| `content` | Prompts, responses, tool payloads, queries, extracted text, page bodies, screenshots | 30 days | 1–90 | **redacted**: the content fields are cleared and the row stays |
| `telemetry` | Model, tool, MCP, guardrail, Knowledge Engine, reranker, web search and vector query logs | 90 days | 30–400 | deleted |
| `trace` | Agent trace sessions and their events, trace threads, browser sessions and steps | 30 days | 7–180 | deleted |
| `jobs` | Crawl results, batch and OCR items, browser flow runs, vector migration and re-index runs | 90 days | 30–365 | deleted (never while running) |
| `metrics` | Inference server metrics, GPU fleet events | 45 days | 7–180 | deleted |
| `alerts` | Resolved alerts, resolved or closed incidents | 180 days | 90–730 | deleted (never while open) |
| `audit` | Audit log, config change log, MCP server change log | 365 days | 365–3650 | deleted |
| `usage` | Daily usage totals (billing and the usage reports) | 760 days | 400–1095 | deleted |
| `results` | Evaluation, red-team and analysis runs, cost prescription reports | 365 days | 90–3650 | deleted (never while running) |
| `delivery` | Webhook and alert deliveries, scheduler claims | its own mechanism, see below | | deleted |

`audit` never goes below `RETENTION_AUDIT_MIN_DAYS`. The records retention leaves about its own deletions are kept for `RETENTION_RECORDS_DAYS` (three years by default), and nothing else can shorten that.

### Presets

A tenant picks a starting point, then changes single classes if it needs to. The presets are engineering defaults, not legal advice.

| Preset | content | telemetry | trace | jobs | metrics | alerts | audit | usage | results |
|--------|---------|-----------|-------|------|---------|--------|-------|-------|---------|
| Standard (the built-in defaults) | 30 | 90 | 30 | 90 | 45 | 180 | 365 | 760 | 365 |
| Minimal | 7 | 30 | 14 | 30 | 45 | 90 | 365 | 400 | 180 |
| EU AI Act high-risk | 30 | 180 | 180 | 180 | 45 | 365 | 365 | 760 | 3650 |
| Finance | 30 | 365 | 90 | 180 | 45 | 365 | 1095 | 1095 | 1095 |

EU AI Act high-risk keeps automatically generated logs for at least six months (art. 19, 26(6)) and evaluation results as technical documentation (art. 18).

### Collections with their own mechanism

These were aged out before the central engine existed and keep their own mechanism. The retention page lists them with their default so every duration is in one place.

| Collection | Default | Set by |
|------------|---------|--------|
| `agent_runs` | 30 days | `AGENT_RUN_RETENTION_DAYS` |
| `agent_session_events` | 30 days | `AGENT_SESSION_EVENT_RETENTION_DAYS` |
| `webhook_deliveries` | 30 days | `WEBHOOK_DELIVERY_RETENTION_DAYS` |
| `agent_trigger_deliveries` | 7 days | built in |
| `alert_deliveries` | 30 days | built in |
| `scheduler_claims` | at most 7 days | the expiry stored on each claim |
| `entity_metrics` | 45 days | `ENTITY_METRICS_RETENTION_DAYS` |
| Agent session files | 30 days | each agent's `attachments.retentionDays` |

## How a duration is decided

The last of these that is set wins:

1. the class default (table above);
2. the deployment default, `RETENTION_<CLASS>_DAYS` (for example `RETENTION_TELEMETRY_DAYS=180`);
3. the tenant policy;
4. a project exception.

The result is then clamped to the class range.

**Project exceptions.** A project can keep a class longer or shorter than the rest of the tenant, for example a regulated project that keeps telemetry for a year. Rows with no project follow the tenant duration.

**Shortening waits.** A save that would make anything expire sooner keeps the old number for `RETENTION_SHORTEN_DELAY_HOURS` (24 by default). The new policy shows as pending and can be cancelled until then. Lengthening applies at once.

## How it runs

The engine runs on the queue provider: BullMQ when Redis is configured, the in-process queue otherwise. No database TTL index is involved. Every `RETENTION_INTERVAL_SECONDS`, one tick per cluster queues one sweep per tenant.

A sweep works through the tenant's collections in batches of `RETENTION_BATCH_SIZE` and for at most `RETENTION_BUDGET_SECONDS`, then queues its own continuation. Deletes run before redactions. A per-tenant lock in the cache keeps two sweeps, or a sweep and a manual purge, off the same tenant.

Redaction remembers how far it got (a watermark in the cache), so each sweep only looks at newly expired rows. Rows that arrive late with an old timestamp are left to the delete phase.

::: warning Dry run is on by default
`RETENTION_DRY_RUN=true` until an operator turns it off: sweeps only count and record what they *would* delete. Run `npm run retention:inventory` to see per tenant and per collection what the first real sweep will do, then set `RETENTION_DRY_RUN=false`. A manual purge ("Clean now") always acts.
:::

On MongoDB each engine target gets an index on its age field, from the index manifest. Without it every batch would be a collection scan.

## Settings screen (Enterprise)

**Settings › Data retention** shows:

- the effective duration of every class and where it comes from (default, deployment, tenant or project);
- what the last sweep did;
- every collection and its mechanism.

The screen has these tabs:

- **Policy**: preset and per-class durations, with an impact preview before saving.
- **Project exceptions**: per-project overrides.
- **Destruction records**: what each sweep and purge deleted and redacted.

**Clean now** purges history on demand. Choose a mode:

- **Apply the policy now**: what the next sweep would do, without waiting.
- **Older than N days**: everything in the chosen classes, optionally for one project.

The preview shows the row counts. The purge starts only after you type the workspace slug, then shows its progress and can be cancelled. Two limits always hold:

- `audit` never goes below its floor and `usage` never below its minimum;
- running jobs and open incidents are never touched.

Reading the page needs `audit:read`. Changing the policy and purging need `audit:admin`.

## API

All routes are tenant-scoped session routes under `/api/retention`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/retention` | Effective classes with source, targets, mechanisms, presets, engine state, last sweep, current purge |
| `PUT` | `/api/retention/policy` | Save `{ preset, classes, projects }` |
| `DELETE` | `/api/retention/policy/pending` | Cancel a pending shortening |
| `POST` | `/api/retention/policy/preview` | Rows a draft policy would delete or redact now |
| `POST` | `/api/retention/purge/preview` | Rows a purge would touch |
| `POST` | `/api/retention/purge` | Start a purge: `{ mode: 'policy' \| 'olderThan', days?, classes?, projectId?, confirm }`, where `confirm` is the workspace slug. Answers `202`, or `409` while another purge runs |
| `GET` | `/api/retention/purge` | Status of the current or last purge |
| `DELETE` | `/api/retention/purge` | Cancel the running purge after its current batch |
| `GET` | `/api/retention/runs` | Destruction records (audit rows of service `retention`) |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `RETENTION_ENGINE_ENABLED` | Scheduled sweeps; with `false` only a manual purge runs | `true` |
| `RETENTION_DRY_RUN` | Sweeps only count. Turn off after checking `npm run retention:inventory` | `true` |
| `RETENTION_INTERVAL_SECONDS` | How often the cluster-wide tick queues the sweeps (minimum `60`) | `3600` |
| `RETENTION_BUDGET_SECONDS` | How long one sweep slice may run before it queues its continuation (`10`–`840`) | `240` |
| `RETENTION_BATCH_SIZE` | Rows per delete or redact batch (`50`–`5000`) | `500` |
| `RETENTION_SHORTEN_DELAY_HOURS` | How long a shortened duration waits before it applies (`0`–`168`) | `24` |
| `RETENTION_AUDIT_MIN_DAYS` | Floor for the `audit` class, for every tenant and every purge (minimum `30`) | `365` |
| `RETENTION_RECORDS_DAYS` | How long destruction records are kept (minimum `1095`) | `1095` |
| `RETENTION_<CLASS>_DAYS` | Deployment default for one class (`CONTENT`, `TELEMETRY`, `TRACE`, `JOBS`, `METRICS`, `ALERTS`, `AUDIT`, `USAGE`, `RESULTS`) | the class default |

## Not covered yet

- Legal holds that pause deletion for a project or a subject.
- Export before deletion.
- Data-subject requests (delete everything about one person).
- Moving the older mechanisms listed above into the engine.
