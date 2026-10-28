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
// Type-only, and therefore erased: types.domain already imports
// IUsageAttributionFields from here, so a value import would close a runtime
// cycle. IGuardrailBinding is declared there because it names GuardrailHookId,
// and the hook vocabulary must have exactly one home.
import type { IGuardrailBinding } from './types.domain';

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
  /** May be an empty string for a "Programmatic User" (canLogin=false) — a deliberate design choice to avoid a SQLite NOT NULL migration, not a bug. */
  email: string;
  emailLower?: string;
  password: string;
  name: string;
  tenantId: string;
  /**
   * Tenant-wide role.
   * project_admin is kept for backward compat — new code uses IUserProject.role for project-level roles.
   */
  role: 'owner' | 'admin' | 'project_admin' | 'user' | 'portal_user';
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
  /**
   * What kind of account this is. Missing means `member` (every row written before this field existed): a person of
   * the workspace. `external` is a person of a HOST APPLICATION whose identity a trusted issuer vouched for (see
   * lib/iam/delegatedIdentity.ts): no password, no dashboard sign-in, no API tokens, left out of the workspace's member
   * lists and pickers, always the User role, listed in the Authorization center with a badge.
   */
  kind?: 'member' | 'external';
  /**
   * The identities this account has at issuers whose signed assertions the workspace trusts: issuer -> subject (`sub`).
   * Not the LDAP / SSO `externalId` above. At most one subject per issuer; the account is found again by it
   * (`findUsersByExternalIdentity`). Not indexed: the lookup scans the workspace's accounts, so callers cache what it finds.
   */
  externalIds?: Record<string, string>;
  invitedBy?: string;
  invitedAt?: Date;
  inviteAcceptedAt?: Date;
  mustChangePassword?: boolean;
  /** Whether this user may authenticate at all. Missing/undefined is treated as `true` everywhere (back-compat for existing rows). `false` marks a "Programmatic User" with no login capability. */
  canLogin?: boolean;
  /**
   * Account lifecycle state. Missing/undefined means `'active'` (every row
   * written before this field existed, including all on-prem rows) — never
   * write a migration that backfills it, and never treat a missing value as
   * disabled. A disabled user keeps their row, role and memberships so the
   * account can be re-enabled without re-provisioning.
   */
  status?: 'active' | 'disabled';
  disabledAt?: Date | null;
  /** Actor user id, or `system:<source>` when a directory sync disabled the account. */
  disabledBy?: string | null;
  disabledReason?: string | null;
  /**
   * The person's last "I need access to a project" request (`POST /api/users/me/access-request`). Never cleared by the
   * server: a screen shows it only while the person still has no accessible project, and a new request (allowed once
   * per 24 h) overwrites it.
   */
  accessRequest?: { at: Date; message?: string } | null;
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
  /** Session user that minted this token. Equals `userId` for self-service tokens; differs when an admin mints on behalf of another user. */
  createdBy?: string;
  /** Plaintext token is only used for legacy records and immediate create responses. */
  token?: string;
  tokenHash?: string;
  tokenPrefix?: string;
  /**
   * Optional least-privilege permission scope for this token. When set (an
   * object, even `{}`), the token's effective RBAC permission is capped at
   * `min(owner, scope)` per service — a service absent from the map resolves to
   * `none`. `null`/`undefined` means the token is unscoped and inherits the
   * owner's permissions (legacy behaviour; the default for existing tokens).
   */
  servicePermissions?: UserServicePermissions | null;
  lastUsed?: Date;
  createdAt?: Date;
  expiresAt?: Date;
  /**
   * Optional network allowlist: CIDR ranges (IPv4 / IPv6; a bare address means
   * /32 or /128) the token may authenticate from. `null` / `undefined` / `[]`
   * = unrestricted, which is every token minted before this field existed.
   * Enforced in token authentication, before anything else is decided.
   */
  allowedIpRanges?: string[] | null;
  /**
   * When true, a call with this token is only served on behalf of a verified person (`X-Cognipeer-User-Token`, or the
   * combined `Authorization` value). Without one the call is refused; the token's owner is never the fallback.
   * `undefined` / `false` = optional, which is every token minted before this field existed.
   */
  requireUserToken?: boolean;
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
  /** Ingestion source: 'custom' for legacy JSON, 'otlp' for OpenTelemetry, 'trigger' for a hosted run a trigger started. */
  source?: 'custom' | 'otlp' | 'trigger';
  agent?: Record<string, unknown>;
  agentName?: string;
  agentVersion?: string;
  agentModel?: string;
  /** Free-form caller-supplied attribution tags (e.g. `{ complexity: 'complex' }`),
   *  sanitized at ingest — sibling of `agent`, not nested under it. Flows into
   *  `usage_daily.metadata` via `recordTracingSessionCreated`/`recordTraceModelUsage`
   *  so callers can group/report on whatever key they send without a schema change. */
  metadata?: Record<string, string>;
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
  /** Sum of `reasoningTokens` across the session's events — a subset of
   *  `totalOutputTokens`, never added on top of it. */
  totalReasoningTokens?: number;
  /** Count of events whose `finishReason` is a truncation reason (see
   *  `isTruncatedFinishReason`), e.g. the model hit its token limit. */
  truncatedEvents?: number;
  /** Counts of error events (see `lib/shared/traceHealth`); top-level, never inside `summary`. */
  errorEvents?: number;
  toolErrors?: number;
  aiErrors?: number;
  /** What was already counted in entity_metrics for this session (idempotency). */
  metricsOutcome?: { status: string; latencyRecorded: boolean; recordedAt: Date } | null;
  /**
   * The client supplied this session's end status (see `isExplicitClientStatus`).
   * A late error event only flips a session whose status was DERIVED to 'error';
   * an explicit status (e.g. a recovered run the client calls 'success') stays,
   * so the outcome does not depend on whether /events or /end arrives first.
   */
  statusExplicit?: boolean;
  totalBytesIn?: number;
  totalBytesOut?: number;
  totalRequestBytes?: number;
  totalResponseBytes?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * One event's contribution to a session's running totals. Applied atomically by
 * the provider so that concurrent events for the same session cannot overwrite
 * each other's increments.
 */
export interface AgentTracingSessionEventDelta {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Subset of `outputTokens` (e.g. OpenAI `completion_tokens_details.reasoning_tokens`);
   *  never added into `totalTokens` or any cost arithmetic. */
  reasoningTokens?: number;
  /** Normalized (trim + lowercase) provider finish reason for this event's
   *  model call, used to bump `truncatedEvents` when it indicates a cutoff. */
  finishReason?: string;
  durationMs?: number;
  /** Event type whose per-type counter should be bumped, e.g. `ai_call`. */
  eventType?: string;
  modelsUsed?: string[];
  toolsUsed?: string[];
  /** Error-event counters for this event; a late error flips a finished session with a derived (not client-supplied) status to 'error'. */
  errorEvents?: number;
  toolErrors?: number;
  aiErrors?: number;
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
  /** Subset of `inputTokens` written to the provider's prompt cache; never added
   *  on top of `inputTokens`, priced at the cache-write rate. */
  cachedWriteTokens?: number;
  /** Subset of `outputTokens` (e.g. OpenAI `completion_tokens_details.reasoning_tokens`);
   *  never added into `totalTokens` or any cost arithmetic. */
  reasoningTokens?: number;
  /** Normalized (trim + lowercase) raw provider finish reason, e.g. `stop`,
   *  `length`, `tool_calls`. See `src/lib/shared/finishReason.ts`. */
  finishReason?: string;
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
  | 'ocr'
  | 'image'
  | 'moderation'
  | 'decision';

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
  /** Cache-READ price per 1M tokens. Blank, 0 or null = not entered: cache reads
   *  bill at the input rate (`resolveTokenRates`). */
  cachedTokenPer1M?: number;
  /** Cache-WRITE price per 1M tokens (Anthropic / Bedrock Claude 5-minute writes
   *  are 1.25x input). Blank, 0 or null = not entered: writes bill at the input rate. */
  cacheWriteTokenPer1M?: number;
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

/**
 * One deployment behind a pooled model.
 *
 * `settings` is merged OVER the model's own settings for calls that land here,
 * which is what makes a pool able to span providers whose knobs differ — an
 * Azure replica needing its own `azureApiVersion`, say. Everything that must
 * stay identical across replicas (pricing, capability profile, cache key,
 * guardrail bindings, quota attribution) deliberately lives on the model and
 * has no per-replica form.
 */
export interface IModelReplica {
  providerKey: string;
  /** Upstream model id at THIS provider — a deployment name on Azure. */
  modelId: string;
  /** Relative share of traffic among healthy replicas. Defaults to 1. */
  weight?: number;
  /** Defaults to true. A disabled replica is drained without being deleted. */
  enabled?: boolean;
  /** Per-replica overrides merged over `IModel.settings`. */
  settings?: Record<string, unknown>;
  label?: string;
}

export type DynamicRoutingStrategy = 'rule-based' | 'model-based';

/** Signals computed from the chat request, available to rule conditions. */
export type DynamicRoutingSignal =
  | 'inputTokensEst' // estimated prompt tokens (chars/4 across all messages)
  | 'messageCount' // number of messages in the conversation
  | 'lastUserLength' // character length of the latest user message
  | 'hasTools' // request supplies tools / tool_choice
  | 'hasResponseFormat' // request requests a structured response_format
  | 'hasImages' // any message carries image content (multimodal)
  | 'conversationCostUsd' // realized spend of this conversation through this router so far
  | 'budgetUsedPct' // share of guards.budget.limitUsd spent in its window (0-100+)
  | 'predictedOutputTokens' // output tokens predicted from this router's history
  | 'ioRatio' // predicted output / input token ratio
  | 'complexityScore' // expected level index from `config.complexity` (a decision model scoring the request)
  | 'keyword' // regex / substring match on the latest user message
  // Caller context (who is asking / through which door). Missing = no match.
  | 'channel' // dashboard | portal | api | embed | a2a | schedule | playground
  | 'userId'
  | 'groupIds' // matches when ANY of the caller's groups is listed
  | 'agentKey'
  | 'portalKey'
  | 'apiTokenId'
  | 'projectId';

export type DynamicRoutingOperator =
  // numeric signals
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  // boolean signals
  | 'isTrue' | 'isFalse'
  // keyword (text) signal
  | 'contains' | 'matches'
  // caller-context signals: value is a list (array or comma-separated string)
  | 'in' | 'not_in';

export interface IDynamicRoutingCondition {
  signal: DynamicRoutingSignal;
  operator: DynamicRoutingOperator;
  value?: string | number | boolean | string[];
}

/**
 * How a pool picks one of its candidates for a request.
 * - `best-under-cap`: the highest-tier candidate whose estimated cost fits
 *   `guards.maxCostPerRequestUsd` (highest tier when no cap is set).
 * - `cheapest`: lowest estimated cost. Meant for quality-equivalent
 *   candidates (the same model on several providers / regions).
 * - `token-profile`: lowest expected cost using the request's predicted
 *   output/input ratio, per-model verbosity and prompt-cache stickiness.
 */
export type DynamicPoolPolicy = 'best-under-cap' | 'cheapest' | 'token-profile';

export interface IDynamicPoolCandidate {
  modelKey: string;
  /** Quality tier, higher = stronger. Used by `best-under-cap`. Defaults to 1. */
  tier?: number;
}

/**
 * Where a routing decision (a rule, a decider label, or the default) lands:
 * one fixed model, or a pool of candidates plus the policy that picks one.
 * Exactly one of `modelKey` / `pool` is set.
 */
export interface IDynamicRoutingTarget {
  modelKey?: string;
  pool?: IDynamicPoolCandidate[];
  policy?: DynamicPoolPolicy;
}

/**
 * Router-wide cost limits, applied after a target has been resolved. A guard
 * can only move a request to a cheaper model — the cheapest eligible pool
 * candidate, or `economyModelKey` for a fixed-model target.
 */
export interface IDynamicRoutingGuards {
  maxCostPerRequestUsd?: number;
  /** Downgrade once a conversation's realized spend through this router reaches this. */
  conversationBudgetUsd?: number;
  budget?: {
    /** Rolling window in hours (1-168). */
    windowHours: number;
    limitUsd: number;
    /** Downgrade once this share of the limit is spent. Defaults to 80. */
    downgradeAtPct?: number;
    /** At 100%: keep serving on the cheapest model, or reject the request. */
    onExceeded?: 'cheapest' | 'reject';
  };
  /** Cheap model a fixed-model target downgrades to when a guard trips. */
  economyModelKey?: string;
  /** token-profile: keep a conversation on its previous model (prompt cache). Defaults to true. */
  sticky?: boolean;
  /** token-profile: only switch away from the sticky model for at least this % saving. Defaults to 15. */
  switchMarginPct?: number;
}

export interface IDynamicRoutingRule {
  label: string;
  /** Fixed target model. Shorthand for `target: { modelKey }`. */
  targetModelKey?: string;
  /** Fixed model or candidate pool; takes precedence over `targetModelKey`. */
  target?: IDynamicRoutingTarget;
  /** How to combine conditions. Defaults to 'all'. */
  matchType?: 'all' | 'any';
  conditions: IDynamicRoutingCondition[];
}

export interface IDynamicDeciderLabel {
  label: string;
  description: string;
  targetModelKey?: string;
  target?: IDynamicRoutingTarget;
}

export interface IDynamicDeciderConfig {
  /**
   * Model key of the classifier that decides the route. New configs must name a
   * `decision`-category model: it is asked one `choice` question (the labels)
   * and answers with a probability per label. An `llm`-category decider is the
   * legacy chat-and-parse form — still honored for configs saved before
   * decision models existed, but it cannot be newly attached.
   */
  modelKey: string;
  /** Overrides the default instructions (decision question text / legacy system prompt). */
  promptOverride?: string;
  labels: IDynamicDeciderLabel[];
  /**
   * Decision deciders only: when the winning label's confidence (or, if the
   * backend reports none, its probability) is below this (0-1), the request
   * goes to `belowConfidence` instead of the label's target.
   */
  minConfidence?: number;
  /** Where a below-threshold answer goes. Defaults to the router's default target. */
  belowConfidence?: IDynamicRoutingTarget;
}

/**
 * A `decision` model that scores every request on ordered levels. Its expected
 * level index becomes the `complexityScore` rule signal (rule-based only,
 * computed only when a rule references it).
 */
export interface IDynamicComplexityConfig {
  /** A `decision`-category model. */
  modelKey: string;
  /** Ordered levels, lowest first (2-255). */
  levels: string[];
  /** Overrides the default scoring instructions. */
  instructions?: string;
}

export interface IDynamicRoutingConfig {
  strategy: DynamicRoutingStrategy;
  /**
   * Used when no rule matches / the decider returns an unknown label, as the
   * last resort when a pool has no eligible candidate, and as the baseline
   * that savings are measured against (unless `baselineModelKey` is set).
   */
  defaultModelKey: string;
  /** Optional pool used instead of `defaultModelKey` when nothing matches. */
  defaultTarget?: IDynamicRoutingTarget;
  /** Used when the chosen model errors. */
  fallbackModelKey?: string;
  /** rule-based strategy: ordered rules, first match wins. */
  rules?: IDynamicRoutingRule[];
  /** model-based strategy: decider model + label→model mapping. */
  decider?: IDynamicDeciderConfig;
  /** rule-based strategy: backs the `complexityScore` signal. */
  complexity?: IDynamicComplexityConfig;
  guards?: IDynamicRoutingGuards;
  /** Reference model for "what would this have cost" savings. Defaults to defaultModelKey. */
  baselineModelKey?: string;
  /** Output tokens assumed when neither max_tokens nor history is available. Defaults to 512. */
  defaultOutputTokens?: number;
  /**
   * `shadow`: pools and guards are evaluated and logged, but traffic keeps
   * going to each target's primary model (its fixed model, or the pool's
   * first candidate). Defaults to `enforce`.
   */
  mode?: 'enforce' | 'shadow';
  /** enforce mode: share (0-100) of conversations that get the enforced decision; the rest run as shadow. Defaults to 100. */
  canaryPercent?: number;
}

/** Per-candidate cost estimate recorded with a pool decision. */
export interface IDynamicPoolEstimate {
  modelKey: string;
  tier: number;
  estimatedCostUsd?: number;
  predictedOutputTokens?: number;
  /** Why the candidate was not eligible (missing capability, context too small, …). */
  skipped?: string;
}

/** Decision metadata recorded on the router's own usage-log row (`role: 'router'`)
 *  and, as attribution, on the child / decider rows it caused. */
export interface IModelUsageRouting {
  /** `router` = the decision row; `child` = the routed model's row; `decider` = the classifier's row. Absent on rows written before this field existed (router rows). */
  role?: 'router' | 'child' | 'decider';
  routerKey: string;
  routerModelDbId?: string;
  strategy: DynamicRoutingStrategy;
  decision: 'rule' | 'model' | 'default' | 'fallback';
  chosenModelKey: string;
  matchedRuleLabel?: string;
  deciderLabel?: string;
  deciderModelKey?: string;
  deciderLatencyMs?: number;
  /** Decision deciders: probability / confidence of the winning label, and the gap to the runner-up. */
  deciderProbability?: number;
  deciderConfidence?: number;
  deciderMargin?: number;
  reason: string;
  signals?: Record<string, unknown>;
  childRequestId?: string;
  /** Pool policy that picked the model, when the target was a pool. */
  policy?: DynamicPoolPolicy;
  pool?: IDynamicPoolEstimate[];
  /** Guard that changed the choice (e.g. `maxCostPerRequestUsd`). */
  guard?: string;
  /** Estimated cost of the chosen model at decision time. */
  estimatedCostUsd?: number;
  predictedOutputTokens?: number;
  /** Stable, hashed conversation identifier used for budgets and stickiness. */
  conversationId?: string;
  /** Segment the request was bucketed into for history-based prediction. */
  segment?: string;
  mode?: 'enforce' | 'shadow';
  /** shadow / canary: what the enforced decision would have been. */
  shadow?: { chosenModelKey: string; estimatedCostUsd?: number; reason: string; policy?: DynamicPoolPolicy; guard?: string };
  baselineModelKey?: string;
  /** child rows: this call's realized usage priced at the baseline model. */
  baselineCostUsd?: number;
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
  | 'image'
  | 'moderation'
  | 'decision'
  | 'websearch'
  /** Telephony carriers (Twilio) for the enterprise realtime voice engine. */
  | 'telephony';

export interface IProviderRecordStatus {
  status: 'active' | 'disabled' | 'errored';
}

/** Outcome of the last "Test connection" run against a stored provider (never carries secrets). */
export interface IProviderLastTest {
  /** `null`: the driver has no test. */
  ok: boolean | null;
  at: Date | string;
  latencyMs: number;
  message: string;
  /** Deployments / models the probe found, when it lists them. */
  deployments?: number;
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
  /** `null` = cleared (the connection changed since the last test). */
  lastTest?: IProviderLastTest | null;
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

export type VectorMigrationStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  /** Incremented every time the migration is (re)started, so its batch logs can be grouped per run. */
  attempt: number;
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
  /** Which run this log belongs to — matches the migration's `attempt` when the batch ran. */
  attempt: number;
  batchIndex: number;
  vectorIds: string[];
  status: VectorMigrationLogStatus;
  migratedCount: number;
  failedCount: number;
  errorMessage?: string;
  durationMs?: number;
  createdAt?: Date;
}

/** Aggregated stats for one run (`attempt`) of a migration, built from its batch logs. */
export interface IVectorMigrationRunSummary {
  attempt: number;
  batchCount: number;
  successBatches: number;
  failedBatches: number;
  skippedBatches: number;
  migratedCount: number;
  failedCount: number;
  startedAt?: Date;
  endedAt?: Date;
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
  /** Set on a file uploaded to an agent session (stored in the bucket the agent's `attachments.bucketKey` names); absent on every other file. */
  purpose?: 'conversation';
  conversationId?: string;
  agentKey?: string;
  /** When the retention cleanup removes the file (session files only). */
  expiresAt?: Date | null;
  /** Who uploaded it (session files); `createdBy` stays the principal the file service was called as. */
  uploadedBy?: string;
  /**
   * `agent_output`: a file the agent wrote to its sandbox's `/outputs/` and the platform collected after a turn.
   * `import`: an object that was already in the storage provider and was registered as a record afterwards.
   * Absent = an upload.
   */
  origin?: 'agent_output' | 'import';
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** The fields of a file record that can be empty, and so can be cleared by a patch. */
type ClearableFileRecordField =
  | 'contentType'
  | 'checksum'
  | 'etag'
  | 'markdownKey'
  | 'markdownError'
  | 'markdownSize'
  | 'markdownContentType';

/**
 * What `updateFileRecord` can change. The fields that can be empty also take `null`: it clears what an earlier run
 * left there - an error a finished conversion left behind, or the type, checksum and Markdown copy of the bytes a
 * new upload replaced (a field that is left out stays as it is).
 */
export type FileRecordPatch =
  Partial<Omit<IFileRecord, 'tenantId' | 'providerKey' | 'bucketKey' | 'key' | 'createdBy' | ClearableFileRecordField>>
  & { [Field in ClearableFileRecordField]?: NonNullable<IFileRecord[Field]> | null };

/** Which files a listing keeps: only session files, or only the ones uploaded some other way. */
export type FileListPurpose = 'conversation' | 'other';

/** One page of a bucket seen as folders: the sub-folders and the files directly in the folder. */
export interface IFileEntriesPage {
  /** Full folder paths (each ends with `/`), in key order. */
  folders: string[];
  items: IFileRecord[];
  /** Pass back as `cursor` for the next page; absent on the last page. */
  nextCursor?: string;
}

/**
 * What a file listing can be narrowed to by kind. A file's kind comes from its content type, with the
 * extension of its name as the fallback (`fileTypeFilter.ts` holds the rules both database providers apply).
 */
export type FileTypeFilter = 'pdf' | 'image' | 'text' | 'office' | 'other';

/** One bucket's files added up: the aggregate behind a bucket list's file count and size. */
export interface IFileBucketStats {
  providerKey: string;
  bucketKey: string;
  fileCount: number;
  /** Σ(size + markdownSize): the original and its Markdown copy both take room in the provider. */
  totalBytes: number;
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
  /**
   * Interchangeable deployments of THIS SAME model, for capacity and
   * resilience. Every replica must be the same model — same pricing, same
   * capabilities, same answers — because the caller asked for this model and
   * cannot tell which replica served it. Routing to a DIFFERENT model is what
   * Dynamic LLM does (`dynamic` below), and the two compose: a Dynamic route
   * picks a model key, and that model may itself be pooled.
   *
   * ABSENT means "one replica", built from the `providerKey`/`modelId` on this
   * record — so every existing model keeps working with no migration, and the
   * top-level pair stays the identity of the model rather than becoming
   * vestigial.
   */
  replicas?: IModelReplica[];
  /**
   * Multi-guardrail binding. AUTHORITATIVE when present: the two deprecated
   * single-slot keys below are then ignored, not merged — see
   * `resolveBindings()` in `@/lib/services/guardrail/hooks/binding`.
   */
  guardrails?: IGuardrailBinding[];
  /**
   * @deprecated Use `guardrails`. Still READ (as the fallback when `guardrails`
   * is absent) and still WRITTEN for one release, so an older console binary
   * on the same tenant database keeps enforcing.
   */
  inputGuardrailKey?: string;
  /** @deprecated Use `guardrails`. See `inputGuardrailKey`. */
  outputGuardrailKey?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type UsageActorType = 'user' | 'api_token' | 'system';
/** 'tracing' marks rows derived from agent observability ingests (traces),
 *  as opposed to calls served by the gateway itself. */
export type UsageSource = 'api' | 'dashboard' | 'system' | 'tracing';

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
  /** The cache-write slice; included in `totalCost`. Absent on rows written before it existed. */
  cacheWriteCost?: number;
  totalCost?: number;
  /** Cache tokens priced at the input rate because the model had no price entered for them. */
  assumedRates?: Array<'cacheRead' | 'cacheWrite'>;
}

/**
 * `cancelled` is a call the client walked away from mid-stream — it is neither
 * a completion nor a provider fault, and counting it as either is wrong: the
 * error rate would blame us for a user pressing stop, and the success rate
 * would claim an answer that was never delivered. Both aggregations match on
 * the exact value, so a third state is additive: it stays in `totalCalls` and
 * in the token sums (we are billed for what the provider generated) without
 * landing in either bucket.
 */
export type ModelUsageStatus = 'success' | 'error' | 'cancelled';

export interface IModelUsageLog extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  modelKey: string;
  modelId?: string;
  requestId: string;
  route: string;
  status: ModelUsageStatus;
  providerRequest: Record<string, unknown>;
  providerResponse: Record<string, unknown>;
  errorMessage?: string;
  latencyMs?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Subset of `inputTokens` written to the provider's prompt cache; never added
   *  on top of `inputTokens`, priced at the cache-write rate. */
  cachedWriteTokens?: number;
  totalTokens: number;
  /** Subset of `outputTokens` (e.g. OpenAI `completion_tokens_details.reasoning_tokens`);
   *  never added into `totalTokens` or any cost arithmetic. */
  reasoningTokens?: number;
  /** Normalized (trim + lowercase) raw provider finish reason, e.g. `stop`,
   *  `length`, `tool_calls`. See `src/lib/shared/finishReason.ts`. */
  finishReason?: string;
  toolCalls?: number;
  cacheHit?: boolean;
  pricingSnapshot?: IModelPricing & IModelUsageCostSnapshot;
  /** Present on Dynamic LLM router rows (route 'chat.completions.router'). */
  routing?: IModelUsageRouting;
  /** The agent the call ran for, and the door it came through (`RoutingCallerContext`). */
  agentKey?: string;
  channel?: string;
  /**
   * The agent run the call belongs to (`RoutingRunAttribution`), as known when the
   * call settled: the ledger of a turn is the sum of its rows, whatever became of
   * the run.
   */
  conversationId?: string;
  turnId?: string;
  runId?: string;
  traceSessionId?: string;
  createdAt?: Date;
}

/**
 * What the model calls of one agent turn have cost so far, summed from
 * `model_usage_logs` — the ledger each call writes when it settles, so it is
 * complete for a turn that failed, was cut off, or is still running.
 */
export interface IAgentTurnUsageSummary {
  calls: number;
  errorCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cachedWriteTokens?: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  lastAt?: Date;
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
  /** Agent the usage is attributed to (tracing agentName); '' when absent.
   *  Rows written before the dimension shipped lack the field entirely. */
  agentKey: string;
  /** Free-form caller-supplied attribution tags (tracing `metadata`), e.g.
   *  `{ complexity: 'complex' }`. '' / {} when absent. */
  metadata: Record<string, string>;
  /** Canonical serialization of `metadata` (sorted-entries JSON) — the actual
   *  rollup dimension, since Mongo/SQLite can't uniquely-index an object.
   *  '' when `metadata` is absent/empty. */
  metadataKey: string;
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
  /** Subset of `inputTokens` written to the provider's prompt cache; never added
   *  on top of `inputTokens`. Absent on rows written before it existed. */
  cachedWriteTokens?: number;
  /** Subset of `outputTokens` (e.g. OpenAI `completion_tokens_details.reasoning_tokens`);
   *  never added into `totalTokens` or any cost arithmetic. */
  reasoningTokens: number;
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
  /** Agent attribution dimension; providers default it to ''. */
  agentKey?: string;
  /** Free-form caller-supplied attribution tags; providers default it to {}. */
  metadata?: Record<string, string>;
  /** Canonical serialization of `metadata`; providers default it to ''. */
  metadataKey?: string;
  day: string;
  requests?: number;
  errors?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Subset of `inputTokens`. Mirrors `IUsageDaily.cachedWriteTokens`. */
  cachedWriteTokens?: number;
  /** Subset of `outputTokens`; never added into `totalTokens` or any cost
   *  arithmetic. Mirrors `IUsageDaily.reasoningTokens`. */
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMsSum?: number;
  latencyCount?: number;
  units?: Record<string, number>;
}

export type EntityMetricType = 'agent' | 'model' | 'tool' | 'mcp' | 'kb';
/** 'tracing' = external SDK/OTLP traces; 'hosted' = console-hosted agent runs (internal sink);
 *  'gateway' = model gateway (logModelUsage); 'service' = rag / mcp / tools services. */
export type EntityMetricSource = 'tracing' | 'hosted' | 'gateway' | 'service';
export const ENTITY_METRIC_BUCKET_MS = 300_000;
/** Upper bounds (inclusive, ms) of latency histogram buckets lat0..lat13; lat14 = overflow (> 600000). */
export const ENTITY_LATENCY_BUCKET_UPPER_MS = [100, 250, 500, 1000, 2000, 3000, 5000, 10000, 20000, 30000, 60000, 120000, 300000, 600000] as const;
export const ENTITY_LATENCY_BUCKET_FIELDS = ['lat0', 'lat1', 'lat2', 'lat3', 'lat4', 'lat5', 'lat6', 'lat7', 'lat8', 'lat9', 'lat10', 'lat11', 'lat12', 'lat13', 'lat14'] as const;
export const ENTITY_METRIC_COUNTER_FIELDS = [
  'requests', 'errors', 'cancelled', 'latencyMsSum', 'latencyCount',
  ...ENTITY_LATENCY_BUCKET_FIELDS,
  'inputTokens', 'outputTokens', 'costUsd',
  'errorEvents', 'toolCalls', 'toolErrors', 'aiCalls', 'aiErrors', 'abandoned', 'emptyResults',
] as const;
export type EntityMetricCounterField = (typeof ENTITY_METRIC_COUNTER_FIELDS)[number];
export type EntityMetricCounters = Record<EntityMetricCounterField, number> & { latencyMsMax: number };

/** Additive increment for one entity_metrics row (all counters default 0). */
export interface IEntityMetricIncrement extends Partial<EntityMetricCounters> {
  tenantId: string;
  /** '' sentinel, never null. */
  projectId: string;
  entityType: EntityMetricType;
  /** Trimmed, max 200 chars. */
  entityKey: string;
  source: EntityMetricSource;
  /** Epoch ms floored to ENTITY_METRIC_BUCKET_MS. */
  bucketMs: number;
  /** Stored as the row's `expiresAt` on insert only (TTL). */
  expiresAtMs?: number;
}

export interface IEntityMetricRow extends EntityMetricCounters {
  _id?: string;
  tenantId: string;
  projectId: string;
  entityType: EntityMetricType;
  entityKey: string;
  source: EntityMetricSource;
  bucketMs: number;
  bucketStart: Date;
  expiresAt?: Date;
  updatedAt?: Date;
}

export type EntityMetricsGroupField = 'entityType' | 'entityKey' | 'source' | 'projectId';

export interface EntityMetricsAggregateQuery {
  tenantId: string;
  /** Omit = tenant-wide (prometheus/admin only). */
  projectId?: string;
  entityType?: EntityMetricType;
  /** At most 500. */
  entityKeys?: string[];
  sources?: EntityMetricSource[];
  /** Required, half-open [fromMs, toMs) on bucketMs. */
  fromMs: number;
  toMs: number;
  groupBy: EntityMetricsGroupField[];
  /** Optional extra time grouping; multiple of 300000. Result `bucketMs` = floor(bucketMs/size)*size. */
  bucketMs?: number;
  /** Default 10000, max 50000; sort: bucketMs asc then requests desc. */
  limit?: number;
}

export interface IEntityMetricAggregate extends EntityMetricCounters {
  entityType?: EntityMetricType;
  entityKey?: string;
  source?: EntityMetricSource;
  projectId?: string;
  bucketMs?: number;
}

export interface IModelUsageAggregate {
  modelKey: string;
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCachedWriteTokens?: number;
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
    cachedWriteTokens?: number;
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
  /**
   * Legacy plaintext monitoring apiKey. New writes never populate this —
   * see `apiKeySealed` — but it is read as a fallback for rows written
   * before the encrypted-at-rest vault existed
   * (`@/lib/services/inferenceMonitoring/apiKeyVault`).
   */
  apiKey?: string;
  /**
   * Encrypted-at-rest monitoring apiKey (AES-256-GCM), see
   * `@/lib/services/inferenceMonitoring/apiKeyVault`. Decrypt only when the
   * key is actually needed to poll the upstream server.
   */
  apiKeySealed?: string;
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
  /**
   * How the membership was granted. `directory` = applied by SSO/LDAP
   * provisioning (`invitedBy` is then `directory:oidc` / `directory:ldap`).
   * Absent on legacy rows — treat as `manual`.
   */
  source?: ProjectMembershipSource;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ProjectMembershipSource = 'manual' | 'directory';

// ── Groups / Teams ─────────────────────────────────────────────────────────

/** Origin of a group or membership record. Rows that come from a directory
 *  (`ldap`, `oidc`) are reconciled on each directory sign-in and must not be
 *  hand-edited in the console; `local` rows are never touched by a sync.
 *  `delegated`: a group created for the issuer of verified identity assertions,
 *  whose members follow the assertions' group claim (lib/iam/delegatedGroups.ts);
 *  like a directory group it is not edited by hand. */
export type GroupSource = 'local' | 'ldap' | 'oidc' | 'delegated';

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
