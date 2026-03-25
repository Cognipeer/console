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
  /** W3C-compatible trace identifier (32 hex chars). */
  traceId?: string;
  /** Root span identifier for the session (16 hex chars). */
  rootSpanId?: string;
  threadId?: string;
  tenantId: string;
  projectId?: string;
  /** Ingestion source: 'custom' for legacy JSON, 'otlp' for OpenTelemetry. */
  source?: 'custom' | 'otlp';
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
  /** W3C-compatible trace identifier (32 hex chars). */
  traceId?: string;
  /** Unique span identifier for this event (16 hex chars). */
  spanId?: string;
  /** Parent span identifier establishing hierarchy (16 hex chars). */
  parentSpanId?: string;
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

// ── Vector Migration types ──────────────────────────────────────────────

export type VectorMigrationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface IVectorMigration {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  sourceProviderKey: string;
  sourceIndexKey: string;
  sourceIndexName: string;
  destinationProviderKey: string;
  destinationIndexKey: string;
  destinationIndexName: string;
  status: VectorMigrationStatus;
  totalVectors: number;
  migratedVectors: number;
  failedVectors: number;
  batchSize: number;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type VectorMigrationLogStatus = 'success' | 'failed' | 'skipped';

export interface IVectorMigrationLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  migrationKey: string;
  batchIndex: number;
  vectorIds: string[];
  status: VectorMigrationLogStatus;
  migratedCount: number;
  failedCount: number;
  errorMessage?: string;
  durationMs?: number;
  createdAt?: Date;
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

