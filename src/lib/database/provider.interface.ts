/**
 * Database Provider Interface
 * This abstraction allows switching between different database providers (MongoDB, PostgreSQL, etc.)
 */

import type { ObjectId } from 'mongodb';
import type {
  QuotaDomain,
  QuotaLimits,
  QuotaPolicy,
  QuotaScope,
} from '@/lib/quota/types';

export interface ITenant {
  _id?: ObjectId | string;
  companyName: string;
  slug: string;
  dbName: string;
  licenseType: string;
  ownerId?: string;
  /** Marks this tenant as the read-only demo tenant. */
  isDemo?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IProject {
  _id?: ObjectId | string;
  tenantId: string;
  key: string;
  name: string;
  description?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type PromptEnvironment = 'dev' | 'staging' | 'prod';

export type PromptDeploymentAction = 'promote' | 'plan' | 'activate' | 'rollback';

export interface IPromptDeploymentState {
  environment: PromptEnvironment;
  versionId: string;
  version: number;
  rolloutStatus: 'planned' | 'active';
  rolloutStrategy: 'manual';
  rollbackVersionId?: string;
  rollbackVersion?: number;
  note?: string;
  updatedBy?: string;
  updatedAt?: Date;
}

export interface IPromptDeploymentEvent {
  id: string;
  environment: PromptEnvironment;
  action: PromptDeploymentAction;
  versionId: string;
  version: number;
  note?: string;
  createdBy?: string;
  createdAt?: Date;
}

export interface IPrompt {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  template: string;
  metadata?: Record<string, unknown>;
  currentVersionId?: string;
  currentVersion?: number;
  deployments?: Partial<Record<PromptEnvironment, IPromptDeploymentState>>;
  deploymentHistory?: IPromptDeploymentEvent[];
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPromptVersion {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  promptId: string;
  version: number;
  name: string;
  description?: string;
  template: string;
  metadata?: Record<string, unknown>;
  comment?: string;
  isLatest?: boolean;
  createdBy: string;
  createdAt?: Date;
}

export interface IPromptComment {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  promptId: string;
  versionId?: string; // If null, comment is on the prompt itself
  version?: number; // Denormalized for easy display
  content: string;
  createdBy: string;
  createdByName?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUser {
  _id?: ObjectId | string;
  email: string;
  emailLower?: string;
  password: string;
  name: string;
  tenantId: string;
  role: 'owner' | 'admin' | 'project_admin' | 'user';
  projectIds?: string[];
  licenseId: string;
  features?: string[];
  invitedBy?: string;
  invitedAt?: Date;
  inviteAcceptedAt?: Date;
  mustChangePassword?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IApiToken {
  _id?: ObjectId | string;
  userId: string;
  tenantId: string;
  projectId?: string;
  label: string;
  token: string;
  lastUsed?: Date;
  createdAt?: Date;
  expiresAt?: Date;
}

export interface ITenantUserDirectoryEntry {
  email: string;
  tenantId: string;
  tenantSlug: string;
  tenantDbName: string;
  tenantCompanyName: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTracingSession {
  _id?: ObjectId | string;
  sessionId: string;
  threadId?: string;
  tenantId: string;
  projectId?: string;
  agent?: Record<string, unknown>;
  agentName?: string;
  agentVersion?: string;
  agentModel?: string;
  config?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  status?: string;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  errors?: Array<Record<string, unknown>>;
  modelsUsed?: string[];
  toolsUsed?: string[];
  eventCounts?: Record<string, number>;
  totalEvents?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCachedInputTokens?: number;
  totalBytesIn?: number;
  totalBytesOut?: number;
  totalRequestBytes?: number;
  totalResponseBytes?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTracingEvent {
  _id?: ObjectId | string;
  sessionId: string;
  tenantId: string;
  projectId?: string;
  id?: string;
  type?: string;
  label?: string;
  sequence?: number;
  timestamp?: Date;
  status?: string;
  actor?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  sections?: Array<Record<string, unknown>>;
  modelNames?: string[];
  model?: string;
  error?: Record<string, unknown>;
  durationMs?: number;
  actorName?: string;
  actorRole?: string;
  toolName?: string;
  toolExecutionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  bytesIn?: number;
  bytesOut?: number;
  requestBytes?: number;
  responseBytes?: number;
  createdAt?: Date;
}

export type ModelCategory = 'llm' | 'embedding';

export type ModelProviderType =
  | 'openai'
  | 'openai-compatible'
  | 'bedrock'
  | 'vertex'
  | 'together';

export interface IModelPricing {
  currency?: string;
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M?: number;
}

export type ProviderDomain =
  | 'model'
  | 'embedding'
  | 'vector'
  | 'file'
  | 'datasource';

export interface IProviderRecordStatus {
  status: 'active' | 'disabled' | 'errored';
}

export interface IProviderRecord
  extends Partial<IProviderRecordStatus> {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  projectIds?: string[];
  key: string;
  type: ProviderDomain;
  driver: string;
  label: string;
  description?: string;
  status: NonNullable<IProviderRecordStatus['status']>;
  credentialsEnc: string;
  settings: Record<string, unknown>;
  capabilitiesOverride?: string[];
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IVectorIndexRecord {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  providerKey: string;
  key: string;
  name: string;
  externalId: string;
  dimension: number;
  metric: 'cosine' | 'dot' | 'euclidean';
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type FileMarkdownStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface IFileBucketRecord {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  providerKey: string;
  description?: string;
  status: 'active' | 'disabled';
  prefix?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IFileRecord {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  providerKey: string;
  bucketKey: string;
  key: string;
  name: string;
  size: number;
  contentType?: string;
  checksum?: string;
  etag?: string;
  metadata?: Record<string, unknown>;
  markdownKey?: string;
  markdownStatus: FileMarkdownStatus;
  markdownError?: string;
  markdownSize?: number;
  markdownContentType?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISemanticCacheConfig {
  enabled: boolean;
  vectorProviderKey: string;
  vectorIndexKey: string;
  embeddingModelKey: string;
  similarityThreshold: number;
  ttlSeconds: number;
  maxCacheSize?: number;
}

export interface IModel {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  name: string;
  description?: string;
  key: string;
  providerKey: string;
  providerDriver: string;
  provider?: ModelProviderType; // deprecated; retained for backwards compatibility
  category: ModelCategory;
  modelId: string;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  settings: Record<string, unknown>;
  pricing: IModelPricing;
  semanticCache?: ISemanticCacheConfig;
  inputGuardrailKey?: string;
  outputGuardrailKey?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IModelUsageCostSnapshot {
  currency: string;
  inputCost?: number;
  outputCost?: number;
  cachedCost?: number;
  totalCost?: number;
}

export interface IModelUsageLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  modelKey: string;
  modelId?: string;
  requestId: string;
  route: string;
  status: 'success' | 'error';
  providerRequest: Record<string, unknown>;
  providerResponse: Record<string, unknown>;
  errorMessage?: string;
  latencyMs?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  totalTokens: number;
  toolCalls?: number;
  cacheHit?: boolean;
  pricingSnapshot?: IModelPricing & IModelUsageCostSnapshot;
  createdAt?: Date;
}

export interface IModelUsageAggregate {
  modelKey: string;
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalTokens: number;
  totalToolCalls: number;
  cacheHits: number;
  cacheMisses: number;
  avgLatencyMs: number | null;
  costSummary?: IModelUsageCostSnapshot;
  timeseries?: Array<{
    period: string;
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    totalCost?: number;
    cacheHits?: number;
  }>;
}

export interface IQuotaPolicy
  extends Omit<QuotaPolicy, '_id' | 'createdAt' | 'updatedAt'> {
  _id?: ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
  projectId?: string;
  scope: QuotaScope;
  domain: QuotaDomain;
  limits: QuotaLimits;
}

export type InferenceServerType = 'vllm' | 'llamacpp';

export interface IInferenceServer {
  _id?: ObjectId | string;
  tenantId: string;
  key: string;
  name: string;
  type: InferenceServerType;
  baseUrl: string;
  apiKey?: string;
  pollIntervalSeconds: number;
  status: 'active' | 'disabled' | 'errored';
  lastPolledAt?: Date;
  lastError?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Guardrail types ────────────────────────────────────────────────────────

export type GuardrailType = 'preset' | 'custom';
export type GuardrailAction = 'block' | 'warn' | 'flag';
export type GuardrailTarget = 'input' | 'output' | 'both';

export interface IGuardrailPiiPolicy {
  enabled: boolean;
  action: GuardrailAction;
  categories: Record<string, boolean>;
}

export interface IGuardrailModerationPolicy {
  enabled: boolean;
  modelKey?: string;
  categories: Record<string, boolean>;
}

export interface IGuardrailPromptShieldPolicy {
  enabled: boolean;
  modelKey?: string;
  sensitivity: 'low' | 'balanced' | 'high';
}

export interface IGuardrailPresetPolicy {
  pii?: IGuardrailPiiPolicy;
  moderation?: IGuardrailModerationPolicy;
  promptShield?: IGuardrailPromptShieldPolicy;
}

export interface IGuardrail {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  type: GuardrailType;
  target: GuardrailTarget;
  action: GuardrailAction;
  enabled: boolean;
  modelKey?: string;
  // For preset guardrails
  policy?: IGuardrailPresetPolicy;
  // For custom prompt guardrails
  customPrompt?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IInferenceServerMetrics {
  _id?: ObjectId | string;
  tenantId: string;
  serverKey: string;
  timestamp: Date;
  numRequestsRunning?: number;
  numRequestsWaiting?: number;
  gpuCacheUsagePercent?: number;
  cpuCacheUsagePercent?: number;
  promptTokensThroughput?: number;
  generationTokensThroughput?: number;
  timeToFirstTokenSeconds?: number;
  timePerOutputTokenSeconds?: number;
  e2eRequestLatencySeconds?: number;
  requestsPerSecond?: number;
  runningModels?: string[];
  raw?: Record<string, unknown>;
  createdAt?: Date;
}

// ── RAG Module types ────────────────────────────────────────────────────

export type RagChunkStrategy = 'recursive_character' | 'token';

export interface IRagChunkConfig {
  strategy: RagChunkStrategy;
  /** Common */
  chunkSize: number;
  chunkOverlap: number;
  /** recursive_character specific */
  separators?: string[];
  /** token specific */
  encoding?: string;
}

export type RagDocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed';

export interface IRagModule {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  fileBucketKey?: string;
  fileProviderKey?: string;
  chunkConfig: IRagChunkConfig;
  status: 'active' | 'disabled';
  totalDocuments?: number;
  totalChunks?: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRagDocument {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  fileKey?: string;
  fileName: string;
  contentType?: string;
  size?: number;
  status: RagDocumentStatus;
  chunkCount?: number;
  errorMessage?: string;
  lastIndexedAt?: Date;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRagChunk {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  documentId: string;
  chunkIndex: number;
  vectorId: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface IRagQueryLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  query: string;
  topK: number;
  matchCount: number;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

// ── Alert types ─────────────────────────────────────────────────────────

export type AlertModule = 'models' | 'inference' | 'guardrails' | 'rag';

export type AlertMetric =
  // models
  | 'error_rate'
  | 'avg_latency_ms'
  | 'p95_latency_ms'
  | 'total_cost'
  | 'total_requests'
  // inference
  | 'gpu_cache_usage'
  | 'request_queue_depth'
  // guardrails
  | 'guardrail_fail_rate'
  | 'guardrail_avg_latency_ms'
  | 'guardrail_total_evaluations'
  // rag
  | 'rag_avg_latency_ms'
  | 'rag_total_queries'
  | 'rag_failed_documents';

export type AlertConditionOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq';

export interface IAlertCondition {
  operator: AlertConditionOperator;
  threshold: number;
}

export type IAlertChannel =
  | { type: 'email'; recipients: string[] };

export type AlertEventStatus = 'fired' | 'resolved' | 'acknowledged';

export interface IAlertRule {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  module: AlertModule;
  enabled: boolean;
  metric: AlertMetric;
  condition: IAlertCondition;
  windowMinutes: number;
  cooldownMinutes: number;
  scope?: {
    modelKey?: string;
    serverKey?: string;
    guardrailKey?: string;
    ragModuleKey?: string;
  };
  channels: IAlertChannel[];
  lastTriggeredAt?: Date;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAlertEvent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  threshold: number;
  actualValue: number;
  status: AlertEventStatus;
  channels: Array<{
    type: string;
    target: string;
    success: boolean;
    error?: string;
  }>;
  firedAt: Date;
  resolvedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface DatabaseProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Tenant operations (uses main/shared database)
  createTenant(
    tenant: Omit<ITenant, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ITenant>;
  findTenantBySlug(slug: string): Promise<ITenant | null>;
  findTenantById(id: string): Promise<ITenant | null>;
  listTenants(): Promise<ITenant[]>;
  updateTenant(id: string, data: Partial<ITenant>): Promise<ITenant | null>;

  // Switch to tenant-specific database
  switchToTenant(tenantDbName: string): Promise<void>;

  // Cross-tenant user directory (uses main/shared database)
  registerUserInDirectory(entry: ITenantUserDirectoryEntry): Promise<void>;
  unregisterUserFromDirectory(email: string, tenantId: string): Promise<void>;
  listTenantsForUser(email: string): Promise<ITenantUserDirectoryEntry[]>;

  // User operations (tenant-specific)
  findUserByEmail(email: string): Promise<IUser | null>;
  findUserById(id: string): Promise<IUser | null>;
  createUser(
    user: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IUser>;
  updateUser(id: string, data: Partial<IUser>): Promise<IUser | null>;
  deleteUser(id: string): Promise<boolean>;
  listUsers(): Promise<IUser[]>;

  // Project operations (tenant-specific)
  createProject(
    project: Omit<IProject, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IProject>;
  updateProject(
    id: string,
    data: Partial<Omit<IProject, 'tenantId' | 'key'>>,
  ): Promise<IProject | null>;
  deleteProject(id: string): Promise<boolean>;
  findProjectById(id: string): Promise<IProject | null>;
  findProjectByKey(tenantId: string, key: string): Promise<IProject | null>;
  listProjects(tenantId: string): Promise<IProject[]>;

  // One-time / best-effort migration helper
  assignProjectIdToLegacyRecords(tenantId: string, projectId: string): Promise<void>;

  // Quota policies (tenant-specific)
  createQuotaPolicy(
    policy: Omit<IQuotaPolicy, '_id'>,
  ): Promise<IQuotaPolicy>;
  listQuotaPolicies(tenantId: string, projectId?: string): Promise<IQuotaPolicy[]>;
  updateQuotaPolicy(
    id: string,
    tenantId: string,
    data: Partial<IQuotaPolicy>,
    projectId?: string,
  ): Promise<IQuotaPolicy | null>;
  deleteQuotaPolicy(id: string, tenantId: string, projectId?: string): Promise<boolean>;

  // API Token operations (tenant-specific)
  createApiToken(
    token: Omit<IApiToken, '_id' | 'createdAt'>,
  ): Promise<IApiToken>;
  listApiTokens(userId: string): Promise<IApiToken[]>;
  listTenantApiTokens(tenantId: string): Promise<IApiToken[]>;
  listProjectApiTokens(tenantId: string, projectId: string): Promise<IApiToken[]>;
  findApiTokenByToken(token: string): Promise<IApiToken | null>;
  deleteApiToken(id: string, userId: string): Promise<boolean>;
  deleteTenantApiToken(id: string, tenantId: string): Promise<boolean>;
  deleteProjectApiToken(id: string, tenantId: string, projectId: string): Promise<boolean>;
  updateTokenLastUsed(token: string): Promise<void>;

  // Agent Tracing Session operations (tenant-specific)
  createAgentTracingSession(
    session: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAgentTracingSession>;
  countAgentTracingDistinctAgents(projectId?: string): Promise<number>;
  agentTracingAgentExists(agentName: string, projectId?: string): Promise<boolean>;
  cleanupAgentTracingRetention(options: {
    projectId?: string;
    olderThan: Date;
    batchSize?: number;
  }): Promise<{ sessionsDeleted: number; eventsDeleted: number }>;
  updateAgentTracingSession(
    sessionId: string,
    data: Partial<IAgentTracingSession>,
    projectId?: string,
  ): Promise<IAgentTracingSession | null>;
  findAgentTracingSessionById(
    sessionId: string,
    projectId?: string,
  ): Promise<IAgentTracingSession | null>;
  listAgentTracingSessions(
    filters?: Record<string, unknown>,
    projectId?: string,
  ): Promise<{ sessions: IAgentTracingSession[]; total: number }>;
  listAgentTracingThreads(
    filters?: Record<string, unknown>,
    projectId?: string,
  ): Promise<{ threads: Array<Record<string, unknown>>; total: number }>;

  // Agent Tracing Event operations (tenant-specific)
  createAgentTracingEvent(
    event: Omit<IAgentTracingEvent, '_id' | 'createdAt'>,
  ): Promise<IAgentTracingEvent>;
  listAgentTracingEvents(
    sessionId: string,
    projectId?: string,
  ): Promise<IAgentTracingEvent[]>;
  deleteAgentTracingEvents(
    sessionId: string,
    projectId?: string,
  ): Promise<number>;

  // Model management (tenant-specific)
  createModel(
    model: Omit<IModel, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IModel>;
  updateModel(id: string, data: Partial<IModel>): Promise<IModel | null>;
  deleteModel(id: string): Promise<boolean>;
  listModels(filters?: {
    projectId?: string;
    category?: ModelCategory;
    provider?: ModelProviderType; // deprecated
    providerKey?: string;
    providerDriver?: string;
  }): Promise<IModel[]>;
  findModelById(id: string, projectId?: string): Promise<IModel | null>;
  findModelByKey(key: string, projectId?: string): Promise<IModel | null>;

  // Prompt management (tenant-specific)
  createPrompt(
    prompt: Omit<IPrompt, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IPrompt>;
  updatePrompt(id: string, data: Partial<IPrompt>): Promise<IPrompt | null>;
  deletePrompt(id: string): Promise<boolean>;
  listPrompts(filters?: { projectId?: string; search?: string }): Promise<IPrompt[]>;
  findPromptById(id: string, projectId?: string): Promise<IPrompt | null>;
  findPromptByKey(key: string, projectId?: string): Promise<IPrompt | null>;

  createPromptVersion(
    version: Omit<IPromptVersion, '_id' | 'createdAt'>,
  ): Promise<IPromptVersion>;
  listPromptVersions(
    promptId: string,
    projectId?: string,
  ): Promise<IPromptVersion[]>;
  findPromptVersionById(
    id: string,
    promptId?: string,
    projectId?: string,
  ): Promise<IPromptVersion | null>;
  deletePromptVersions(promptId: string, projectId?: string): Promise<number>;

  // Prompt comments (tenant-specific)
  createPromptComment(
    comment: Omit<IPromptComment, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IPromptComment>;
  listPromptComments(
    promptId: string,
    options?: { versionId?: string; projectId?: string },
  ): Promise<IPromptComment[]>;
  updatePromptComment(
    id: string,
    data: Partial<Pick<IPromptComment, 'content'>>,
  ): Promise<IPromptComment | null>;
  deletePromptComment(id: string): Promise<boolean>;
  deletePromptCommentsByPromptId(promptId: string): Promise<number>;

  // Model usage logging (tenant-specific)
  createModelUsageLog(
    log: Omit<IModelUsageLog, '_id' | 'createdAt'>,
  ): Promise<IModelUsageLog>;
  listModelUsageLogs(
    modelKey: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    projectId?: string,
  ): Promise<IModelUsageLog[]>;
  aggregateModelUsage(
    modelKey: string,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    projectId?: string,
  ): Promise<IModelUsageAggregate>;

  // Vector index operations (tenant-specific)
  createVectorIndex(
    index: Omit<IVectorIndexRecord, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IVectorIndexRecord>;
  updateVectorIndex(
    id: string,
    data: Partial<
      Omit<IVectorIndexRecord, 'tenantId' | 'providerKey' | 'key'>
    >,
  ): Promise<IVectorIndexRecord | null>;
  deleteVectorIndex(id: string): Promise<boolean>;
  listVectorIndexes(filters?: {
    providerKey?: string;
    projectId?: string;
    search?: string;
  }): Promise<IVectorIndexRecord[]>;
  findVectorIndexById(id: string): Promise<IVectorIndexRecord | null>;
  findVectorIndexByKey(
    providerKey: string,
    key: string,
    projectId?: string,
  ): Promise<IVectorIndexRecord | null>;
  findVectorIndexByExternalId(
    providerKey: string,
    externalId: string,
    projectId?: string,
  ): Promise<IVectorIndexRecord | null>;

  // File object operations (tenant-specific)
  createFileRecord(
    record: Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IFileRecord>;
  updateFileRecord(
    id: string,
    data: Partial<Omit<IFileRecord, 'tenantId' | 'providerKey' | 'key' | 'createdBy'>>,
  ): Promise<IFileRecord | null>;
  deleteFileRecord(id: string): Promise<boolean>;
  findFileRecordById(id: string): Promise<IFileRecord | null>;
  findFileRecordByKey(
    providerKey: string,
    bucketKey: string,
    key: string,
    projectId?: string,
  ): Promise<IFileRecord | null>;
  listFileRecords(filters: {
    providerKey: string;
    bucketKey: string;
    projectId?: string;
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: IFileRecord[]; nextCursor?: string }>;

  countFileRecords(filters?: {
    projectId?: string;
  }): Promise<number>;

  sumFileRecordBytes(filters?: { projectId?: string }): Promise<number>;

  getProjectVectorCountApprox(projectId: string): Promise<number>;
  incrementProjectVectorCountApprox(projectId: string, delta: number): Promise<number>;

  // File bucket operations (tenant-specific)
  createFileBucket(
    bucket: Omit<IFileBucketRecord, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IFileBucketRecord>;
  updateFileBucket(
    id: string,
    data: Partial<Omit<IFileBucketRecord, 'tenantId' | 'key' | 'providerKey'>>,
  ): Promise<IFileBucketRecord | null>;
  deleteFileBucket(id: string): Promise<boolean>;
  findFileBucketById(id: string): Promise<IFileBucketRecord | null>;
  findFileBucketByKey(
    tenantId: string,
    key: string,
    projectId?: string,
  ): Promise<IFileBucketRecord | null>;
  listFileBuckets(tenantId: string, projectId?: string): Promise<IFileBucketRecord[]>;

  // Shared provider registry (tenant-specific)
  createProvider(
    provider: Omit<IProviderRecord, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IProviderRecord>;
  updateProvider(
    id: string,
    data: Partial<Omit<IProviderRecord, 'tenantId' | 'key'>>,
  ): Promise<IProviderRecord | null>;
  findProviderById(id: string): Promise<IProviderRecord | null>;
  findProviderByKey(
    tenantId: string,
    key: string,
    projectId?: string,
  ): Promise<IProviderRecord | null>;
  listProviders(
    tenantId: string,
    filters?: {
      type?: ProviderDomain;
      driver?: string;
      status?: IProviderRecord['status'];
      projectId?: string;
    },
  ): Promise<IProviderRecord[]>;
  deleteProvider(id: string): Promise<boolean>;

  // Inference server operations (tenant-specific)
  createInferenceServer(
    server: Omit<IInferenceServer, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IInferenceServer>;
  updateInferenceServer(
    id: string,
    data: Partial<Omit<IInferenceServer, 'tenantId' | 'key'>>,
  ): Promise<IInferenceServer | null>;
  deleteInferenceServer(id: string): Promise<boolean>;
  findInferenceServerById(id: string): Promise<IInferenceServer | null>;
  findInferenceServerByKey(tenantId: string, key: string): Promise<IInferenceServer | null>;
  listInferenceServers(tenantId: string): Promise<IInferenceServer[]>;

  // Inference server metrics (tenant-specific)
  createInferenceServerMetrics(
    metrics: Omit<IInferenceServerMetrics, '_id' | 'createdAt'>,
  ): Promise<IInferenceServerMetrics>;
  listInferenceServerMetrics(
    serverKey: string,
    options?: { from?: Date; to?: Date; limit?: number },
  ): Promise<IInferenceServerMetrics[]>;
  deleteInferenceServerMetrics(serverKey: string): Promise<number>;

  // Rate limiting
  incrementRateLimit(
    key: string,
    windowSeconds: number,
    amount: number,
  ): Promise<{ count: number; resetAt: Date }>;

  // Guardrail operations (tenant-specific)
  createGuardrail(
    guardrail: Omit<IGuardrail, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IGuardrail>;
  updateGuardrail(
    id: string,
    data: Partial<Omit<IGuardrail, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IGuardrail | null>;
  deleteGuardrail(id: string): Promise<boolean>;
  findGuardrailById(id: string): Promise<IGuardrail | null>;
  findGuardrailByKey(key: string, projectId?: string): Promise<IGuardrail | null>;
  listGuardrails(filters?: {
    projectId?: string;
    type?: GuardrailType;
    enabled?: boolean;
    search?: string;
  }): Promise<IGuardrail[]>;

  // ── Guardrail evaluation logs ──
  listGuardrailEvaluationLogs(
    guardrailId: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date; passed?: boolean },
  ): Promise<IGuardrailEvaluationLog[]>;
  aggregateGuardrailEvaluations(
    guardrailId: string,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
  ): Promise<IGuardrailEvalAggregate>;

  // ── Alert rule operations (tenant-specific) ──
  createAlertRule(
    rule: Omit<IAlertRule, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAlertRule>;
  updateAlertRule(
    id: string,
    data: Partial<Omit<IAlertRule, 'tenantId' | 'createdBy'>>,
  ): Promise<IAlertRule | null>;
  deleteAlertRule(id: string): Promise<boolean>;
  findAlertRuleById(id: string): Promise<IAlertRule | null>;
  listAlertRules(
    tenantId: string,
    filters?: { projectId?: string; enabled?: boolean },
  ): Promise<IAlertRule[]>;

  // ── Alert event (history) operations (tenant-specific) ──
  createAlertEvent(
    event: Omit<IAlertEvent, '_id'>,
  ): Promise<IAlertEvent>;
  listAlertEvents(
    tenantId: string,
    options?: {
      projectId?: string;
      ruleId?: string;
      status?: AlertEventStatus;
      limit?: number;
      skip?: number;
    },
  ): Promise<IAlertEvent[]>;
  updateAlertEvent(
    id: string,
    data: Partial<IAlertEvent>,
  ): Promise<IAlertEvent | null>;
  countActiveAlerts(tenantId: string, projectId?: string): Promise<number>;

  // ── RAG Module operations (tenant-specific) ──
  createRagModule(
    ragModule: Omit<IRagModule, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IRagModule>;
  updateRagModule(
    id: string,
    data: Partial<Omit<IRagModule, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IRagModule | null>;
  deleteRagModule(id: string): Promise<boolean>;
  findRagModuleById(id: string): Promise<IRagModule | null>;
  findRagModuleByKey(key: string, projectId?: string): Promise<IRagModule | null>;
  listRagModules(filters?: {
    projectId?: string;
    status?: IRagModule['status'];
    search?: string;
  }): Promise<IRagModule[]>;

  // ── RAG Document operations (tenant-specific) ──
  createRagDocument(
    doc: Omit<IRagDocument, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IRagDocument>;
  updateRagDocument(
    id: string,
    data: Partial<Omit<IRagDocument, 'tenantId' | 'ragModuleKey' | 'createdBy'>>,
  ): Promise<IRagDocument | null>;
  deleteRagDocument(id: string): Promise<boolean>;
  findRagDocumentById(id: string): Promise<IRagDocument | null>;
  listRagDocuments(
    ragModuleKey: string,
    filters?: { projectId?: string; status?: RagDocumentStatus; search?: string },
  ): Promise<IRagDocument[]>;
  countRagDocuments(ragModuleKey: string, projectId?: string): Promise<number>;

  // ── RAG Chunk operations (tenant-specific) ──
  bulkInsertRagChunks(
    chunks: Omit<IRagChunk, '_id' | 'createdAt'>[],
  ): Promise<void>;
  findRagChunksByVectorIds(vectorIds: string[]): Promise<IRagChunk[]>;
  findRagChunksByDocumentId(documentId: string): Promise<IRagChunk[]>;
  deleteRagChunksByDocumentId(documentId: string): Promise<number>;

  // ── RAG Query Log operations (tenant-specific) ──
  createRagQueryLog(
    log: Omit<IRagQueryLog, '_id' | 'createdAt'>,
  ): Promise<IRagQueryLog>;
  listRagQueryLogs(
    ragModuleKey: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date },
  ): Promise<IRagQueryLog[]>;

  // ── Memory Store operations (tenant-specific) ──
  createMemoryStore(
    store: Omit<IMemoryStore, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IMemoryStore>;
  updateMemoryStore(
    id: string,
    data: Partial<Omit<IMemoryStore, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IMemoryStore | null>;
  deleteMemoryStore(id: string): Promise<boolean>;
  findMemoryStoreById(id: string): Promise<IMemoryStore | null>;
  findMemoryStoreByKey(key: string, projectId?: string): Promise<IMemoryStore | null>;
  listMemoryStores(filters?: {
    projectId?: string;
    status?: MemoryStoreStatus;
    search?: string;
  }): Promise<IMemoryStore[]>;
  countMemoryStores(projectId?: string): Promise<number>;

  // ── Memory Item operations (tenant-specific) ──
  createMemoryItem(
    item: Omit<IMemoryItem, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IMemoryItem>;
  updateMemoryItem(
    id: string,
    data: Partial<Omit<IMemoryItem, 'tenantId' | 'storeKey'>>,
  ): Promise<IMemoryItem | null>;
  deleteMemoryItem(id: string): Promise<boolean>;
  deleteMemoryItems(
    storeKey: string,
    filter?: { scope?: MemoryScope; scopeId?: string; tags?: string[]; before?: Date },
  ): Promise<number>;
  findMemoryItemById(id: string): Promise<IMemoryItem | null>;
  findMemoryItemByHash(storeKey: string, contentHash: string): Promise<IMemoryItem | null>;
  listMemoryItems(
    storeKey: string,
    filters?: {
      projectId?: string;
      scope?: MemoryScope;
      scopeId?: string;
      tags?: string[];
      status?: MemoryItemStatus;
      search?: string;
      limit?: number;
      skip?: number;
    },
  ): Promise<{ items: IMemoryItem[]; total: number }>;
  countMemoryItems(storeKey: string, projectId?: string): Promise<number>;
  incrementMemoryAccess(id: string): Promise<void>;

  // ── Config (Secret/Configuration Management) operations (tenant-specific) ──

  // Config Group operations
  createConfigGroup(
    group: Omit<IConfigGroup, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IConfigGroup>;
  updateConfigGroup(
    id: string,
    data: Partial<Omit<IConfigGroup, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IConfigGroup | null>;
  deleteConfigGroup(id: string): Promise<boolean>;
  findConfigGroupById(id: string): Promise<IConfigGroup | null>;
  findConfigGroupByKey(key: string, projectId?: string): Promise<IConfigGroup | null>;
  listConfigGroups(filters?: {
    projectId?: string;
    tags?: string[];
    search?: string;
  }): Promise<IConfigGroup[]>;
  countConfigGroups(projectId?: string): Promise<number>;

  // Config Item operations
  createConfigItem(
    item: Omit<IConfigItem, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IConfigItem>;
  updateConfigItem(
    id: string,
    data: Partial<Omit<IConfigItem, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IConfigItem | null>;
  deleteConfigItem(id: string): Promise<boolean>;
  deleteConfigItemsByGroupId(groupId: string): Promise<number>;
  findConfigItemById(id: string): Promise<IConfigItem | null>;
  findConfigItemByKey(
    key: string,
    projectId?: string,
  ): Promise<IConfigItem | null>;
  listConfigItems(filters?: {
    projectId?: string;
    groupId?: string;
    isSecret?: boolean;
    tags?: string[];
    search?: string;
  }): Promise<IConfigItem[]>;
  countConfigItems(projectId?: string): Promise<number>;

  // ── Config Audit Log operations (tenant-specific) ──
  createConfigAuditLog(
    log: Omit<IConfigAuditLog, '_id' | 'createdAt'>,
  ): Promise<IConfigAuditLog>;
  listConfigAuditLogs(
    configKey: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date },
  ): Promise<IConfigAuditLog[]>;
}

// ── Memory types ─────────────────────────────────────────────────────────

export type MemoryScope = 'user' | 'agent' | 'session' | 'global';
export type MemorySource = 'chat' | 'api' | 'agent' | 'manual';
export type MemoryStoreStatus = 'active' | 'inactive' | 'error';
export type MemoryItemStatus = 'active' | 'archived' | 'expired';

export interface IMemoryStoreConfig {
  embeddingDimension: number;
  metric: 'cosine' | 'euclidean' | 'dotproduct';
  defaultScope: MemoryScope;
  deduplication: boolean;
  autoSummarize: boolean;
  maxMemories?: number;
  ttlDays?: number;
}

export interface IMemoryStore {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  key: string;
  name: string;
  description?: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  embeddingModelKey: string;
  config: IMemoryStoreConfig;
  status: MemoryStoreStatus;
  memoryCount: number;
  lastActivityAt?: Date;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IMemoryItem {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  storeKey: string;
  content: string;
  contentHash: string;
  summary?: string;
  scope: MemoryScope;
  scopeId?: string;
  metadata: Record<string, unknown>;
  tags: string[];
  source?: MemorySource;
  importance: number;
  accessCount: number;
  lastAccessedAt?: Date;
  embeddingVersion: string;
  vectorId: string;
  expiresAt?: Date;
  status: MemoryItemStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IGuardrailEvaluationLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  guardrailId: string;
  guardrailKey: string;
  guardrailName: string;
  guardrailType: GuardrailType;
  target: GuardrailTarget;
  action: GuardrailAction;
  passed: boolean;
  findings: Array<{
    type: string;
    category: string;
    severity: 'low' | 'medium' | 'high';
    message: string;
    action: string;
    block: boolean;
    value?: string;
  }>;
  inputText?: string;
  latencyMs?: number;
  source?: string;
  requestId?: string;
  message?: string | null;
  createdAt?: Date;
}

export interface IGuardrailEvalAggregate {
  guardrailId: string;
  totalEvaluations: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  avgLatencyMs: number | null;
  findingsByType: Record<string, number>;
  findingsBySeverity: Record<string, number>;
  timeseries?: Array<{
    period: string;
    total: number;
    passed: number;
    failed: number;
  }>;
}

// ── Config (Secret/Configuration Management) types ───────────────────────

export type ConfigValueType = 'string' | 'number' | 'boolean' | 'json';

export interface IConfigGroup {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IConfigItem {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  groupId: string;
  key: string;
  name: string;
  description?: string;
  /** Stored value. If `isSecret` is true, this is encrypted at rest. */
  value: string;
  valueType: ConfigValueType;
  isSecret: boolean;
  tags?: string[];
  version: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IConfigAuditLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  configKey: string;
  action: 'create' | 'update' | 'delete' | 'read';
  previousValue?: string;
  newValue?: string;
  version?: number;
  performedBy: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}
