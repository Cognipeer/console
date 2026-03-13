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
    ownerId TEXT,
    isDemo INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

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
    licenseId TEXT NOT NULL DEFAULT 'FREE',
    features TEXT DEFAULT '[]',
    invitedBy TEXT,
    invitedAt TEXT,
    inviteAcceptedAt TEXT,
    mustChangePassword INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_emailLower ON users(emailLower);

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
    token TEXT NOT NULL UNIQUE,
    lastUsed TEXT,
    createdAt TEXT NOT NULL,
    expiresAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_token ON api_tokens(token);

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
    threadId TEXT,
    tenantId TEXT NOT NULL,
    projectId TEXT,
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
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracing_sessions_sessionId ON agent_tracing_sessions(sessionId);
  CREATE INDEX IF NOT EXISTS idx_tracing_sessions_threadId ON agent_tracing_sessions(threadId);

  CREATE TABLE IF NOT EXISTS agent_tracing_events (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
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
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_model_usage_modelKey ON model_usage_logs(modelKey);
  CREATE INDEX IF NOT EXISTS idx_model_usage_createdAt ON model_usage_logs(createdAt);

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
    target TEXT NOT NULL DEFAULT 'both',
    action TEXT NOT NULL DEFAULT 'block',
    enabled INTEGER NOT NULL DEFAULT 1,
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
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_guardrail_eval_guardrailId ON guardrail_evaluation_logs(guardrailId);
  CREATE INDEX IF NOT EXISTS idx_guardrail_eval_createdAt ON guardrail_evaluation_logs(createdAt);

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
    createdAt TEXT NOT NULL
  );

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
    openApiSpec TEXT NOT NULL,
    tools TEXT DEFAULT '[]',
    upstreamBaseUrl TEXT NOT NULL,
    upstreamAuth TEXT DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    endpointSlug TEXT NOT NULL,
    totalRequests INTEGER DEFAULT 0,
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
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_request_logs_serverKey ON mcp_request_logs(serverKey);
  CREATE INDEX IF NOT EXISTS idx_mcp_request_logs_createdAt ON mcp_request_logs(createdAt);

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
`;
