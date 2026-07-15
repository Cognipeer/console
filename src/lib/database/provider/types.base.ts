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
import type {
  PermissionService,
  ServicePermissionLevel,
  UserRole,
  UserServicePermissions,
} from '@/lib/security/rbac';

export interface ITenant {
  _id?: ObjectId | string;
  companyName: string;
  slug: string;
  dbName: string;
  licenseType: string;
  licenseId?: string | null;
  licenseKey?: string | null;
  licenseStatus?: 'free' | 'active' | 'expired' | 'invalid';
  licensePayload?: Record<string, unknown> | null;
  licenseActivatedAt?: Date | null;
  licenseLastVerifiedAt?: Date | null;
  licenseExpiresAt?: Date | null;
  licenseError?: string | null;
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
  /**
   * Tenant-wide role.
   * project_admin is kept for backward compat — new code uses IUserProject.role for project-level roles.
   */
  role: 'owner' | 'admin' | 'project_admin' | 'user';
  /** @deprecated Use IUserProject records for project access control. */
  projectIds?: string[];
  /** Tenant-level service permission overrides (admin use only). */
  servicePermissions?: UserServicePermissions;
  licenseId: string;
  features?: string[];
  /**
   * Identity source for this user. Defaults to 'local' (email + bcrypt
   * password). External directory users (LDAP/SSO) are provisioned just-in-time
   * on first login and skip the local password path; their `password` field
   * holds an unusable placeholder. Set by the enterprise external-auth seam.
   */
  authProvider?: 'local' | 'ldap' | 'oidc' | 'saml';
  /** Stable identifier from the external directory (e.g. LDAP entry DN). */
  externalId?: string;
  invitedBy?: string;
  invitedAt?: Date;
  inviteAcceptedAt?: Date;
  mustChangePassword?: boolean;
  /**
   * Timestamp of the last password change.
   * Used to invalidate password reset tokens issued before this moment,
   * making reset tokens effectively single-use.
   */
  passwordChangedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAuditLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  requestId?: string;
  actorType: 'user' | 'api_token' | 'system';
  actorUserId?: string;
  actorEmail?: string;
  actorRole?: string;
  apiTokenId?: string;
  service: PermissionService | string;
  action: ServicePermissionLevel | 'auth' | 'security';
  event: string;
  method?: string;
  path?: string;
  statusCode?: number;
  outcome: 'success' | 'failure' | 'denied';
  ipAddress?: string;
  userAgent?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface IApiToken {
  _id?: ObjectId | string;
  userId: string;
  tenantId: string;
  projectId?: string;
  label: string;
  /** Plaintext token is only used for legacy records and immediate create responses. */
  token?: string;
  tokenHash?: string;
  tokenPrefix?: string;
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

export interface IAgentTracingSession extends IUsageAttributionFields {
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

export interface IAgentTracingSessionSummaryAggregate {
  sessionId: string;
  agentName?: string;
  status?: string;
  startedAt?: Date;
  durationMs?: number;
  totalEvents?: number;
  totalTokens: number;
}

export interface IAgentTracingTokenAggregate {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalTokens: number;
  averageInputTokensPerSession: number;
  averageOutputTokensPerSession: number;
  averageCachedInputTokensPerSession: number;
  averageTokensPerSession: number;
}

export interface IAgentTracingTotalsAggregate extends IAgentTracingTokenAggregate {
  sessionsCount: number;
  totalEvents: number;
  totalDurationMs: number;
  averageDurationMs: number;
}

export interface IAgentTracingAgentAggregate extends IAgentTracingTokenAggregate {
  name: string;
  label: string;
  latestSessionAt?: Date;
  latestStatus?: string;
  sessionsCount: number;
  totalEvents: number;
  averageDurationMs: number;
}

export interface IAgentTracingDashboardAggregate {
  recentSessions: IAgentTracingSessionSummaryAggregate[];
  recentAgents: IAgentTracingAgentAggregate[];
  recentAgentsTotal: number;
  analytics: {
    totals: IAgentTracingTotalsAggregate;
    tools: {
      totals: {
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      };
      items: Array<{
        toolName: string;
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      }>;
    };
    statuses: Array<{
      status: string;
      count: number;
    }>;
    models: Array<{
      model: string;
      sessionsCount: number;
    }>;
    agents: IAgentTracingAgentAggregate[];
    daily: Array<{
      date: string;
      sessionsCount: number;
      totalEvents: number;
      totalTokens: number;
      averageDurationMs: number;
    }>;
  };
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

export type ModelCategory =
  | 'llm'
  | 'embedding'
  | 'rerank'
  | 'stt'
  | 'tts'
  | 'ocr';

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
  // STT pricing: cost per 1,000 input seconds of audio
  inputSecondPer1K?: number;
  // TTS streaming pricing: cost per 1,000 output seconds of audio (optional)
  outputSecondPer1K?: number;
  // TTS pricing: cost per 1,000,000 input characters
  inputCharacterPer1M?: number;
  // OCR pricing: cost per 1,000 processed pages
  pagePer1K?: number;
  // Image generation / vision input pricing: cost per 1,000 images
  imagePer1K?: number;
}

// ── Dynamic LLM routing ───────────────────────────────────────────────────
// A "Dynamic LLM" is a virtual model (category 'llm', providerKey/Driver
// 'dynamic') that owns no real provider. Its config lives under
// `model.settings.dynamic` so it persists as JSON in both DB providers without
// a schema migration. At call time the inference layer resolves it to a real
// child model — by rules (signal thresholds) or by a decider model — and
// recurses through `handleChatCompletion` against the chosen key.

export type DynamicRoutingStrategy = 'rule-based' | 'model-based';

/** Signals computed from the chat request, available to rule conditions. */
export type DynamicRoutingSignal =
  | 'inputTokensEst' // estimated prompt tokens (chars/4 across all messages)
  | 'messageCount' // number of messages in the conversation
  | 'lastUserLength' // character length of the latest user message
  | 'hasTools' // request supplies tools / tool_choice
  | 'hasResponseFormat' // request requests a structured response_format
  | 'hasImages' // any message carries image content (multimodal)
  | 'keyword'; // regex / substring match on the latest user message

export type DynamicRoutingOperator =
  // numeric signals
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  // boolean signals
  | 'isTrue' | 'isFalse'
  // keyword (text) signal
  | 'contains' | 'matches';

export interface IDynamicRoutingCondition {
  signal: DynamicRoutingSignal;
  operator: DynamicRoutingOperator;
  value?: string | number | boolean;
}

export interface IDynamicRoutingRule {
  label: string;
  targetModelKey: string;
  /** How to combine conditions. Defaults to 'all'. */
  matchType?: 'all' | 'any';
  conditions: IDynamicRoutingCondition[];
}

export interface IDynamicDeciderLabel {
  label: string;
  description: string;
  targetModelKey: string;
}

export interface IDynamicDeciderConfig {
  /** Model key of the classifier that decides the route. */
  modelKey: string;
  /** Optional override of the default classification system prompt. */
  promptOverride?: string;
  labels: IDynamicDeciderLabel[];
}

export interface IDynamicRoutingConfig {
  strategy: DynamicRoutingStrategy;
  /** Used when no rule matches / the decider returns an unknown label. */
  defaultModelKey: string;
  /** Used when the chosen model errors. */
  fallbackModelKey?: string;
  /** rule-based strategy: ordered rules, first match wins. */
  rules?: IDynamicRoutingRule[];
  /** model-based strategy: decider model + label→model mapping. */
  decider?: IDynamicDeciderConfig;
}

/** Decision metadata recorded on the router's own usage-log row. */
export interface IModelUsageRouting {
  routerKey: string;
  routerModelDbId?: string;
  strategy: DynamicRoutingStrategy;
  decision: 'rule' | 'model' | 'default' | 'fallback';
  chosenModelKey: string;
  matchedRuleLabel?: string;
  deciderLabel?: string;
  deciderModelKey?: string;
  deciderLatencyMs?: number;
  reason: string;
  signals?: Record<string, unknown>;
  childRequestId?: string;
}

export type ProviderDomain =
  | 'model'
  | 'embedding'
  | 'vector'
  | 'file'
  | 'datasource'
  | 'stt'
  | 'tts'
  | 'ocr'
  | 'websearch';

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

export type OcrInvocationMode = 'native' | 'vlm';

export interface IOcrModelSettings {
  // 'native' uses provider's OCR runtime; 'vlm' calls a vision chat model with
  // an extraction prompt. Stored under model.settings.ocr.
  mode?: OcrInvocationMode;
  prompt?: string;
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

export type UsageActorType = 'user' | 'api_token' | 'system';
export type UsageSource = 'api' | 'dashboard' | 'system';

/**
 * Shared attribution envelope for every per-service usage/log record. Filled
 * centrally from the request context (see lib/services/usage/usageEvents.ts) —
 * services must not populate these by hand.
 *
 * No `source` field here on purpose: several raw logs already carry a
 * service-specific `source` column, and the request origin is derivable from
 * `actorType` (user→dashboard, api_token→api, system→system). The rollup
 * (`usage_daily`) stores the derived origin as its own `source` dimension.
 */
export interface IUsageAttributionFields {
  /** Owner of the request: token owner's userId or the session user. */
  userId?: string;
  /** API token that made the request (client v1 paths only). */
  apiTokenId?: string;
  actorType?: UsageActorType;
}

export interface IModelUsageCostSnapshot {
  currency: string;
  inputCost?: number;
  outputCost?: number;
  cachedCost?: number;
  totalCost?: number;
}

export interface IModelUsageLog extends IUsageAttributionFields {
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
  /** Present on Dynamic LLM router rows (route 'chat.completions.router'). */
  routing?: IModelUsageRouting;
  createdAt?: Date;
}

/**
 * Cross-service daily usage rollup — THE primary source for usage/spend
 * reports. One row per (dimension tuple, UTC day); counters are additive and
 * written via `incrementUsageDaily` upserts, so concurrent writers are safe.
 *
 * Dimension fields use '' (never NULL/undefined) when absent: SQLite treats
 * NULLs as distinct in UNIQUE constraints, which would silently duplicate
 * rows for the same logical dimension tuple.
 */
export interface IUsageDaily {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  userId: string;
  apiTokenId: string;
  actorType: string;
  source: string;
  /** Service slug: 'models' | 'websearch' | 'mcp' | 'tools' | 'rag' | ... */
  service: string;
  /** Service-local resource key: modelKey, searchKey, toolKey, ... */
  refKey: string;
  /** UTC calendar day, 'YYYY-MM-DD'. */
  day: string;
  /**
   * UTC midnight of `day` as a real Date — set by the mixins on first insert.
   * Exists because the EE reports engine builds time-range filters and
   * time-bucket expressions against Date-typed fields.
   */
  dayDate?: Date;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMsSum: number;
  latencyCount: number;
  /** Service-specific additive counters (pages, audioSeconds, results, ...). */
  units?: Record<string, number>;
  updatedAt?: Date;
}

/** Additive increment for one usage_daily row (all counters default 0). */
export interface IUsageDailyIncrement {
  tenantId: string;
  projectId: string;
  userId: string;
  apiTokenId: string;
  actorType: string;
  source: string;
  service: string;
  refKey: string;
  day: string;
  requests?: number;
  errors?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMsSum?: number;
  latencyCount?: number;
  units?: Record<string, number>;
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

// ── Project Membership ────────────────────────────────────────────────────

export type ProjectRole = 'project_admin' | 'member';

/**
 * Per-project membership record.
 * Replaces the deprecated IUser.projectIds + IUser.role='project_admin' pattern.
 * Owners and admins have implicit access to all projects — no IUserProject needed.
 */
export interface IUserProject {
  _id?: ObjectId | string;
  tenantId: string;
  userId: string;
  projectId: string;
  role: ProjectRole;
  /** Project-scoped service permission overrides — take precedence over tenant-level defaults. */
  servicePermissions?: UserServicePermissions;
  invitedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Groups / Teams ─────────────────────────────────────────────────────────

/** Origin of a group or membership record. LDAP-sourced rows are reconciled
 *  on each directory login and must not be hand-edited in the console. */
export type GroupSource = 'local' | 'ldap';

/**
 * A named group of users within a tenant (team, department, squad, etc.).
 *
 * A group grants its members access at two levels, unioned with the member's
 * direct grants (highest permission wins):
 *   - tenant-wide: `tenantRole` + `servicePermissions` (e.g. make members admin)
 *   - per-project: via IGroupProject assignments
 */
export interface IGroup {
  _id?: ObjectId | string;
  tenantId: string;
  name: string;
  description?: string;
  /** Tenant-wide role granted to every member (unioned with their own role). */
  tenantRole?: UserRole;
  /** Tenant-level service permission grants applied to every member. */
  servicePermissions?: UserServicePermissions;
  /** Where the group came from. Defaults to 'local'. */
  source?: GroupSource;
  /** Stable external identifier for directory-sourced groups (e.g. LDAP group DN). */
  externalId?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Membership of a user in a group. */
export interface IGroupMember {
  _id?: ObjectId | string;
  tenantId: string;
  groupId: string;
  userId: string;
  /** Whether the user can manage group membership. */
  role: 'admin' | 'member';
  /** Where the membership came from. LDAP-sourced rows are reconciled on
   *  directory login; local rows are never touched by the sync. Defaults to 'local'. */
  source?: GroupSource;
  addedBy?: string;
  createdAt?: Date;
}

/** Assignment of a group to a project with a role and optional service overrides. */
export interface IGroupProject {
  _id?: ObjectId | string;
  tenantId: string;
  groupId: string;
  projectId: string;
  role: ProjectRole;
  servicePermissions?: UserServicePermissions;
  createdAt?: Date;
  updatedAt?: Date;
}
