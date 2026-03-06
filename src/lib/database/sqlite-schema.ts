/**
 * SQLite Schema Definitions
 *
 * Table creation SQL for the main (shared) and tenant databases.
 * Dates are stored as ISO-8601 strings, JSON objects as TEXT.
 * IDs are UUIDs generated via crypto.randomUUID().
 */

/* ------------------------------------------------------------------ */
/*  Main (shared) database tables                                     */
/* ------------------------------------------------------------------ */

export const MAIN_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  companyName TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  dbName TEXT NOT NULL,
  licenseType TEXT NOT NULL DEFAULT 'FREE',
  ownerId TEXT,
  isDemo INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_user_directory (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tenantId TEXT NOT NULL,
  tenantSlug TEXT NOT NULL,
  tenantDbName TEXT NOT NULL,
  tenantCompanyName TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(email, tenantId)
);
`;

/* ------------------------------------------------------------------ */
/*  Tenant-specific database tables                                   */
/* ------------------------------------------------------------------ */

export const TENANT_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  emailLower TEXT,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  tenantId TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  projectIds TEXT DEFAULT '[]',
  licenseId TEXT NOT NULL,
  features TEXT DEFAULT '[]',
  invitedBy TEXT,
  invitedAt TEXT,
  inviteAcceptedAt TEXT,
  mustChangePassword INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(emailLower);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  tenantId TEXT NOT NULL,
  projectId TEXT,
  label TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  lastUsed TEXT,
  createdAt TEXT NOT NULL,
  expiresAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_token ON api_tokens(token);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(userId);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  createdBy TEXT NOT NULL,
  updatedBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(tenantId, key)
);

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

CREATE TABLE IF NOT EXISTS agent_tracing_sessions (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_ats_sessionId ON agent_tracing_sessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_ats_threadId ON agent_tracing_sessions(threadId);

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
  error TEXT,
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
CREATE INDEX IF NOT EXISTS idx_ate_sessionId ON agent_tracing_events(sessionId);

CREATE TABLE IF NOT EXISTS agent_tracing_threads (
  id TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  tenantId TEXT NOT NULL,
  projectId TEXT,
  sessionsCount INTEGER DEFAULT 0,
  agents TEXT DEFAULT '[]',
  statuses TEXT DEFAULT '[]',
  latestStatus TEXT DEFAULT 'unknown',
  startedAt TEXT,
  endedAt TEXT,
  totalEvents INTEGER DEFAULT 0,
  totalInputTokens INTEGER DEFAULT 0,
  totalOutputTokens INTEGER DEFAULT 0,
  totalDurationMs INTEGER DEFAULT 0,
  modelsUsed TEXT DEFAULT '[]',
  toolsUsed TEXT DEFAULT '[]',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_threadId ON agent_tracing_threads(threadId);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  projectId TEXT,
  name TEXT NOT NULL,
  description TEXT,
  key TEXT NOT NULL,
  providerKey TEXT NOT NULL,
  providerDriver TEXT NOT NULL,
  provider TEXT,
  category TEXT NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_models_key ON models(key);

CREATE TABLE IF NOT EXISTS model_usage_logs (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  projectId TEXT,
  modelKey TEXT NOT NULL,
  modelId TEXT,
  requestId TEXT NOT NULL,
  route TEXT NOT NULL,
  status TEXT NOT NULL,
  providerRequest TEXT DEFAULT '{}',
  providerResponse TEXT DEFAULT '{}',
  errorMessage TEXT,
  latencyMs INTEGER,
  inputTokens INTEGER DEFAULT 0,
  outputTokens INTEGER DEFAULT 0,
  cachedInputTokens INTEGER DEFAULT 0,
  totalTokens INTEGER DEFAULT 0,
  toolCalls INTEGER DEFAULT 0,
  cacheHit INTEGER DEFAULT 0,
  pricingSnapshot TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mul_modelKey ON model_usage_logs(modelKey);
CREATE INDEX IF NOT EXISTS idx_mul_createdAt ON model_usage_logs(createdAt);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_key ON prompts(key);

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
CREATE INDEX IF NOT EXISTS idx_pv_promptId ON prompt_versions(promptId);

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
CREATE INDEX IF NOT EXISTS idx_pc_promptId ON prompt_comments(promptId);

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
  credentialsEnc TEXT NOT NULL,
  settings TEXT DEFAULT '{}',
  capabilitiesOverride TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  createdBy TEXT NOT NULL,
  updatedBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_key ON providers(tenantId, key);

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

CREATE TABLE IF NOT EXISTS vector_counters (
  projectId TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

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
CREATE INDEX IF NOT EXISTS idx_ism_serverKey ON inference_server_metrics(serverKey);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  windowStart TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  resetAt TEXT NOT NULL,
  PRIMARY KEY (key, windowStart)
);

CREATE TABLE IF NOT EXISTS guardrails (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  projectId TEXT,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  modelKey TEXT,
  policy TEXT,
  customPrompt TEXT,
  metadata TEXT DEFAULT '{}',
  createdBy TEXT NOT NULL,
  updatedBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardrails_key ON guardrails(key);

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
CREATE INDEX IF NOT EXISTS idx_gel_guardrailId ON guardrail_evaluation_logs(guardrailId);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  module TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  metric TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT '{}',
  windowMinutes INTEGER NOT NULL,
  cooldownMinutes INTEGER NOT NULL,
  scope TEXT,
  channels TEXT DEFAULT '[]',
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
  channels TEXT DEFAULT '[]',
  firedAt TEXT NOT NULL,
  resolvedAt TEXT,
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ae_tenantId ON alert_events(tenantId);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_modules_key ON rag_modules(key);

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
  chunkCount INTEGER,
  errorMessage TEXT,
  lastIndexedAt TEXT,
  metadata TEXT DEFAULT '{}',
  createdBy TEXT NOT NULL,
  updatedBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rd_ragModuleKey ON rag_documents(ragModuleKey);

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
CREATE INDEX IF NOT EXISTS idx_rc_documentId ON rag_chunks(documentId);
CREATE INDEX IF NOT EXISTS idx_rc_vectorId ON rag_chunks(vectorId);

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
  memoryCount INTEGER DEFAULT 0,
  lastActivityAt TEXT,
  createdBy TEXT NOT NULL,
  updatedBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ms_key ON memory_stores(key);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  storeKey TEXT NOT NULL,
  content TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  summary TEXT,
  scope TEXT NOT NULL,
  scopeId TEXT,
  metadata TEXT DEFAULT '{}',
  tags TEXT DEFAULT '[]',
  source TEXT,
  importance REAL DEFAULT 0.5,
  accessCount INTEGER DEFAULT 0,
  lastAccessedAt TEXT,
  embeddingVersion TEXT NOT NULL,
  vectorId TEXT NOT NULL,
  expiresAt TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mi_storeKey ON memory_items(storeKey);
CREATE INDEX IF NOT EXISTS idx_mi_contentHash ON memory_items(storeKey, contentHash);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  config TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT DEFAULT '{}',
  createdBy TEXT NOT NULL,
  updatedBy TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_key ON agents(key);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(projectId);

CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  projectId TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS agent_conversations (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  projectId TEXT NOT NULL,
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
`;
