# Configuration

All application configuration is managed through the central `getConfig()` function in `src/lib/core/config.ts`. Environment variables are the default source, but the abstraction supports swapping to database-backed configuration.

> **Rule**: Never read `process.env` directly in application code. Always use `getConfig()`.

## Environment Variables Reference

### Required

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Secret for JWT signing (min 32 chars) | — |

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

### Authentication

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_EXPIRES_IN` | JWT token expiry | `7d` |
| `PROVIDER_ENCRYPTION_SECRET` | Encryption key for provider credentials | Falls back to `JWT_SECRET` |

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

Self-hosted deployments that legitimately call in-network services (e.g. a
vLLM server on a private IP) should list those hosts in
`OUTBOUND_HTTP_ALLOWED_HOSTS` rather than disabling the guard globally.

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

Every agent call is a run. A synchronous call waits up to `AGENT_SYNC_TIMEOUT_MS` and then answers `202` while the run keeps going; runs can also be queued (`background`), deferred (low priority) or scheduled, and an agent's routines start runs on a cron schedule (in a timezone), once at a set time, or on Run now. See [Agent background execution](/guide/agent-background-execution).

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
| `AGENT_RUN_DRAIN_TIMEOUT_MS` | On shutdown: how long to wait for runs executing on this node before marking the rest `interrupted`. Kept below `SHUTDOWN_TIMEOUT_MS` minus 3 seconds | `10000` |
| `AGENT_ROUTINE_TICK_MS` | How often the routine scheduler looks for due slots (minimum `5000`) | `30000` |
| `AGENT_ROUTINE_MISFIRE_GRACE_MS` | A missed routine slot older than this is skipped; at most one catch-up run fires | `3600000` |
| `AGENT_WEBHOOK_BODY_LIMIT_BYTES` | Largest body an incoming routine webhook accepts (min 16384, max 26214400); larger deliveries get 413 | `5242880` |
| `AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE` | Runs one routine's webhook trigger starts per minute (`0` = off). Per node unless `RATE_LIMIT_PROVIDER=redis` | `60` |
| `AGENT_CHAT_CONCURRENCY` | Concurrent agent chat turns per node | `4` |
| `AGENT_RUN_RETENTION_DAYS` | How long run records (`userMessage`, result) are kept | `30` |
| `AGENT_RUN_HEARTBEAT_INTERVAL_MS` | How often a worker stamps the heartbeat of a running run (minimum `1000`) | `15000` |
| `AGENT_RUN_HEARTBEAT_STALE_MS` | A running run whose heartbeat is older than this is failed as `worker_lost` (at least three heartbeat intervals) | `45000` |
| `AGENT_RUN_REQUEUE_AFTER_MS` | A queued run that no worker picked up after this long is republished (minimum `10000`) | `120000` |

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
| `PROVIDER_RUNTIME_CACHE_TTL_SECONDS` | Runtime pool entry TTL | `300` |

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
// Checks: MONGODB_URI required, JWT_SECRET required,
// REDIS_URL required when CACHE_PROVIDER=redis, etc.
```

Validation errors are logged but do not crash the server — this allows K8s secrets to be injected after initial startup.

## Example `.env.local`

### SQLite mode (default, zero dependencies)

```bash
# Required
JWT_SECRET=your-secret-key-must-be-at-least-32-chars

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
