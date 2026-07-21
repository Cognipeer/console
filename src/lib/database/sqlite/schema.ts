/**
 * SQLite Schema Definitions
 *
 * All table creation DDL for the SQLite provider.
 * Called once per database (main + each tenant).
 */

/** Tables used in the MAIN database (tenant metadata + user directory). */
export const MAIN_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    companyName TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    dbName TEXT NOT NULL,
    licenseType TEXT NOT NULL DEFAULT 'FREE',
    licenseId TEXT,
    licenseKey TEXT,
    licenseStatus TEXT NOT NULL DEFAULT 'free',
    licensePayload TEXT DEFAULT '{}',
    licenseActivatedAt TEXT,
    licenseLastVerifiedAt TEXT,
    licenseExpiresAt TEXT,
    licenseError TEXT,
    ownerId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    label TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    tokenPrefix TEXT NOT NULL,
    lastUsed TEXT,
    createdAt TEXT NOT NULL,
    expiresAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(tokenHash);
  CREATE INDEX IF NOT EXISTS idx_api_tokens_tenant_project ON api_tokens(tenantId, projectId);

  CREATE TABLE IF NOT EXISTS tenant_user_directory (
    email TEXT NOT NULL,
    tenantId TEXT NOT NULL,
    tenantSlug TEXT NOT NULL,
    tenantDbName TEXT NOT NULL,
    tenantCompanyName TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (email, tenantId)
  );

  -- Cluster node registry (system-wide)
  CREATE TABLE IF NOT EXISTS nodes (
    name TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    url TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    lastHeartbeatAt TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    version TEXT,
    hostname TEXT,
    pid INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
  CREATE INDEX IF NOT EXISTS idx_nodes_heartbeat ON nodes(lastHeartbeatAt);

  -- Instance → node assignments (system-wide; covers all tenants' instances)
  CREATE TABLE IF NOT EXISTS instance_assignments (
    entityType TEXT NOT NULL,
    entityId TEXT NOT NULL,
    nodeName TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'strict',
    updatedAt TEXT NOT NULL,
    updatedBy TEXT,
    PRIMARY KEY (entityType, entityId)
  );
  CREATE INDEX IF NOT EXISTS idx_instance_assignments_node ON instance_assignments(nodeName);

  -- Beta access codes gating public signup (system-wide)
  CREATE TABLE IF NOT EXISTS beta_access_codes (
    code TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    note TEXT,
    usedByEmail TEXT,
    usedAt TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_beta_access_codes_status ON beta_access_codes(status);
`;

/**
 * OCR jobs (persistent container + per-file items). Exported separately so the
 * boot migration can drop+recreate these tables when an older v1 schema is
 * detected (the v1 layout had incompatible NOT NULL columns).
 */
export const OCR_TENANT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ocr_jobs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    name TEXT,
    status TEXT NOT NULL,
    bucketKey TEXT NOT NULL,
    prefix TEXT,
    ocrModelKey TEXT NOT NULL,
    llmModelKey TEXT,
    outputs TEXT NOT NULL,
    summaryPrompt TEXT,
    structuredSchema TEXT,
    language TEXT,
    features TEXT,
    pdfMaxPages INTEGER,
    callbackUrl TEXT,
    callbackSecret TEXT,
    callbackEvents TEXT,
    itemsTotal INTEGER NOT NULL DEFAULT 0,
    itemsProcessed INTEGER NOT NULL DEFAULT 0,
    itemsFailed INTEGER NOT NULL DEFAULT 0,
    usageInputTokens INTEGER NOT NULL DEFAULT 0,
    usageOutputTokens INTEGER NOT NULL DEFAULT 0,
    usageTotalTokens INTEGER NOT NULL DEFAULT 0,
    usagePages INTEGER NOT NULL DEFAULT 0,
    usageOcrTokens INTEGER NOT NULL DEFAULT 0,
    usageLlmTokens INTEGER NOT NULL DEFAULT 0,
    costOcr REAL NOT NULL DEFAULT 0,
    costLlm REAL NOT NULL DEFAULT 0,
    costTotal REAL NOT NULL DEFAULT 0,
    costCurrency TEXT,
    lastItemAt TEXT,
    metadata TEXT,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ocr_jobs_tenantId ON ocr_jobs(tenantId);
  CREATE INDEX IF NOT EXISTS idx_ocr_jobs_status ON ocr_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_ocr_jobs_createdAt ON ocr_jobs(createdAt DESC);

  CREATE TABLE IF NOT EXISTS ocr_job_items (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    jobId TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    fileName TEXT,
    status TEXT NOT NULL,
    result TEXT,
    usage TEXT,
    costTotal REAL,
    costCurrency TEXT,
    callbackStatus TEXT,
    errorMessage TEXT,
    startedAt TEXT,
    endedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ocr_job_items_jobId ON ocr_job_items(jobId);
  CREATE INDEX IF NOT EXISTS idx_ocr_job_items_jobId_index ON ocr_job_items(jobId, "index");
`;

/**
 * Batch API (OpenAI-compatible async bulk inference). One row per batch plus
 * one row per submitted request line.
 */
export const BATCH_TENANT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    endpoint TEXT NOT NULL,
    status TEXT NOT NULL,
    completionWindow TEXT,
    inputFile TEXT,
    outputFile TEXT,
    errorMessage TEXT,
    itemsTotal INTEGER NOT NULL DEFAULT 0,
    itemsSucceeded INTEGER NOT NULL DEFAULT 0,
    itemsFailed INTEGER NOT NULL DEFAULT 0,
    itemsCancelled INTEGER NOT NULL DEFAULT 0,
    usageInputTokens INTEGER NOT NULL DEFAULT 0,
    usageOutputTokens INTEGER NOT NULL DEFAULT 0,
    usageTotalTokens INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdBy TEXT NOT NULL,
    startedAt TEXT,
    completedAt TEXT,
    cancelledAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batch_jobs_tenantId ON batch_jobs(tenantId);
  CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_batch_jobs_createdAt ON batch_jobs(createdAt DESC);

  CREATE TABLE IF NOT EXISTS batch_job_items (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    batchId TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    customId TEXT,
    requestBody TEXT NOT NULL,
    status TEXT NOT NULL,
    responseStatusCode INTEGER,
    responseBody TEXT,
    errorMessage TEXT,
    usage TEXT,
    startedAt TEXT,
    endedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batch_job_items_batchId ON batch_job_items(batchId);
  CREATE INDEX IF NOT EXISTS idx_batch_job_items_batchId_index ON batch_job_items(batchId, "index");
  CREATE INDEX IF NOT EXISTS idx_batch_job_items_batchId_status ON batch_job_items(batchId, status);
`;

/** Realtime API: named realtime models + per-connection session logs. */
export const REALTIME_TENANT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS realtime_models (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    chatModelKey TEXT,
    agentKey TEXT,
    instructions TEXT,
    temperature REAL,
    maxOutputTokens INTEGER,
    sttModelKey TEXT,
    inputAudioFormat TEXT,
    ttsModelKey TEXT,
    voice TEXT,
    ttsFormat TEXT,
    turnSilenceMs INTEGER,
    turnSilenceThreshold REAL,
    greeting TEXT,
    toolStatusMessage TEXT,
    metadata TEXT,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_models_key ON realtime_models(tenantId, key);
  CREATE INDEX IF NOT EXISTS idx_realtime_models_tenantId ON realtime_models(tenantId);

  CREATE TABLE IF NOT EXISTS realtime_sessions (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    sessionId TEXT NOT NULL,
    realtimeModelKey TEXT,
    chatModelKey TEXT,
    transport TEXT NOT NULL,
    status TEXT NOT NULL,
    responseCount INTEGER NOT NULL DEFAULT 0,
    inputAudioSeconds REAL NOT NULL DEFAULT 0,
    usageInputTokens INTEGER NOT NULL DEFAULT 0,
    usageOutputTokens INTEGER NOT NULL DEFAULT 0,
    usageTotalTokens INTEGER NOT NULL DEFAULT 0,
    firstTokenLatencyMs INTEGER,
    errorMessage TEXT,
    clientInfo TEXT,
    startedAt TEXT NOT NULL,
    endedAt TEXT,
    durationMs INTEGER,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_realtime_sessions_tenantId ON realtime_sessions(tenantId);
  CREATE INDEX IF NOT EXISTS idx_realtime_sessions_startedAt ON realtime_sessions(startedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_realtime_sessions_modelKey ON realtime_sessions(tenantId, realtimeModelKey);
`;

/** Tables used in every TENANT database. */
export const TENANT_SCHEMA_SQL = `
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    emailLower TEXT NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    tenantId TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    projectIds TEXT DEFAULT '[]',
    servicePermissions TEXT DEFAULT '{}',
    licenseId TEXT NOT NULL DEFAULT 'FREE',
    features TEXT DEFAULT '[]',
    invitedBy TEXT,
    invitedAt TEXT,
    inviteAcceptedAt TEXT,
    mustChangePassword INTEGER DEFAULT 0,
    passwordChangedAt TEXT,
    authProvider TEXT NOT NULL DEFAULT 'local',
    externalId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_emailLower ON users(emailLower);

  -- General audit logs
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    requestId TEXT,
    actorType TEXT NOT NULL,
    actorUserId TEXT,
    actorEmail TEXT,
    actorRole TEXT,
    apiTokenId TEXT,
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    event TEXT NOT NULL,
    method TEXT,
    path TEXT,
    statusCode INTEGER,
    outcome TEXT NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    resourceType TEXT,
    resourceId TEXT,
    metadata TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_logs_createdAt ON audit_logs(createdAt);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_service ON audit_logs(service);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actorUserId);

  -- Projects
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_tenant_key ON projects(tenantId, key);

  -- API Tokens
  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    label TEXT NOT NULL,
    token TEXT,
    tokenHash TEXT,
    tokenPrefix TEXT,
    lastUsed TEXT,
    createdAt TEXT NOT NULL,
    expiresAt TEXT
  );

  -- Prompts
  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    template TEXT NOT NULL DEFAULT '',
    metadata TEXT DEFAULT '{}',
    currentVersion INTEGER,
    deployments TEXT DEFAULT '{}',
    deploymentHistory TEXT DEFAULT '[]',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompt_versions (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    promptId TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    template TEXT NOT NULL DEFAULT '',
    metadata TEXT DEFAULT '{}',
    comment TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompt_comments (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    promptId TEXT NOT NULL,
    versionId TEXT,
    version INTEGER,
    content TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    createdByName TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- Quota policies
  CREATE TABLE IF NOT EXISTS quota_policies (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    scope TEXT NOT NULL,
    scopeId TEXT,
    domain TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1,
    label TEXT,
    description TEXT,
    limits TEXT NOT NULL DEFAULT '{}',
    createdBy TEXT,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- Agent tracing
  CREATE TABLE IF NOT EXISTS agent_tracing_sessions (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL UNIQUE,
    traceId TEXT,
    rootSpanId TEXT,
    threadId TEXT,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    source TEXT,
    agent TEXT DEFAULT '{}',
    agentName TEXT,
    agentVersion TEXT,
    agentModel TEXT,
    config TEXT DEFAULT '{}',
    summary TEXT DEFAULT '{}',
    status TEXT,
    startedAt TEXT,
    endedAt TEXT,
    durationMs INTEGER,
    errors TEXT DEFAULT '[]',
    modelsUsed TEXT DEFAULT '[]',
    toolsUsed TEXT DEFAULT '[]',
    eventCounts TEXT DEFAULT '{}',
    totalEvents INTEGER DEFAULT 0,
    totalInputTokens INTEGER DEFAULT 0,
    totalOutputTokens INTEGER DEFAULT 0,
    totalCachedInputTokens INTEGER DEFAULT 0,
    totalBytesIn INTEGER DEFAULT 0,
    totalBytesOut INTEGER DEFAULT 0,
    totalRequestBytes INTEGER DEFAULT 0,
    totalResponseBytes INTEGER DEFAULT 0,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracing_sessions_sessionId ON agent_tracing_sessions(sessionId);
  CREATE INDEX IF NOT EXISTS idx_tracing_sessions_threadId ON agent_tracing_sessions(threadId);
  CREATE INDEX IF NOT EXISTS idx_tracing_sessions_project_startedAt ON agent_tracing_sessions(projectId, startedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_tracing_sessions_project_createdAt ON agent_tracing_sessions(projectId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_tracing_sessions_project_status_startedAt ON agent_tracing_sessions(projectId, status, startedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_tracing_sessions_project_agent_startedAt ON agent_tracing_sessions(projectId, agentName, startedAt DESC);

  CREATE TABLE IF NOT EXISTS agent_tracing_events (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    traceId TEXT,
    spanId TEXT,
    parentSpanId TEXT,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    eventId TEXT,
    type TEXT,
    label TEXT,
    sequence INTEGER,
    timestamp TEXT,
    status TEXT,
    actor TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    sections TEXT DEFAULT '[]',
    modelNames TEXT DEFAULT '[]',
    model TEXT,
    error TEXT DEFAULT '{}',
    durationMs INTEGER,
    actorName TEXT,
    actorRole TEXT,
    toolName TEXT,
    toolExecutionId TEXT,
    inputTokens INTEGER DEFAULT 0,
    outputTokens INTEGER DEFAULT 0,
    totalTokens INTEGER DEFAULT 0,
    cachedInputTokens INTEGER DEFAULT 0,
    bytesIn INTEGER DEFAULT 0,
    bytesOut INTEGER DEFAULT 0,
    requestBytes INTEGER DEFAULT 0,
    responseBytes INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracing_events_sessionId ON agent_tracing_events(sessionId);
  CREATE INDEX IF NOT EXISTS idx_tracing_events_session_eventId ON agent_tracing_events(sessionId, eventId);

  -- Models
  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    name TEXT NOT NULL,
    description TEXT,
    key TEXT NOT NULL,
    providerKey TEXT NOT NULL,
    providerDriver TEXT NOT NULL DEFAULT '',
    provider TEXT,
    category TEXT NOT NULL DEFAULT 'llm',
    modelId TEXT NOT NULL,
    isMultimodal INTEGER DEFAULT 0,
    supportsToolCalls INTEGER DEFAULT 0,
    settings TEXT DEFAULT '{}',
    pricing TEXT DEFAULT '{}',
    semanticCache TEXT,
    inputGuardrailKey TEXT,
    outputGuardrailKey TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_models_key ON models(key);

  -- Model usage logs
  CREATE TABLE IF NOT EXISTS model_usage_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    modelKey TEXT NOT NULL,
    modelId TEXT,
    requestId TEXT NOT NULL,
    route TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success',
    providerRequest TEXT DEFAULT '{}',
    providerResponse TEXT DEFAULT '{}',
    errorMessage TEXT,
    latencyMs INTEGER,
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    cachedInputTokens INTEGER DEFAULT 0,
    totalTokens INTEGER NOT NULL DEFAULT 0,
    toolCalls INTEGER DEFAULT 0,
    cacheHit INTEGER DEFAULT 0,
    pricingSnapshot TEXT,
    routing TEXT,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_model_usage_modelKey ON model_usage_logs(modelKey);
  CREATE INDEX IF NOT EXISTS idx_model_usage_createdAt ON model_usage_logs(createdAt);
  -- NOTE: idx_model_usage_user lives in applyTenantIndexes (base.ts), NOT here:
  -- it references userId, which legacy tenant DBs only gain via the
  -- ensureTableColumn migration that runs AFTER this schema script. Creating it
  -- here aborts the whole schema exec on pre-attribution DBs
  -- ("no such column: userId").

  -- Cross-service daily usage rollup — primary source for usage/spend reports.
  -- Dimension columns store '' (never NULL) when absent: SQLite treats NULLs
  -- as distinct in UNIQUE constraints, which would duplicate dimension rows.
  CREATE TABLE IF NOT EXISTS usage_daily (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT NOT NULL DEFAULT '',
    userId TEXT NOT NULL DEFAULT '',
    apiTokenId TEXT NOT NULL DEFAULT '',
    actorType TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    service TEXT NOT NULL,
    refKey TEXT NOT NULL DEFAULT '',
    day TEXT NOT NULL,
    dayDate TEXT,
    requests INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    cachedInputTokens INTEGER NOT NULL DEFAULT 0,
    totalTokens INTEGER NOT NULL DEFAULT 0,
    costUsd REAL NOT NULL DEFAULT 0,
    latencyMsSum INTEGER NOT NULL DEFAULT 0,
    latencyCount INTEGER NOT NULL DEFAULT 0,
    units TEXT,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_usage_daily_dims
    ON usage_daily(tenantId, projectId, userId, apiTokenId, source, service, refKey, day);
  CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(tenantId, day DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_daily_user_day ON usage_daily(tenantId, userId, day DESC);

  -- Vector indexes
  CREATE TABLE IF NOT EXISTS vector_indexes (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    providerKey TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    externalId TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    metric TEXT NOT NULL DEFAULT 'cosine',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- File buckets
  CREATE TABLE IF NOT EXISTS file_buckets (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    providerKey TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    prefix TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- Files
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    providerKey TEXT NOT NULL,
    bucketKey TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    contentType TEXT,
    checksum TEXT,
    etag TEXT,
    metadata TEXT DEFAULT '{}',
    markdownKey TEXT,
    markdownStatus TEXT NOT NULL DEFAULT 'pending',
    markdownError TEXT,
    markdownSize INTEGER,
    markdownContentType TEXT,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- Providers (unified)
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    projectIds TEXT DEFAULT '[]',
    key TEXT NOT NULL,
    type TEXT NOT NULL,
    driver TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    credentialsEnc TEXT NOT NULL DEFAULT '',
    settings TEXT DEFAULT '{}',
    capabilitiesOverride TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_providers_key ON providers(key);

  -- Inference servers
  CREATE TABLE IF NOT EXISTS inference_servers (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    baseUrl TEXT NOT NULL,
    apiKey TEXT,
    pollIntervalSeconds INTEGER NOT NULL DEFAULT 60,
    status TEXT NOT NULL DEFAULT 'active',
    lastPolledAt TEXT,
    lastError TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inference_server_metrics (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    serverKey TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    numRequestsRunning INTEGER,
    numRequestsWaiting INTEGER,
    gpuCacheUsagePercent REAL,
    cpuCacheUsagePercent REAL,
    promptTokensThroughput REAL,
    generationTokensThroughput REAL,
    timeToFirstTokenSeconds REAL,
    timePerOutputTokenSeconds REAL,
    e2eRequestLatencySeconds REAL,
    requestsPerSecond REAL,
    runningModels TEXT DEFAULT '[]',
    raw TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL
  );

  -- Guardrails
  CREATE TABLE IF NOT EXISTS guardrails (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'preset',
    target TEXT NOT NULL DEFAULT 'input',
    action TEXT NOT NULL DEFAULT 'block',
    enabled INTEGER NOT NULL DEFAULT 1,
    failMode TEXT NOT NULL DEFAULT 'open',
    modelKey TEXT,
    policy TEXT DEFAULT '{}',
    customPrompt TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS guardrail_evaluation_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    guardrailId TEXT NOT NULL,
    guardrailKey TEXT NOT NULL,
    guardrailName TEXT NOT NULL,
    guardrailType TEXT NOT NULL,
    target TEXT NOT NULL,
    action TEXT NOT NULL,
    passed INTEGER NOT NULL DEFAULT 1,
    findings TEXT DEFAULT '[]',
    inputText TEXT,
    latencyMs INTEGER,
    source TEXT,
    requestId TEXT,
    message TEXT,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_guardrail_eval_guardrailId ON guardrail_evaluation_logs(guardrailId);
  CREATE INDEX IF NOT EXISTS idx_guardrail_eval_createdAt ON guardrail_evaluation_logs(createdAt);

  CREATE TABLE IF NOT EXISTS guardrail_word_lists (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    language TEXT,
    words TEXT DEFAULT '[]',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_guardrail_word_lists_key ON guardrail_word_lists(key);

  -- Evaluation service (offline agent/model testing)
  CREATE TABLE IF NOT EXISTS evaluation_targets (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL DEFAULT 'model',
    agentKey TEXT,
    modelKey TEXT,
    external TEXT,
    defaultParams TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_targets_key ON evaluation_targets(key);

  CREATE TABLE IF NOT EXISTS evaluation_datasets (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    items TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_datasets_key ON evaluation_datasets(key);

  CREATE TABLE IF NOT EXISTS evaluation_suites (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    targetKey TEXT NOT NULL,
    datasetKey TEXT NOT NULL,
    scorers TEXT DEFAULT '[]',
    judgeModelKey TEXT,
    runConfig TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_suites_key ON evaluation_suites(key);

  CREATE TABLE IF NOT EXISTS evaluation_runs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    suiteKey TEXT NOT NULL,
    targetKey TEXT NOT NULL,
    datasetKey TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    mode TEXT NOT NULL DEFAULT 'sync',
    progress TEXT DEFAULT '{}',
    aggregate TEXT,
    items TEXT DEFAULT '[]',
    error TEXT,
    startedAt TEXT,
    finishedAt TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_eval_runs_suiteKey ON evaluation_runs(suiteKey);
  CREATE INDEX IF NOT EXISTS idx_eval_runs_createdAt ON evaluation_runs(createdAt);

  -- Red-team service (adversarial agent/model testing)
  CREATE TABLE IF NOT EXISTS redteam_campaigns (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    targetKind TEXT NOT NULL DEFAULT 'agent',
    agentKey TEXT,
    modelKey TEXT,
    probeKeys TEXT DEFAULT '[]',
    judgeModelKey TEXT,
    runConfig TEXT DEFAULT '{}',
    policy TEXT DEFAULT '{}',
    schedule TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_redteam_campaigns_key ON redteam_campaigns(key);

  CREATE TABLE IF NOT EXISTS redteam_runs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    campaignKey TEXT NOT NULL,
    targetKind TEXT NOT NULL DEFAULT 'agent',
    targetRef TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    mode TEXT NOT NULL DEFAULT 'async',
    progress TEXT DEFAULT '{}',
    aggregate TEXT,
    attempts TEXT DEFAULT '[]',
    error TEXT,
    startedAt TEXT,
    finishedAt TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_redteam_runs_campaignKey ON redteam_runs(campaignKey);
  CREATE INDEX IF NOT EXISTS idx_redteam_runs_createdAt ON redteam_runs(createdAt);

  CREATE TABLE IF NOT EXISTS redteam_custom_probes (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    family TEXT NOT NULL DEFAULT 'custom',
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    attempts TEXT DEFAULT '[]',
    detectors TEXT DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_redteam_custom_probes_key ON redteam_custom_probes(key);

  -- Analysis service (conversation field extraction, judge & accuracy)
  CREATE TABLE IF NOT EXISTS analysis_definitions (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    fieldSet TEXT DEFAULT '[]',
    extractionInstructions TEXT,
    modes TEXT DEFAULT '{}',
    extractionModelKey TEXT,
    judgeModelKey TEXT,
    runConfig TEXT DEFAULT '{}',
    schedule TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_defs_key ON analysis_definitions(key);

  CREATE TABLE IF NOT EXISTS analysis_conversations (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT,
    description TEXT,
    transcript TEXT DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'imported',
    tags TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    occurredAt TEXT,
    referenceFields TEXT,
    extractedFields TEXT,
    lastAnalyzedAt TEXT,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_convos_key ON analysis_conversations(key);
  CREATE INDEX IF NOT EXISTS idx_analysis_convos_createdAt ON analysis_conversations(createdAt);

  CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    definitionKey TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    mode TEXT NOT NULL DEFAULT 'sync',
    progress TEXT DEFAULT '{}',
    aggregate TEXT,
    items TEXT DEFAULT '[]',
    error TEXT,
    startedAt TEXT,
    finishedAt TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_analysis_runs_definitionKey ON analysis_runs(definitionKey);
  CREATE INDEX IF NOT EXISTS idx_analysis_runs_createdAt ON analysis_runs(createdAt);

  -- PII policies (standalone service)
  CREATE TABLE IF NOT EXISTS pii_policies (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    defaultAction TEXT NOT NULL DEFAULT 'detect',
    categories TEXT DEFAULT '{}',
    customPatterns TEXT DEFAULT '[]',
    languages TEXT DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pii_policies_tenant_project ON pii_policies(tenantId, projectId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pii_policies_key ON pii_policies(tenantId, projectId, key);

  -- Alert rules
  CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    module TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    metric TEXT NOT NULL,
    condition TEXT NOT NULL DEFAULT '{}',
    windowMinutes INTEGER NOT NULL DEFAULT 5,
    cooldownMinutes INTEGER NOT NULL DEFAULT 15,
    scope TEXT DEFAULT '{}',
    channels TEXT NOT NULL DEFAULT '[]',
    lastTriggeredAt TEXT,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alert_events (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    ruleId TEXT NOT NULL,
    ruleName TEXT NOT NULL,
    metric TEXT NOT NULL,
    threshold REAL NOT NULL,
    actualValue REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'fired',
    channels TEXT NOT NULL DEFAULT '[]',
    firedAt TEXT NOT NULL,
    resolvedAt TEXT,
    metadata TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    alertEventId TEXT NOT NULL,
    ruleId TEXT NOT NULL,
    ruleName TEXT NOT NULL,
    metric TEXT NOT NULL,
    threshold REAL NOT NULL,
    actualValue REAL NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    status TEXT NOT NULL DEFAULT 'open',
    assignedTo TEXT,
    notes TEXT NOT NULL DEFAULT '[]',
    firedAt TEXT NOT NULL,
    acknowledgedAt TEXT,
    resolvedAt TEXT,
    closedAt TEXT,
    resolvedBy TEXT,
    metadata TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- RAG modules
  CREATE TABLE IF NOT EXISTS rag_modules (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    embeddingModelKey TEXT NOT NULL,
    vectorProviderKey TEXT NOT NULL,
    vectorIndexKey TEXT NOT NULL,
    fileBucketKey TEXT,
    fileProviderKey TEXT,
    chunkConfig TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    rerankerKey TEXT,
    rerankerOversample INTEGER,
    totalDocuments INTEGER DEFAULT 0,
    totalChunks INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rag_documents (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    ragModuleKey TEXT NOT NULL,
    fileKey TEXT,
    fileName TEXT NOT NULL,
    contentType TEXT,
    size INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    chunkCount INTEGER DEFAULT 0,
    errorMessage TEXT,
    lastIndexedAt TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rag_chunks (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    ragModuleKey TEXT NOT NULL,
    documentId TEXT NOT NULL,
    chunkIndex INTEGER NOT NULL,
    vectorId TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rag_query_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    ragModuleKey TEXT NOT NULL,
    query TEXT NOT NULL,
    topK INTEGER NOT NULL,
    matchCount INTEGER NOT NULL DEFAULT 0,
    latencyMs INTEGER,
    metadata TEXT DEFAULT '{}',
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL
  );

  -- Rerankers (first-class service backed by configurable strategy + model)
  CREATE TABLE IF NOT EXISTS rerankers (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    strategy TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    totalRuns INTEGER NOT NULL DEFAULT 0,
    avgLatencyMs REAL,
    lastUsedAt TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rerankers_tenant_key ON rerankers(tenantId, key);

  CREATE TABLE IF NOT EXISTS reranker_run_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    rerankerKey TEXT NOT NULL,
    strategy TEXT NOT NULL,
    modelKey TEXT,
    query TEXT NOT NULL,
    inputCount INTEGER NOT NULL DEFAULT 0,
    outputCount INTEGER NOT NULL DEFAULT 0,
    latencyMs INTEGER,
    status TEXT NOT NULL DEFAULT 'success',
    errorMessage TEXT,
    source TEXT,
    ragModuleKey TEXT,
    metadata TEXT DEFAULT '{}',
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reranker_run_logs_key_createdAt ON reranker_run_logs(rerankerKey, createdAt DESC);

  -- Web search run logs (per Web Search instance = websearch provider record)
  CREATE TABLE IF NOT EXISTS websearch_run_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    searchKey TEXT NOT NULL,
    driver TEXT NOT NULL,
    query TEXT NOT NULL,
    resultCount INTEGER NOT NULL DEFAULT 0,
    latencyMs INTEGER,
    status TEXT NOT NULL DEFAULT 'success',
    errorMessage TEXT,
    source TEXT,
    answer TEXT,
    results TEXT,
    metadata TEXT DEFAULT '{}',
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_websearch_run_logs_key_createdAt ON websearch_run_logs(searchKey, createdAt DESC);

  -- Memory stores
  CREATE TABLE IF NOT EXISTS memory_stores (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    vectorProviderKey TEXT NOT NULL,
    vectorIndexKey TEXT NOT NULL,
    embeddingModelKey TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    memoryCount INTEGER NOT NULL DEFAULT 0,
    lastActivityAt TEXT,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    storeKey TEXT NOT NULL,
    content TEXT NOT NULL,
    contentHash TEXT NOT NULL,
    summary TEXT,
    scope TEXT NOT NULL DEFAULT 'global',
    scopeId TEXT,
    metadata TEXT DEFAULT '{}',
    tags TEXT DEFAULT '[]',
    source TEXT,
    importance REAL NOT NULL DEFAULT 0.5,
    accessCount INTEGER NOT NULL DEFAULT 0,
    lastAccessedAt TEXT,
    embeddingVersion TEXT NOT NULL DEFAULT '',
    vectorId TEXT NOT NULL DEFAULT '',
    expiresAt TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_items_storeKey ON memory_items(storeKey);
  CREATE INDEX IF NOT EXISTS idx_memory_items_hash ON memory_items(storeKey, contentHash);

  -- Agents
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    config TEXT DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    metadata TEXT DEFAULT '{}',
    publishedVersion INTEGER,
    latestVersion INTEGER,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_key ON agents(key);
  CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(projectId);

  -- Agent versions
  CREATE TABLE IF NOT EXISTS agent_versions (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    agentId TEXT NOT NULL,
    agentKey TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT DEFAULT '{}',
    changelog TEXT,
    publishedBy TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_versions_agent_ver ON agent_versions(agentId, version);
  CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agentId);

  -- Agent conversations
  CREATE TABLE IF NOT EXISTS agent_conversations (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    agentKey TEXT NOT NULL,
    title TEXT,
    messages TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_aconv_agent ON agent_conversations(agentKey);
  CREATE INDEX IF NOT EXISTS idx_aconv_project ON agent_conversations(projectId);

  -- Config groups
  CREATE TABLE IF NOT EXISTS config_groups (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    tags TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_config_groups_key ON config_groups(key);

  -- Config items (secret/configuration values within groups)
  CREATE TABLE IF NOT EXISTS config_items (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    groupId TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    value TEXT NOT NULL,
    valueType TEXT NOT NULL DEFAULT 'string',
    isSecret INTEGER NOT NULL DEFAULT 0,
    tags TEXT DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_config_items_key ON config_items(key);
  CREATE INDEX IF NOT EXISTS idx_config_items_groupId ON config_items(groupId);

  -- Config audit logs
  CREATE TABLE IF NOT EXISTS config_audit_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    configKey TEXT NOT NULL,
    action TEXT NOT NULL,
    previousValue TEXT,
    newValue TEXT,
    version INTEGER,
    performedBy TEXT NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    metadata TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_config_audit_configKey ON config_audit_logs(configKey);

  -- Vector counters (approximate counts per project)
  CREATE TABLE IF NOT EXISTS vector_counters (
    projectId TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );

  -- Rate limits
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    resetAt TEXT NOT NULL
  );

  -- Tools (unified tool system)
  CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    actions TEXT DEFAULT '[]',
    openApiSpec TEXT,
    upstreamBaseUrl TEXT,
    upstreamAuth TEXT DEFAULT '{}',
    mcpEndpoint TEXT,
    mcpTransport TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tools_key ON tools(key);
  CREATE INDEX IF NOT EXISTS idx_tools_type ON tools(type);

  -- Tool Request Logs
  CREATE TABLE IF NOT EXISTS tool_request_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    toolKey TEXT NOT NULL,
    actionKey TEXT NOT NULL,
    actionName TEXT NOT NULL,
    status TEXT NOT NULL,
    requestPayload TEXT DEFAULT '{}',
    responsePayload TEXT DEFAULT '{}',
    errorMessage TEXT,
    latencyMs INTEGER,
    callerType TEXT,
    callerTokenId TEXT,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tool_request_logs_toolKey ON tool_request_logs(toolKey);
  CREATE INDEX IF NOT EXISTS idx_tool_request_logs_createdAt ON tool_request_logs(createdAt);

  -- MCP Servers
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    sourceType TEXT NOT NULL DEFAULT 'openapi',
    openApiSpec TEXT,
    remoteConfig TEXT,
    stdioConfig TEXT,
    tools TEXT DEFAULT '[]',
    toolsDiscoveredAt TEXT,
    upstreamBaseUrl TEXT,
    upstreamAuth TEXT DEFAULT '{}',
    exposure TEXT,
    aegis TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    endpointSlug TEXT NOT NULL,
    totalRequests INTEGER DEFAULT 0,
    lastError TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_key ON mcp_servers(key);
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_slug ON mcp_servers(endpointSlug);

  -- MCP Request Logs
  CREATE TABLE IF NOT EXISTS mcp_request_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    serverKey TEXT NOT NULL,
    toolName TEXT NOT NULL,
    status TEXT NOT NULL,
    requestPayload TEXT DEFAULT '{}',
    responsePayload TEXT DEFAULT '{}',
    errorMessage TEXT,
    latencyMs INTEGER,
    callerTokenId TEXT,
    callerType TEXT,
    callerUserId TEXT,
    transport TEXT,
    sourceType TEXT,
    sessionId TEXT,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_request_logs_serverKey ON mcp_request_logs(serverKey);
  CREATE INDEX IF NOT EXISTS idx_mcp_request_logs_createdAt ON mcp_request_logs(createdAt);

  -- MCP Audit Logs
  CREATE TABLE IF NOT EXISTS mcp_audit_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    serverId TEXT,
    serverKey TEXT NOT NULL,
    action TEXT NOT NULL,
    changes TEXT,
    performedBy TEXT NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    metadata TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_serverKey ON mcp_audit_logs(serverKey);
  CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_createdAt ON mcp_audit_logs(createdAt);

  -- MCP Hubs (enterprise module: curated server catalogs)
  CREATE TABLE IF NOT EXISTS mcp_hubs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    serverKeys TEXT DEFAULT '[]',
    exposure TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    endpointSlug TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_hubs_key ON mcp_hubs(key);
  CREATE INDEX IF NOT EXISTS idx_mcp_hubs_slug ON mcp_hubs(endpointSlug);

  -- Vector migrations
  CREATE TABLE IF NOT EXISTS vector_migrations (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    sourceProviderKey TEXT NOT NULL,
    sourceIndexKey TEXT NOT NULL,
    sourceIndexName TEXT NOT NULL,
    destinationProviderKey TEXT NOT NULL,
    destinationIndexKey TEXT NOT NULL,
    destinationIndexName TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    totalVectors INTEGER NOT NULL DEFAULT 0,
    migratedVectors INTEGER NOT NULL DEFAULT 0,
    failedVectors INTEGER NOT NULL DEFAULT 0,
    batchSize INTEGER NOT NULL DEFAULT 100,
    errorMessage TEXT,
    startedAt TEXT,
    completedAt TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_migrations_key ON vector_migrations(key);
  CREATE INDEX IF NOT EXISTS idx_vector_migrations_tenantId ON vector_migrations(tenantId);
  CREATE INDEX IF NOT EXISTS idx_vector_migrations_status ON vector_migrations(status);

  -- Vector migration logs
  CREATE TABLE IF NOT EXISTS vector_migration_logs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    migrationKey TEXT NOT NULL,
    batchIndex INTEGER NOT NULL,
    vectorIds TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    migratedCount INTEGER NOT NULL DEFAULT 0,
    failedCount INTEGER NOT NULL DEFAULT 0,
    errorMessage TEXT,
    durationMs INTEGER,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vml_migrationKey ON vector_migration_logs(migrationKey);
  CREATE INDEX IF NOT EXISTS idx_vml_status ON vector_migration_logs(status);

  -- Browsers (parent profiles)
  CREATE TABLE IF NOT EXISTS browsers (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    artifactBucketKey TEXT,
    defaultSessionConfig TEXT DEFAULT '{}',
    defaultModelKey TEXT,
    defaultRunOptions TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_browsers_tenantId ON browsers(tenantId);
  CREATE INDEX IF NOT EXISTS idx_browsers_projectId ON browsers(projectId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_browsers_tenant_key ON browsers(tenantId, key);

  -- Browser sessions
  CREATE TABLE IF NOT EXISTS browser_sessions (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    browserId TEXT NOT NULL,
    sessionKey TEXT NOT NULL,
    name TEXT,
    agentId TEXT,
    agentKey TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    config TEXT NOT NULL DEFAULT '{}',
    currentUrl TEXT,
    pageTitle TEXT,
    lastActivityAt TEXT,
    lastScreenshot TEXT,
    artifactBucketKey TEXT,
    startedAt TEXT,
    endedAt TEXT,
    errorMessage TEXT,
    eventCount INTEGER NOT NULL DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_browser_sessions_tenantId ON browser_sessions(tenantId);
  CREATE INDEX IF NOT EXISTS idx_browser_sessions_browserId ON browser_sessions(browserId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_sessions_tenant_key ON browser_sessions(tenantId, sessionKey);

  -- Browser session events
  CREATE TABLE IF NOT EXISTS browser_session_events (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    sessionId TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    status TEXT,
    url TEXT,
    selector TEXT,
    ref TEXT,
    durationMs INTEGER,
    artifact TEXT,
    data TEXT,
    errorMessage TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_browser_session_events_sessionId ON browser_session_events(sessionId);
  CREATE INDEX IF NOT EXISTS idx_browser_session_events_seq ON browser_session_events(sessionId, sequence);

  -- Crawlers (parent profiles)
  CREATE TABLE IF NOT EXISTS crawlers (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    seeds TEXT NOT NULL DEFAULT '[]',
    engine TEXT NOT NULL DEFAULT 'auto',
    maxDepth INTEGER NOT NULL DEFAULT 1,
    maxPages INTEGER NOT NULL DEFAULT 0,
    autoCrawl INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL DEFAULT '{}',
    downloadableMimes TEXT DEFAULT '[]',
    http TEXT NOT NULL DEFAULT '{}',
    markdownOptions TEXT DEFAULT '{}',
    rag TEXT,
    webhook TEXT,
    schedule TEXT,
    metadata TEXT DEFAULT '{}',
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_crawlers_tenantId ON crawlers(tenantId);
  CREATE INDEX IF NOT EXISTS idx_crawlers_projectId ON crawlers(projectId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crawlers_tenant_key ON crawlers(tenantId, key);

  -- Crawl jobs
  CREATE TABLE IF NOT EXISTS crawl_jobs (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    crawlerKey TEXT,
    trigger TEXT NOT NULL,
    triggerActor TEXT NOT NULL,
    planSnapshot TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    startedAt TEXT,
    endedAt TEXT,
    durationMs INTEGER,
    pagesDiscovered INTEGER NOT NULL DEFAULT 0,
    pagesProcessed INTEGER NOT NULL DEFAULT 0,
    filesProcessed INTEGER NOT NULL DEFAULT 0,
    errorsCount INTEGER NOT NULL DEFAULT 0,
    limitReached INTEGER NOT NULL DEFAULT 0,
    cancelRequestedAt TEXT,
    callbackUrl TEXT,
    errorMessage TEXT,
    metadata TEXT DEFAULT '{}',
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_tenantId ON crawl_jobs(tenantId);
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_crawlerKey ON crawl_jobs(crawlerKey);
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status ON crawl_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_crawl_jobs_createdAt ON crawl_jobs(createdAt DESC);

  -- Crawl results
  CREATE TABLE IF NOT EXISTS crawl_results (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    jobId TEXT NOT NULL,
    crawlerKey TEXT,
    url TEXT NOT NULL,
    parentUrl TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    httpStatus INTEGER,
    contentType TEXT,
    title TEXT,
    description TEXT,
    bodyMarkdown TEXT,
    bytes INTEGER,
    ragDocumentId TEXT,
    ragStatus TEXT,
    errorMessage TEXT,
    fetchedAt TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_crawl_results_jobId ON crawl_results(jobId);
  CREATE INDEX IF NOT EXISTS idx_crawl_results_jobId_createdAt ON crawl_results(jobId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_crawl_results_tenant_url ON crawl_results(tenantId, url);

  ${OCR_TENANT_SCHEMA_SQL}

  ${BATCH_TENANT_SCHEMA_SQL}

  ${REALTIME_TENANT_SCHEMA_SQL}

  -- Project membership (replaces user.projectIds)
  CREATE TABLE IF NOT EXISTS user_projects (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    userId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    servicePermissions TEXT DEFAULT '{}',
    invitedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(tenantId, userId, projectId)
  );
  CREATE INDEX IF NOT EXISTS idx_user_projects_user ON user_projects(tenantId, userId);
  CREATE INDEX IF NOT EXISTS idx_user_projects_project ON user_projects(tenantId, projectId);

  -- Groups / Teams (tenant + project scoped access grants)
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    tenantRole TEXT,
    servicePermissions TEXT DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'local',
    externalId TEXT,
    createdBy TEXT NOT NULL,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups(tenantId);

  CREATE TABLE IF NOT EXISTS group_members (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    groupId TEXT NOT NULL,
    userId TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    source TEXT NOT NULL DEFAULT 'local',
    addedBy TEXT,
    createdAt TEXT NOT NULL,
    UNIQUE(tenantId, groupId, userId)
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(tenantId, groupId);
  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(tenantId, userId);

  CREATE TABLE IF NOT EXISTS group_projects (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    groupId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    servicePermissions TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(tenantId, groupId, projectId)
  );
  CREATE INDEX IF NOT EXISTS idx_group_projects_group ON group_projects(tenantId, groupId);
  CREATE INDEX IF NOT EXISTS idx_group_projects_project ON group_projects(tenantId, projectId);

  -- GPU fleet: hosts (one row per GPU machine connected to the console)
  CREATE TABLE IF NOT EXISTS gpu_hosts (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'self',
    status TEXT NOT NULL DEFAULT 'pending',
    accelerator TEXT NOT NULL DEFAULT 'cpu',
    gpuFramework TEXT NOT NULL DEFAULT 'none',
    serviceAddress TEXT,
    terminalEnabled INTEGER NOT NULL DEFAULT 0,
    agentTokenHash TEXT,
    agentTokenVersion INTEGER NOT NULL DEFAULT 1,
    registrationTokenHash TEXT,
    registrationTokenExpiresAt TEXT,
    inventory TEXT,
    labels TEXT NOT NULL DEFAULT '{}',
    lastHeartbeatAt TEXT,
    lastEventSequence INTEGER NOT NULL DEFAULT 0,
    agentVersion TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gpu_hosts_tenant ON gpu_hosts(tenantId);
  CREATE INDEX IF NOT EXISTS idx_gpu_hosts_status ON gpu_hosts(status);
  CREATE INDEX IF NOT EXISTS idx_gpu_hosts_regtoken ON gpu_hosts(registrationTokenHash);
  CREATE INDEX IF NOT EXISTS idx_gpu_hosts_agenttoken ON gpu_hosts(agentTokenHash);

  -- GPU fleet: slices (one row per schedulable GPU partition, MIG or full-card)
  CREATE TABLE IF NOT EXISTS gpu_slices (
    uuid TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    hostId TEXT NOT NULL,
    gpuUuid TEXT NOT NULL,
    migGiId INTEGER,
    migCiId INTEGER,
    kind TEXT NOT NULL,
    profile TEXT,
    memoryMiB INTEGER NOT NULL DEFAULT 0,
    -- JSON array of deployment ids bound to this slice. A slice may host
    -- more than one deployment at once (see gpu-fleet.mixin.ts).
    assignedDeploymentIds TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gpu_slices_host ON gpu_slices(hostId);

  -- GPU fleet: LLM deployments (Docker containers serving a model on a slice)
  CREATE TABLE IF NOT EXISTS llm_deployments (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    hostId TEXT NOT NULL,
    sliceUuid TEXT,
    name TEXT NOT NULL,
    runtime TEXT NOT NULL,
    image TEXT NOT NULL,
    modelName TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    port INTEGER NOT NULL,
    healthPath TEXT NOT NULL DEFAULT '/health',
    volumes TEXT NOT NULL DEFAULT '[]',
    restart TEXT NOT NULL DEFAULT 'unless-stopped',
    desiredState TEXT NOT NULL DEFAULT 'running',
    actualState TEXT NOT NULL DEFAULT 'pending',
    containerId TEXT,
    lastHealthyAt TEXT,
    lastError TEXT,
    inferenceServerKey TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_llm_deployments_tenant ON llm_deployments(tenantId);
  CREATE INDEX IF NOT EXISTS idx_llm_deployments_host ON llm_deployments(hostId);
  CREATE INDEX IF NOT EXISTS idx_llm_deployments_slice ON llm_deployments(sliceUuid);

  -- GPU fleet: pending commands queued for delivery via long-poll
  CREATE TABLE IF NOT EXISTS gpu_fleet_commands (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    hostId TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    lastError TEXT,
    issuedAt TEXT NOT NULL,
    deliveredAt TEXT,
    completedAt TEXT,
    resourceRef TEXT,
    createdBy TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gpu_fleet_commands_host_status ON gpu_fleet_commands(hostId, status, issuedAt);

  -- GPU fleet: model pools (load-balanced multi-host deployments)
  CREATE TABLE IF NOT EXISTS llm_pools (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    modelName TEXT NOT NULL,
    modelLibraryId TEXT,
    algorithm TEXT NOT NULL DEFAULT 'round-robin',
    status TEXT NOT NULL DEFAULT 'active',
    deploymentIds TEXT NOT NULL DEFAULT '[]',
    weights TEXT NOT NULL DEFAULT '{}',
    providerKey TEXT,
    modelKey TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(tenantId, key)
  );
  CREATE INDEX IF NOT EXISTS idx_llm_pools_tenant ON llm_pools(tenantId);

  -- GPU fleet: tenant-wide settings (single-row table). Holds the fleet
  -- registration token hash plus per-tenant defaults the UI exposes.
  CREATE TABLE IF NOT EXISTS gpu_fleet_settings (
    tenantId TEXT PRIMARY KEY,
    fleetTokenHash TEXT,
    fleetTokenRotatedAt TEXT,
    fleetTokenRotatedBy TEXT,
    agentDistributionMode TEXT NOT NULL DEFAULT 'console-served',
    agentDistributionExternalUrlTemplate TEXT,
    terminalSessionTtlSeconds INTEGER NOT NULL DEFAULT 1800,
    huggingFaceTokenEnc TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- GPU fleet: append-only event stream from agents
  CREATE TABLE IF NOT EXISTS gpu_fleet_events (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    hostId TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    occurredAt TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL,
    UNIQUE(hostId, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_gpu_fleet_events_host_seq ON gpu_fleet_events(hostId, sequence DESC);

  -- GPU fleet: periodic nvidia-smi readings per host GPU (history/charts).
  -- Rows are throttled at write time (not one per heartbeat) and pruned by
  -- a retention reconciler — see hostService.ts.
  CREATE TABLE IF NOT EXISTS gpu_host_metrics (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    hostId TEXT NOT NULL,
    gpuUuid TEXT NOT NULL,
    gpuIndex INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    utilizationGpuPercent REAL,
    utilizationMemoryPercent REAL,
    memoryUsedMiB REAL,
    memoryTotalMiB REAL,
    temperatureC REAL,
    powerDrawW REAL,
    powerLimitW REAL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gpu_host_metrics_host_gpu_time ON gpu_host_metrics(hostId, gpuUuid, timestamp DESC);

  -- ===== Agent Runtime Sandbox (independent of gpu fleet) =====
  CREATE TABLE IF NOT EXISTS sandbox_runners (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    labels TEXT,
    inventory TEXT,
    agentTokenHash TEXT,
    agentTokenVersion INTEGER NOT NULL DEFAULT 0,
    registrationTokenHash TEXT,
    registrationTokenExpiresAt TEXT,
    lastSeenAt TEXT,
    lastEventSequence INTEGER NOT NULL DEFAULT 0,
    terminalEnabled INTEGER NOT NULL DEFAULT 0,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_runners_tenant ON sandbox_runners(tenantId);
  CREATE INDEX IF NOT EXISTS idx_sandbox_runners_agenttoken ON sandbox_runners(agentTokenHash);

  CREATE TABLE IF NOT EXISTS sandbox_templates (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    baseImage TEXT NOT NULL,
    runtime TEXT NOT NULL,
    isolation TEXT NOT NULL,
    resources TEXT,
    env TEXT,
    entrypoint TEXT,
    toolboxPort INTEGER NOT NULL,
    previewPorts TEXT,
    volumeMounts TEXT,
    idleReapSeconds INTEGER,
    warmPoolSize INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_templates_tenant ON sandbox_templates(tenantId);

  CREATE TABLE IF NOT EXISTS sandbox_instances (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    templateId TEXT NOT NULL,
    runnerId TEXT,
    name TEXT NOT NULL,
    containerId TEXT,
    imageRef TEXT,
    desiredState TEXT NOT NULL,
    actualState TEXT NOT NULL,
    volumeId TEXT,
    toolboxPort INTEGER,
    previewPorts TEXT,
    isolation TEXT NOT NULL,
    env TEXT,
    persist INTEGER NOT NULL DEFAULT 0,
    blockNetwork INTEGER NOT NULL DEFAULT 0,
    previewEnabled INTEGER NOT NULL DEFAULT 1,
    previewPublic INTEGER NOT NULL DEFAULT 0,
    resources TEXT,
    warm INTEGER NOT NULL DEFAULT 0,
    warmKey TEXT,
    lastError TEXT,
    lastActivityAt TEXT,
    userId TEXT,
    apiTokenId TEXT,
    actorType TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_instances_tenant ON sandbox_instances(tenantId);
  CREATE INDEX IF NOT EXISTS idx_sandbox_instances_runner ON sandbox_instances(runnerId);

  CREATE TABLE IF NOT EXISTS sandbox_commands (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    runnerId TEXT NOT NULL,
    instanceId TEXT,
    kind TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lastError TEXT,
    issuedAt TEXT NOT NULL,
    deliveredAt TEXT,
    completedAt TEXT,
    createdBy TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_commands_runner ON sandbox_commands(runnerId, status, issuedAt);

  CREATE TABLE IF NOT EXISTS sandbox_events (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    runnerId TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    occurredAt TEXT NOT NULL,
    receivedAt TEXT NOT NULL,
    UNIQUE(runnerId, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_events_runner_seq ON sandbox_events(runnerId, sequence DESC);

  CREATE TABLE IF NOT EXISTS sandbox_volumes (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    container TEXT NOT NULL,
    prefix TEXT NOT NULL,
    bucketKey TEXT,
    sizeBytes INTEGER,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_volumes_tenant ON sandbox_volumes(tenantId);

  CREATE TABLE IF NOT EXISTS sandbox_snapshots (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT,
    instanceId TEXT,
    templateId TEXT,
    runnerId TEXT,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL,
    imageRef TEXT NOT NULL,
    storageProvider TEXT,
    storageContainer TEXT,
    storageKey TEXT,
    volumeId TEXT,
    blockNetwork INTEGER NOT NULL DEFAULT 0,
    resources TEXT,
    warmPoolSize INTEGER,
    sizeBytes INTEGER,
    status TEXT NOT NULL,
    lastError TEXT,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_snapshots_tenant ON sandbox_snapshots(tenantId);
  CREATE INDEX IF NOT EXISTS idx_sandbox_snapshots_instance ON sandbox_snapshots(instanceId);

  CREATE TABLE IF NOT EXISTS sandbox_settings (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    fleetTokenHash TEXT,
    terminalSessionTtlSeconds INTEGER NOT NULL DEFAULT 3600,
    defaultStorageProvider TEXT,
    defaultIsolation TEXT,
    idleReapSeconds INTEGER NOT NULL DEFAULT 1800,
    projectResourceDefaults TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sandbox_settings_tenant ON sandbox_settings(tenantId);
`;
