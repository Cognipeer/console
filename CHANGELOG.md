# Changelog

For the full changelog, see [docs/changelog.md](docs/changelog.md). Released versions are described in the
[release notes](docs/releases/index.md); this page lists what is already merged and not yet in a release.

## Unreleased

### Authorization

- The policy engine decides every request. The earlier legacy, shadow and monitor modes are gone: a policy is
  either enabled or disabled, and a refusal always carries a decision id. When the engine cannot decide, the
  request is answered `503 authorization_unavailable` instead of being allowed. The workspace owner's session
  always reaches the IAM center, so the owner can repair a policy that went wrong.
- Project permission levels narrow a person's access in that project: a level that is left on **Inherit** follows
  the person's workspace level, an explicit level caps it.
- A deny rule that cannot be evaluated for a request counts as a deny for that request.
- The session payload carries `effectivePermissions`, so the navigation shows only what the active project allows.
- Approving a pending tool call of an agent session is a permission of its own, `agent.approve`, and it is
  appointed: having Write access to Agents no longer approves somebody else's request. A built-in rule appoints the
  people the agent's *Who can answer* setting names (the person who started the session always may), an allow rule in
  the policy editor appoints more approvers (a compliance group), a deny rule narrows; it applies to the dashboard, the
  API and portals alike. Ending somebody's open approval as a side effect (cancelling a paused run, a new message to an
  agent that cancels pending requests) takes the same permission; answering a question follows the session instead.
  The timeout sweep is recorded in the audit log as `system`. When the engine cannot decide who may answer, the answer
  is `503 authorization_unavailable` with nothing recorded. The session page and the Sessions list show the server's
  verdict (`canResolve`, `resolveBlockedReason`) instead of guessing from a role: for a request the viewer may not answer
  the cards say why and their controls (Approve, Deny, Edit arguments, Don't ask again, or Send and Skip) are disabled,
  and the header badge, side panel, drawer, composer and status filter say "Waiting for an approver" instead of
  "Waiting for you".
- Two more agent actions decide what somebody else may do with a session another person started:
  `agent.session_view_others` (Read) and `agent.session_manage_others` (Write); continuing a session (a message, a
  run, an answer to its question) asks both. By default every holder of
  `agents` Read / Write has them; a role that holds Tracing or Files but no `agents` level does not reach other
  people's agent sessions through those screens (earlier releases did not look at who started a session there). The
  Access check takes the session's owner and the agent's setting as inputs.
  A refused approval that was asked through a portal names the agent as the resource and the portal apart from it, in the
  audit feed and in the decision lookup.
  Every path to a session's content asks the same question - the session routes, its files (also through the Document
  Store and the client Files API), events, runs, tracing threads, Assistants threads and the continuation of a session
  by id in the Responses and chat completions routes, whichever service gate let the token in. A list shows the caller
  only their own sessions when a rule stops them from viewing others', cut in the database before the page (the sessions
  of a deleted agent count as others' too); the Sessions table shows who started each session. The tracing and Files
  lists are read on until the page is full and, for such a caller, report `hasMore` / `nextSkip` instead of a `total`.
  A session that cannot be read is `503`, never an allow; so is an engine outage under a list. An open event stream is
  checked again every minute and ends when the caller may no longer watch it.
- Naming the bucket an agent keeps its session files in is a Files decision about that bucket (`file-bucket.update`);
  the bucket picker lists only the buckets the caller may look at (`file-bucket.get`). A bucket that an agent names is
  a reference of the agent in the resource graph (`agent.attachmentsBucket`), and the policy lists of an agent or a
  bucket show the rules that reach them.
- A reader of Webhooks (`webhooks` Read) sees an endpoint's URL without its query string and userinfo and with every
  path segment longer than eight characters hidden (`https://host/services/T0000/…`); only Admin sees it whole.
- Importing an agent (`POST /agents/import`, `POST /agents/import/document`) that names a session-files bucket asks the
  same Files question as creating or updating one.
- `POST /client/v1/threads/:id` only writes the keys of a thread's metadata that belong to the caller; the keys the
  server keeps there (including the session's tool allow-list) are left as they are.
- Levels add up in an allow rule: choosing Admin on a service (or the Admin level for every service) also allows Write and
  Read, and Write also allows Read, so a rule that names only `webhooks.admin` lets the person read, change and
  administer webhooks instead of administering what they cannot see. The policy editor shows the included levels and
  says so; the rule that is stored and shown lists all of them. A deny rule blocks exactly the levels it names. A rule
  written as Cedar text is taken literally and the editor warns when it names a level without the lower ones.
- Webhooks are an administration service: the policy engine is the only authority (Read to look, Admin to change),
  owners and admins hold it by default and everybody else until it is granted. Being a project admin is no longer a
  permission on webhooks by itself; grant **Webhooks** to the people or groups who should manage them. Tenant-wide
  endpoints and other projects' endpoints need the permission in the workspace itself, which an API token never has.
  Every route that changes something (create, edit, delete, test, rotate the secret, redeliver) asks for `webhooks.admin`
  itself, on the dashboard and the client API alike: an allow rule that names only `webhooks.write` no longer lets a
  person change a webhook, and the Webhooks page and the whole receiver address follow the same two questions
  (`webhooks.read` to look, `webhooks.admin` to change), so a deny rule on Write leaves Admin as it is.
- The Document Store's folder view hides the session folders too: in the listing of `<folder>/<agentKey>/` the
  sub-folder of a session that a caller may not view (`agent.session_view_others`) is left out, as its files already
  were. Folders count as entries of the page, which is filled from the following reads; the scope is decided once per
  request. The dashboard and the client Files API answer alike on SQLite and MongoDB.

### People and access

- The IAM center's **Principals** tab is the one place to manage people, service accounts, groups and API tokens:
  invite or create, edit, change the role, disable, delete, group memberships and token rules, with server-side
  search, filters and paging, bulk actions on the current page and filters kept in the address.
- The role of a person can be changed (the owner's role cannot, nobody changes their own, and only an owner or an
  admin grants or removes the admin role). A role change applies to the API at once and to page access within
  half a minute.
- Accounts managed by a directory (LDAP, SSO) keep their name, email and password in the directory and are
  disabled rather than deleted here. A password reset is not offered for them.
- When a directory connection (LDAP, SSO) is set to sync roles, the role of the accounts it signs in is the
  directory's: it is shown as **Managed by your directory** and the server refuses to change it by hand
  (`409 directory_managed`). Their access, projects and groups stay editable. Without a directory connection
  nothing changes.
- Upgrade note, directory role sync: a directory connection saved before this release reads as syncing roles, so
  the first sign-in after the upgrade gives each account the role the directory says (the admin mapping, otherwise
  the connection's default role). A role that was set here by hand and differs from it is replaced, and with an admin
  mapping an admin who is not in it falls to the default role. To keep the roles as they are, switch **Sync role
  from the directory** off in the connection's settings right after the upgrade, before people sign in. The workspace
  owner is never changed. A directory can say only admin or the default role, so with the switch on a person cannot
  be given the project admin role directly (use a group).
- Groups can come from SSO as well as from LDAP. The members of a group that comes from a directory are the
  directory's: adding or removing one is refused (`409 group_directory_managed`) and the group and person drawers
  say where the group comes from. A directory group's grants, projects and policies stay editable.
- "Programmatic user" is now **Service account**.
- A new **My account** page lets every person see their profile, change their own password (local accounts) and
  reach their own API tokens. The API tokens page lists a person's own tokens only; owners and admins manage
  other people's tokens in the IAM center, never above their own level. Editing or revoking a token that is not
  your own is limited to the projects you belong to.
- People who are neither owners nor admins and hold no `iam` permission no longer see the IAM center.
- The Members and Tenant settings pages are removed; their old addresses redirect.
- A portal embedded in another application recognises the people of that application with the same verified-identity
  core as the API's "acting for a user" (see below): the statement the host signs is checked as an identity assertion
  (single use for a portal) and the person is found, linked or created by the shared resolver. The people it creates
  are **external** accounts, described under "Acting for a user".

### Acting for a user (verified identity)

- An application can send a signed statement about the person a call is for in the `X-Cognipeer-User-Token` header,
  next to its API token, or both in the one `Authorization` header as `Bearer <api token>~<user token>` for SDKs that
  can only set an API key (split at the door by `src/lib/iam/combinedCredential.ts`; sending both forms is `400
  invalid_combined_credential`). The call then runs as that person (their access, limits, quotas and name in the logs), capped
  by the token's scope and project; the token stays the actor. Owners and admins set it up per token under **IAM center
  → Principals → API tokens → Acting for users**: issuer, audience, a pinned algorithm (`HS256`, `RS256`, `ES256`), a
  shared secret with key ids, a public key or a key set URL, how the person is found (identity and/or verified email)
  and what to do when nobody matches (nothing, an external account, or a person managed by the identity provider).
- An API token can be flagged `requireUserToken`: it is then only served on behalf of a verified person, and a call without a
  user token is refused (`401 user_token_required`) instead of running as the token's owner. The flag lives on the token
  record (no extra lookup per call), outlives a missing or disabled delegation (the token then refuses everything), is
  passed on to tokens it mints and is refused by endpoints and the AI App Gateway that cannot act for users.
- The workspace owner can never be acted for; an administrator only when the setup allows it, and a refused account is
  left untouched (not linked to the subject, no group changes). A refused call
  is answered `401` (`delegation_not_enabled`, `invalid_assertion`, `expired`, `untrusted_key`, `unknown_principal`,
  `disabled`, `seat_limit`, `conflict`), `403` (`delegation_refused`, `project_not_accessible`) or `503`
  (`delegation_unavailable`), always with a decision id; the token's owner is never the fallback.
- The person must be able to open the token's project themselves, as in the dashboard: a membership of their own or of
  one of their groups (an external person: a delegated group that was given the project), or any project for an
  administrator. Otherwise the call is refused (`project_not_accessible`).
- **External** accounts: people of a host application who are vouched for by a trusted issuer. They cannot sign in to
  the dashboard or hold API tokens, always have the User role, are never added to a project (their access comes from the
  groups they are in) and are left out of member lists and pickers; the IAM center shows them with a badge and a
  counter. Creating one counts toward the licence user limit.
- Groups can follow the statement: with a group map, memberships in groups created for that issuer (never in a local or
  directory group) follow the `groups` claim, and every change is audited.
- Usage rows, request logs, runs and traces record the person as the subject and the application token as the actor, with
  `via: { kind: "delegated", issuer }` where a record has a metadata field. A person's drawer in the IAM center has a new
  **Activity** section.

### Portals (Enterprise)

- Opening a portal and running an agent through it are decided by the policy engine. A portal's access list is its
  built-in policy; custom deny rules can block on top of it. A refusal shows a reference code on the portal's error
  page and in the **Access check**. If the engine cannot decide, the portal fails closed.
- A portal can list the **networks** it may be used from; built-in rules refuse every other address, for opening the
  portal, running its agents and answering its approvals (people using the embedded chat and administrators trying
  the portal included). The form checks your own address before you save.
- Workspace owners and admins can open a portal as a **test** without being on its access list (marked, recorded in the
  audit log, left out of the statistics, still bound by the network restriction), and **view as** a person or a group to
  see whether they could open a portal and which agents they could run. The Access check accepts a group for these.
- A portal that is embedded in another application can take every person the application verified
  (`access.embedded`), instead of requiring them to be on the access list.

### Search and display

- Pickers and lists in the IAM center search Turkish names the way people type them: `istanbul` finds `İstanbul`,
  and the Turkish letters I, İ, ı and i match each other. The page language follows the locale.
- Portal pages stay readable on dark portal themes.

### Entity health and alerting

- Agents, models, tools, MCP servers and knowledge bases now write **5-minute health rollups** (`entity_metrics`, kept
  for `ENTITY_METRICS_RETENTION_DAYS`, 45 days by default; every node buffers increments and flushes them every
  `ENTITY_METRICS_FLUSH_MS`, 30 seconds). They feed the new agent health views, the alert engine and the Prometheus
  export. New settings: `ENTITY_METRICS_FLUSH_MS`, `ENTITY_METRICS_RETENTION_DAYS`, `ENTITY_METRICS_MAX_BUFFERED_ROWS`,
  `ENTITY_METRICS_MAX_BUFFERED_ROWS_PER_TENANT`, `TRACING_STALE_SESSION_MINUTES`, `TRACING_FINALIZER_INTERVAL_MS` and
  `ALERT_CHANNEL_TIMEOUT_MS` (see [Configuration](docs/guide/configuration.md#entity-health-alerting)).
- **Agent health.** **Agents** lists every agent with sessions, error rate, p95 duration, tool errors and cost against
  the period before, and an alert badge (Firing, Pending, OK, **No alert rule**, Unknown). An agent opens a health panel
  with charts, version and incident markers and a link to its failing sessions. New API:
  `GET /api/tracing/agents/health` and `GET /api/tracing/agents/:agentName/health`.
- **Per-entity alert rules.** Alert rules cover agents, models, knowledge bases, MCP servers and tools (the Agents and
  Tools modules are new). One rule watches all entities of a type or selected ones, and each entity has its own state,
  incident and notifications. 26 new metrics, for example `agent_error_rate`, `agent_p95_duration_ms`,
  `model_p95_latency_ms`, `kb_empty_result_rate`, `tool_error_rate`. Condition types: threshold and absence ("stopped
  sending traffic") in every edition; baseline and SLO burn are Enterprise (`402` without the licence). A rule can hold
  a condition for a number of minutes, has a cooldown and optional reminders, resolves on its own after two clean
  evaluation windows, and derives its severity from the breach. **Preview now** shows what a rule would do without
  sending anything.
- **Channels.** Email, webhook (signed with `x-cognipeer-signature`), Slack, Microsoft Teams and PagerDuty (Events API
  v2, deduplicated per rule and entity, resolved on recovery). Webhook and chat URLs, signing secrets and PagerDuty keys
  are stored encrypted and shown masked; webhook, Slack and Teams URLs must be `https` and public. **Send test** is
  limited to 5 per minute per user and 20 per minute per project.
- **Incidents** show a count per status, filter by severity, module, rule and entity, can be assigned and updated in bulk
  (up to 100), name the people involved, and carry a context captured when the alert fired: the agent version that
  changed, the most common errors, a link to the failing sessions and, with Enterprise, related models and tools that
  also deviated. New API reference: [Alerts API](docs/api/alerts.md).
- **Webhook subscriptions** can subscribe to `alert.fired` and `alert.resolved`.
- **Session status** is now decided the same way on every ingest path. A status the client sends is final (a late error
  event no longer flips it, though it still counts as an error event); when none is sent it is derived from the error
  events. A batch without `status` used to be stored as `unknown` and a stream `/end` without `status` as `success`;
  both are now `error` when an event failed and `success` otherwise. **OTLP** sessions stay `in_progress` until the
  request carrying the root span arrives (they used to be `success` or `error` from their first batch), and a session
  whose root span never arrives is closed after 10 minutes without activity. A session that never reports an end is
  marked **`abandoned`** after `TRACING_STALE_SESSION_MINUTES` (6 hours); an abandoned session is not an error. Starting
  a stream session again resets an earlier explicit status.
- Health counters of externally traced agents are booked at the event time clamped into 3 hours before to 5 minutes after
  the arrival; events older than 24 hours are not counted. A session is counted once, when it reaches a final status.
- **Prometheus** (`GET /api/metrics`): `console_tracing_input_tokens_total` and `console_tracing_output_tokens_total` are
  renamed `console_tracing_input_tokens_24h` and `console_tracing_output_tokens_24h` (they are 24-hour gauges, not
  counters); `console_tracing_sessions_total` has the statuses `success`, `error` and `abandoned` and counts the sessions
  that finished in the last 24 hours; `console_tracing_agents_total` counts the agents active in the last 24 hours;
  `console_entity_requests_24h` and `console_entity_errors_24h` are new. Update dashboards that use the old names.
- Existing alert rules keep working: the module-wide metrics they use (`error_rate`, `avg_latency_ms`, `mcp_error_rate`,
  `rag_total_queries`, the `aegis_*` guardrail metrics and the others) stay evaluable with their scope and their email
  channel, and are no longer offered for new rules. Every rule now has a per-entity state, so a breach that was
  already ongoing at the upgrade does not re-fire inside the old cooldown; incidents the previous engine had opened
  stay open until you close them. Per-entity rules judge whole 5-minute buckets that are at least one flush interval
  old, so an alert fires about 0.5 to 6.5 minutes after the data arrived, plus the hold time.
