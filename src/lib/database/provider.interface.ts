/**
 * Database Provider Interface
 * This abstraction allows switching between different database providers (MongoDB, PostgreSQL, etc.)
 */

import { ObjectId } from 'mongodb';
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
  settings: Record<string, any>;
  pricing: IModelPricing;
  metadata?: Record<string, any>;
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

  // Rate limiting
  incrementRateLimit(
    key: string,
    windowSeconds: number,
    amount: number,
  ): Promise<{ count: number; resetAt: Date }>;
}
