# Changelog

For the full changelog, see [docs/changelog.md](docs/changelog.md). Released versions are described in the
[release notes](docs/releases/index.md); this page lists what is already merged and not yet in a release.

## Unreleased

### Incompatible changes

- The OpenAI Assistants-compatible adapter is removed (`/client/v1/assistants`, `/client/v1/threads`, and the Studio
  card for it). Use the agent runs and sessions API, the Responses API or chat completions instead.
- Agent **schedules** are replaced by [triggers](docs/guide/agent-triggers.md). Existing schedules are not converted:
  create a trigger of type `schedule`. The `schedule.fired` and `schedule.failed` webhook events become
  `trigger.fired` and `trigger.failed`.
- The per-agent **Execution** settings are gone (background on/off, default mode, sync timeout, background timeout and
  the callback fields that lived there). How long a call waits is `AGENT_SYNC_TIMEOUT_MS` and how long a run may take is
  `AGENT_BACKGROUND_MAX_DURATION_MS`, for the whole deployment. The agent's default callback is `config.callback`
  (Studio: Configure → Callback & budget) and its default session budget `config.budget`. The
  `agent_background_disabled` error no longer exists.
- A call that is still running when its wait window ends no longer fails: it answers `202` with a `Location` header and
  the run carries on. Clients that treated a long call as an error should read the run instead.
- `/responses` and `/chat/completions` run an agent's **published** version by default (the draft only while nothing is
  published); `"version": "draft"` selects the draft. The id of an agent response is `resp_<runId>`.
- The unused `/api/models/v1` prefix, the unmounted `src/server/api/routes/**` tree and the dashboard
  `GET`/`POST /agents/:agentId/conversations` routes are removed; the live API is under `/api/client/v1` and the
  Sessions routes.
- `@cognipeer/console-sdk` 4 drops `agents.chat` (use `agents.responses` or the runs API).

### Agent runs and run classes

- Every agent turn from the API is a **run** (`run_<id>`) on one engine: Responses, chat completions, A2A, sessions,
  triggers and the runs API. A call waits up to `AGENT_SYNC_TIMEOUT_MS` (10 minutes) and then answers `202` with
  `Location` and `Retry-After` while the run continues; a run may take up to `AGENT_BACKGROUND_MAX_DURATION_MS`
  (30 minutes).
- **Run classes.** `default` runs are capped per tenant (`AGENT_RUN_MAX_ACTIVE_PER_TENANT`, 250; per project, off by
  default) and a run over the cap is `429 agent_run_concurrency_limit`. `deferred` runs use their own queue and workers
  (2 running, up to 10000 queued or scheduled) and expire after 24 hours (`expired`).
- **Scheduled runs**: `run_at` or `delay_seconds` (up to 30 days) start a run later (status `scheduled`).
- **Idempotency** on every mode: `Idempotency-Key` (up to 255 characters), `409 idempotency_key_conflict` for a key used
  with another request; the `trigger:` and `hook:` prefixes are reserved (`400 idempotency_key_reserved`).
- **Runs API** under `/api/client/v1/agents/runs`: create (`wait`, `Prefer: wait=N`), list with filters, queue view, get
  (`?wait`), cancel, events (also as SSE) and actions for a run that waits on a person. Cancelling is one meaning on four
  routes: the runs API, `POST /agents/sessions/{id}/cancel`, `POST /responses/{id}/cancel` and A2A `tasks/cancel`.
- Callbacks (`callback_url`, or the agent's `config.callback`) and `agent_run.*` webhook events are for runs that ended
  after the call returned; deliveries are signed (`x-cognipeer-signature`), retried 5 times and sent from their own queue.
- A server that shuts down hands its runs over (`interrupted`), a run whose worker disappears is closed as `worker_lost`,
  and retention (`AGENT_RUN_RETENTION_DAYS`) never deletes a queued, running, scheduled or waiting run.
- `GET /responses/{id}` reports `background: true` for a run that was started with `background: true`, also when the
  call streamed; a `service_tier: "flex"` call reads `false` (it is queued, but not a background request).
- A waited call whose run is ended elsewhere before it finishes (the server shut down and handed its runs over, or the
  worker was lost) answers `503 agent_run_interrupted` (retryable; tool side effects may have happened) instead of the
  partial answer its turn had produced, and a stream ends with an `error` event and `response.failed`. Graceful shutdown
  drains the runs **before** the HTTP server waits for its open connections (`AGENT_RUN_DRAIN_TIMEOUT_MS` applies there),
  and open session event streams are ended (clients reconnect).
- A run's retention (`AGENT_RUN_RETENTION_DAYS`) is counted from when it finished, whatever way it ended, and for a
  scheduled or deferred run from its due time, so a run scheduled far ahead is not deleted soon after it ran; on MongoDB
  the idempotency key now lives as long as its run.
- A due scheduled run is promoted only while the tenant (or project) is under its default-class active-run cap; at the
  cap it stays `scheduled`, so it can start later than `run_at`.
- A paused run whose pause is dropped (a new message to an agent set to cancel pending requests, a session truncate,
  `onTimeout: cancel`) now ends `canceled` (`canceled_by_caller`) with its callback and `agent_run.canceled` event,
  instead of staying `requires_action`.
- After a pause, run callbacks carry an event id of their own for each outcome (`evt_<runId>_<event>_<generation>` from
  the second one on) and a late delivery of an older event no longer overwrites the state of a newer one.
- Answering an approval inline continues the paused run: the response id is `resp_<runId>` of that run, its events cover
  the continuation (they no longer stop at the pause), and a timeout continuation (`onTimeout` deny or allow) is labelled
  `timeout` in the session events.
- The agent-run quota counts a run only once it is admitted (a conflict or a concurrency refusal uses no unit), and a
  start refused before its run exists removes the session that the same request created. A queued run whose job fails
  before it claims its run is no longer lost: the reconciler republishes it.
- Streams (runs API, `/responses`, chat completions) check the active-run caps and the agent quota before they open: over
  a limit the answer is a plain JSON `429` (`Retry-After` 30 s for the cap, 60 s for the quota), not an `error` event;
  non-stream concurrency `429`s carry `Retry-After: 30` too. Long-polls (`?wait`, a trigger's Run now) stop when the
  client disconnects.
- A body that is not a JSON object is `400 invalid_json` on the runs API, `/responses` and `/agents/responses`; an
  `Idempotency-Key` replay of a `stream: true` runs-API request answers as a stream; a remote `file_url` / `image_url`
  has to arrive within the outbound timeout (`400 attachment_unreachable`), and a malformed percent-escape in its name no
  longer fails the call.
- Responses `usage` always carries `input_tokens_details.cached_tokens` and `output_tokens_details.reasoning_tokens`
  (`0` when not reported; `reasoning_tokens` is `0` for an agent run). `reasoning` is applied to runs that execute in the
  request only: a queued (`background`, `flex`, `POST …/runs` without `stream`) run uses the agent's own effort.

### Agent templates

- **Agent templates**: 25 ready-made agents (support, knowledge, engineering, research, sales and marketing, operations,
  multi-agent) in a gallery under Agents → Templates. **Use template** creates a draft agent with your model, knowledge
  bases and guardrails, its `tpl-` skills (reused when they exist) and the suggested [triggers](docs/guide/agent-triggers.md)
  **disabled**; a webhook trigger's secret is shown once. Creating is all-or-nothing. Each template shows whether the
  project can run it (ready, needs setup, unavailable). New dashboard routes `GET /agents/templates`,
  `GET /agents/templates/{templateKey}` (agents read) and `POST /agents/templates/{templateKey}/instantiate` (agents
  write); the agent records `metadata.template`. See [Agent templates](docs/guide/agent-templates.md).

### Responses, chat completions and models

- `/responses` and `/chat/completions` serve **models and agents**. `model: "agent:<key>"` is an agent; a bare name is a
  model of the project first, then an agent, and `404 model_not_found` when it is neither. Access follows the resolved
  target: the Models service for a model, the Agents service for an agent. A model target is translated to a chat
  completion and nothing of it is stored.
- Agent responses stream (`response.*` events), take `previous_response_id`, `background`, `service_tier: "flex"` (a
  `deferred` run), `GET` and `cancel`, and answer `202` past the wait window. Agent chat completions stream with a
  keep-alive comment and `stream_options.include_usage`.
- `GET /models` lists `agent:<key>` entries, so an OpenAI-compatible client can pick an agent from its model list.
  `GET /models` and `GET /models/{id}` admit a token that holds Models **or** Agents (read): an Agents-only token lists
  only agents (no models, no providers) and fetches `agent:<key>`, while fetching a model id needs Models (`403`).
- Chat completions with an agent model check `version` like `/responses` (a positive integer, a numeric string or
  `"draft"`; otherwise `400 invalid_version`, an unknown version `404 version_not_found`). The transcript match that
  continues a session now covers file and image references and the OpenAI `user` field, and continues a session only when
  exactly one of the owner's sessions matches (an ambiguous transcript starts a new session).
- `attachments.accepts_images` on `GET /agents/{key}` is `false` while uploads are off or the bucket is unusable.
- **Structured output** per request in each dialect (`text.format`, `response_format`, an A2A data artifact).
  `GET /agents/{key}` returns `variables_schema` and `output_schema`. Studio: Configure → Variables and Output.
- **Variables.** An agent can declare typed variables (`config.variables`: a name, a type of text, number, integer,
  yes/no or JSON, required or optional, allowed values, a default) that a caller sends next to the message as
  `variables` (runs API, `/responses`, `/chat/completions`, A2A `data` parts, triggers). They are checked before the model
  is called: a missing required value or a wrong type is `400 invalid_variables` and nothing is spent. The prompt reads
  them as `{{variables.<name>}}` and the model also gets them as a `Variables` JSON block in the user message. They suit
  runs a program starts. Chat clients cannot send them, so a required variable without a default refuses every chat
  message that arrives through the API: on an agent that is also used in chat, keep variables optional or give them a
  default. Values belong to the request that carries them: a session does not remember them, the prompt is rendered
  again on every turn, and the block stays in the history of each turn that sent one. Studio explains this in
  Configure → Variables and warns next to a required variable that has no default.

### A2A

- `message/send` can answer without waiting (`blocking: false`), `message/stream` streams status and artifact updates,
  messages take file and data parts, and the agent card lists the accepted file types.
- A `message/stream` client that disconnects no longer cancels the task. `tasks/resubscribe` (`{ "id": … }`) reattaches:
  the current Task, then status and artifact updates until the task is final (a finished task, or one waiting on input,
  answers the Task and its final status at once; one resubscribe stream follows a task for up to 60 minutes).
  `tasks/cancel` works in any non-final state; a task that cannot be canceled answers `-32002` (`TaskNotCancelable`,
  earlier `-32004`).
- `message/send` answers a Task in state `canceled` for a run that was stopped while the call waited, and a Task in state
  `failed` (with `metadata.errorType` / `errorCode`) for a run that failed after it started, the agent quota refusal and
  a still-pending request included; a refusal before the run exists stays a JSON-RPC error.
- **Public A2A** (`/api/public/a2a/...`): a task and its session are bound to the caller that created them. Ids are
  `run_<runId>.<nonce>` and `<sessionId>.<nonce>` and must be handed back whole; without the right nonce `tasks/get`,
  `tasks/cancel` and `tasks/resubscribe` answer `-32001` and a `contextId` answers `-32602` (`unknown contextId`).
  Public conversations created before this change can no longer be reached from the public route. The variables of a
  public caller's `data` part are external content and never reach the system prompt.

### Triggers and incoming webhooks

- **Triggers** (Studio: Deploy → Triggers; `/agents/{key}/triggers` on both APIs) start an agent by their `type` and that
  type's settings object: a cron `schedule` in an IANA timezone, `once`, `manual` or `webhook`. An agent can have several
  triggers (a schedule one and a webhook one, say); each has one type. A fire is a queued, unattended run in a new session
  owned by `system:trigger:<id>`, with the idempotency key `trigger:<id>:<slot>`; **Run now** and a run history per
  trigger. The scheduler runs on every node and the database picks one winner per slot
  (`AGENT_TRIGGER_TICK_MS`, `AGENT_TRIGGER_MISFIRE_GRACE_MS`). `trigger.fired` and `trigger.failed` are webhook events.
  The limits, quota, spend and usage of a scheduled, once or webhook fire are counted against the trigger's last
  updater (its creator until someone changes it); **Run now** counts against the person and API token that pressed it.
- **Incoming webhooks**: a trigger of type `webhook` starts when something posts to
  `POST /api/public/hooks/{tenantId}/{hookId}` (no API token; each delivery proves the trigger's secret). Presets for
  GitHub, GitLab, Azure DevOps and a generic sender, an event allow-list and payload filters, a Mustache prompt template,
  event-derived variables, de-duplication, a per-trigger run rate (`AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE`), secret rotation
  with a grace period, **Run with this payload** (with `dry_run`) and a delivery log. Event text reaches the model only in
  the message, marked as external data, never in the system prompt.
- Crawler cron schedules fire again (a due slot was never detected) and every scheduler slot is claimed once across
  replicas.

### File outputs

- Agents can create files without a sandbox: the `session_files_create` and `session_files_append` tools write into the
  session's bucket. File outputs are independent of uploads: with uploads on and a bucket set they are on by default,
  with uploads off they stay off until turned on, and the read tools are offered when uploads **or** outputs are on.
  `attachments.outputs` on `GET /agents/{key}` shows the effective setting.
- Files an agent produced come back on Responses, chat completions (`output_files`, `file_path` annotations) and A2A
  artifacts. They are stored byte for byte (no text copy, a Markdown file keeps its own object, an append keeps its line
  breaks).

### Sandbox

- An agent's sandbox secrets are kept out of tool output, out of files written back into the session and out of publish
  responses. A secret that can no longer be read (the key it was stored under changed) is marked
  `config.sandbox.secretsUnreadable: true`: saving the agent with a mix of masked and new values answers
  `409 sandbox_secrets_unreadable` (enter every value again to replace them; only masks keeps them), its tools run without secrets and say so,
  and Studio shows a warning.
- Environment fields of sandbox templates and instances are write-only: stored sealed and shown masked (Enterprise).
  An environment that cannot be decrypted is reported (`envUnreadable`) instead of dropped: a change that needs the
  stored values answers `409 sandbox_env_unreadable` and keeps the ciphertext, and the template editor asks for every
  value or none. A row opened with Replace and saved without a value keeps the stored one.
- Clearing an agent's callback URL removes the whole callback, and the stored secret with it (the masked secret read back
  next to no URL is accepted and dropped).

### Configuration

- New settings for the agent run engine, all in the *Agent Runs* table of
  [Configuration](docs/guide/configuration.md#agent-runs): `AGENT_SYNC_TIMEOUT_MS`, `AGENT_BACKGROUND_MAX_DURATION_MS`,
  `AGENT_RUN_MAX_ACTIVE_PER_TENANT` / `_PER_PROJECT` (replacing `AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_*`), `AGENT_DEFERRED_*`, `AGENT_RUN_RETENTION_DAYS`, `AGENT_TRIGGER_*` and
  `AGENT_WEBHOOK_*`. `.env.example` and `docker-compose.yml` list them.
- `openapi.yaml` in the repository root is the one canonical OpenAPI description of the client API (the copy under
  `docs/public` is gone; the docs build publishes the root file), and CI (`npm run test:openapi`) checks that its
  paths and the registered routes agree.

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
  Store and the client Files API), events, runs, tracing threads and the continuation of a session
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
  A run that pauses for a person or for the calling app (`paused`) is counted when it finishes or is closed, with the
  tokens and cost of all of its parts and a duration that leaves out the waiting.
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
- **Incident inbox.** **Incidents** has a summary (open and acknowledged incidents, incidents fired and resolved, and the
  median times to acknowledge and to resolve over 24 hours, 7 or 30 days), search over rule, entity and metric, assignee
  and snooze filters, sorting, grouping by rule or entity, built-in and saved views, a preview beside the list, keyboard
  shortcuts and live updates. Bulk actions add **Reopen**, **Assign…** and **Snooze…**. **Snooze** holds back the
  reminders of one incident for up to 30 days. The incident page lists every notification attempt per channel (kept 30
  days), the same rule's incidents on the same entity in the last 30 days, the rule's runbook, and how often the incident
  was reopened. Entities link to their console pages for every entity type that has one.
- **Rule insights.** The rule list counts each rule's fires over 7 days with a sparkline, marks noisy rules (10 or more
  fires), shows rules without data, and can be searched, filtered by status and owner, and sorted. A rule can be
  **muted** for up to 30 days: it keeps evaluating and opening incidents, but its channels are not notified (webhook
  subscriptions still are). **Backtest** replays a threshold or absence rule on a per-entity metric over the last 7 days
  and suggests a threshold when it would have been noisy. A rule can link a **runbook**.
- **Shared channels.** **Alerts & Incidents → Channels** keeps notification channels once for the whole workspace. Rules
  reference them, so a changed destination applies to every rule that uses it. Owners and admins manage and test them.
- New API: `POST /api/alerts/rules/:ruleId/mute`, `POST /api/alerts/rules/backtest`, `POST /api/alerts/entities/links`,
  the channel library under `/api/alerts/channels/library`, `GET /api/alerts/incidents/stats`,
  `GET /api/alerts/incidents/:incidentId/deliveries` and `GET /api/alerts/incidents/:incidentId/similar`. The rule list
  takes filters, a sort and `include=stats`; the incident list takes `q`, `assignee`, `snoozed`, `updatedAfter` and
  `sort` and returns `serverTime`; incidents can be snoozed (`snoozedUntil`), and bulk updates can reopen, assign,
  snooze and unsnooze. See [Alerts API](docs/api/alerts.md) and [Incidents API](docs/api/incidents.md).
- **Alert rule templates.** **Alerts → Templates** is a catalog of 26 recommended rules in six categories (errors,
  latency, traffic, cost, quality, safety): pick the ones a project needs, or customise one in the rule form first.
  Five of them are the **default set**: error-rate rules that watch every agent, model, knowledge base, MCP server and
  tool of a project (above 20%, or 30% for MCP servers and tools, over 30 minutes with at least 20 requests and a
  10-minute hold). A new project gets the default set enabled unless its creator opts out (`defaultAlertRules: false`),
  and a new workspace gets it on its Default Project; `ALERT_DEFAULT_RULES_ON_CREATE=false` turns that default off. The
  baseline and error-budget templates need Enterprise. New API: `GET`/`POST /api/alerts/templates`, `templateKey` on
  `POST /api/alerts/rules`; the client API adds the default set to a project it creates only with
  `defaultAlertRules: true`. Rules added from a template carry a `template` mark.
- **Project admins as recipients.** An email channel can set `audience: "project_admins"`: each notification then also
  goes to the admins of the rule's project, looked up when it is sent. With no project admin it falls back to the
  workspace owners and admins. The default rules use it.
- **Deleting a project** now deletes its alert rules, so they no longer evaluate and notify under "Unknown Project", and
  closes its open incidents. Its alert history is kept.
