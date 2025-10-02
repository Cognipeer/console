/**
 * Database Provider Interface
 * This abstraction allows switching between different database providers (MongoDB, PostgreSQL, etc.)
 */

import { ObjectId } from 'mongodb';

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

export interface IUser {
  _id?: ObjectId | string;
  email: string;
  emailLower?: string;
  password: string;
  name: string;
  tenantId: string;
  role: 'owner' | 'admin' | 'user';
  licenseId: string;
  features?: string[];
  invitedBy?: string;
  invitedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IApiToken {
  _id?: ObjectId | string;
  userId: string;
  tenantId: string;
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

export interface IModel {
  _id?: ObjectId | string;
  tenantId: string;
  name: string;
  description?: string;
  key: string;
  provider: ModelProviderType;
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

  // API Token operations (tenant-specific)
  createApiToken(
    token: Omit<IApiToken, '_id' | 'createdAt'>,
  ): Promise<IApiToken>;
  listApiTokens(userId: string): Promise<IApiToken[]>;
  findApiTokenByToken(token: string): Promise<IApiToken | null>;
  deleteApiToken(id: string, userId: string): Promise<boolean>;
  updateTokenLastUsed(token: string): Promise<void>;

  // Agent Tracing Session operations (tenant-specific)
  createAgentTracingSession(
    session: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAgentTracingSession>;
  updateAgentTracingSession(
    sessionId: string,
    data: Partial<IAgentTracingSession>,
  ): Promise<IAgentTracingSession | null>;
  findAgentTracingSessionById(
    sessionId: string,
  ): Promise<IAgentTracingSession | null>;
  listAgentTracingSessions(
    filters?: Record<string, unknown>,
  ): Promise<{ sessions: IAgentTracingSession[]; total: number }>;

  // Agent Tracing Event operations (tenant-specific)
  createAgentTracingEvent(
    event: Omit<IAgentTracingEvent, '_id' | 'createdAt'>,
  ): Promise<IAgentTracingEvent>;
  listAgentTracingEvents(sessionId: string): Promise<IAgentTracingEvent[]>;
  deleteAgentTracingEvents(sessionId: string): Promise<number>;

  // Model management (tenant-specific)
  createModel(
    model: Omit<IModel, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IModel>;
  updateModel(id: string, data: Partial<IModel>): Promise<IModel | null>;
  deleteModel(id: string): Promise<boolean>;
  listModels(filters?: {
    category?: ModelCategory;
    provider?: ModelProviderType;
  }): Promise<IModel[]>;
  findModelById(id: string): Promise<IModel | null>;
  findModelByKey(key: string): Promise<IModel | null>;

  // Model usage logging (tenant-specific)
  createModelUsageLog(
    log: Omit<IModelUsageLog, '_id' | 'createdAt'>,
  ): Promise<IModelUsageLog>;
  listModelUsageLogs(
    modelKey: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date },
  ): Promise<IModelUsageLog[]>;
  aggregateModelUsage(
    modelKey: string,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
  ): Promise<IModelUsageAggregate>;
}
