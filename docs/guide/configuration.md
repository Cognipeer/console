# Configuration

All application configuration is managed through the central `getConfig()` function in `src/lib/core/config.ts`. Environment variables are the default source, but the abstraction supports swapping to database-backed configuration.

> **Rule**: Never read `process.env` directly in application code. Always use `getConfig()`.

## Environment Variables Reference

### Required

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Secret for JWT signing (min 32 chars) | — |
| `PROVIDER_ENCRYPTION_SECRET` | Key that encrypts provider credentials at rest (min 32 chars, must differ from `JWT_SECRET`) | — |

Both secrets are checked at startup; see [Validation](#validation).

### Database

| Variable | Description | Default |
|----------|-------------|----------|
| `DB_PROVIDER` | Database backend: `sqlite` or `mongodb` | `sqlite` |
| `SQLITE_DATA_DIR` | Data directory for SQLite files | `./data` |
| `MONGODB_URI` | MongoDB connection string (required when `DB_PROVIDER=mongodb`) | — |
| `MAIN_DB_NAME` | Main database name | `console_main` |
| `MONGODB_MIN_POOL_SIZE` | Min connection pool size | `2` |
| `MONGODB_MAX_POOL_SIZE` | Max connection pool size | `10` |
| `MONGODB_CONNECT_TIMEOUT_MS` | Connection timeout | `10000` |
| `MONGODB_SOCKET_TIMEOUT_MS` | Socket timeout | `45000` |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | Server selection timeout | `30000` |
| `MONGODB_SINGLE_DATABASE` | Keep tenant collections in `MAIN_DB_NAME` instead of a separate `tenant_<slug>` database per tenant. A second tenant is refused in this mode. | `true` when [`DEPLOYMENT_MODE`](#deployment-mode) is `onprem` and `DB_PROVIDER=mongodb`, otherwise `false` |

### Deployment mode

| Variable | Description | Default |
|----------|-------------|---------|
| `DEPLOYMENT_MODE` | `saas` for the hosted multi-tenant service, `onprem` for an installation you run yourself. | `onprem` when `DB_PROVIDER=sqlite`, otherwise `saas` |

Only the exact values `saas` and `onprem` are read; anything else is ignored and the default applies. The default follows the database because SQLite is the self-hosted choice, so **an installation that uses MongoDB starts in `saas` mode unless you set `DEPLOYMENT_MODE=onprem`**. The Docker Compose file in the repository sets it to `onprem`.

What the mode changes:

| Area | `saas` | `onprem` |
|------|--------|----------|
| Endpoints of providers (model, embedding, image, speech, moderation, decision and file providers, the hosts of a GridFS connection string included) | A private, loopback or link-local endpoint is refused. The one exception is a private network the operator has opened for the organization with [`PROVIDER_PRIVATE_NETWORKS`](#provider-private-networks); neither `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` nor `OUTBOUND_HTTP_ALLOWED_HOSTS` changes anything here. | Private and loopback endpoints are allowed, unless `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` is set to `true` explicitly. The `saas` rule then applies, with `PROVIDER_PRIVATE_NETWORKS` to open networks and `OUTBOUND_HTTP_ALLOWED_HOSTS` to list the hosts that stay allowed. |
| Options of a MongoDB GridFS connection string | Certificate files (`tlsCAFile`, `tlsCertificateKeyFile`, `tlsCRLFile`) are refused, and so are the sign-in methods that use the identity of the server. | Available (the sign-in methods unless private networks are blocked explicitly). |
| `MONGODB_SINGLE_DATABASE` | Defaults to `false`: one database per tenant. | Defaults to `true` with MongoDB: one database for the whole installation. |
| Modules for self-hosted installations (for example LDAP) | Not available (`404`). | Available; they still need the enterprise license. |
| IAM engine statistics | This tenant's own counters. | Also the process-wide figures of the engine. |
| Support entry points | Shown only when the Support hand-off is fully configured (`SUPPORT_BASE_URL`, `SUPPORT_CRM_API_URL` and `SUPPORT_HANDOFF_SECRET`). | Also shown when only `SUPPORT_BASE_URL` is set; the link then opens the Support login. |

**Skip TLS verification** and plain `http://` endpoints of storage providers (S3-compatible storage, Amazon S3 with a custom endpoint, Azure Blob) do not depend on the mode: both are the provider's own choice on every deployment, and the address rules above still apply to them.

On an installation you run yourself, set `DEPLOYMENT_MODE=onprem` to use storage on your internal network (a MinIO on a private address, Azurite). On a hosted deployment the operator opens that network for your organization instead, as described under [Provider private networks](#provider-private-networks). See [Files](/guide/files#which-endpoints-a-provider-may-use) for the rules per provider.

::: warning Changing the mode of an existing MongoDB installation
`DEPLOYMENT_MODE=onprem` also changes the default of `MONGODB_SINGLE_DATABASE` to `true`. An installation that has run in `saas` mode keeps tenant data in per-tenant databases (`tenant_<slug>`); after the switch the console would look for that data in the main database. Set `MONGODB_SINGLE_DATABASE=false` together with `DEPLOYMENT_MODE=onprem` to keep the data where it is.
:::

### Authentication

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_EXPIRES_IN` | JWT token expiry | `7d` |
| `PROVIDER_ENCRYPTION_SECRET` | Key that encrypts provider credentials at rest. Required: min 32 chars, must differ from `JWT_SECRET`. | — |

Production refuses to start unless `PROVIDER_ENCRYPTION_SECRET` is valid, and in production credentials are never encrypted with `JWT_SECRET`. Outside production, an unset `PROVIDER_ENCRYPTION_SECRET` is reported as a configuration error and new credentials are encrypted with `JWT_SECRET` instead. Decryption also tries `JWT_SECRET`, so credentials that an earlier version saved under it stay readable and are encrypted under `PROVIDER_ENCRYPTION_SECRET` the next time they are saved.

### Network & Authorization

| Variable | Description | Default |
|----------|-------------|---------|
| `TRUSTED_PROXIES` | Comma-separated IPs / CIDRs of the reverse proxies or load balancers allowed to set `X-Forwarded-For`. Token IP allowlists and the IP condition of access policies use the address resolved through them; unset, they use the direct connection address and ignore forwarded headers. | — |
| `IAM_VALIDATE_REQUESTS` | Set to `1` to validate every authorization request against the engine's schema (diagnostics; adds about 0.1 ms per decision). | off |

There is no switch for the authorization engine itself: it decides every request. See [Authorization](/guide/authorization).

### Registration

| Variable | Description | Default |
|----------|-------------|---------|
| `REGISTRATION_MODE` | `open` (anyone can sign up), `beta` (signup requires a beta access code), or `disabled` (public signup off) | `open` |
| `BOOTSTRAP_ORG_NAME` | On-prem bootstrap: organization name to create on first boot when no organization exists | — |
| `BOOTSTRAP_ADMIN_EMAIL` | On-prem bootstrap: owner user email | — |
| `BOOTSTRAP_ADMIN_PASSWORD` | On-prem bootstrap: owner user password (must satisfy the password policy) | — |
| `BOOTSTRAP_ADMIN_NAME` | On-prem bootstrap: owner display name | `Administrator` |

With `REGISTRATION_MODE=beta`, seed single-use access codes into the main
database with `npm run seed:beta-codes -- --count 10` (or pass explicit codes;
`--list` shows all codes and their status). The signup form then requires a
valid unused code, and each code is consumed on successful registration.

For on-prem deployments, set `REGISTRATION_MODE=disabled` together with the
three `BOOTSTRAP_*` variables: the server creates exactly one organization
owned by the given user on first boot and public signup stays off.

### Gateway (Resilience)

| Variable | Description | Default |
|----------|-------------|---------|
| `GATEWAY_REQUEST_TIMEOUT_MS` | Request timeout for provider calls | `120000` |
| `GATEWAY_RETRY_ENABLED` | Enable automatic retries | `true` |
| `GATEWAY_RETRY_MAX_ATTEMPTS` | Maximum retry attempts | `3` |
| `GATEWAY_RETRY_INITIAL_DELAY_MS` | Initial retry delay (exponential) | `200` |
| `GATEWAY_CIRCUIT_BREAKER_ENABLED` | Enable circuit breaker | `true` |
| `GATEWAY_CIRCUIT_BREAKER_THRESHOLD` | Failures before opening circuit | `5` |
| `GATEWAY_CIRCUIT_BREAKER_RESET_MS` | Time before half-open test | `30000` |

### Cache

| Variable | Description | Default |
|----------|-------------|---------|
| `CACHE_PROVIDER` | Cache backend: `none`, `memory`, `redis` | `memory` |
| `CACHE_TTL_SECONDS` | Default cache TTL | `300` |
| `REDIS_URL` | Redis connection URL (required when provider=redis) | — |
| `REDIS_KEY_PREFIX` | Key prefix for Redis cache | `console:` |

### Rate Limiting

| Variable | Description | Default |
|----------|-------------|---------|
| `RATE_LIMIT_PROVIDER` | Provider: `mongodb`, `memory`, `redis`. `memory` and `redis` require the same `CACHE_PROVIDER`. | `mongodb` |
| `RATE_LIMIT_SYNC_INTERVAL_MS` | Sync interval for distributed counters | `5000` |
| `RATE_LIMIT_MAX_TRACKED_KEYS` | Counters the in-process limiter (login and other auth endpoints, public MCP endpoints) keeps at once. When it is full, counters whose window has ended are dropped, then the ones counted least recently. A whole number from `1`; any other value (`0`, a negative or non-numeric one, `1e5`, `100,000`) uses the default. | `100000` |

Sign-in, registration, password reset and session issuance are limited per client
address (`request.ip`, which follows `TRUSTED_PROXIES`). A forwarded value that is
not an IP address, such as an empty or unusually long one, is limited together
with every other such value instead of getting a counter of its own. A trailing
port (`203.0.113.9:51234`, `[2001:db8::1]:443`) is ignored.

### Browser Runtime

| Variable | Description | Default |
|----------|-------------|---------|
| `BROWSER_BLOCK_PRIVATE_NETWORK` | Blocks localhost, link-local, private, and reserved network egress from managed browser sessions. | `true` |

### Outbound HTTP (SSRF Guard)

Services that fetch tenant-supplied URLs (tools, MCP servers, custom reranker
endpoints, connected external agents, inference-monitoring pollers) route
through a shared guard that blocks requests resolving to loopback, private,
link-local, CGNAT, or cloud-metadata address space, and re-validates every
redirect hop.

| Variable | Description | Default |
|----------|-------------|---------|
| `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` | Block outbound requests to private/loopback address space from tenant-configured integrations. | `true` |
| `OUTBOUND_HTTP_ALLOWED_HOSTS` | Comma-separated hostnames exempt from the block. Use a leading dot to match subdomains (e.g. `.svc.cluster.local`). | *(empty)* |
| `OUTBOUND_HTTP_DEFAULT_TIMEOUT_MS` | Default timeout for guarded outbound requests. | `30000` |
| `PROVIDER_PRIVATE_NETWORKS` | Private ranges that provider endpoints may reach, per organization. Entries are separated by `;`; each is `<tenantId>=<cidr>[,<cidr>...]`, and `*` in place of a tenant ID opens the ranges for every organization. IPv4 and IPv6 CIDRs are accepted (a bare address means one host); host names are not. Whitespace is ignored and two entries for one organization merge. An entry or range that cannot be read opens nothing and is logged as an error at startup. Example: `"64f0c0ffee1234567890abcd=10.50.0.0/16,fd12:3456::/48;*=100.64.10.0/24"`. See [Provider private networks](#provider-private-networks). | *(empty: nothing is opened)* |
| `PROVIDER_PRIVATE_NETWORKS_DENY` | Comma-separated CIDRs that stay refused even inside an opened range. Set it to the cluster's pod and service ranges and to any other internal range. An entry that cannot be read closes every opened network until it is fixed. | *(empty)* |

Self-hosted deployments that legitimately call in-network services (e.g. a
vLLM server on a private IP) should list those hosts in
`OUTBOUND_HTTP_ALLOWED_HOSTS` rather than disabling the guard globally.

Endpoints that a person types into a provider (model, embedding, image,
speech, moderation, decision and file providers) follow the
[deployment mode](#deployment-mode) instead of that global default. In `saas`
mode the block is always on and the allow-list does not apply; networks opened
with [`PROVIDER_PRIVATE_NETWORKS`](#provider-private-networks) are the
exception. In `onprem` mode private addresses are allowed unless
`OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` is set to `true` explicitly; only then do
`OUTBOUND_HTTP_ALLOWED_HOSTS` entries matter for providers. For file providers
the check runs when the provider is saved or tested and each time its storage
client is built, and the client's connections are checked when they are opened.
See [Files](/guide/files#which-endpoints-a-provider-may-use).

#### Provider private networks

Provider endpoints (model, embedding, image, speech, moderation, decision and
file providers) are checked by a guard of their own. On SaaS it always refuses
private, loopback and link-local addresses; on a self-hosted installation it does
so only when `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` is explicitly `true`. A
customer's own store or model server often sits on a private address of the
customer's network, which the operator has connected to the deployment with a VPN
or a peering. `PROVIDER_PRIVATE_NETWORKS` opens those networks for chosen
organizations, and `PROVIDER_PRIVATE_NETWORKS_DENY` keeps ranges closed inside
them:

```bash
PROVIDER_PRIVATE_NETWORKS="64f0c0ffee1234567890abcd=10.50.0.0/16,fd12:3456::/48;*=100.64.10.0/24"
PROVIDER_PRIVATE_NETWORKS_DENY="10.244.0.0/16,10.96.0.0/12"
```

- A private address is allowed for an organization only when it lies inside one of
  its ranges (or a `*` range) and is not one of the addresses that are never
  opened. A name is resolved and every address it answers with has to pass.
  Public addresses are decided as before. For a file provider the rule applies
  again each time its storage client is built and a connection is opened.
- An entry or a range that cannot be read opens nothing and is logged as an error
  at startup; the readable ranges of the same entry still apply. A deny list with
  an entry that cannot be read opens nothing for anyone until it is fixed, because
  what it was meant to keep out is unknown.
- Both settings are read once, when Console starts, on every Console process (a
  `worker` node included, see [Cluster](/guide/cluster)): restart every replica
  after changing them. The startup log has one line with the counts
  (organizations with ranges of their own, opened ranges, ranges opened for every
  organization, deny ranges), an error line that lists the entries that cannot be
  read, and a warning for an opened range that overlaps an address that is never
  opened.
- They apply wherever the provider guard blocks private targets: always on SaaS
  and, on a self-hosted installation, only with
  `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=true` (hosts in
  `OUTBOUND_HTTP_ALLOWED_HOSTS` keep passing there). Webhooks, tools, MCP servers,
  alert channels, browser sessions, the crawler, OCR webhooks and imports are not
  covered: they follow the `OUTBOUND_HTTP_*` settings above.
- Never opened, whatever the entries say: loopback, link-local (which holds the
  cloud metadata services), multicast and reserved addresses, the IPv6 forms that
  carry an IPv4 address, Console's own addresses and the ranges in
  `PROVIDER_PRIVATE_NETWORKS_DENY`. The names `localhost` and `*.localhost` stay
  refused as well.

[Private networks on SaaS](/guide/providers#private-networks-on-saas) describes the
procedure, the complete list of addresses that are never opened, how to find a
tenant ID, and how `mongodb+srv://` connection strings are checked.

### MCP Gateway

Limits on the MCP gateway: what a failed tool call and a server's request log
keep, the pool of stdio subprocesses, the SSE transport, and the public
(unauthenticated) endpoints. Secret values the server holds (its upstream
credential, stdio environment values, runtime headers) are masked as
`[REDACTED]` in the error text before it is cut to length or stored.

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_ERROR_MESSAGE_MAX_CHARS` | Longest error message a failed tool call hands back to its caller (minimum `256`). | `8192` |
| `MCP_LAST_ERROR_MAX_CHARS` | Longest `lastError` message stored on an MCP server record (minimum `64`). | `2048` |
| `MCP_LAST_ERROR_THROTTLE_MS` | An identical `lastError` is not written again within this window. `0` writes every time. | `60000` |
| `MCP_LOG_TOOL_NAME_MAX_CHARS` | Longest tool name stored in an MCP request-log row (minimum `16`). | `200` |
| `MCP_LOG_USER_AGENT_MAX_CHARS` | Longest caller user-agent stored with an MCP request-log row (minimum `16`). | `300` |
| `MCP_LOG_CLIENT_META` | Store the `params._meta` an MCP host sends with a tool call in the request-log row (under `_client.meta`, bounded and with sensitive values masked; coordinates are never stored). `false` stores nothing. | `true` |
| `MCP_LOG_CLIENT_META_MAX_BYTES` | Largest serialized `_meta` kept per request-log row; keys beyond it are dropped and the row is marked `_truncated` (minimum `256`). | `2048` |
| `MCP_INVOKE_CONCURRENCY` | Concurrent MCP tool invocations per node when calls are routed through the job queue. | `4` |
| `MCP_STDIO_MAX_CONCURRENT` | Stdio (npx/uvx) MCP subprocesses running at once, all tenants together. | `8` |
| `MCP_STDIO_MAX_CONCURRENT_PER_TENANT` | One tenant's share of them; a call over it is refused with an error saying so. `0` leaves only the process-wide limit, which suits an installation with a single tenant. | half of `MCP_STDIO_MAX_CONCURRENT`, at least `1` |

#### SSE streams

The legacy SSE transport keeps one open stream per client (`GET …/sse`), fed by
`POST …/message?sessionId=…`. A session belongs to the caller that opened it:
a message naming a session that does not exist, or that another token (or the
public endpoint) opened, is answered `404`. A stream over a limit is answered
`429` or `503` with a `Retry-After` header and a JSON body. `0` turns a limit
off.

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_SSE_MAX_SESSIONS` | Open streams per process. Streams on public endpoints stop at 75% of it, so API-token callers keep room. | `2000` |
| `MCP_SSE_MAX_SESSIONS_PER_IP` | Open streams one client address may hold on the public endpoints. | `50` |
| `MCP_SSE_IDLE_TIMEOUT_MS` | A stream that has received no message for this long is closed. The keep-alive comments the gateway sends do not count. | `1800000` |
| `MCP_SSE_MAX_BUFFERED_BYTES` | A stream whose unsent output (a client that stopped reading) exceeds this is closed. | `8388608` |
| `MCP_SSE_KEEPALIVE_MS` | Interval of the comment frame that keeps a quiet stream open through proxies. | `25000` |

The `endpoint` event carries the path of the message URL
(`/api/…/message?sessionId=…`), never an absolute URL. MCP clients resolve it
against the URL they opened the stream on, so it does not depend on `APP_URL`
or on the request's `Host` and `X-Forwarded-*` headers, and a client may reach
the gateway under any hostname.

With several replicas and a Redis relay, a message for a stream on a public
endpoint may reach a different replica than the one holding the stream: the
response is relayed to that replica, provided the stream was opened on the same
endpoint by an anonymous caller. Streams opened with an API token stay on the
replica that holds them, so route their `POST …/message` calls to the same
replica (session affinity) or use the streamable HTTP transport instead.

#### Public endpoints

Servers whose access mode is `public` answer at `/api/public/mcp/…` without a
token. Those routes accept JSON bodies only (`415` otherwise), answer a request
over its rate with `429` and a `Retry-After`, and report a failed tool call
without the upstream's text: *Tool execution failed* or *Upstream request
failed (status N)*, followed by the id of the request-log row that holds the
detail. Invalid arguments and unknown tool names are reported as such
(JSON-RPC `-32602`). Calls are also logged with the caller's address and user
agent, and with smaller payloads than token calls.

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_PUBLIC_RATE_LIMIT_PER_MINUTE` | Requests per client address and endpoint per minute (and ten times that per address across all public endpoints). `0` turns these limits off. | `300` |
| `MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE` | Requests per endpoint per minute from all callers together, whatever address they appear to come from. Unset, it is twenty times `MCP_PUBLIC_RATE_LIMIT_PER_MINUTE`. `0` turns it off. | `6000` |
| `MCP_PUBLIC_BODY_LIMIT_BYTES` | Largest request body a public POST may carry (minimum `1024`). | `1048576` |
| `MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT` | Tool calls one tenant may have running at once through its public endpoints; a call over it gets `503`. `0` turns the cap off. | `100` |
| `MCP_PUBLIC_LOG_PAYLOAD_LIMIT_BYTES` | Largest request or response payload a public call stores in the request log (minimum `256`). | `16384` |

The client address is the one Fastify resolves; when the gateway runs behind a
reverse proxy, list the proxy in `TRUSTED_PROXIES` so the address cannot be
supplied by the caller. The per-endpoint rate
(`MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE`) does not depend on the address. An
endpoint used by many people behind one corporate gateway may need
`MCP_PUBLIC_RATE_LIMIT_PER_MINUTE` raised, since everyone behind an address
shares that address's rate. The counters are kept under the server's stored ids
and per process; with `RATE_LIMIT_PROVIDER=redis` the per-endpoint limits are
shared by all replicas.

### Cluster & Queue

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ROLE` | Node role: `main`, `worker`, or `all` | `all` |
| `NODE_NAME` | Unique node name (used in the cluster registry) | `<hostname>-<pid>` |
| `CLUSTER_DEFAULT_NODE_NAME` | Default node for new instance assignments | First online node |
| `QUEUE_PROVIDER` | Queue backend: `auto`, `memory`, `bullmq` | `auto` (bullmq when Redis is configured) |
| `QUEUE_REDIS_URL` | Redis URL for BullMQ | Falls back to `REDIS_URL` |
| `QUEUE_PREFIX` | BullMQ key prefix | `console:q:` |
| `QUEUE_DEFAULT_ATTEMPTS` | Default retry attempts per job | `3` |
| `QUEUE_DEFAULT_BACKOFF_MS` | Default backoff between retries | `1000` |

See [Cluster](/guide/cluster) for the full topology / assignment model.

### Agent Runs

Every agent call is a run. A synchronous call waits up to `AGENT_SYNC_TIMEOUT_MS` and then answers `202` while the run keeps going; runs can also be queued (`background`), deferred (low priority) or scheduled, and an agent's triggers start runs on a cron schedule (in a timezone), once at a set time, or on Run now. See [Agent background execution](/guide/agent-background-execution).

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_SYNC_TIMEOUT_MS` | How long a synchronous call waits for its run (minimum `5000`). After that the call answers `202` with the run and it continues in the background. Keep it below the shortest infrastructure timeout (load balancer, gateway) in the deployment | `600000` |
| `AGENT_BACKGROUND_MAX_DURATION_MS` | Longest wall-clock any run may take (an inline run after it detached, background and deferred runs), independent of the agent's own `maxWallClockMs` | `1800000` |
| `AGENT_RUN_MAX_ACTIVE_PER_TENANT` | Default-class runs queued or running per tenant, synchronous calls included. `0` = no cap. The tenant quota `maxConcurrentAgentRuns` lowers it | `250` |
| `AGENT_RUN_MAX_ACTIVE_PER_PROJECT` | The same per project. `0` = off | `0` |
| `AGENT_RUN_CONCURRENCY` | Default-class queue workers per node | `4` |
| `AGENT_DEFERRED_MAX_RUNNING_PER_TENANT` | Deferred (low priority) runs executing at once per tenant | `2` |
| `AGENT_DEFERRED_MAX_QUEUED_PER_TENANT` | Deferred runs queued or scheduled per tenant. A new run over it is refused with `429` | `10000` |
| `AGENT_DEFERRED_CONCURRENCY` | Deferred queue workers per node | half of `AGENT_RUN_CONCURRENCY`, at least `1` |
| `AGENT_DEFERRED_MAX_WAIT_MS` | A deferred or scheduled run that has not started this long after it became due fails with reason `expired` (minimum `60000`) | `86400000` |
| `AGENT_RUN_CALLBACK_CONCURRENCY` | Callback delivery workers per node | `4` |
| `AGENT_RUN_DRAIN_TIMEOUT_MS` | On shutdown: how long to wait for runs executing on this node before marking the rest `interrupted`. The drain runs before the HTTP server waits for its open connections, so a caller waiting on such a run is answered (`503 agent_run_interrupted`) and open streams end. Kept below `SHUTDOWN_TIMEOUT_MS` minus 3 seconds | `10000` |
| `AGENT_TRIGGER_TICK_MS` | How often the trigger scheduler looks for due slots (minimum `5000`) | `30000` |
| `AGENT_TRIGGER_MISFIRE_GRACE_MS` | A missed trigger slot older than this is skipped; at most one catch-up run fires | `3600000` |
| `AGENT_WEBHOOK_BODY_LIMIT_BYTES` | Largest body an incoming trigger webhook accepts (min 16384, max 26214400); larger deliveries get 413 | `5242880` |
| `AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE` | Runs one webhook trigger starts per minute (`0` = off). Per node unless `RATE_LIMIT_PROVIDER=redis` | `60` |
| `AGENT_REMINDERS_ENABLED` | Platform switch for agent reminders. `false`: no agent is offered the reminder tools and due reminders are not run | `true` |
| `AGENT_REMINDER_MIN_DELAY_SECONDS` | Shortest reminder delay any agent may use (minimum `30`) | `60` |
| `AGENT_REMINDER_MAX_HORIZON_HOURS` | Furthest ahead any agent may set a reminder (`1`..`720`) | `168` |
| `AGENT_REMINDER_MAX_ACTIVE_PER_SESSION` | Scheduled reminders one session may hold at once | `10` |
| `AGENT_REMINDER_MAX_FIRES_PER_SESSION` | Reminders one session may ever create (stops a reminder that keeps re-arming itself) | `100` |
| `AGENT_CHAT_CONCURRENCY` | Concurrent agent chat turns per node | `4` |
| `AGENT_RUN_RETENTION_DAYS` | How long run records (`userMessage`, result) are kept, counted from when the run finished (a scheduled or deferred run is also kept until it was due) | `30` |
| `AGENT_RUN_HEARTBEAT_INTERVAL_MS` | How often a worker stamps the heartbeat of a running run (minimum `1000`) | `15000` |
| `AGENT_RUN_HEARTBEAT_STALE_MS` | A running run whose heartbeat is older than this is failed as `worker_lost` (at least three heartbeat intervals) | `45000` |
| `AGENT_STATE_MAX_BYTES` | Cap on one stored conversation state document (the turn snapshot plus, while a run waits for an approval or an answer, the paused copy), as stored: compressed and base64 (`100000`..`15000000`). The default suits Cosmos DB for MongoDB RU (2 MB document limit); MongoDB and Cosmos vCore (16 MB) can go up to 15 MB. A state over the cap is trimmed (tool outputs first); a pause that still does not fit fails the run with the reason | `1500000` |
| `AGENT_RUN_REQUEUE_AFTER_MS` | A queued run that no worker picked up after this long is republished (minimum `10000`); the republish uses a job id of its own for each window, so a job that failed before it claimed its run is tried again | `120000` |

`AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_TENANT` and `AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_PROJECT` are replaced by `AGENT_RUN_MAX_ACTIVE_PER_TENANT` and `AGENT_RUN_MAX_ACTIVE_PER_PROJECT`; the new caps also count synchronous calls.

### Entity Health & Alerting

Health views, alert rules and reports for agents, models, knowledge bases, MCP servers and tools read 5-minute rollups that every node buffers in memory and flushes to the database. See [Monitoring](/guide/monitoring#alerts-incidents) for how alert rules use them and [Agent Tracing](/guide/tracing#session-status) for how a session's status is decided.

| Variable | Description | Default |
|----------|-------------|---------|
| `ENTITY_METRICS_FLUSH_MS` | How often buffered rollup increments are written to the database (minimum `1000`). Alert evaluation only reads data older than this, so a longer interval delays alerts by the same amount | `30000` |
| `ENTITY_METRICS_RETENTION_DAYS` | Rollup buckets older than this many days are expired (database TTL plus an hourly purge, minimum `1`). Health ranges and baselines cannot look further back than this | `45` |
| `ENTITY_METRICS_MAX_BUFFERED_ROWS` | Cap on distinct rollup rows buffered per process (minimum `100`); new rows beyond the cap are dropped and counted, existing rows keep accumulating | `50000` |
| `ENTITY_METRICS_MAX_BUFFERED_ROWS_PER_TENANT` | Cap on distinct rollup rows one tenant may hold in the buffer (minimum `100`), so a single tenant cannot use up the share of the others; the effective cap is the lower of this and `ENTITY_METRICS_MAX_BUFFERED_ROWS`. Excess new rows are dropped and counted per tenant | `10000` |
| `TRACING_STALE_SESSION_MINUTES` | A traced session still `in_progress` this many minutes after its last activity is marked `abandoned` (minimum `5`). An abandoned session is not an error | `360` |
| `TRACING_FINALIZER_INTERVAL_MS` | How often stale traced sessions are swept (minimum `10000`) | `300000` |
| `ALERT_CHANNEL_TIMEOUT_MS` | Per-channel timeout when delivering an alert notification: webhook, Slack, Teams and PagerDuty (minimum `1000`) | `10000` |
| `ALERT_DEFAULT_RULES_ON_CREATE` | New projects and the Default Project of a new workspace get the five default [alert rules](../api/alerts.md#the-default-set) (the default set of the rule templates). `false` turns that default off; a project can still add them from **Alerts → Templates**, and a create request that sends `defaultAlertRules: true` still gets them | `true` |

OTLP sessions are closed earlier than the stale window: one that has been quiet for 10 minutes (or the stale window, whichever is shorter) is finalized as `success` or `error` instead of `abandoned`. The 10 minutes are fixed.

### Data Retention

How long logs are kept and how the central retention engine runs. See [Data Retention](/guide/data-retention) for the data classes, presets and the settings screen.

| Variable | Description | Default |
|----------|-------------|---------|
| `RETENTION_ENGINE_ENABLED` | Scheduled sweeps; with `false` only a manual purge runs | `true` |
| `RETENTION_DRY_RUN` | Sweeps only count what they would delete. Turn off after checking `npm run retention:inventory` | `true` |
| `RETENTION_INTERVAL_SECONDS` | How often the cluster-wide tick queues one sweep per tenant (minimum `60`) | `3600` |
| `RETENTION_BUDGET_SECONDS` | How long one sweep slice runs before it queues its continuation (`10`–`840`) | `240` |
| `RETENTION_BATCH_SIZE` | Rows per delete or redact batch (`50`–`5000`) | `500` |
| `RETENTION_SHORTEN_DELAY_HOURS` | A shortened duration applies this many hours after it is saved (`0`–`168`) | `24` |
| `RETENTION_AUDIT_MIN_DAYS` | Floor for the `audit` class (minimum `30`) | `365` |
| `RETENTION_RECORDS_DAYS` | How long destruction records are kept (minimum `1095`) | `1095` |
| `RETENTION_<CLASS>_DAYS` | Deployment default for one class: `CONTENT`, `TELEMETRY`, `TRACE`, `JOBS`, `METRICS`, `ALERTS`, `AUDIT`, `USAGE`, `RESULTS` | the class default |

### Logging

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Log level: `error`, `warn`, `info`, `debug` | `debug` (dev) / `info` (prod) |
| `LOG_FORMAT` | Output format: `json`, `pretty` | `pretty` (dev) / `json` (prod) |
| `LOG_REQUEST_BODY` | Log request bodies | `false` |
| `LOG_RESPONSE_BODY` | Log response bodies | `false` |

### CORS

| Variable | Description | Default |
|----------|-------------|---------|
| `CORS_ENABLED` | Enable CORS for client API | `false` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins | — |
| `CORS_MAX_AGE` | Preflight cache duration (seconds) | `86400` |

### SMTP (Email)

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_HOST` | SMTP server host | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP server port | `587` |
| `SMTP_SECURE` | Use TLS | `false` |
| `SMTP_USER` | SMTP username | — |
| `SMTP_PASS` | SMTP password | — |
| `SMTP_FROM` | From address | Falls back to `SMTP_USER` |
| `SENDGRID_API_KEY` | SendGrid API key; used through SendGrid SMTP when `SMTP_*` credentials are absent | — |
| `SENDGRID_FROM_EMAIL` | Verified SendGrid sender address | — |

### Application

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_URL` | Server public application URL used in emails and generated links | `http://localhost:3000` |
| `NEXT_PUBLIC_APP_URL` | Legacy fallback for `APP_URL` | `http://localhost:3000` |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown timeout | `15000` |
| `TRACING_MAX_BODY_SIZE_MB` | Max tracing payload size | `10` |
| `HEALTH_ENDPOINT_ENABLED` | Enable health endpoints | `true` |
| `PROVIDER_RUNTIME_CACHE_TTL_SECONDS` | Runtime pool entry TTL. `0` turns expiry off (entries are still replaced when a provider's configuration changes). | `300` |
| `PROVIDER_RUNTIME_DISPOSE_GRACE_SECONDS` | How long an evicted runtime keeps its connections open before they are closed, so a request that still holds it can finish. `0` closes immediately. See [Runtime Pool](/guide/core-runtime-pool). | `300` |

### Portal Address

Enterprise portals open at `/p/{portalKey}` on the Console host. With one of these settings they get an address of their own, and `/p` links are sent on to it.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORTAL_BASE_DOMAIN` | Each workspace's portals at `https://<workspace slug>.<base>/{portalKey}`, with the portal chooser at `/`. Needs a wildcard DNS record and certificate for `*.<base>`. Must not contain the Console host (`APP_URL`). | *(empty)* |
| `PORTAL_HOST` | One fixed host without a wildcard, for example `assistant.example.com`. Must not be the Console host. | *(empty)* |
| `PORTAL_HOST_TENANT` | The slug of the workspace `PORTAL_HOST` serves. Empty: the workspace of the person's session, as `/p` does. | *(empty)* |

People still sign in on the Console host (password, LDAP and SSO are unchanged, so identity providers need no new redirect URI). The portal host keeps its own session cookie, and signing out there also ends the Console session.

### Files

| Variable | Description | Default |
|----------|-------------|---------|
| `FILE_UPLOAD_MAX_MB` | Largest single file an upload may carry, in MB. An upload request body may be that size as base64 plus 64 KiB. Stored files are read back (download, preview, zip) up to the larger of twice this value and 100 MB. | `50` |
| `FILE_UPLOAD_ALLOWED_MIME_TYPES` | Comma-separated allow-list of content types; `image/*` style wildcards work. An upload of another type is refused with `415`. Empty allows any type. | *(empty)* |

See [Files](/guide/files#limits) for the other limits of the Document Store.

## Config Source Abstraction

The config module uses a `ConfigSource` interface, making it easy to swap between ENV-based and database-backed configuration:

```typescript
interface ConfigSource {
  readonly name: string;
  get(key: string): string | undefined;
}
```

The default `EnvConfigSource` reads from `process.env`. You can replace it:

```typescript
import { setConfigSource } from '@/lib/core/config';

setConfigSource(myDatabaseConfigSource);
```

## Validation

At startup, critical configuration is validated:

```typescript
const cfg = getConfig();
const errors = validateConfig(cfg);
// Checks: MONGODB_URI required, JWT_SECRET required (min 32 chars),
// PROVIDER_ENCRYPTION_SECRET required (min 32 chars, different from JWT_SECRET),
// REDIS_URL required when CACHE_PROVIDER=redis, etc.
```

Every error is logged. In production the server then refuses to start. In any other environment it keeps running and logs a warning that some features may not work.

## Example `.env.local`

### SQLite mode (default, zero dependencies)

```bash
# Required
JWT_SECRET=your-secret-key-must-be-at-least-32-chars
PROVIDER_ENCRYPTION_SECRET=another-secret-key-of-at-least-32-chars

# Database (SQLite is the default — no MongoDB needed)
# DB_PROVIDER=sqlite
# SQLITE_DATA_DIR=./data

# Cache
CACHE_PROVIDER=memory

# Logging
LOG_LEVEL=debug
LOG_FORMAT=pretty

# CORS (for client SDKs)
CORS_ENABLED=true
CORS_ALLOWED_ORIGINS=http://localhost:3001,http://localhost:5173
```

### MongoDB mode

```bash
# Required
JWT_SECRET=your-secret-key-must-be-at-least-32-chars
PROVIDER_ENCRYPTION_SECRET=another-secret-key-of-at-least-32-chars

# Database
DB_PROVIDER=mongodb
MONGODB_URI=mongodb://localhost:27017

# Cache
CACHE_PROVIDER=memory
# REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=debug
LOG_FORMAT=pretty

# CORS (for client SDKs)
CORS_ENABLED=true
CORS_ALLOWED_ORIGINS=http://localhost:3001,http://localhost:5173

# SMTP (optional)
# SMTP_HOST=smtp.gmail.com
# SMTP_USER=your@email.com
# SMTP_PASS=your-app-password
```
