/**
 * Central Configuration Module
 *
 * All application configuration flows through this module.
 * The ConfigSource abstraction allows swapping ENV for a settings page,
 * database, or any other source in the future.
 *
 * Usage:
 *   import { getConfig } from '@/lib/core/config';
 *   const cfg = getConfig();
 *   cfg.database.uri  // typed, validated, with defaults
 */

/* ------------------------------------------------------------------ */
/*  Config Source Abstraction                                          */
/* ------------------------------------------------------------------ */

export interface ConfigSource {
  /** Human-readable name for diagnostics */
  readonly name: string;
  /** Read a raw string value by key. Returns undefined when missing. */
  get(key: string): string | undefined;
}

/** Default source: reads from process.env */
class EnvConfigSource implements ConfigSource {
  readonly name = 'env';
  get(key: string): string | undefined {
    return process.env[key];
  }
}

/* ------------------------------------------------------------------ */
/*  Typed Config Shape                                                */
/* ------------------------------------------------------------------ */

export interface AppConfig {
  nodeEnv: string;

  /**
   * Services switched off for the whole deployment (see
   * src/lib/services/availability/serviceAvailability.ts). Both empty = nothing off.
   */
  services: {
    disabled: string[];
    enabled: string[];
  };

  deployment: {
    /** saas = Cognipeer-hosted, onprem = customer-hosted. */
    mode: 'saas' | 'onprem';
    isOnPrem: boolean;
  };

  license: {
    offlinePublicKey: string;
    offlinePublicKeyPath: string;
    issuer: string;
    audience: string;
    /** Days after `exp` that an expired license still activates (with a warning). */
    graceDays: number;
  };

  storage: {
    /**
     * Root directory for all built-in on-disk data (vector indexes, file
     * storage, model caches). In Docker this points at the mounted
     * app-data volume (/app/data).
     */
    dataDir: string;
  };

  pii: {
    /**
     * Directory containing local ONNX NER models, laid out as
     * `<nerModelPath>/<modelId>/{config.json,tokenizer.json,onnx/model*.onnx}`
     * — the layout `@huggingface/transformers` expects for a local model.
     * Empty (default): the NER layer is unavailable and any policy asking
     * for `detection.mode: 'pattern+dictionary+ner'` runs dictionary-only
     * and reports itself degraded. This is the LOCAL stand-in for the
     * planned GitHub-Releases asset registry (see
     * `internal-notes/pii-v2-nlp-ve-asset-registry-plani.md` §3) — not
     * itself the registry.
     */
    nerModelPath: string;
    /** In-process concurrency cap on simultaneous NER inference calls. No
     *  worker pool (product decision, 2026-09-09): runs inline in the app
     *  process; isolation is deferred to a future sandbox-executor
     *  integration. */
    nerMaxConcurrent: number;
  };

  database: {
    provider: 'mongodb' | 'sqlite';
    uri: string;
    mainDbName: string;
    dataDir: string;
    minPoolSize: number;
    maxPoolSize: number;
    connectTimeoutMs: number;
    socketTimeoutMs: number;
    serverSelectionTimeoutMs: number;
    /**
     * When true, tenant-scoped MongoDB operations are bound to the main
     * database instead of a separate `tenant_{slug}` database. On-prem
     * deployments are single-organization by construction (REGISTRATION_MODE
     * disabled + BOOTSTRAP_* envs), so collapsing main+tenant collections into
     * one physical database removes an extra database to provision/back up
     * without any cross-tenant risk. Defaults on for onprem+mongodb; override
     * with MONGODB_SINGLE_DATABASE for edge cases.
     */
    singleDatabase: boolean;
  };

  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    providerEncryptionSecret: string;
  };

  registration: {
    /**
     * open     – anyone can sign up (default; current behavior)
     * beta     – signup requires a valid beta access code (SaaS beta)
     * disabled – public signup is off (on-prem; use the bootstrap envs below)
     */
    mode: 'open' | 'beta' | 'disabled';
    /** On-prem bootstrap: create a single organization + owner on boot when no tenant exists. */
    bootstrapOrgName: string;
    bootstrapAdminEmail: string;
    bootstrapAdminPassword: string;
    bootstrapAdminName: string;
  };

  /**
   * Cognipeer Support handoff. Console never sends the secret to the browser:
   * it exchanges it server-to-server for a single-use CRM code.
   */
  support: {
    /** Public Support app URL. Every Support entry point stays hidden while this is empty. */
    baseUrl: string;
    /** CRM API that issues handoff codes. */
    crmApiUrl: string;
    /** Must equal CRM's SUPPORT_HANDOFF_SECRET_CONSOLE. */
    handoffSecret: string;
  };

  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };

  gateway: {
    requestTimeoutMs: number;
    retryEnabled: boolean;
    retryMaxAttempts: number;
    retryInitialDelayMs: number;
    circuitBreakerEnabled: boolean;
    circuitBreakerThreshold: number;
    circuitBreakerResetMs: number;
  };

  cache: {
    provider: 'none' | 'memory' | 'redis';
    ttlSeconds: number;
    redis: {
      url: string;
      keyPrefix: string;
    };
  };

  rateLimit: {
    provider: 'mongodb' | 'memory' | 'redis';
    syncIntervalMs: number;
    /**
     * Distinct counters the in-process limiter (auth endpoints, public MCP
     * endpoints) keeps at once. Past it, counters whose window has ended are
     * dropped, then the ones counted least recently. A whole number from 1; any
     * other value takes the default.
     */
    maxTrackedKeys: number;
  };

  quota: {
    /** TTL for the cached tenant license + policy set. 0 disables the cache. */
    policyCacheTtlSeconds: number;
  };

  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    format: 'json' | 'pretty';
    logRequestBody: boolean;
    logResponseBody: boolean;
  };

  cors: {
    enabled: boolean;
    allowedOrigins: string[];
    maxAge: number;
  };

  health: {
    endpointEnabled: boolean;
    /** How often buffered entity metric increments are flushed to the database. */
    entityMetricsFlushMs: number;
    /** Entity metric buckets older than this are expired (TTL + hourly purge). */
    entityMetricsRetentionDays: number;
    /** Cap on distinct buffered rows per process; new rows beyond it are dropped and counted. */
    entityMetricsMaxBufferedRows: number;
    /** Share of the buffer one tenant may hold, so one tenant cannot starve the others; excess new rows are dropped and counted per tenant. */
    entityMetricsMaxBufferedRowsPerTenant: number;
    /** A tracing session still 'in_progress' this long after its last activity is marked 'abandoned'. */
    tracingStaleSessionMinutes: number;
    /** How often the stale tracing-session finalizer runs. */
    tracingFinalizerIntervalMs: number;
    /** Per-channel timeout when delivering an alert notification. */
    alertChannelTimeoutMs: number;
    /** New projects get the default alert rules (the default set of the rule templates). */
    defaultAlertRulesOnCreate: boolean;
  };

  network: {
    /**
     * Which immediate peers Fastify's `trustProxy` (and everything that
     * reads `request.ip`/X-Forwarded-For through it, e.g. the auth rate
     * limiter and audit IP logging) trusts to have set X-Forwarded-For
     * honestly. Empty (default) preserves the existing `trustProxy: true`
     * behaviour -- every hop is trusted, including one the caller
     * themselves controls if a request can reach this process directly.
    * Set to your real reverse proxy/load balancer's IP(s) or CIDR(s) to
    * close that gap. Numeric hop counts are intentionally unsupported:
    * they cannot authenticate the immediate peer and fail closed. Anything
    * not matching this list falls back to the raw socket address instead of
    * a spoofable header.
     */
    trustedProxies: string[];
  };

  limits: {
    bodySize: string;
    tracingMaxBodySizeMb: number;
    fileUploadMaxMb: number;
    fileUploadAllowedMimeTypes: string[];
  };

  app: {
    /**
     * Canonical external URL for server-generated links. Resolved from APP_URL
     * first, with NEXT_PUBLIC_APP_URL retained as a legacy fallback.
     */
    url: string;
    shutdownTimeoutMs: number;
  };

  providerRuntime: {
    cacheTtlSeconds: number;
    /**
     * How long an evicted runtime is held before its connections are closed.
     * Covers requests still holding a reference. 0 closes immediately.
     */
    disposeGraceSeconds: number;
  };

  browser: {
    /** Concurrency limiter provider (in-memory or future redis). */
    concurrencyProvider: 'memory';
    /** Default per-tenant maximum concurrent live browser sessions. */
    defaultMaxConcurrent: number;
    /** Auto-close session after N ms with no activity. */
    defaultIdleTimeoutMs: number;
    /** Hard upper bound on session lifetime (ms). */
    defaultMaxLifetimeMs: number;
    /** Default per-action timeout (click/hover/type/snapshot) in ms. */
    defaultActionTimeoutMs: number;
    /** Default navigation timeout (goto) in ms. */
    defaultNavigationTimeoutMs: number;
    /** Default Playwright headless mode. */
    headless: boolean;
    /** Default viewport width. */
    viewportWidth: number;
    /** Default viewport height. */
    viewportHeight: number;
    /** Reaper sweep interval (ms). */
    reaperIntervalMs: number;
    /** Bucket key used for browser artifacts when none is provided. */
    defaultArtifactBucketKey: string;
    /** Block localhost/private network egress from managed browser sessions. */
    blockPrivateNetwork: boolean;
    /**
     * Extra Chromium command-line flags, appended after the built-in
     * `--no-sandbox`/`--disable-dev-shm-usage` set on every launch — an
     * operator-controlled escape hatch for whatever a specific network
     * requires (e.g. `--proxy-bypass-list=...`,
     * `--ignore-certificate-errors-spki-list=...`) without needing a code
     * change and a new release for each one.
     */
    chromiumExtraArgs: string[];
    /**
     * Passes `--ignore-certificate-errors` to Chromium. For networks with a
     * TLS-inspecting corporate proxy (the browser-side equivalent of setting
     * `NODE_EXTRA_CA_CERTS`/`NODE_TLS_REJECT_UNAUTHORIZED=0` for Node's own
     * TLS stack, which Chromium does not read either) whose intercepting
     * certificate Chromium has no independent way to trust. This disables
     * certificate validation for EVERY page the managed browser navigates
     * to — only turn it on for a network you already control end-to-end.
     */
    ignoreCertificateErrors: boolean;
  };

  outboundHttp: {
    /**
     * Block requests to loopback/private/link-local/metadata address space
     * from services that fetch tenant-supplied URLs (tools, MCP, rerankers,
     * connected agents, inference pollers).
     */
    blockPrivateNetwork: boolean;
    /**
     * Hosts exempt from the private-network block. Exact hostnames, or
     * `.suffix` entries matching any subdomain (e.g. `.internal.example.com`).
     */
    allowedHosts: string[];
    /**
     * Private networks a provider endpoint may reach even though private targets are blocked, per organization.
     * Raw `PROVIDER_PRIVATE_NETWORKS` entries (`<tenantId or *>=<cidr>[,<cidr>...]`, separated by `;`). Read and
     * checked by `lib/security/providerPrivateNetworks`; nothing is opened unless an entry is valid.
     */
    providerPrivateNetworks: string[];
    /**
     * CIDR ranges (`PROVIDER_PRIVATE_NETWORKS_DENY`) that stay refused even inside an opened network.
     */
    providerPrivateNetworksDeny: string[];
    /** Default timeout applied to guarded outbound requests (ms). */
    defaultTimeoutMs: number;
  };

  systemModels: {
    openai: {
      apiKey: string;
      organizationId: string;
    };
    bedrock: {
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
    };
    together: {
      apiKey: string;
    };
    vertex: {
      projectId: string;
      location: string;
      /** Full service account key JSON string */
      serviceAccountKey: string;
    };
  };

  node: {
    /** Deployment role of this process. */
    role: 'main' | 'worker' | 'all';
    /** Unique name across the cluster. Defaults to hostname-pid when empty. */
    name: string;
    /** Public URL of this node (informational). */
    url: string;
    /** Free-form tags for grouping. */
    tags: string[];
    /** Heartbeat write interval in ms. */
    heartbeatMs: number;
    /** Nodes with last heartbeat older than this are marked offline. */
    offlineAfterMs: number;
    /** Default node name for instance assignments. Empty = first main node. */
    defaultNodeName: string;
  };

  queue: {
    /** auto = bullmq when Redis is configured, otherwise memory. */
    provider: 'auto' | 'memory' | 'bullmq';
    redis: {
      /** Falls back to cache.redis.url when empty. */
      url: string;
      prefix: string;
    };
    defaultAttempts: number;
    defaultBackoffMs: number;
  };

  /**
   * Agent background execution (docs/guide/agent-background-execution.md).
   * Both timeouts are server-operated ceilings, distinct from the agent's
   * own `runtime.limits.maxWallClockMs` (§5, §12.5/§12.13) — deploy-time
   * config must keep `syncTimeoutMs` below the shortest infrastructure
   * timeout in the deployment (Decision 6).
   */
  agent: {
    /** How long a synchronous call waits for its run; after it the call answers 202 and the run continues. Default 10 min. */
    syncTimeoutMs: number;
    /** Wall-clock ceiling of any run (inline after it detached, background, deferred). */
    backgroundMaxDurationMs: number;
    /** Retention TTL for AgentRun records (§12.10), following the tracing-retention precedent. */
    runRetentionDays: number;
    /** Retention TTL for `agent_session_events` (the append-only session event log). */
    sessionEventRetentionDays: number;
    /** How often a background worker writes heartbeatAt while a run is `running`. */
    runHeartbeatIntervalMs: number;
    /** A `running` run whose heartbeat is older than this is considered orphaned by the reconciler (§7.1). */
    runHeartbeatStaleMs: number;
    /** Background runs executed at once per node (own queue, so they never starve chat). */
    runConcurrency: number;
    /** A `queued` run older than this with no worker is republished by the reconciler. */
    runRequeueAfterMs: number;
    /** Default class: queued+running runs per tenant, every mode (sync, inline, background); 0 = no cap. The tenant quota `maxConcurrentAgentRuns` lowers it. */
    runMaxActivePerTenant: number;
    /** Default class: queued+running runs per project; 0 = off. */
    runMaxActivePerProject: number;
    /** Deferred class: runs executing at once per tenant. */
    deferredMaxRunningPerTenant: number;
    /** Deferred class: queued+scheduled runs per tenant; over it a new run is refused (429). */
    deferredMaxQueuedPerTenant: number;
    /** Deferred queue workers per node (the deferred share of a node; default half of `runConcurrency`, at least 1). */
    deferredConcurrency: number;
    /** A deferred / scheduled run that has not started this long after it became due is failed as `expired`. */
    deferredMaxWaitMs: number;
    /** Callback delivery workers per node (own queue). */
    runCallbackConcurrency: number;
    /** On shutdown: how long to wait for runs executing on this node before marking them `interrupted`. Below the shutdown timeout. */
    runDrainTimeoutMs: number;
    /** How often the trigger scheduler looks for due slots. */
    triggerTickMs: number;
    /** A missed trigger slot older than this is skipped (at most one catch-up fire). */
    triggerMisfireGraceMs: number;
    /** Concurrent agent chat turns per node (the `agent` queue). */
    chatConcurrency: number;
    /** Incoming trigger webhooks (`POST /api/public/hooks/:tenantId/:hookId`). */
    webhooks: {
      /** Largest accepted delivery body (min 16 KiB, max 25 MiB). */
      bodyLimitBytes: number;
      /** Runs one trigger's webhook starts per minute; 0 = off. */
      rateLimitPerMinute: number;
    };
    /** Reminders agents set for themselves (`reminder_set`): the platform ceilings over every agent's own settings. */
    reminders: {
      /** Off = the reminder tools are never offered and due reminders are not run. */
      enabled: boolean;
      minDelaySeconds: number;
      maxHorizonHours: number;
      maxActivePerSession: number;
      maxFiresPerSession: number;
    };
  };

  /**
   * Outgoing webhook subscriptions (`webhook_endpoints` / `webhook_deliveries`).
   * The retry schedule is the wait after each failed attempt, in seconds: with
   * the default seven entries a delivery is tried up to eight times.
   */
  webhooks: {
    /** Per-attempt timeout. */
    timeoutMs: number;
    /** Deliveries sent at once per node. */
    concurrency: number;
    /** Wait before retry 1, 2, ... after a failed attempt (seconds). */
    retryScheduleSeconds: number[];
    /** An endpoint failing continuously for longer than this is disabled. */
    autoDisableHours: number;
    /** Delivery rows older than this are deleted by the reconciler's retention pass. */
    deliveryRetentionDays: number;
  };

  /**
   * MCP gateway bounds (docs/guide/configuration.md, "MCP Gateway"): how much a
   * failed tool call and an MCP server's request log keep, how many SSE streams
   * the process holds, and what the public (unauthenticated) endpoints accept.
   * Each is clamped to a floor that keeps it usable; where a limit can be
   * switched off, `0` does it.
   */
  mcp: {
    /** Longest error message (chars) a failed tool call hands back to its caller. Min 256. */
    errorMessageMaxChars: number;
    /** Longest `lastError.message` (chars) stored on an MCP server record. Min 64. */
    lastErrorMaxChars: number;
    /** An identical `lastError` is not written again within this window (ms); 0 = write every time. */
    lastErrorThrottleMs: number;
    /** Longest tool name (chars) stored in an MCP request-log row. Min 16. */
    logToolNameMaxChars: number;
    /** Longest caller user-agent (chars) stored with an MCP request-log row. Min 16. */
    logUserAgentMaxChars: number;

    /** The SSE transport: `GET .../sse` opens a stream, `POST .../message?sessionId=` feeds it. */
    sse: {
      /** Open streams per process; 0 = no cap. Public streams stop at 75% of it so token callers keep room. */
      maxSessions: number;
      /** Open streams one client address may hold on the public endpoints; 0 = no cap. */
      maxSessionsPerIp: number;
      /** A stream that has received no message for this long (ms) is closed; 0 = never. */
      idleTimeoutMs: number;
      /** A stream whose unsent backlog exceeds this many bytes is closed; 0 = unbounded. */
      maxBufferedBytes: number;
      /** Interval (ms) of the comment frame that keeps an idle stream alive; 0 = none. */
      keepaliveMs: number;
    };

    /** Stdio (npx/uvx) servers run as subprocesses of this process, from one pool shared by all tenants. */
    stdio: {
      /** Subprocesses running at once, all tenants together. */
      maxConcurrent: number;
      /** Subprocesses one tenant may run at once; 0 = only `maxConcurrent` limits. Default: half the pool, at least 1. */
      maxConcurrentPerTenant: number;
    };

    /** `/api/public/mcp/...`, the endpoints of servers whose access mode is `public`. */
    public: {
      /** Requests per client address and endpoint per minute; 0 = no limit. */
      rateLimitPerMinute: number;
      /**
       * Requests per endpoint per minute from all callers together, whatever
       * address they appear to come from; 0 = no limit. Default: twenty times
       * `rateLimitPerMinute`.
       */
      endpointRateLimitPerMinute: number;
      /** Largest request body (bytes) a public POST may carry. Min 1024. */
      bodyLimitBytes: number;
      /** Tool calls one tenant may have running at once across its public endpoints; 0 = no limit. */
      maxInflightPerTenant: number;
      /** Largest request/response payload (bytes) a public call stores in the request log. Min 256. */
      logPayloadLimitBytes: number;
    };
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * The run-timing knobs, clamped to values that cannot wedge the system: a 0
 * heartbeat would spin a hot interval, a stale window at or below the
 * heartbeat would fail every live run as `worker_lost`, and a 0 sync timeout
 * would 504 every call before it starts.
 */
function boundedAgentRunConfig(source: ConfigSource) {
  const atLeast = (value: number, min: number) => (Number.isFinite(value) ? Math.max(value, min) : min);
  const runHeartbeatIntervalMs = atLeast(int(source, 'AGENT_RUN_HEARTBEAT_INTERVAL_MS', 15_000), 1_000);
  const runConcurrency = atLeast(int(source, 'AGENT_RUN_CONCURRENCY', 4), 1);
  return {
    runHeartbeatIntervalMs,
    runHeartbeatStaleMs: atLeast(int(source, 'AGENT_RUN_HEARTBEAT_STALE_MS', 45_000), runHeartbeatIntervalMs * 3),
    runConcurrency,
    runRequeueAfterMs: atLeast(int(source, 'AGENT_RUN_REQUEUE_AFTER_MS', 120_000), 10_000),
    runMaxActivePerTenant: atLeast(int(source, 'AGENT_RUN_MAX_ACTIVE_PER_TENANT', 250), 0),
    runMaxActivePerProject: atLeast(int(source, 'AGENT_RUN_MAX_ACTIVE_PER_PROJECT', 0), 0),
    deferredMaxRunningPerTenant: atLeast(int(source, 'AGENT_DEFERRED_MAX_RUNNING_PER_TENANT', 2), 1),
    deferredMaxQueuedPerTenant: atLeast(int(source, 'AGENT_DEFERRED_MAX_QUEUED_PER_TENANT', 10_000), 1),
    deferredConcurrency: atLeast(int(source, 'AGENT_DEFERRED_CONCURRENCY', Math.max(1, Math.floor(runConcurrency / 2))), 1),
    deferredMaxWaitMs: atLeast(int(source, 'AGENT_DEFERRED_MAX_WAIT_MS', 86_400_000), 60_000),
    runCallbackConcurrency: atLeast(int(source, 'AGENT_RUN_CALLBACK_CONCURRENCY', 4), 1),
    // Shutdown also has to stop servers and flush; the drain gets what is left after 3 s of that.
    runDrainTimeoutMs: Math.min(
      atLeast(int(source, 'AGENT_RUN_DRAIN_TIMEOUT_MS', 10_000), 0),
      atLeast(int(source, 'SHUTDOWN_TIMEOUT_MS', 15_000) - 3_000, 0),
    ),
    triggerTickMs: atLeast(int(source, 'AGENT_TRIGGER_TICK_MS', 30_000), 5_000),
    triggerMisfireGraceMs: atLeast(int(source, 'AGENT_TRIGGER_MISFIRE_GRACE_MS', 3_600_000), 0),
    chatConcurrency: atLeast(int(source, 'AGENT_CHAT_CONCURRENCY', 4), 1),
    webhooks: {
      bodyLimitBytes: Math.min(atLeast(int(source, 'AGENT_WEBHOOK_BODY_LIMIT_BYTES', 5_242_880), 16_384), 26_214_400),
      rateLimitPerMinute: atLeast(int(source, 'AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE', 60), 0),
    },
    reminders: {
      enabled: bool(source, 'AGENT_REMINDERS_ENABLED', true),
      minDelaySeconds: atLeast(int(source, 'AGENT_REMINDER_MIN_DELAY_SECONDS', 60), 30),
      // A scheduled run may start at most 30 days ahead.
      maxHorizonHours: Math.min(atLeast(int(source, 'AGENT_REMINDER_MAX_HORIZON_HOURS', 168), 1), 720),
      maxActivePerSession: atLeast(int(source, 'AGENT_REMINDER_MAX_ACTIVE_PER_SESSION', 10), 1),
      maxFiresPerSession: atLeast(int(source, 'AGENT_REMINDER_MAX_FIRES_PER_SESSION', 100), 1),
    },
  };
}

/**
 * The stdio subprocess pool and one tenant's share of it. The share defaults to
 * half the pool (at least 1) so that one tenant cannot hold every slot; an unset,
 * negative or unreadable value takes the default, and 0 leaves the pool as the
 * only limit.
 */
function stdioPoolConfig(source: ConfigSource) {
  const maxConcurrent = Math.max(int(source, 'MCP_STDIO_MAX_CONCURRENT', 8), 0);
  const share = int(source, 'MCP_STDIO_MAX_CONCURRENT_PER_TENANT', -1);
  return {
    maxConcurrent,
    maxConcurrentPerTenant: share >= 0 ? share : Math.max(Math.floor(maxConcurrent / 2), 1),
  };
}

/** The endpoint-wide request rate defaults to this many times the per-address one. */
const ENDPOINT_RATE_FACTOR = 20;

/**
 * The public MCP endpoints' request rates. The rate for an endpoint as a whole
 * defaults to twenty times the per-address one; an unset or negative value takes
 * that default, and 0 turns the endpoint-wide rate off on its own.
 */
function publicRateConfig(source: ConfigSource) {
  const rateLimitPerMinute = Math.max(int(source, 'MCP_PUBLIC_RATE_LIMIT_PER_MINUTE', 300), 0);
  const endpointRate = int(source, 'MCP_PUBLIC_ENDPOINT_RATE_LIMIT_PER_MINUTE', -1);
  return {
    rateLimitPerMinute,
    endpointRateLimitPerMinute: endpointRate >= 0 ? endpointRate : rateLimitPerMinute * ENDPOINT_RATE_FACTOR,
  };
}

function str(source: ConfigSource, key: string, fallback: string): string {
  return source.get(key) ?? fallback;
}

function int(source: ConfigSource, key: string, fallback: number): number {
  const raw = source.get(key);
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * A plain positive integer (digits only). Anything else, including zero, '1e5'
 * or '100,000', is treated as unset and falls back; `int` would read the last
 * two as 1 and 100.
 */
function positiveInt(source: ConfigSource, key: string, fallback: number): number {
  const raw = source.get(key)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

function bool(source: ConfigSource, key: string, fallback: boolean): boolean {
  const raw = source.get(key);
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function list(source: ConfigSource, key: string, fallback: string[]): string[] {
  const raw = source.get(key);
  if (!raw || raw.trim() === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Like `list`, split on `;` (for entries whose own value is a comma-separated list). */
function semicolonList(source: ConfigSource, key: string, fallback: string[]): string[] {
  const raw = source.get(key);
  if (!raw || raw.trim() === '') return fallback;
  return raw.split(';').map((s) => s.trim()).filter(Boolean);
}

function oneOf<T extends string>(
  source: ConfigSource,
  key: string,
  allowed: T[],
  fallback: T,
): T {
  const raw = source.get(key);
  if (raw && allowed.includes(raw as T)) return raw as T;
  return fallback;
}

const DEFAULT_APP_URL = 'http://localhost:3000';

function resolveAppUrl(source: ConfigSource): string {
  return source.get('APP_URL')?.trim()
    || source.get('NEXT_PUBLIC_APP_URL')?.trim()
    || DEFAULT_APP_URL;
}

function validateProductionAppUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'must be an absolute http(s) URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'must use the http or https protocol';
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || hostname === '0.0.0.0'
    || hostname.startsWith('127.')
  ) {
    return 'must not point to a loopback address';
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Config Builder                                                    */
/* ------------------------------------------------------------------ */

/** `WEBHOOK_RETRY_SCHEDULE_SECONDS`: positive integers, comma separated; unusable input keeps the default. */
const DEFAULT_WEBHOOK_RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400];
function webhookRetrySchedule(source: ConfigSource): number[] {
  const parsed = list(source, 'WEBHOOK_RETRY_SCHEDULE_SECONDS', [])
    .map((entry) => Number(entry))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
    .map((seconds) => Math.floor(seconds));
  return parsed.length > 0 ? parsed : DEFAULT_WEBHOOK_RETRY_SCHEDULE_SECONDS;
}

function buildConfig(source: ConfigSource): AppConfig {
  const nodeEnv = str(source, 'NODE_ENV', 'development');
  const databaseProvider = oneOf(source, 'DB_PROVIDER', ['mongodb', 'sqlite'], 'sqlite');
  const smtpUser = str(source, 'SMTP_USER', '');
  const smtpPass = str(source, 'SMTP_PASS', '');
  const sendGridApiKey = str(source, 'SENDGRID_API_KEY', '');
  const hasExplicitSmtpTransport = Boolean(
    source.get('SMTP_HOST') || smtpUser || smtpPass,
  );
  const useSendGrid = Boolean(sendGridApiKey && !hasExplicitSmtpTransport);
  // SQLite is the self-hosted default, so it decides the mode unless an operator says otherwise.
  const deploymentMode = oneOf(
    source,
    'DEPLOYMENT_MODE',
    ['saas', 'onprem'],
    databaseProvider === 'sqlite' ? 'onprem' : 'saas',
  );

  return {
    nodeEnv,

    deployment: {
      mode: deploymentMode,
      isOnPrem: deploymentMode === 'onprem',
    },

    services: {
      disabled: list(source, 'CONSOLE_DISABLED_SERVICES', []),
      enabled: list(source, 'CONSOLE_ENABLED_SERVICES', []),
    },

    license: {
      offlinePublicKey: str(source, 'OFFLINE_LICENSE_PUBLIC_KEY', ''),
      offlinePublicKeyPath: str(source, 'OFFLINE_LICENSE_PUBLIC_KEY_PATH', ''),
      issuer: str(source, 'OFFLINE_LICENSE_ISSUER', 'cognipeer'),
      audience: str(source, 'OFFLINE_LICENSE_AUDIENCE', 'cognipeer-console'),
      graceDays: int(source, 'LICENSE_GRACE_DAYS', 14),
    },

    storage: {
      dataDir: str(source, 'DATA_DIR', './data'),
    },

    pii: {
      nerModelPath: str(source, 'PII_NER_MODEL_PATH', ''),
      nerMaxConcurrent: int(source, 'PII_NER_MAX_CONCURRENT', 2),
    },

    database: {
      provider: databaseProvider,
      uri: str(source, 'MONGODB_URI', ''),
      mainDbName: str(source, 'MAIN_DB_NAME', 'console_main'),
      dataDir: str(source, 'SQLITE_DATA_DIR', './data'),
      minPoolSize: int(source, 'MONGODB_MIN_POOL_SIZE', 2),
      maxPoolSize: int(source, 'MONGODB_MAX_POOL_SIZE', 10),
      connectTimeoutMs: int(source, 'MONGODB_CONNECT_TIMEOUT_MS', 10000),
      socketTimeoutMs: int(source, 'MONGODB_SOCKET_TIMEOUT_MS', 45000),
      serverSelectionTimeoutMs: int(source, 'MONGODB_SERVER_SELECTION_TIMEOUT_MS', 30000),
      singleDatabase: bool(
        source,
        'MONGODB_SINGLE_DATABASE',
        deploymentMode === 'onprem' && databaseProvider === 'mongodb',
      ),
    },

    auth: {
      jwtSecret: str(source, 'JWT_SECRET', 'jwt-key-change-me'),
      jwtExpiresIn: str(source, 'JWT_EXPIRES_IN', '7d'),
      providerEncryptionSecret: str(source, 'PROVIDER_ENCRYPTION_SECRET', ''),
    },

    registration: {
      mode: oneOf(source, 'REGISTRATION_MODE', ['open', 'beta', 'disabled'], 'open'),
      bootstrapOrgName: str(source, 'BOOTSTRAP_ORG_NAME', ''),
      bootstrapAdminEmail: str(source, 'BOOTSTRAP_ADMIN_EMAIL', ''),
      bootstrapAdminPassword: str(source, 'BOOTSTRAP_ADMIN_PASSWORD', ''),
      bootstrapAdminName: str(source, 'BOOTSTRAP_ADMIN_NAME', 'Administrator'),
    },

    support: {
      baseUrl: str(source, 'SUPPORT_BASE_URL', '').replace(/\/$/, ''),
      crmApiUrl: str(source, 'SUPPORT_CRM_API_URL', '').replace(/\/$/, ''),
      handoffSecret: str(source, 'SUPPORT_HANDOFF_SECRET', ''),
    },

    smtp: {
      host: str(source, 'SMTP_HOST', useSendGrid ? 'smtp.sendgrid.net' : 'smtp.gmail.com'),
      port: int(source, 'SMTP_PORT', 587),
      secure: bool(source, 'SMTP_SECURE', false),
      user: smtpUser || (useSendGrid ? 'apikey' : ''),
      pass: smtpPass || (useSendGrid ? sendGridApiKey : ''),
      from: str(source, 'SMTP_FROM', '')
        || (useSendGrid ? str(source, 'SENDGRID_FROM_EMAIL', '') : smtpUser),
    },

    gateway: {
      requestTimeoutMs: int(source, 'GATEWAY_REQUEST_TIMEOUT_MS', 120000),
      retryEnabled: bool(source, 'GATEWAY_RETRY_ENABLED', true),
      retryMaxAttempts: int(source, 'GATEWAY_RETRY_MAX_ATTEMPTS', 3),
      retryInitialDelayMs: int(source, 'GATEWAY_RETRY_INITIAL_DELAY_MS', 200),
      circuitBreakerEnabled: bool(source, 'GATEWAY_CIRCUIT_BREAKER_ENABLED', true),
      circuitBreakerThreshold: int(source, 'GATEWAY_CIRCUIT_BREAKER_THRESHOLD', 5),
      circuitBreakerResetMs: int(source, 'GATEWAY_CIRCUIT_BREAKER_RESET_MS', 30000),
    },

    cache: {
      provider: oneOf(source, 'CACHE_PROVIDER', ['none', 'memory', 'redis'], 'memory'),
      ttlSeconds: int(source, 'CACHE_TTL_SECONDS', 300),
      redis: {
        url: str(source, 'REDIS_URL', ''),
        keyPrefix: str(source, 'REDIS_KEY_PREFIX', 'console:'),
      },
    },

    rateLimit: {
      provider: oneOf(source, 'RATE_LIMIT_PROVIDER', ['mongodb', 'memory', 'redis'], 'mongodb'),
      syncIntervalMs: int(source, 'RATE_LIMIT_SYNC_INTERVAL_MS', 5000),
      maxTrackedKeys: positiveInt(source, 'RATE_LIMIT_MAX_TRACKED_KEYS', 100_000),
    },

    quota: {
      policyCacheTtlSeconds: int(source, 'QUOTA_POLICY_CACHE_TTL_SECONDS', 30),
    },

    logging: {
      level: oneOf(source, 'LOG_LEVEL', ['error', 'warn', 'info', 'debug'], nodeEnv === 'production' ? 'info' : 'debug'),
      format: oneOf(source, 'LOG_FORMAT', ['json', 'pretty'], nodeEnv === 'production' ? 'json' : 'pretty'),
      logRequestBody: bool(source, 'LOG_REQUEST_BODY', false),
      logResponseBody: bool(source, 'LOG_RESPONSE_BODY', false),
    },

    cors: {
      enabled: bool(source, 'CORS_ENABLED', false),
      allowedOrigins: list(source, 'CORS_ALLOWED_ORIGINS', []),
      maxAge: int(source, 'CORS_MAX_AGE', 86400),
    },

    health: {
      endpointEnabled: bool(source, 'HEALTH_ENDPOINT_ENABLED', true),
      entityMetricsFlushMs: Math.max(int(source, 'ENTITY_METRICS_FLUSH_MS', 30_000), 1_000),
      entityMetricsRetentionDays: Math.max(int(source, 'ENTITY_METRICS_RETENTION_DAYS', 45), 1),
      entityMetricsMaxBufferedRows: Math.max(int(source, 'ENTITY_METRICS_MAX_BUFFERED_ROWS', 50_000), 100),
      entityMetricsMaxBufferedRowsPerTenant: Math.max(int(source, 'ENTITY_METRICS_MAX_BUFFERED_ROWS_PER_TENANT', 10_000), 100),
      tracingStaleSessionMinutes: Math.max(int(source, 'TRACING_STALE_SESSION_MINUTES', 360), 5),
      tracingFinalizerIntervalMs: Math.max(int(source, 'TRACING_FINALIZER_INTERVAL_MS', 300_000), 10_000),
      alertChannelTimeoutMs: Math.max(int(source, 'ALERT_CHANNEL_TIMEOUT_MS', 10_000), 1_000),
      defaultAlertRulesOnCreate: bool(source, 'ALERT_DEFAULT_RULES_ON_CREATE', true),
    },

    network: {
      trustedProxies: list(source, 'TRUSTED_PROXIES', []),
    },

    limits: {
      bodySize: str(source, 'NEXT_BODY_SIZE_LIMIT', '10mb'),
      tracingMaxBodySizeMb: int(source, 'TRACING_MAX_BODY_SIZE_MB', 10),
      fileUploadMaxMb: int(source, 'FILE_UPLOAD_MAX_MB', 50),
      // Empty list disables the allowlist (any MIME accepted). When non-empty,
      // only listed types are accepted. Wildcards like "image/*" are honored.
      fileUploadAllowedMimeTypes: list(source, 'FILE_UPLOAD_ALLOWED_MIME_TYPES', []),
    },

    app: {
      url: resolveAppUrl(source),
      shutdownTimeoutMs: int(source, 'SHUTDOWN_TIMEOUT_MS', 15000),
    },

    providerRuntime: {
      cacheTtlSeconds: int(source, 'PROVIDER_RUNTIME_CACHE_TTL_SECONDS', 300),
      disposeGraceSeconds: int(source, 'PROVIDER_RUNTIME_DISPOSE_GRACE_SECONDS', 300),
    },

    browser: {
      concurrencyProvider: oneOf(source, 'BROWSER_CONCURRENCY_PROVIDER', ['memory'] as const, 'memory'),
      defaultMaxConcurrent: int(source, 'BROWSER_DEFAULT_MAX_CONCURRENT', 10),
      defaultIdleTimeoutMs: int(source, 'BROWSER_DEFAULT_IDLE_TIMEOUT_MS', 5 * 60 * 1000),
      defaultMaxLifetimeMs: int(source, 'BROWSER_DEFAULT_MAX_LIFETIME_MS', 30 * 60 * 1000),
      defaultActionTimeoutMs: int(source, 'BROWSER_DEFAULT_ACTION_TIMEOUT_MS', 15 * 1000),
      defaultNavigationTimeoutMs: int(source, 'BROWSER_DEFAULT_NAVIGATION_TIMEOUT_MS', 30 * 1000),
      headless: bool(source, 'BROWSER_HEADLESS', true),
      viewportWidth: int(source, 'BROWSER_VIEWPORT_WIDTH', 1280),
      viewportHeight: int(source, 'BROWSER_VIEWPORT_HEIGHT', 800),
      reaperIntervalMs: int(source, 'BROWSER_REAPER_INTERVAL_MS', 30 * 1000),
      defaultArtifactBucketKey: str(source, 'BROWSER_DEFAULT_ARTIFACT_BUCKET', 'browser-artifacts'),
      blockPrivateNetwork: bool(source, 'BROWSER_BLOCK_PRIVATE_NETWORK', true),
      chromiumExtraArgs: list(source, 'BROWSER_CHROMIUM_EXTRA_ARGS', []),
      ignoreCertificateErrors: bool(source, 'BROWSER_IGNORE_CERTIFICATE_ERRORS', false),
    },

    outboundHttp: {
      blockPrivateNetwork: bool(source, 'OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK', true),
      allowedHosts: list(source, 'OUTBOUND_HTTP_ALLOWED_HOSTS', []),
      providerPrivateNetworks: semicolonList(source, 'PROVIDER_PRIVATE_NETWORKS', []),
      providerPrivateNetworksDeny: list(source, 'PROVIDER_PRIVATE_NETWORKS_DENY', []),
      defaultTimeoutMs: int(source, 'OUTBOUND_HTTP_DEFAULT_TIMEOUT_MS', 30_000),
    },

    systemModels: {
      openai: {
        apiKey: str(source, 'SYSTEM_OPENAI_API_KEY', ''),
        organizationId: str(source, 'SYSTEM_OPENAI_ORG_ID', ''),
      },
      bedrock: {
        accessKeyId: str(source, 'SYSTEM_BEDROCK_ACCESS_KEY_ID', ''),
        secretAccessKey: str(source, 'SYSTEM_BEDROCK_SECRET_ACCESS_KEY', ''),
        region: str(source, 'SYSTEM_BEDROCK_REGION', 'us-east-1'),
      },
      together: {
        apiKey: str(source, 'SYSTEM_TOGETHER_API_KEY', ''),
      },
      vertex: {
        projectId: str(source, 'SYSTEM_VERTEX_PROJECT_ID', ''),
        location: str(source, 'SYSTEM_VERTEX_LOCATION', 'us-central1'),
        serviceAccountKey: str(source, 'SYSTEM_VERTEX_SERVICE_ACCOUNT_KEY', ''),
      },
    },

    node: {
      role: oneOf(source, 'NODE_ROLE', ['main', 'worker', 'all'] as const, 'all'),
      name: str(source, 'NODE_NAME', ''),
      url: str(source, 'NODE_URL', ''),
      tags: list(source, 'NODE_TAGS', []),
      heartbeatMs: int(source, 'NODE_HEARTBEAT_MS', 10_000),
      offlineAfterMs: int(source, 'NODE_OFFLINE_AFTER_MS', 30_000),
      defaultNodeName: str(source, 'CLUSTER_DEFAULT_NODE_NAME', ''),
    },

    queue: {
      provider: oneOf(source, 'QUEUE_PROVIDER', ['auto', 'memory', 'bullmq'] as const, 'auto'),
      redis: {
        url: str(source, 'QUEUE_REDIS_URL', ''),
        prefix: str(source, 'QUEUE_PREFIX', 'console:q:'),
      },
      defaultAttempts: int(source, 'QUEUE_DEFAULT_ATTEMPTS', 3),
      defaultBackoffMs: int(source, 'QUEUE_DEFAULT_BACKOFF_MS', 1_000),
    },

    agent: {
      syncTimeoutMs: Math.max(int(source, 'AGENT_SYNC_TIMEOUT_MS', 600_000), 5_000),
      backgroundMaxDurationMs: Math.max(int(source, 'AGENT_BACKGROUND_MAX_DURATION_MS', 1_800_000), 10_000),
      runRetentionDays: Math.max(int(source, 'AGENT_RUN_RETENTION_DAYS', 30), 1),
      sessionEventRetentionDays: Math.max(int(source, 'AGENT_SESSION_EVENT_RETENTION_DAYS', 30), 1),
      ...boundedAgentRunConfig(source),
    },

    webhooks: {
      timeoutMs: Math.max(int(source, 'WEBHOOK_TIMEOUT_MS', 10_000), 1_000),
      concurrency: Math.max(int(source, 'WEBHOOK_CONCURRENCY', 8), 1),
      retryScheduleSeconds: webhookRetrySchedule(source),
      autoDisableHours: Math.max(int(source, 'WEBHOOK_AUTO_DISABLE_HOURS', 72), 1),
      deliveryRetentionDays: Math.max(int(source, 'WEBHOOK_DELIVERY_RETENTION_DAYS', 30), 1),
    },

    mcp: {
      errorMessageMaxChars: Math.max(int(source, 'MCP_ERROR_MESSAGE_MAX_CHARS', 8 * 1024), 256),
      lastErrorMaxChars: Math.max(int(source, 'MCP_LAST_ERROR_MAX_CHARS', 2 * 1024), 64),
      lastErrorThrottleMs: Math.max(int(source, 'MCP_LAST_ERROR_THROTTLE_MS', 60_000), 0),
      logToolNameMaxChars: Math.max(int(source, 'MCP_LOG_TOOL_NAME_MAX_CHARS', 200), 16),
      logUserAgentMaxChars: Math.max(int(source, 'MCP_LOG_USER_AGENT_MAX_CHARS', 300), 16),
      sse: {
        maxSessions: Math.max(int(source, 'MCP_SSE_MAX_SESSIONS', 2000), 0),
        maxSessionsPerIp: Math.max(int(source, 'MCP_SSE_MAX_SESSIONS_PER_IP', 50), 0),
        idleTimeoutMs: Math.max(int(source, 'MCP_SSE_IDLE_TIMEOUT_MS', 30 * 60 * 1000), 0),
        maxBufferedBytes: Math.max(int(source, 'MCP_SSE_MAX_BUFFERED_BYTES', 8 * 1024 * 1024), 0),
        keepaliveMs: Math.max(int(source, 'MCP_SSE_KEEPALIVE_MS', 25_000), 0),
      },
      stdio: stdioPoolConfig(source),
      public: {
        ...publicRateConfig(source),
        bodyLimitBytes: Math.max(int(source, 'MCP_PUBLIC_BODY_LIMIT_BYTES', 1024 * 1024), 1024),
        maxInflightPerTenant: Math.max(int(source, 'MCP_PUBLIC_MAX_INFLIGHT_PER_TENANT', 100), 0),
        logPayloadLimitBytes: Math.max(int(source, 'MCP_PUBLIC_LOG_PAYLOAD_LIMIT_BYTES', 16 * 1024), 256),
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

export interface ConfigValidationError {
  key: string;
  message: string;
}

/**
 * Validate critical config values.  Returns an array of problems.
 * An empty array means the config is valid.
 */
/**
 * Mirrors jose's own `secs()` duration grammar (the parser `SignJWT
 * .setExpirationTime` runs on a string), plus a bare number of seconds,
 * which jose accepts only as an actual number — so `JWT_EXPIRES_IN=604800`,
 * a perfectly reasonable thing for an operator to write, stays valid.
 * `token-manager.ts` normalizes it the same way.
 */
const JWT_DURATION_RE =
  /^(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)$/i;

export function isParsableJwtDuration(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^\d+$/.test(trimmed)) return true; // bare seconds
  return JWT_DURATION_RE.test(trimmed);
}

export function validateConfig(cfg: AppConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (cfg.database.provider === 'mongodb' && !cfg.database.uri) {
    errors.push({ key: 'MONGODB_URI', message: 'MongoDB connection string is required when DB_PROVIDER=mongodb' });
  }
  if (!cfg.auth.jwtSecret) {
    errors.push({ key: 'JWT_SECRET', message: 'JWT secret is required for authentication' });
  } else if (cfg.auth.jwtSecret.length < 32) {
    errors.push({
      key: 'JWT_SECRET',
      message: 'JWT_SECRET must be at least 32 characters (use a high-entropy random value)',
    });
  }
  // Checked at BOOT, not at first login: `generateToken` hands this string
  // straight to jose's duration parser now (it used to silently coerce
  // anything unrecognised to 7 days), so an unparseable value would
  // otherwise surface as every login failing at runtime rather than as a
  // config error the operator sees while starting the process.
  if (!isParsableJwtDuration(cfg.auth.jwtExpiresIn)) {
    errors.push({
      key: 'JWT_EXPIRES_IN',
      message:
        `JWT_EXPIRES_IN="${cfg.auth.jwtExpiresIn}" is not a duration this build can parse. `
        + 'Use a number of seconds ("604800") or a value with a unit ("30m", "12h", "7d", "2 weeks").',
    });
  }
  if (!cfg.auth.providerEncryptionSecret) {
    errors.push({
      key: 'PROVIDER_ENCRYPTION_SECRET',
      message: 'PROVIDER_ENCRYPTION_SECRET is required to encrypt provider credentials at rest',
    });
  } else if (cfg.auth.providerEncryptionSecret.length < 32) {
    errors.push({
      key: 'PROVIDER_ENCRYPTION_SECRET',
      message: 'PROVIDER_ENCRYPTION_SECRET must be at least 32 characters',
    });
  } else if (cfg.auth.providerEncryptionSecret === cfg.auth.jwtSecret) {
    errors.push({
      key: 'PROVIDER_ENCRYPTION_SECRET',
      message: 'PROVIDER_ENCRYPTION_SECRET must not equal JWT_SECRET (use independent secrets)',
    });
  }
  const bootstrapEnvs = [
    cfg.registration.bootstrapOrgName,
    cfg.registration.bootstrapAdminEmail,
    cfg.registration.bootstrapAdminPassword,
  ];
  if (bootstrapEnvs.some(Boolean) && !bootstrapEnvs.every(Boolean)) {
    errors.push({
      key: 'BOOTSTRAP_ORG_NAME',
      message:
        'BOOTSTRAP_ORG_NAME, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must all be set together to bootstrap an organization',
    });
  }
  if (cfg.cache.provider === 'redis' && !cfg.cache.redis.url) {
    errors.push({ key: 'REDIS_URL', message: 'Redis URL is required when CACHE_PROVIDER=redis' });
  }
  if (cfg.rateLimit.provider === 'redis' && !cfg.cache.redis.url) {
    errors.push({ key: 'REDIS_URL', message: 'Redis URL is required when RATE_LIMIT_PROVIDER=redis' });
  }
  if (
    (cfg.rateLimit.provider === 'redis' || cfg.rateLimit.provider === 'memory')
    && cfg.cache.provider !== cfg.rateLimit.provider
  ) {
    errors.push({
      key: 'CACHE_PROVIDER',
      message: `CACHE_PROVIDER must be ${cfg.rateLimit.provider} when RATE_LIMIT_PROVIDER=${cfg.rateLimit.provider}`,
    });
  }

  // Hard-fail if request/response body logging is enabled in production.
  // These flags expose secrets (auth headers, API keys, prompts) to logs.
  if (cfg.nodeEnv === 'production') {
    const appUrlError = validateProductionAppUrl(cfg.app.url);
    if (appUrlError) {
      errors.push({
        key: 'APP_URL',
        message:
          `APP_URL ${appUrlError} in production. Set APP_URL (preferred) or `
          + 'NEXT_PUBLIC_APP_URL (legacy) to the public Console origin.',
      });
    }
    if (cfg.logging.logRequestBody) {
      errors.push({
        key: 'LOG_REQUEST_BODY',
        message: 'LOG_REQUEST_BODY must be false in production (leaks secrets / PII into logs)',
      });
    }
    if (cfg.logging.logResponseBody) {
      errors.push({
        key: 'LOG_RESPONSE_BODY',
        message: 'LOG_RESPONSE_BODY must be false in production (leaks secrets / PII into logs)',
      });
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/*  Singleton                                                         */
/* ------------------------------------------------------------------ */

let currentSource: ConfigSource = new EnvConfigSource();
let cachedConfig: AppConfig | null = null;

/**
 * Replace the config source (e.g. switch from ENV to database-backed config).
 * Invalidates the cached config so the next getConfig() call rebuilds.
 */
export function setConfigSource(source: ConfigSource): void {
  currentSource = source;
  cachedConfig = null;
}

/**
 * Get the current config source (for diagnostics / testing).
 */
export function getConfigSource(): ConfigSource {
  return currentSource;
}

/**
 * Get the application configuration (built & cached on first call).
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = buildConfig(currentSource);
  }
  return cachedConfig;
}

/**
 * Force config reload (e.g. after ENV changes in tests).
 */
export function reloadConfig(): AppConfig {
  cachedConfig = null;
  return getConfig();
}
