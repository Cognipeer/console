import type {
  AgentStatus,
  AgentTracingSessionEventDelta,
  AlertEventStatus,
  BrowserSessionStatus,
  BrowserStatus,
  GuardrailType,
  IAgent,
  IAgentConversation,
  IAgentConversationListItem,
  IAgentConversationSearchHit,
  AgentSessionRuntimeStatus,
  IAgentConversationState,
  IAgentPendingAction,
  IAgentMessageFeedback,
  AgentMessageFeedbackFilter,
  AgentMessageFeedbackTotals,
  IAgentSessionEvent,
  NewAgentSessionEvent,
  IAgentSkill,
  IAgentTracingEvent,
  IAgentTracingDashboardAggregate,
  IAgentTracingSession,
  IAgentVersion,
  IAuditLog,
  IWebhookDelivery,
  IWebhookEndpoint,
  WebhookDeliveryStatus,
  WebhookEndpointStatus,
  IAlertEvent,
  IAlertRule,
  IAlertState,
  IAlertDelivery,
  IAlertChannelLibraryEntry,
  IAlertStateFilter,
  AlertModule,
  IApiToken,
  IBrowser,
  IBrowserFlow,
  IBrowserFlowRun,
  BrowserFlowStatus,
  BrowserFlowRunStatus,
  IBrowserSession,
  IBrowserSessionEvent,
  ICrawler,
  ICrawlJob,
  ICrawlResult,
  CrawlJobStatus,
  CrawlerStatus,
  IAgentRun,
  AgentRunClass,
  IAgentTrigger,
  AgentTriggerPatch,
  NewAgentTrigger,
  IAgentTriggerDelivery,
  IOcrJob,
  IOcrJobItem,
  OcrJobStatus,
  OcrJobAggregateDelta,
  IBatchJob,
  IBatchJobItem,
  BatchJobStatus,
  BatchJobAggregateDelta,
  IConfigAuditLog,
  IConfigGroup,
  IConfigItem,
  IFileBucketRecord,
  IFileRecord,
  IFileEntriesPage,
  FileListPurpose,
  IGuardrail,
  IGuardrailEvalAggregate,
  IGuardrailEvaluationLog,
  IGuardrailWordList,
  IPiiPolicy,
  IIncident,
  IInferenceServer,
  IInferenceServerMetrics,
  IMcpAuditLog,
  IMcpRequestAggregate,
  IMcpRequestLog,
  McpLogServerScope,
  IMcpServer,
  IModel,
  IModelUsageAggregate,
  IModelUsageLog,
  IUsageDaily,
  IUsageDailyIncrement,
  EntityMetricsAggregateQuery,
  IEntityMetricAggregate,
  IEntityMetricIncrement,
  IMemoryItem,
  IMemoryStore,
  IPrompt,
  IPromptComment,
  IPromptVersion,
  IProject,
  IProviderRecord,
  IQuotaPolicy,
  IRagChunk,
  IRagDocument,
  IRagModule,
  IRagQueryLog,
  IRagReindexRun,
  IReranker,
  IRerankerRunLog,
  IWebSearchRunLog,
  RerankerStatus,
  ITenant,
  ITenantUserDirectoryEntry,
  ITool,
  IToolRequestAggregate,
  IToolRequestLog,
  IUser,
  IUserProject,
  IGroup,
  IGroupMember,
  IGroupProject,
  IInstanceAssignment,
  INodeRecord,
  InstanceEntityType,
  NodeStatus,
  IBetaAccessCode,
  BetaAccessCodeStatus,
  IIamDoc,
  IamCollectionName,
  IamPage,
  IamPageRequest,
  IamUserQuery,
  IamUserFilter,
  IamGroupQuery,
  IamGroupFilter,
  IamTokenQuery,
  IamTokenFilter,
  IamAuditQuery,
  IExternalModelPricing,
  IExternalPricingVersion,
  IModelPricing,
  IGpuHost,
  IGpuSlice,
  ILlmDeployment,
  IGpuFleetCommand,
  IGpuFleetEvent,
  IGpuFleetSettings,
  ILlmPool,
  GpuHostStatus,
  GpuFleetCommandStatus,
  ProjectRole,
  IVectorIndexRecord,
  IVectorQueryLog,
  IVectorQueryStats,
  IVectorMigration,
  IVectorMigrationLog,
  IVectorMigrationRunSummary,
  VectorMigrationStatus,
  VectorMigrationLogStatus,
  IncidentSeverity,
  IncidentSort,
  IIncidentStatRow,
  IncidentStatus,
  McpServerStatus,
  MemoryItemStatus,
  MemoryScope,
  MemoryStoreStatus,
  ModelCategory,
  ModelProviderType,
  ProviderDomain,
  RagDocumentStatus,
  ToolSourceType,
  ToolStatus,
  ISandboxRunner,
  ISandboxTemplate,
  ISandboxInstance,
  ISandboxCommand,
  ISandboxEvent,
  ISandboxVolume,
  ISandboxSettings,
  SandboxInstanceState,
  SandboxCommandStatus,
  IEvaluationTarget,
  IEvaluationDataset,
  IEvaluationDatasetItem,
  IEvaluationDatasetItemRecord,
  EvaluationDatasetItemQuery,
  IEvaluationSuite,
  IEvaluationRun,
  EvaluationTargetKind,
  EvaluationDatasetSource,
  EvaluationRunStatus,
  IRedTeamCampaign,
  IRedTeamRun,
  IRedTeamCustomProbe,
  RedTeamRunStatus,
  IAnalysisDefinition,
  IAnalysisConversation,
  IAnalysisRun,
  AnalysisConversationSource,
  AnalysisRunStatus,
} from './types';
import type { EnterpriseDbMethods } from '@/enterprise/registry';

// `EnterpriseDbMethods` is EMPTY in the community edition and augmented by the
// enterprise overlay (gpu-fleet + sandbox methods). See the cognipeer-console-ee repo (docs/licensing/MANIFEST.md).
export interface DatabaseProvider extends EnterpriseDbMethods {
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
  /** Returns the tenant DB currently bound to this request context, or null. */
  getCurrentTenantDbName(): string | null;
  /** Throws if the active tenant context does not match the expected tenant. */
  assertTenantContext(expectedTenantDbName: string): void;
  /**
   * Run `fn` with the given tenant DB bound for its entire (sync + async)
   * execution via a real AsyncLocalStorage scope. Unlike `switchToTenant`
   * (which relies on `enterWith` and can lose the binding across an `await`
   * boundary in the caller's continuation), this guarantees every nested query
   * resolves to the correct tenant even under concurrent requests for different
   * tenants. Optional so partial test doubles need not implement it.
   */
  runWithTenant?<T>(tenantDbName: string, fn: () => T | Promise<T>): Promise<T>;

  // Cross-tenant user directory (uses main/shared database)
  registerUserInDirectory(entry: ITenantUserDirectoryEntry): Promise<void>;
  unregisterUserFromDirectory(email: string, tenantId: string): Promise<void>;
  listTenantsForUser(email: string): Promise<ITenantUserDirectoryEntry[]>;

  // User operations (tenant-specific)
  findUserByEmail(email: string): Promise<IUser | null>;
  findUserById(id: string): Promise<IUser | null>;
  /** Looks up by external-directory identity (OIDC `sub`, LDAP DN, ...), not email. */
  findUserByExternalId(
    authProvider: NonNullable<IUser['authProvider']>,
    externalId: string,
  ): Promise<IUser | null>;
  createUser(
    user: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IUser>;
  updateUser(id: string, data: Partial<IUser>): Promise<IUser | null>;
  deleteUser(id: string): Promise<boolean>;
  /**
   * The workspace's people. Accounts of kind `external` (people of a host application whose identity a trusted issuer
   * vouched for) are left out unless `includeExternal` asks for them: every member list and picker means the workspace's
   * own people.
   */
  listUsers(options?: { includeExternal?: boolean }): Promise<IUser[]>;
  /**
   * The accounts that hold this identity (`externalIds[issuer] === subject`), oldest first (at most a handful - normally
   * one; a second is the loser of a race between two first sign-ins). Not indexed: callers cache the answer.
   */
  findUsersByExternalIdentity(issuer: string, subject: string): Promise<IUser[]>;
  /**
   * Record `externalIds[issuer] = subject` on an account unless it already holds another subject for that issuer:
   * `linked` (written), `already` (it held exactly this one) or `conflict` (it holds a different one) or `not_found`.
   */
  linkUserExternalIdentity(userId: string, issuer: string, subject: string): Promise<'linked' | 'already' | 'conflict' | 'not_found'>;
  /** How many `external` accounts the workspace has. */
  countExternalUsers(): Promise<number>;

  // Project membership (UserProject — replaces user.projectIds)
  findUserProject(userId: string, projectId: string): Promise<IUserProject | null>;
  listUserProjectsByUser(userId: string): Promise<IUserProject[]>;
  listUserProjectsByProject(projectId: string): Promise<IUserProject[]>;
  /** Every membership row of the tenant in one read (project stats / overview — no per-project N+1). */
  listUserProjectsByTenant(tenantId: string): Promise<IUserProject[]>;
  upsertUserProject(data: Omit<IUserProject, '_id' | 'createdAt' | 'updatedAt'>): Promise<IUserProject>;
  deleteUserProject(userId: string, projectId: string): Promise<boolean>;
  deleteUserProjectsByProject(projectId: string): Promise<void>;
  deleteUserProjectsByUser(userId: string): Promise<void>;

  // Groups / Teams (tenant + project scoped access grants)
  createGroup(data: Omit<IGroup, '_id' | 'createdAt' | 'updatedAt'>): Promise<IGroup>;
  findGroupById(id: string): Promise<IGroup | null>;
  /** Look up a directory-sourced group by its stable external id (e.g. LDAP DN). */
  findGroupByExternalId(externalId: string): Promise<IGroup | null>;
  listGroups(tenantId: string): Promise<IGroup[]>;
  updateGroup(
    id: string,
    data: Partial<Pick<IGroup, 'name' | 'description' | 'updatedBy' | 'tenantRole' | 'servicePermissions' | 'source' | 'externalId'>>,
  ): Promise<IGroup | null>;
  deleteGroup(id: string): Promise<boolean>;
  addGroupMember(data: Omit<IGroupMember, '_id' | 'createdAt'>): Promise<IGroupMember>;
  removeGroupMember(groupId: string, userId: string): Promise<boolean>;
  listGroupMembers(groupId: string): Promise<IGroupMember[]>;
  listGroupMembersByUser(userId: string): Promise<IGroupMember[]>;
  upsertGroupProject(data: Omit<IGroupProject, '_id' | 'createdAt' | 'updatedAt'>): Promise<IGroupProject>;
  removeGroupProject(groupId: string, projectId: string): Promise<boolean>;
  listGroupProjectsByProject(projectId: string): Promise<IGroupProject[]>;
  listGroupProjectsByGroup(groupId: string): Promise<IGroupProject[]>;
  /** Every group→project grant of the tenant in one read. */
  listGroupProjectsByTenant(tenantId: string): Promise<IGroupProject[]>;
  /** Every group membership row of the tenant in one read. */
  listGroupMembersByTenant(tenantId: string): Promise<IGroupMember[]>;
  /** Cascade helpers used when a group is deleted. */
  deleteGroupMembersByGroup(groupId: string): Promise<void>;
  deleteGroupProjectsByGroup(groupId: string): Promise<void>;

  // General audit logs (tenant-specific)
  createAuditLog(
    log: Omit<IAuditLog, '_id' | 'createdAt'>,
  ): Promise<IAuditLog>;
  listAuditLogs(filters?: {
    actorUserId?: string;
    outcome?: IAuditLog['outcome'];
    service?: string;
    action?: string;
    method?: string;
    /** Free-text match against event, path and actorEmail. */
    q?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    skip?: number;
  }): Promise<IAuditLog[]>;

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

  // Quota policies (tenant-specific)
  createQuotaPolicy(
    policy: Omit<IQuotaPolicy, '_id'>,
  ): Promise<IQuotaPolicy>;
  listQuotaPolicies(tenantId: string, projectId?: string): Promise<IQuotaPolicy[]>;
  /**
   * Policies that carry no project (`projectId` absent/null/empty). The quota
   * guard asks for them separately because `listQuotaPolicies(tenant, project)`
   * only ever returns that project's rows; see `isTenantWideKind` in
   * lib/quota/types.ts for which of them the guard actually applies.
   */
  listTenantWideQuotaPolicies(tenantId: string): Promise<IQuotaPolicy[]>;
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
  findApiTokenByHash(tokenHash: string): Promise<IApiToken | null>;
  /** One token by id inside a tenant. Null when it does not exist (a malformed id is "does not exist", not an error). */
  findApiTokenById(id: string, tenantId: string): Promise<IApiToken | null>;
  /**
   * Edit the mutable fields of a token (label, expiry, IP allowlist). Only the
   * keys present in `data` change; `expiresAt: null` / `allowedIpRanges: null`
   * clear the field. Null when the token does not exist in the tenant.
   */
  updateApiToken(
    id: string,
    tenantId: string,
    data: { label?: string; expiresAt?: Date | null; allowedIpRanges?: string[] | null; requireUserToken?: boolean },
  ): Promise<IApiToken | null>;
  deleteApiToken(id: string, userId: string): Promise<boolean>;
  deleteTenantApiToken(id: string, tenantId: string): Promise<boolean>;
  deleteProjectApiToken(id: string, tenantId: string, projectId: string): Promise<boolean>;
  updateTokenLastUsedByHash(tokenHash: string): Promise<void>;

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
  applyAgentTracingSessionEvent(
    sessionId: string,
    delta: AgentTracingSessionEventDelta,
    projectId?: string,
  ): Promise<void>;
  /**
   * Sessions still 'in_progress' whose last activity is older than `updatedBefore` (tenant-wide, oldest first).
   * `source` (e.g. 'otlp') restricts the scan to one ingest source, so a source-specific pass is not crowded out
   * of `limit` by other sources' idle sessions.
   */
  listStaleAgentTracingSessions(input: {
    updatedBefore: Date;
    limit: number;
    source?: string;
  }): Promise<IAgentTracingSession[]>;
  /**
   * Compare-and-set: marks a session 'abandoned' (endedAt = last activity,
   * durationMs = last activity - startedAt) only while it is still
   * 'in_progress' and idle since `updatedBefore`. Returns null when the CAS
   * missed (a late event or /end won).
   */
  abandonAgentTracingSession(input: {
    projectId: string;
    sessionId: string;
    updatedBefore: Date;
  }): Promise<IAgentTracingSession | null>;
  findAgentTracingSessionById(
    sessionId: string,
    projectId?: string,
  ): Promise<IAgentTracingSession | null>;
  listAgentTracingSessions(
    filters?: Record<string, unknown>,
    projectId?: string,
  ): Promise<{ sessions: IAgentTracingSession[]; total: number }>;
  aggregateAgentTracingDashboard(
    filters?: { from?: string; to?: string; timezone?: string },
    projectId?: string,
  ): Promise<IAgentTracingDashboardAggregate>;
  listAgentTracingThreads(
    filters?: Record<string, unknown>,
    projectId?: string,
  ): Promise<{ threads: Array<Record<string, unknown>>; total: number }>;

  // Agent Tracing Event operations (tenant-specific)
  createAgentTracingEvent(
    event: Omit<IAgentTracingEvent, '_id' | 'createdAt'>,
  ): Promise<IAgentTracingEvent>;
  findAgentTracingEventById(
    sessionId: string,
    eventId: string,
    projectId?: string,
  ): Promise<IAgentTracingEvent | null>;
  /**
   * Narrow, migration-only update for a single tracing event.
   *
   * Tracing events are otherwise write-once — ingest creates them and nothing
   * mutates them — so this deliberately accepts only the fields a data
   * migration needs, rather than a general `Partial<IAgentTracingEvent>` that
   * would invite drift between the two providers.
   */
  updateAgentTracingEvent(
    sessionId: string,
    eventId: string,
    data: Partial<Pick<IAgentTracingEvent, 'finishReason' | 'reasoningTokens' | 'metadata'>>,
    projectId?: string,
  ): Promise<IAgentTracingEvent | null>;
  listAgentTracingEvents(
    sessionId: string,
    projectId?: string,
    options?: {
      projection?: Record<string, 0 | 1>;
    },
  ): Promise<IAgentTracingEvent[]>;
  /**
   * Where a session stands on a person: the status of its latest event, and of its latest approval or question
   * event (`tool_approval` / `user_question`). Two single-row reads (highest sequence), no sections: the
   * finalizer's "is it waiting" check does not need the event list.
   */
  getAgentTracingWaitState(
    sessionId: string,
    projectId?: string,
  ): Promise<{ latestStatus?: string; latestHumanStatus?: string }>;
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

  // Agent skill library (tenant-specific) — see IAgentSkill
  createSkill(
    skill: Omit<IAgentSkill, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAgentSkill>;
  updateSkill(id: string, data: Partial<IAgentSkill>): Promise<IAgentSkill | null>;
  deleteSkill(id: string): Promise<boolean>;
  findSkillById(id: string, projectId?: string): Promise<IAgentSkill | null>;
  findSkillByKey(key: string, projectId?: string): Promise<IAgentSkill | null>;
  listSkills(filters?: {
    projectId?: string;
    status?: IAgentSkill['status'];
    search?: string;
  }): Promise<IAgentSkill[]>;

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
  /** Dynamic LLM attribution rows (child + decider) a router caused, newest
   *  first, without request/response payloads. Feeds routing analytics. */
  listRoutedUsageLogs(
    routerKey: string,
    options?: { from?: Date; to?: Date; limit?: number },
    projectId?: string,
  ): Promise<IModelUsageLog[]>;
  aggregateModelUsage(
    modelKey: string,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    projectId?: string,
  ): Promise<IModelUsageAggregate>;

  // Cross-service daily usage rollup (tenant-specific)
  /** Additive bulk upsert — one call per rollup flush, safe under concurrency. */
  incrementUsageDaily(rows: IUsageDailyIncrement[]): Promise<void>;
  /** Absolute costUsd overwrite by row id — retroactive repricing only. */
  setUsageDailyCost(updates: Array<{ id: string; costUsd: number }>): Promise<number>;
  listUsageDaily(filter: {
    projectId?: string;
    userId?: string;
    apiTokenId?: string;
    service?: string;
    refKey?: string;
    agentKey?: string;
    source?: string;
    fromDay?: string;
    toDay?: string;
    limit?: number;
  }): Promise<IUsageDaily[]>;

  // Entity health rollup (tenant-specific): 5-minute buckets per
  // (project, entity type, entity key, source) with a latency histogram.
  /** Additive bulk upsert (chunks of 500) - safe under concurrency. */
  incrementEntityMetrics(rows: IEntityMetricIncrement[]): Promise<void>;
  /** Sums every counter (max for latencyMsMax) over the half-open [fromMs, toMs) range, grouped by `groupBy` (+ optional time bucket). */
  aggregateEntityMetrics(q: EntityMetricsAggregateQuery): Promise<IEntityMetricAggregate[]>;
  /** Batched delete of buckets with `bucketMs < olderThanMs`; returns the number of rows deleted. */
  purgeEntityMetrics(input: { olderThanMs: number; batchSize?: number }): Promise<number>;

  // External model pricing (tenant-specific) — reference prices for models
  // observed via tracing that are not in the Model Hub.
  /** Case-insensitive upsert on (projectId, modelName). */
  upsertExternalModelPricing(entry: {
    tenantId: string;
    projectId?: string;
    modelName: string;
    pricing: IModelPricing;
    versions?: IExternalPricingVersion[];
    updatedBy?: string;
  }): Promise<IExternalModelPricing>;
  /** With projectId: that project's entries plus tenant-wide ('') ones. */
  listExternalModelPricing(projectId?: string): Promise<IExternalModelPricing[]>;
  deleteExternalModelPricing(modelName: string, projectId?: string): Promise<boolean>;

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
  /** Record one similarity query for the index analytics panel. */
  createVectorQueryLog(
    log: Omit<IVectorQueryLog, '_id'>,
  ): Promise<IVectorQueryLog>;
  /** Aggregate the query logs of one index for the analytics panel. */
  aggregateVectorQueryStats(params: {
    indexKey: string;
    from: Date;
    to: Date;
  }): Promise<IVectorQueryStats>;
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

  // Vector migration operations (tenant-specific)
  createVectorMigration(
    migration: Omit<IVectorMigration, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IVectorMigration>;
  updateVectorMigration(
    key: string,
    data: Partial<Omit<IVectorMigration, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IVectorMigration | null>;
  deleteVectorMigration(key: string): Promise<boolean>;
  listVectorMigrations(filters?: {
    projectId?: string;
    status?: VectorMigrationStatus;
    statuses?: VectorMigrationStatus[];
  }): Promise<IVectorMigration[]>;
  findVectorMigrationByKey(key: string): Promise<IVectorMigration | null>;
  createVectorMigrationLog(
    log: Omit<IVectorMigrationLog, '_id' | 'createdAt'>,
  ): Promise<IVectorMigrationLog>;
  listVectorMigrationLogs(
    migrationKey: string,
    options?: { limit?: number; offset?: number; attempt?: number },
  ): Promise<IVectorMigrationLog[]>;
  countVectorMigrationLogs(
    migrationKey: string,
    status?: VectorMigrationLogStatus,
    attempt?: number,
  ): Promise<number>;
  /** Per-run (per-attempt) batch stats, most recent run first. */
  listVectorMigrationRuns(migrationKey: string): Promise<IVectorMigrationRunSummary[]>;

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
    /** Only keys under this prefix, however deep (a flat, recursive listing). */
    prefix?: string;
    purpose?: FileListPurpose;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: IFileRecord[]; nextCursor?: string }>;
  /**
   * A bucket as folders, like an object store listing with a `/` delimiter:
   * the sub-folders under `prefix` (a folder path, `''` = the bucket root) and
   * the files directly in it, in key order. The folders are derived from the keys
   * — walking the key index, one probe per entry returned, never a scan of the
   * whole bucket. `cursor` is the path of the last entry of the previous page.
   */
  listFileEntries(filters: {
    providerKey: string;
    bucketKey: string;
    projectId?: string;
    prefix: string;
    purpose?: FileListPurpose;
    limit?: number;
    cursor?: string;
  }): Promise<IFileEntriesPage>;

  /** Every file of an agent session (`purpose: 'conversation'`), oldest first. */
  listFileRecordsByConversation(conversationId: string): Promise<IFileRecord[]>;
  /** Session files whose `expiresAt` has passed, for the retention sweep. */
  listExpiredConversationFiles(before: Date, limit: number): Promise<IFileRecord[]>;

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
  /**
   * Three DIFFERENT questions, told apart by `projectId`:
   *   - a string  → that project's row only (`projectId = ?`, which excludes NULL);
   *   - `null`    → the TENANT-WIDE row only (`projectId IS NULL` / `{ projectId: null }`);
   *   - undefined → no project clause: the first row with that key in ANY project.
   * Keys are unique per project, not per tenant, so `undefined` is ambiguous the
   * moment two projects share a key. Every runtime fallback ("project first,
   * then workspace-wide") must pass `null`; `undefined` is for callers that
   * genuinely mean "any" (an owner/admin lookup, a legacy migration).
   * The same rule applies to `findGuardrailWordListByKey` and `findPiiPolicyByKey`.
   */
  findGuardrailByKey(key: string, projectId?: string | null): Promise<IGuardrail | null>;
  listGuardrails(filters?: {
    projectId?: string;
    type?: GuardrailType;
    enabled?: boolean;
    search?: string;
  }): Promise<IGuardrail[]>;


  // ── Guardrail word lists (tenant-managed banned-word lists) ──
  createGuardrailWordList(
    list: Omit<IGuardrailWordList, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IGuardrailWordList>;
  updateGuardrailWordList(
    id: string,
    data: Partial<Omit<IGuardrailWordList, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IGuardrailWordList | null>;
  deleteGuardrailWordList(id: string): Promise<boolean>;
  findGuardrailWordListById(id: string): Promise<IGuardrailWordList | null>;
  /** `projectId` semantics as documented on `findGuardrailByKey`. */
  findGuardrailWordListByKey(key: string, projectId?: string | null): Promise<IGuardrailWordList | null>;
  listGuardrailWordLists(filters?: {
    projectId?: string;
    search?: string;
  }): Promise<IGuardrailWordList[]>;

  // ── Guardrail evaluation logs ──
  createGuardrailEvaluationLog(
    log: Omit<IGuardrailEvaluationLog, '_id' | 'createdAt'>,
  ): Promise<void>;
  listGuardrailEvaluationLogs(
    guardrailId: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date; passed?: boolean },
  ): Promise<IGuardrailEvaluationLog[]>;
  aggregateGuardrailEvaluations(
    guardrailId: string,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
  ): Promise<IGuardrailEvalAggregate>;

  // ── Evaluation operations (tenant-specific) ──
  createEvaluationTarget(
    target: Omit<IEvaluationTarget, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IEvaluationTarget>;
  updateEvaluationTarget(
    id: string,
    data: Partial<Omit<IEvaluationTarget, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IEvaluationTarget | null>;
  deleteEvaluationTarget(id: string): Promise<boolean>;
  findEvaluationTargetById(id: string): Promise<IEvaluationTarget | null>;
  findEvaluationTargetByKey(key: string, projectId?: string): Promise<IEvaluationTarget | null>;
  listEvaluationTargets(filters?: {
    projectId?: string;
    kind?: EvaluationTargetKind;
    search?: string;
  }): Promise<IEvaluationTarget[]>;

  // Dataset writes still ACCEPT an inline `items` array for compatibility —
  // the provider routes it to the separate item collection (create inserts,
  // update replaces) and maintains `itemCount`; returned/listed datasets
  // never carry `items`. Reads go through the item methods below, which
  // transparently serve legacy documents whose items are still embedded.
  createEvaluationDataset(
    dataset: Omit<IEvaluationDataset, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IEvaluationDataset>;
  updateEvaluationDataset(
    id: string,
    data: Partial<Omit<IEvaluationDataset, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IEvaluationDataset | null>;
  deleteEvaluationDataset(id: string): Promise<boolean>;
  findEvaluationDatasetById(id: string): Promise<IEvaluationDataset | null>;
  findEvaluationDatasetByKey(key: string, projectId?: string): Promise<IEvaluationDataset | null>;
  listEvaluationDatasets(filters?: {
    projectId?: string;
    source?: EvaluationDatasetSource;
    search?: string;
  }): Promise<IEvaluationDataset[]>;

  // ── Dataset items (separate collection; ordered by `position`) ──
  /** Append items after the current last position. Rejects duplicate item ids. */
  createEvaluationDatasetItems(datasetId: string, items: IEvaluationDatasetItem[]): Promise<number>;
  /** Replace ALL items of the dataset (positions renumbered 0..n-1). */
  replaceEvaluationDatasetItems(datasetId: string, items: IEvaluationDatasetItem[]): Promise<number>;
  listEvaluationDatasetItems(
    datasetId: string,
    options?: EvaluationDatasetItemQuery,
  ): Promise<IEvaluationDatasetItemRecord[]>;
  countEvaluationDatasetItems(
    datasetId: string,
    search?: string,
    filters?: Omit<EvaluationDatasetItemQuery, 'skip' | 'limit' | 'search'>,
  ): Promise<number>;
  findEvaluationDatasetItem(datasetId: string, itemId: string): Promise<IEvaluationDatasetItemRecord | null>;
  updateEvaluationDatasetItem(
    datasetId: string,
    itemId: string,
    data: Partial<Omit<IEvaluationDatasetItem, 'id'>>,
  ): Promise<IEvaluationDatasetItemRecord | null>;
  deleteEvaluationDatasetItem(datasetId: string, itemId: string): Promise<boolean>;

  createEvaluationSuite(
    suite: Omit<IEvaluationSuite, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IEvaluationSuite>;
  updateEvaluationSuite(
    id: string,
    data: Partial<Omit<IEvaluationSuite, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IEvaluationSuite | null>;
  deleteEvaluationSuite(id: string): Promise<boolean>;
  findEvaluationSuiteById(id: string): Promise<IEvaluationSuite | null>;
  findEvaluationSuiteByKey(key: string, projectId?: string): Promise<IEvaluationSuite | null>;
  listEvaluationSuites(filters?: {
    projectId?: string;
    targetKey?: string;
    datasetKey?: string;
    search?: string;
  }): Promise<IEvaluationSuite[]>;

  createEvaluationRun(
    run: Omit<IEvaluationRun, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IEvaluationRun>;
  updateEvaluationRun(
    id: string,
    data: Partial<Omit<IEvaluationRun, 'tenantId' | 'suiteKey' | 'createdBy'>>,
  ): Promise<IEvaluationRun | null>;
  findEvaluationRunById(id: string): Promise<IEvaluationRun | null>;
  listEvaluationRuns(filters?: {
    projectId?: string;
    suiteKey?: string;
    status?: EvaluationRunStatus;
    limit?: number;
    skip?: number;
  }): Promise<IEvaluationRun[]>;

  // ── Red-team operations (tenant-specific) ──
  createRedTeamCampaign(
    campaign: Omit<IRedTeamCampaign, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IRedTeamCampaign>;
  updateRedTeamCampaign(
    id: string,
    data: Partial<Omit<IRedTeamCampaign, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IRedTeamCampaign | null>;
  deleteRedTeamCampaign(id: string): Promise<boolean>;
  findRedTeamCampaignById(id: string): Promise<IRedTeamCampaign | null>;
  findRedTeamCampaignByKey(key: string, projectId?: string): Promise<IRedTeamCampaign | null>;
  listRedTeamCampaigns(filters?: {
    projectId?: string;
    targetKind?: IRedTeamCampaign['targetKind'];
    search?: string;
  }): Promise<IRedTeamCampaign[]>;

  createRedTeamRun(
    run: Omit<IRedTeamRun, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IRedTeamRun>;
  updateRedTeamRun(
    id: string,
    data: Partial<Omit<IRedTeamRun, 'tenantId' | 'campaignKey' | 'createdBy'>>,
  ): Promise<IRedTeamRun | null>;
  findRedTeamRunById(id: string): Promise<IRedTeamRun | null>;
  listRedTeamRuns(filters?: {
    projectId?: string;
    campaignKey?: string;
    status?: RedTeamRunStatus;
    limit?: number;
    skip?: number;
  }): Promise<IRedTeamRun[]>;

  createRedTeamCustomProbe(
    probe: Omit<IRedTeamCustomProbe, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IRedTeamCustomProbe>;
  updateRedTeamCustomProbe(
    id: string,
    data: Partial<Omit<IRedTeamCustomProbe, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IRedTeamCustomProbe | null>;
  deleteRedTeamCustomProbe(id: string): Promise<boolean>;
  findRedTeamCustomProbeById(id: string): Promise<IRedTeamCustomProbe | null>;
  findRedTeamCustomProbeByKey(key: string, projectId?: string): Promise<IRedTeamCustomProbe | null>;
  listRedTeamCustomProbes(filters?: {
    projectId?: string;
    search?: string;
  }): Promise<IRedTeamCustomProbe[]>;

  // ── Analysis operations (tenant-specific) ──
  createAnalysisDefinition(
    definition: Omit<IAnalysisDefinition, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAnalysisDefinition>;
  updateAnalysisDefinition(
    id: string,
    data: Partial<Omit<IAnalysisDefinition, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IAnalysisDefinition | null>;
  deleteAnalysisDefinition(id: string): Promise<boolean>;
  findAnalysisDefinitionById(id: string): Promise<IAnalysisDefinition | null>;
  findAnalysisDefinitionByKey(key: string, projectId?: string): Promise<IAnalysisDefinition | null>;
  listAnalysisDefinitions(filters?: {
    projectId?: string;
    search?: string;
  }): Promise<IAnalysisDefinition[]>;

  createAnalysisConversation(
    conversation: Omit<IAnalysisConversation, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAnalysisConversation>;
  updateAnalysisConversation(
    id: string,
    data: Partial<Omit<IAnalysisConversation, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IAnalysisConversation | null>;
  deleteAnalysisConversation(id: string): Promise<boolean>;
  findAnalysisConversationById(id: string): Promise<IAnalysisConversation | null>;
  findAnalysisConversationByKey(key: string, projectId?: string): Promise<IAnalysisConversation | null>;
  listAnalysisConversations(filters?: {
    projectId?: string;
    source?: AnalysisConversationSource;
    tag?: string;
    search?: string;
    limit?: number;
    skip?: number;
  }): Promise<IAnalysisConversation[]>;

  createAnalysisRun(
    run: Omit<IAnalysisRun, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAnalysisRun>;
  updateAnalysisRun(
    id: string,
    data: Partial<Omit<IAnalysisRun, 'tenantId' | 'definitionKey' | 'createdBy'>>,
  ): Promise<IAnalysisRun | null>;
  findAnalysisRunById(id: string): Promise<IAnalysisRun | null>;
  listAnalysisRuns(filters?: {
    projectId?: string;
    definitionKey?: string;
    status?: AnalysisRunStatus;
    limit?: number;
    skip?: number;
  }): Promise<IAnalysisRun[]>;

  // ── PII policy operations (tenant-specific) ──
  createPiiPolicy(
    policy: Omit<IPiiPolicy, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IPiiPolicy>;
  updatePiiPolicy(
    id: string,
    data: Partial<Omit<IPiiPolicy, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IPiiPolicy | null>;
  deletePiiPolicy(id: string): Promise<boolean>;
  findPiiPolicyById(id: string): Promise<IPiiPolicy | null>;
  /** `projectId` semantics as documented on `findGuardrailByKey`. */
  findPiiPolicyByKey(key: string, projectId?: string | null): Promise<IPiiPolicy | null>;
  listPiiPolicies(filters?: {
    projectId?: string;
    enabled?: boolean;
    search?: string;
  }): Promise<IPiiPolicy[]>;

  // ── Alert rule operations (tenant-specific) ──
  // `projectId`, when given, filters by project inside the query (a rule of
  // another project reads as missing).
  createAlertRule(
    rule: Omit<IAlertRule, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAlertRule>;
  updateAlertRule(
    id: string,
    data: Partial<Omit<IAlertRule, 'tenantId' | 'createdBy'>>,
    projectId?: string,
  ): Promise<IAlertRule | null>;
  deleteAlertRule(id: string, projectId?: string): Promise<boolean>;
  findAlertRuleById(id: string, projectId?: string): Promise<IAlertRule | null>;
  listAlertRules(
    tenantId: string,
    filters?: { projectId?: string; enabled?: boolean },
  ): Promise<IAlertRule[]>;

  // ── Alert event (history) operations (tenant-specific) ──
  createAlertEvent(
    event: Omit<IAlertEvent, '_id'>,
  ): Promise<IAlertEvent>;
  findAlertEventById(id: string, projectId?: string): Promise<IAlertEvent | null>;
  listAlertEvents(
    tenantId: string,
    options?: {
      projectId?: string;
      ruleId?: string;
      status?: AlertEventStatus;
      /** Clamped to 1..200. */
      limit?: number;
      skip?: number;
    },
  ): Promise<IAlertEvent[]>;
  updateAlertEvent(
    id: string,
    data: Partial<IAlertEvent>,
  ): Promise<IAlertEvent | null>;
  countActiveAlerts(tenantId: string, projectId?: string): Promise<number>;
  /** Minimal (ruleId, firedAt) rows of alert events fired at or after `since`, newest first (one fire = one event). Capped. */
  listAlertFirings(
    tenantId: string,
    options: { projectId?: string; since: Date; limit?: number },
  ): Promise<Array<{ ruleId: string; firedAt: Date }>>;

  // ── Alert delivery log (tenant-specific) ──
  createAlertDeliveries(rows: Array<Omit<IAlertDelivery, '_id'>>): Promise<void>;
  /** Newest first; clamped to 1..200. */
  listAlertDeliveries(
    tenantId: string,
    options: { incidentId?: string; ruleId?: string; limit?: number },
  ): Promise<IAlertDelivery[]>;
  /** Retention: removes rows whose attemptAt is older than `before`; returns the number removed. */
  pruneAlertDeliveries(before: Date): Promise<number>;

  // ── Scheduler claims (tenant-specific; exactly-once primitive) ──
  /**
   * Insert-once claim: true only for the single caller that created `key`
   * (the database arbitrates); false when it was already claimed.
   */
  claimSchedulerSlot(key: string, expiresAt: Date): Promise<boolean>;
  /** Retention: removes claims whose expiresAt is before `olderThan`; returns the number removed. */
  cleanupSchedulerClaims(olderThan: Date): Promise<number>;

  // ── Agent triggers (tenant-specific) ──
  createAgentTrigger(record: NewAgentTrigger): Promise<IAgentTrigger>;
  /** Scoped by tenant AND project: an id of another project's trigger is not found. */
  getAgentTrigger(id: string, tenantId: string, projectId: string): Promise<IAgentTrigger | null>;
  /** Oldest first. */
  listAgentTriggers(filter: { tenantId: string; projectId: string; agentKey?: string }): Promise<IAgentTrigger[]>;
  /**
   * The updated trigger, or null when it does not exist in that scope. A patch
   * with a `type` replaces the trigger's type settings as a whole: the settings
   * objects of its other types are dropped.
   */
  updateAgentTrigger(id: string, tenantId: string, projectId: string, patch: AgentTriggerPatch): Promise<IAgentTrigger | null>;
  deleteAgentTrigger(id: string, tenantId: string, projectId: string): Promise<boolean>;
  /** Removes every trigger of an agent (the agent was deleted); returns the number removed. */
  deleteAgentTriggersForAgent(tenantId: string, projectId: string, agentKey: string): Promise<number>;
  /** Enabled triggers whose `nextFireAt` is at or before `now`, the most overdue first. */
  listDueTriggers(now: Date, limit: number): Promise<IAgentTrigger[]>;
  /**
   * Moves `nextFireAt` from `from` to `next` (CAS: false when it is no longer
   * `from` — another scheduler advanced it, or an edit recomputed it).
   */
  advanceTriggerNextFire(id: string, from: Date, next: Date | null): Promise<boolean>;
  /**
   * Records the outcome of one fire (CAS on `lastFireAt`: an older fire landing
   * late never overwrites a newer one). False when a newer fire is recorded.
   */
  setTriggerFireResult(
    id: string,
    result: { fireAt: Date; status: 'started' | 'failed'; runId?: string | null; error?: string | null },
  ): Promise<boolean>;
  /** The trigger whose `webhook` has this hook id (tenant DB), or null. */
  findAgentTriggerByHookId(hookId: string): Promise<IAgentTrigger | null>;

  // ── Agent trigger webhook deliveries (tenant-specific) ──
  recordAgentTriggerDelivery(record: Omit<IAgentTriggerDelivery, '_id'>): Promise<IAgentTriggerDelivery>;
  /** Newest first; `before` = a delivery id of the previous page (the rows after it). */
  listAgentTriggerDeliveries(filter: {
    tenantId: string;
    projectId: string;
    triggerId: string;
    limit: number;
    before?: string;
  }): Promise<IAgentTriggerDelivery[]>;
  /** Retention: removes up to `batchSize` deliveries whose `expiresAt` is before `olderThan`. */
  cleanupAgentTriggerDeliveryRetention(options: { olderThan: Date; batchSize: number }): Promise<{ deletedCount: number }>;
  /** Removes a trigger's delivery log (the trigger, or its agent, was deleted). */
  deleteAgentTriggerDeliveries(triggerId: string): Promise<number>;

  // ── Alert evaluation state (tenant-specific) ──
  listAlertStates(filter: IAlertStateFilter): Promise<IAlertState[]>;
  /** Keyed by the unique (tenantId, ruleId, entityKey). */
  upsertAlertState(state: Omit<IAlertState, '_id' | 'updatedAt'>): Promise<IAlertState>;
  deleteAlertStates(filter: { ruleId: string; entityKeys?: string[] }): Promise<number>;

  // ── Alert channel library (tenant-wide; lazily created storage) ──
  listAlertChannelLibrary(tenantId: string): Promise<IAlertChannelLibraryEntry[]>;
  findAlertChannelLibraryEntry(id: string): Promise<IAlertChannelLibraryEntry | null>;
  createAlertChannelLibraryEntry(
    entry: Omit<IAlertChannelLibraryEntry, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAlertChannelLibraryEntry>;
  updateAlertChannelLibraryEntry(
    id: string,
    data: Partial<Pick<IAlertChannelLibraryEntry, 'name' | 'config'>>,
  ): Promise<IAlertChannelLibraryEntry | null>;
  deleteAlertChannelLibraryEntry(id: string): Promise<boolean>;

  // ── Incident operations (tenant-specific) ──
  createIncident(
    incident: Omit<IIncident, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IIncident>;
  updateIncident(
    id: string,
    data: Partial<Omit<IIncident, 'tenantId' | 'alertEventId' | 'ruleId'>>,
    projectId?: string,
  ): Promise<IIncident | null>;
  findIncidentById(id: string, projectId?: string): Promise<IIncident | null>;
  findIncidentByAlertEventId(alertEventId: string): Promise<IIncident | null>;
  listIncidents(
    tenantId: string,
    options?: {
      projectId?: string;
      ruleId?: string;
      status?: IncidentStatus;
      severity?: IncidentSeverity;
      entityKey?: string;
      module?: AlertModule;
      /** Only rows whose `updatedAt` is strictly after this instant (live refresh). */
      updatedAfter?: Date;
      /** Only rows fired at or after this instant. */
      firedAfter?: Date;
      /** Case/Turkish-i-insensitive substring over ruleName, entityKey and metric (literal, no wildcards). */
      q?: string;
      /** A user id, or null for unassigned. Undefined = no filter. */
      assignee?: string | null;
      /** true = snoozedUntil in the future; false = not snoozed (never snoozed or expired). */
      snoozed?: boolean;
      /** Row to leave out (similar incidents). */
      excludeId?: string;
      /** Default `-firedAt`. A leading `-` is descending; severity ranks critical > warning > info. */
      sort?: IncidentSort;
      /** Clamped to 1..200. */
      limit?: number;
      skip?: number;
    },
  ): Promise<IIncident[]>;
  /**
   * The minimal fields stats need, for a project: incidents fired at/after `firedSince`
   * and/or resolved at/after `resolvedSince` (union), newest first, at most `limit` (<= 5000).
   */
  listIncidentStatRows(
    projectId: string,
    options: { firedSince?: Date; resolvedSince?: Date; limit?: number },
  ): Promise<IIncidentStatRow[]>;
  countIncidents(
    tenantId: string,
    options?: { projectId?: string; status?: IncidentStatus },
  ): Promise<number>;
  /** Incident counts per status for one project (every status present, 0 when none). */
  countIncidentsByStatus(projectId: string): Promise<Record<IncidentStatus, number>>;

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
  findRagDocumentByFileName(
    ragModuleKey: string,
    fileName: string,
    projectId?: string,
  ): Promise<IRagDocument | null>;
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
    options?: {
      limit?: number;
      skip?: number;
      from?: Date;
      to?: Date;
      /** Only queries that returned nothing — the content-gap feed. */
      zeroOnly?: boolean;
      /** Scope to one project; module keys are unique only within a project. */
      projectId?: string;
    },
  ): Promise<IRagQueryLog[]>;
  countRagQueryLogs(
    ragModuleKey: string,
    options?: { from?: Date; to?: Date; projectId?: string },
  ): Promise<{
    total: number;
    avgLatencyMs: number;
    /** Queries that returned no matches at all. */
    zeroMatchCount: number;
    /**
     * Queries where the store DID return candidates and the minScore threshold
     * discarded every one of them — a tuning problem, not a content gap.
     */
    minScoreFilteredCount: number;
  }>;
  /**
   * Histogram of the best score per query, bucketed to one decimal, so the
   * minScore slider can be set against the module's real distribution instead
   * of guessed at.
   */
  aggregateRagQueryScoreDistribution(
    ragModuleKey: string,
    options?: { from?: Date; to?: Date; projectId?: string },
  ): Promise<Array<{ bucket: string; count: number }>>;
  /** Retention: query text is stored in full, so this table cannot grow forever. */
  deleteRagQueryLogsOlderThan(before: Date, ragModuleKey?: string): Promise<number>;

  // ── RAG module teardown (tenant-specific) ──
  /**
   * Deleting a module used to orphan every document, chunk and vector it owned.
   * These make the cascade expressible.
   */
  deleteRagDocumentsByModuleKey(ragModuleKey: string): Promise<number>;
  deleteRagChunksByModuleKey(ragModuleKey: string): Promise<number>;
  /**
   * How many modules point at the same vector index. Two modules sharing one
   * index silently cross-contaminate unless isolation is on.
   */
  countRagModulesByVectorIndexKey(
    vectorIndexKey: string,
    options?: { projectId?: string; excludeKey?: string },
  ): Promise<number>;

  // ── RAG re-index runs (tenant-specific) ──
  createRagReindexRun(
    run: Omit<IRagReindexRun, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IRagReindexRun>;
  updateRagReindexRun(
    key: string,
    data: Partial<Omit<IRagReindexRun, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IRagReindexRun | null>;
  findRagReindexRunByKey(key: string): Promise<IRagReindexRun | null>;
  listRagReindexRuns(filters?: {
    ragModuleKey?: string;
    projectId?: string;
    statuses?: IRagReindexRun['status'][];
    limit?: number;
  }): Promise<IRagReindexRun[]>;
  deleteRagReindexRun(key: string): Promise<boolean>;
  /**
   * Take ownership of a run in ONE atomic statement. Matches only when the run
   * is pending/queued/running AND it is unclaimed, already ours, or its
   * heartbeat is older than `staleBefore`. Returns null — without writing —
   * when another live worker owns it.
   */
  claimRagReindexRun(
    key: string,
    ownerId: string,
    staleBefore: Date,
  ): Promise<IRagReindexRun | null>;
  /** Refresh the heartbeat while still held; false means the claim was lost. */
  touchRagReindexRunClaim(key: string, ownerId: string): Promise<boolean>;
  /** Give the claim up, only if we still hold it. */
  releaseRagReindexRunClaim(key: string, ownerId: string): Promise<void>;

  // ── Reranker operations (tenant-specific) ──
  createReranker(
    reranker: Omit<IReranker, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IReranker>;
  updateReranker(
    id: string,
    data: Partial<Omit<IReranker, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IReranker | null>;
  deleteReranker(id: string): Promise<boolean>;
  findRerankerById(id: string): Promise<IReranker | null>;
  findRerankerByKey(key: string, projectId?: string): Promise<IReranker | null>;
  listRerankers(filters?: {
    projectId?: string;
    status?: RerankerStatus;
    search?: string;
  }): Promise<IReranker[]>;

  createRerankerRunLog(
    log: Omit<IRerankerRunLog, '_id' | 'createdAt'>,
  ): Promise<IRerankerRunLog>;
  listRerankerRunLogs(
    rerankerKey: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date },
  ): Promise<IRerankerRunLog[]>;

  // ── Web Search operations (tenant-specific) ──
  createWebSearchRunLog(
    log: Omit<IWebSearchRunLog, '_id' | 'createdAt'>,
  ): Promise<IWebSearchRunLog>;
  listWebSearchRunLogs(
    searchKey: string,
    options?: { limit?: number; skip?: number; from?: Date; to?: Date },
  ): Promise<IWebSearchRunLog[]>;

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

  // ── Tool operations (tenant-specific) ──
  createTool(
    tool: Omit<ITool, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ITool>;
  updateTool(
    id: string,
    data: Partial<Omit<ITool, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<ITool | null>;
  deleteTool(id: string): Promise<boolean>;
  findToolById(id: string): Promise<ITool | null>;
  findToolByKey(key: string, projectId?: string | null): Promise<ITool | null>;
  listTools(filters?: {
    projectId?: string;
    type?: ToolSourceType;
    status?: ToolStatus;
    search?: string;
  }): Promise<ITool[]>;
  countTools(projectId?: string): Promise<number>;

  // ── Tool Request Log operations (tenant-specific) ──
  createToolRequestLog(
    log: Omit<IToolRequestLog, '_id' | 'createdAt'>,
  ): Promise<IToolRequestLog>;
  listToolRequestLogs(
    toolKey: string,
    options?: {
      limit?: number;
      skip?: number;
      from?: Date;
      to?: Date;
      status?: string;
      actionKey?: string;
      keyword?: string;
    },
  ): Promise<IToolRequestLog[]>;
  countToolRequestLogs(
    toolKey: string,
    options?: { from?: Date; to?: Date; status?: string; actionKey?: string; keyword?: string },
  ): Promise<number>;
  aggregateToolRequestLogs(
    toolKey: string,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
  ): Promise<IToolRequestAggregate>;

  // ── Agent operations (tenant-specific) ──
  createAgent(
    agent: Omit<IAgent, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAgent>;
  updateAgent(
    id: string,
    data: Partial<Omit<IAgent, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IAgent | null>;
  deleteAgent(id: string): Promise<boolean>;
  findAgentById(id: string): Promise<IAgent | null>;
  findAgentByKey(key: string, projectId?: string): Promise<IAgent | null>;
  listAgents(filters?: {
    projectId?: string;
    status?: AgentStatus;
    search?: string;
  }): Promise<IAgent[]>;
  countAgents(projectId?: string): Promise<number>;

  // ── Agent Version operations (tenant-specific) ──
  createAgentVersion(
    version: Omit<IAgentVersion, '_id' | 'createdAt'>,
  ): Promise<IAgentVersion>;
  findAgentVersion(
    agentId: string,
    version: number,
  ): Promise<IAgentVersion | null>;
  findLatestAgentVersion(
    agentId: string,
  ): Promise<IAgentVersion | null>;
  listAgentVersions(
    agentId: string,
    options?: { limit?: number; skip?: number },
  ): Promise<{ versions: IAgentVersion[]; total: number }>;

  // ── Agent Conversation operations (tenant-specific) ──
  createAgentConversation(
    conversation: Omit<IAgentConversation, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAgentConversation>;
  updateAgentConversation(
    id: string,
    data: Partial<Omit<IAgentConversation, 'tenantId' | 'agentKey' | 'createdBy'>>,
  ): Promise<IAgentConversation | null>;
  /**
   * Writes only the runtime fields (`runtimeStatus`, `stopReason`,
   * `pendingActionIds`, `lastEventSeq`, `transcriptHash`, and the session `budget` / `spentUsd`;
   * `budget: null` removes the budget) — no `updatedAt` bump, no re-read. The
   * session event recorder calls this around every turn, so it stays much
   * cheaper than `updateAgentConversation` and cannot be mistaken for a
   * transcript write.
   *
   * `runtimeTurnId` names the turn that owns the fields (a turn writes it when it
   * starts). With `options.onlyIfTurn` the write is conditional on that: it
   * happens only when the stored owner is that turn or nobody (a session from
   * before owners were recorded), and the result says whether it did — `false`
   * means a newer turn has taken over and the caller must not report its own end
   * (anything else — `true`, or nothing from a minimal implementation — means written).
   */
  updateAgentConversationRuntime(
    id: string,
    patch: Partial<Pick<IAgentConversation, 'runtimeStatus' | 'stopReason' | 'pendingActionIds' | 'lastEventSeq' | 'budget' | 'spentUsd' | 'runtimeTurnId' | 'transcriptHash'>>,
    options?: { onlyIfTurn?: string },
  ): Promise<boolean | void>;
  /**
   * Atomically moves the session's running spend total (`spentUsd`): first up to
   * `atLeastUsd` when it is below that (a missing total counts as 0), then by
   * `addUsd`. The database does the arithmetic, so two writers that spend at the
   * same time both land — reading the total and writing back a sum lets the last
   * writer erase the other's. Never lowers the total.
   */
  addAgentConversationSpend(id: string, change: { addUsd?: number; atLeastUsd?: number }): Promise<void>;
  deleteAgentConversation(id: string): Promise<boolean>;
  findAgentConversationById(id: string): Promise<IAgentConversation | null>;
  /**
   * The sessions `createdBy` started on `agentKey` in `projectId` whose last chat-completions turn left
   * `transcriptHash`, most recently updated first, at most `limit` (more than one = an ambiguous match).
   */
  findAgentConversationsByTranscriptHash(filter: {
    projectId: string;
    agentKey: string;
    createdBy: string;
    transcriptHash: string;
  }, limit: number): Promise<IAgentConversation[]>;
  listAgentConversations(
    agentKey: string,
    filters?: {
      projectId?: string;
      limit?: number;
      skip?: number;
      /** Only the sessions this user started (the list of a caller who may not see other people's). */
      createdBy?: string;
    },
  ): Promise<IAgentConversation[]>;
  /**
   * Conversations whose title or message text contains `search` (case-insensitive, literal), newest updated
   * first, without transcripts, each with where it first matched. `agentKeys` limits it to those agents (an
   * empty list matches nothing); `createdBy` to one person's sessions. A `search` shorter than 2 characters
   * matches nothing; longer than 200 is cut.
   */
  searchAgentConversations(filters: {
    projectId: string;
    search: string;
    agentKeys?: string[];
    createdBy?: string;
    limit?: number;
    skip?: number;
  }): Promise<IAgentConversationSearchHit[]>;
  /**
   * A page of a project's conversations, newest created first (`createdAt`, then
   * id), without their transcripts. `runtimeStatus: 'idle'` also matches a
   * conversation that has never run. `after` is the keyset of the last row of the
   * previous page.
   */
  listAgentConversationPage(filters: {
    projectId: string;
    agentKey?: string;
    runtimeStatus?: AgentSessionRuntimeStatus;
    limit: number;
    after?: { createdAt: Date; id: string };
    /**
     * The caller may view other people's sessions of only some agents (`viewableAgentKeys`; none when absent):
     * a row is returned when `userId` started it or its agent is one of those; a row of any other agent - one
     * that no longer exists included - is returned only to the person who started it.
     * Applied before the page is cut, so a busy teammate cannot push the caller's own sessions off it.
     */
    ownOnly?: { userId: string; viewableAgentKeys?: string[] };
  }): Promise<IAgentConversationListItem[]>;
  /** The runtime state a conversation's last turn ended in — see `IAgentConversationState`. */
  findAgentConversationState(conversationId: string): Promise<IAgentConversationState | null>;
  /** Upsert by `conversationId`. */
  saveAgentConversationState(
    state: Omit<IAgentConversationState, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<void>;
  deleteAgentConversationState(conversationId: string): Promise<boolean>;

  // ── Agent session event log (tenant-specific, append-only) ──
  /**
   * Appends events. A `(conversationId, seq)` that already exists makes the whole
   * call throw `AgentSessionEventSeqConflictError`. Nothing is kept from the
   * conflicting batch on SQLite; on Mongo an ordered insert keeps the events
   * before the conflict, and the error's `writtenIds` names them — a caller
   * re-reads the max seq and retries only the rest, so no event is stored
   * twice. An event may carry its own `_id`; one without gets a generated id.
   */
  appendAgentSessionEvents(events: NewAgentSessionEvent[]): Promise<void>;
  /** Events with `seq > afterSeq`, ascending. `types` filters by exact type. */
  listAgentSessionEvents(
    conversationId: string,
    /** `runId`: only the events one run wrote (the runs API's event log of a run). */
    options?: { afterSeq?: number; types?: string[]; limit?: number; runId?: string },
  ): Promise<IAgentSessionEvent[]>;
  /** Highest `seq` written for the conversation; 0 when there are none. */
  getAgentSessionMaxSeq(conversationId: string): Promise<number>;
  deleteAgentSessionEvents(conversationId: string): Promise<number>;
  /** Retention sweep (SQLite; Mongo also has a TTL index). Deletes events with `expiresAt < olderThan`. */
  cleanupAgentSessionEventRetention(options: { olderThan: Date; batchSize?: number }): Promise<{ deletedCount: number }>;

  // ── Agent pending actions (tenant-specific; tool approvals / questions a turn paused on) ──
  createAgentPendingActions(
    actions: Array<Omit<IAgentPendingAction, '_id'>>,
  ): Promise<IAgentPendingAction[]>;
  findAgentPendingActionById(id: string): Promise<IAgentPendingAction | null>;
  listAgentPendingActions(
    conversationId: string,
    options?: { status?: IAgentPendingAction['status'] },
  ): Promise<IAgentPendingAction[]>;
  /**
   * Compare-and-set: applies `data` only while the row's status is `onlyIfStatus`
   * (default `pending`). Null when it matched nothing — someone else resolved it first.
   */
  updateAgentPendingAction(
    id: string,
    data: Partial<Omit<IAgentPendingAction, '_id' | 'tenantId' | 'projectId' | 'conversationId'>>,
    options?: { onlyIfStatus?: IAgentPendingAction['status'] },
  ): Promise<IAgentPendingAction | null>;
  /** `status = pending AND expiresAt < now`, oldest first — the reconciler's timeout sweep. */
  listExpiredAgentPendingActions(now: Date, limit?: number): Promise<IAgentPendingAction[]>;
  deleteAgentPendingActions(conversationId: string): Promise<number>;

  // ── Message feedback (tenant-specific; a person's rating of an assistant message) ──
  /**
   * Stores the rating, replacing the person's earlier one for the same message
   * (`conversationId + messageId + userId`). `created` is false for a replacement.
   */
  upsertAgentMessageFeedback(
    feedback: Omit<IAgentMessageFeedback, '_id' | 'createdAt' | 'updatedAt' | 'removedAt'>,
  ): Promise<{ feedback: IAgentMessageFeedback; created: boolean }>;
  findAgentMessageFeedback(conversationId: string, messageId: string, userId: string): Promise<IAgentMessageFeedback | null>;
  /** Withdraws a rating. False when there was none. */
  deleteAgentMessageFeedback(conversationId: string, messageId: string, userId: string): Promise<boolean>;
  /** Every rating of one conversation, oldest first; `userId` narrows it to one person's. */
  listAgentMessageFeedbackByConversation(conversationId: string, options?: { userId?: string }): Promise<IAgentMessageFeedback[]>;
  /** An agent's ratings, newest first. */
  listAgentMessageFeedback(
    filter: AgentMessageFeedbackFilter,
    options?: { limit?: number; skip?: number },
  ): Promise<{ items: IAgentMessageFeedback[]; total: number }>;
  aggregateAgentMessageFeedback(filter: AgentMessageFeedbackFilter): Promise<AgentMessageFeedbackTotals>;
  /** Marks the ratings of messages at or after `fromIndex` as removed (the messages were cut from the transcript). */
  markAgentMessageFeedbackRemoved(conversationId: string, fromIndex: number, at?: Date): Promise<number>;
  deleteAgentMessageFeedbackByConversation(conversationId: string): Promise<number>;

  // ── Webhook subscriptions (tenant-specific) ──
  createWebhookEndpoint(
    endpoint: Omit<IWebhookEndpoint, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IWebhookEndpoint>;
  findWebhookEndpointById(id: string): Promise<IWebhookEndpoint | null>;
  /**
   * `projectScopes` keeps endpoints whose `projectId` is one of the entries
   * (`null` = tenant-wide); absent = every endpoint. Oldest first.
   */
  listWebhookEndpoints(
    tenantId: string,
    filter?: { projectScopes?: Array<string | null>; status?: WebhookEndpointStatus },
  ): Promise<IWebhookEndpoint[]>;
  updateWebhookEndpoint(
    id: string,
    data: Partial<Omit<IWebhookEndpoint, '_id' | 'tenantId' | 'projectId' | 'createdBy' | 'createdAt'>>,
  ): Promise<IWebhookEndpoint | null>;
  /** Removes the endpoint and its deliveries. */
  deleteWebhookEndpoint(id: string): Promise<boolean>;
  createWebhookDeliveries(
    deliveries: Array<Omit<IWebhookDelivery, '_id'>>,
  ): Promise<IWebhookDelivery[]>;
  findWebhookDeliveryById(id: string): Promise<IWebhookDelivery | null>;
  /** Newest first. */
  listWebhookDeliveries(
    endpointId: string,
    options?: { limit?: number; skip?: number; status?: WebhookDeliveryStatus },
  ): Promise<IWebhookDelivery[]>;
  updateWebhookDelivery(
    id: string,
    data: Partial<Omit<IWebhookDelivery, '_id' | 'tenantId' | 'endpointId' | 'eventId' | 'createdAt'>>,
  ): Promise<IWebhookDelivery | null>;
  /**
   * Compare-and-set lease: while the delivery is `pending` and due
   * (`nextAttemptAt <= now`), pushes `nextAttemptAt` to `leaseUntil` and returns
   * the row; null when it is not due or someone else holds it. A worker that
   * dies mid-attempt just lets the lease run out and the reconciler tries again.
   */
  claimWebhookDelivery(id: string, now: Date, leaseUntil: Date): Promise<IWebhookDelivery | null>;
  /** `status = pending AND nextAttemptAt <= now`, oldest due first — the reconciler's retry sweep. */
  listDueWebhookDeliveries(tenantId: string, now: Date, limit?: number): Promise<IWebhookDelivery[]>;
  /** Marks every `pending` delivery of the endpoint `failed` (it was disabled or removed). */
  failPendingWebhookDeliveries(endpointId: string, reason: string): Promise<number>;
  /** Deletes settled (not `pending`) deliveries created before `olderThan`. */
  cleanupWebhookDeliveryRetention(options: { olderThan: Date; batchSize?: number }): Promise<{ deletedCount: number }>;

  // ── MCP Server operations (tenant-specific) ──
  createMcpServer(
    server: Omit<IMcpServer, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IMcpServer>;
  updateMcpServer(
    id: string,
    data: Partial<Omit<IMcpServer, 'tenantId' | 'createdBy'>>,
  ): Promise<IMcpServer | null>;
  deleteMcpServer(id: string): Promise<boolean>;
  findMcpServerById(id: string): Promise<IMcpServer | null>;
  /**
   * `projectId`: a string selects that project's row; `null` selects ONLY the
   * tenant-wide row (`projectId IS NULL`); `undefined` adds no project clause
   * (any project — keys are unique per project, so use with care).
   */
  findMcpServerByKey(key: string, projectId?: string | null): Promise<IMcpServer | null>;
  findMcpServerByEndpointSlug(endpointSlug: string): Promise<IMcpServer | null>;
  listMcpServers(filters?: {
    projectId?: string;
    status?: McpServerStatus;
    search?: string;
  }): Promise<IMcpServer[]>;
  countMcpServers(projectId?: string): Promise<number>;

  // ── MCP Request Log operations (tenant-specific) ──
  createMcpRequestLog(
    log: Omit<IMcpRequestLog, '_id' | 'createdAt'>,
  ): Promise<IMcpRequestLog>;
  listMcpRequestLogs(
    scope: McpLogServerScope,
    options?: {
      limit?: number;
      skip?: number;
      from?: Date;
      to?: Date;
      status?: string;
      keyword?: string;
    },
  ): Promise<IMcpRequestLog[]>;
  countMcpRequestLogs(
    scope: McpLogServerScope,
    options?: { from?: Date; to?: Date; status?: string; keyword?: string },
  ): Promise<number>;
  aggregateMcpRequestLogs(
    scope: McpLogServerScope,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
  ): Promise<IMcpRequestAggregate>;
  listRecentMcpRequestLogs(options?: {
    projectId?: string;
    limit?: number;
    status?: string;
  }): Promise<IMcpRequestLog[]>;

  // ── MCP Audit Log operations (tenant-specific) ──
  createMcpAuditLog(
    log: Omit<IMcpAuditLog, '_id' | 'createdAt'>,
  ): Promise<IMcpAuditLog>;
  listMcpAuditLogs(options?: {
    projectId?: string;
    serverKey?: string;
    action?: string;
    limit?: number;
    skip?: number;
  }): Promise<IMcpAuditLog[]>;

  // ── Browsers (tenant-specific) ──
  createBrowser(
    record: Omit<IBrowser, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IBrowser>;
  updateBrowser(
    id: string,
    data: Partial<Omit<IBrowser, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<IBrowser | null>;
  deleteBrowser(id: string): Promise<boolean>;
  findBrowserById(id: string): Promise<IBrowser | null>;
  findBrowserByKey(
    tenantId: string,
    key: string,
    projectId?: string,
  ): Promise<IBrowser | null>;
  listBrowsers(
    tenantId: string,
    filters?: { projectId?: string; status?: BrowserStatus | string; search?: string },
  ): Promise<IBrowser[]>;

  // ── Browser Sessions (tenant-specific) ──
  createBrowserSession(
    record: Omit<IBrowserSession, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IBrowserSession>;
  updateBrowserSession(
    id: string,
    data: Partial<Omit<IBrowserSession, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<IBrowserSession | null>;
  deleteBrowserSession(id: string): Promise<boolean>;
  findBrowserSessionById(id: string): Promise<IBrowserSession | null>;
  findBrowserSessionByKey(
    tenantId: string,
    sessionKey: string,
    projectId?: string,
  ): Promise<IBrowserSession | null>;
  listBrowserSessions(
    tenantId: string,
    filters?: {
      projectId?: string;
      browserId?: string;
      agentId?: string;
      status?: BrowserSessionStatus | string;
      search?: string;
      /** Inclusive lower bound on `createdAt`. */
      createdFrom?: Date;
      /** Inclusive upper bound on `createdAt`. */
      createdTo?: Date;
      limit?: number;
    },
  ): Promise<IBrowserSession[]>;

  // ── Browser Session Events (tenant-specific) ──
  createBrowserSessionEvent(
    record: Omit<IBrowserSessionEvent, '_id' | 'createdAt'>,
  ): Promise<IBrowserSessionEvent>;
  listBrowserSessionEvents(
    sessionId: string,
    options?: { limit?: number; skip?: number },
  ): Promise<IBrowserSessionEvent[]>;
  countBrowserSessionEvents(sessionId: string): Promise<number>;

  // ── Browser Flows (tenant-specific) ──
  createBrowserFlow(
    record: Omit<IBrowserFlow, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IBrowserFlow>;
  updateBrowserFlow(
    id: string,
    data: Partial<Omit<IBrowserFlow, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<IBrowserFlow | null>;
  deleteBrowserFlow(id: string): Promise<boolean>;
  findBrowserFlowById(id: string): Promise<IBrowserFlow | null>;
  findBrowserFlowByKey(
    tenantId: string,
    key: string,
    projectId?: string,
  ): Promise<IBrowserFlow | null>;
  listBrowserFlows(
    tenantId: string,
    filters?: {
      projectId?: string;
      status?: BrowserFlowStatus | string;
      browserId?: string;
      search?: string;
    },
  ): Promise<IBrowserFlow[]>;

  // ── Browser Flow Runs (tenant-specific) ──
  createBrowserFlowRun(
    record: Omit<IBrowserFlowRun, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IBrowserFlowRun>;
  updateBrowserFlowRun(
    id: string,
    data: Partial<Omit<IBrowserFlowRun, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<IBrowserFlowRun | null>;
  findBrowserFlowRunById(id: string): Promise<IBrowserFlowRun | null>;
  listBrowserFlowRuns(
    tenantId: string,
    filters?: {
      projectId?: string;
      flowId?: string;
      status?: BrowserFlowRunStatus | string;
      limit?: number;
      skip?: number;
    },
  ): Promise<IBrowserFlowRun[]>;

  // ── Crawlers (tenant-specific) ──
  createCrawler(
    record: Omit<ICrawler, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ICrawler>;
  updateCrawler(
    id: string,
    data: Partial<Omit<ICrawler, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<ICrawler | null>;
  deleteCrawler(id: string): Promise<boolean>;
  findCrawlerById(id: string): Promise<ICrawler | null>;
  findCrawlerByKey(
    tenantId: string,
    key: string,
    projectId?: string,
  ): Promise<ICrawler | null>;
  listCrawlers(
    tenantId: string,
    filters?: { projectId?: string; status?: CrawlerStatus | string; search?: string },
  ): Promise<ICrawler[]>;

  // ── Crawl jobs (tenant-specific) ──
  createCrawlJob(
    record: Omit<ICrawlJob, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ICrawlJob>;
  updateCrawlJob(
    id: string,
    data: Partial<Omit<ICrawlJob, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<ICrawlJob | null>;
  /**
   * Atomically transition a `queued` job to `running`. Returns the claimed
   * job (now `running`) only if this call performed the transition; returns
   * `null` if the job was not `queued` (e.g. a duplicate/redelivered queue
   * message tried to claim a job another consumer already started).
   * Callers MUST treat `null` as "do not run this job".
   */
  claimCrawlJob(id: string, tenantId: string, startedAt: Date): Promise<ICrawlJob | null>;
  /**
   * Record a cancellation request. A `queued` job is transitioned straight
   * to `canceled` (nothing is executing it yet); a `running` job only has
   * `cancelRequestedAt` stamped so the *owning* runner — which may be on a
   * different node than the one handling this request — observes it on its
   * next DB round trip and performs its own terminal transition. Returns
   * `null` if the job does not exist or is already in a terminal state.
   */
  requestCrawlJobCancel(id: string, tenantId: string): Promise<ICrawlJob | null>;
  /**
   * Persist a running job's terminal status/counters, guarded so it only
   * applies while the job is still `running`. This prevents a late/duplicate
   * writer from clobbering a status another writer already finalized (e.g.
   * a cross-node cancel that raced the owning runner's own completion).
   */
  finalizeCrawlJob(
    id: string,
    tenantId: string,
    data: Partial<Omit<ICrawlJob, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<ICrawlJob | null>;
  findCrawlJobById(id: string): Promise<ICrawlJob | null>;
  listCrawlJobs(
    tenantId: string,
    filters?: {
      projectId?: string;
      crawlerKey?: string;
      status?: CrawlJobStatus | string;
      limit?: number;
    },
  ): Promise<ICrawlJob[]>;

  // ── Agent Runs (background execution, tenant-specific) ──
  // See docs/guide/agent-background-execution.md §6, §7, §12.
  /**
   * Insert a new AgentRun row. Each provider enforces "at most one
   * queued/running run per conversation" race-free (§6/§12.14): SQLite with a
   * partial unique index, Mongo with agent_run_locks documents, since Cosmos
   * rejects partial indexes — for both `mode: 'sync'` and
   * `mode: 'inline'` and `mode: 'background'` rows alike. A `scheduled` row is
   * not active and takes no slot (it takes it when promoted, see
   * `promoteScheduledAgentRun`). A violation MUST be caught by the
   * implementation and re-thrown as `AgentRunConflictError` (see
   * `./errors.ts`), never left as a raw driver error, so callers can map it
   * directly to `409 Conflict` without a TOCTOU check-then-insert.
   */
  createAgentRun(
    record: Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IAgentRun>;
  /**
   * Atomically transition a `queued` run to `running`, stamping `workerId`,
   * `startedAt`, and `heartbeatAt`. Returns `null` if the run was not
   * `queued` (e.g. a duplicate/redelivered queue message tried to claim a
   * run another consumer already started) — callers MUST treat `null` as
   * "do not run this job" (§7 step 4).
   */
  claimAgentRun(
    id: string,
    tenantId: string,
    workerId: string,
    startedAt: Date,
  ): Promise<IAgentRun | null>;
  /**
   * Update `heartbeatAt` for a run this worker still owns. Guarded by
   * `status = 'running' AND workerId = ?` so a worker that has already been
   * superseded (e.g. reclaimed by the reconciler) cannot resurrect a run by
   * writing a fresh heartbeat to it.
   */
  updateAgentRunHeartbeat(
    id: string,
    workerId: string,
    heartbeatAt: Date,
  ): Promise<IAgentRun | null>;
  /**
   * Record a cancellation request, scoped by tenantId + projectId (§12.11).
   * Mirrors `requestCrawlJobCancel`: a `queued` or `scheduled` run transitions
   * straight to `canceled` (nothing is executing it yet); a `running` run only has
   * `cancelRequestedAt` stamped so the owning worker's own poll loop
   * observes it and performs its own guarded transition (§7 step 6).
   */
  requestAgentRunCancel(
    id: string,
    tenantId: string,
    projectId: string,
  ): Promise<IAgentRun | null>;
  /**
   * Persist a run's terminal status, guarded so it only applies while the
   * run is still `running` (or paused, see below). This is what prevents a deadline-timer-driven
   * `failed` transition (§12.13) from later being clobbered back to
   * `succeeded` by an abandoned `invoke()` call that eventually settles
   * (§12.12) — the CAS guard, not the caller's discretion, is the actual
   * protection. A paused (`requires_action`) run can be finalized as well:
   * a cancel, or a continuation that completed inline.
   */
  finalizeAgentRun(
    id: string,
    tenantId: string,
    data: Partial<Omit<IAgentRun, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<IAgentRun | null>;
  /**
   * Puts a paused (`requires_action`) run back in the queue to continue its
   * turn: CAS from `requires_action` to `queued`, taking the conversation's
   * active-run slot again. Null when the run is not paused any more; throws
   * `AgentRunConflictError` when another run holds the slot. Increments
   * `queueGeneration` (a resume is a new execution: its job dedup key differs).
   * `continuation` records what continues the turn and who answered
   * (`resumeTrigger`, `resumeUserId`, `resumeApiTokenId`).
   */
  requeueAgentRunForResume(
    id: string,
    tenantId: string,
    resumeActionIds: string[],
    continuation?: { trigger: 'resume' | 'timeout'; userId?: string | null; apiTokenId?: string | null },
  ): Promise<IAgentRun | null>;
  /**
   * Updates callback delivery bookkeeping ONLY (`callbackStatus`,
   * `callbackAttempts`) — deliberately NOT guarded by `status = 'running'`
   * the way `finalizeAgentRun` is, because a callback delivery attempt (and
   * its retries, §12.6) happens AFTER the run has already reached its
   * terminal status. Reusing `finalizeAgentRun`'s CAS here would silently
   * no-op every callback bookkeeping write once the run is no longer
   * `running` — which is always, since finalize runs first.
   *
   * `data.callbackEventId` records which event the bookkeeping is for;
   * `options.onlyIfEventId` applies the write only while the row's
   * `callbackEventId` is that event (or unset), so the delivery of an older
   * event never overwrites the bookkeeping of a newer one. Null when it did not apply.
   */
  updateAgentRunCallback(
    id: string,
    tenantId: string,
    data: { callbackStatus: NonNullable<IAgentRun['callbackStatus']>; callbackAttempts: number; callbackEventId?: string | null },
    options?: { onlyIfEventId?: string },
  ): Promise<IAgentRun | null>;
  getAgentRunById(
    id: string,
    tenantId: string,
    projectId: string,
  ): Promise<IAgentRun | null>;
  /** Background-mode-only idempotency lookup (§9, §12.15), scoped by tenantId+projectId. */
  getAgentRunByIdempotencyKey(
    tenantId: string,
    projectId: string,
    idempotencyKey: string,
  ): Promise<IAgentRun | null>;
  /**
   * Heartbeat-sweep input for the crash-recovery reconciler (§7.1): `running`
   * rows in this tenant (every mode, `inline` included) whose `heartbeatAt` is
   * older than `heartbeatBefore`.
   */
  listStaleAgentRuns(
    tenantId: string,
    heartbeatBefore: Date,
  ): Promise<IAgentRun[]>;
  /**
   * Boot-time recovery input (§7.1): `queued` rows in this tenant — a
   * message the in-memory queue provider lost on process restart is safe to
   * republish as-is, since a `queued` run never started executing. `deferred`
   * rows are left out (their dispatcher publishes them), and so are
   * `scheduled` rows (not queued yet).
   */
  listQueuedAgentRuns(
    tenantId: string,
    options?: { createdBefore?: Date; limit?: number },
  ): Promise<IAgentRun[]>;
  /**
   * Runs whose callback never settled: a `callbackUrl`, a `pending` / `failed`
   * status with fewer than `maxAttempts` attempts, in a state that has a
   * callback to send (terminal or `requires_action`), untouched since
   * `updatedBefore`. The reconciler re-delivers these.
   */
  listAgentRunsWithUndeliveredCallbacks(
    tenantId: string,
    options: { updatedBefore: Date; maxAttempts: number; limit?: number },
  ): Promise<IAgentRun[]>;
  /**
   * Run listing, newest first (stable order: `createdAt` then id). Always
   * tenant+project scoped; everything else narrows it. `cursor` is the id of
   * the last row of the previous page (rows after it are returned). A caller
   * that wants `has_more` asks for `limit + 1` rows.
   */
  listAgentRuns(filter: {
    tenantId: string;
    projectId: string;
    agentKey?: string;
    conversationId?: string;
    status?: IAgentRun['status'][];
    /** One mode or any of several. */
    mode?: IAgentRun['mode'] | IAgentRun['mode'][];
    excludeModes?: IAgentRun['mode'][];
    /** `default` also matches rows with no class. */
    runClass?: AgentRunClass;
    triggerId?: string;
    channel?: NonNullable<IAgentRun['channel']>;
    trigger?: NonNullable<IAgentRun['trigger']>;
    /** Exact `key = value` pairs the run's metadata must carry. */
    metadata?: Record<string, string>;
    createdAfter?: Date;
    createdBefore?: Date;
    cursor?: string;
    /** Only the runs this user queued (the list of a caller who may not see other people's). */
    userId?: string;
    limit?: number;
  }): Promise<IAgentRun[]>;
  /**
   * Sync-mode cleanup (§6): unconditional delete, not a finalize — a
   * `mode: 'sync'` row is a reservation slot, never a terminal record, and
   * an orphaned one (process crash mid-call) is freed the same way by the
   * reconciler. Also the undo of a refused (cap overflow) insert.
   */
  deleteAgentRun(id: string): Promise<boolean>;
  /**
   * §12.8 concurrency-cap input: count of `queued`+`running` rows. `runClass`
   * `default` also counts rows with no class.
   */
  countActiveAgentRuns(
    tenantId: string,
    projectId?: string,
    opts?: { mode?: IAgentRun['mode']; runClass?: AgentRunClass },
  ): Promise<number>;
  /**
   * Row counts per status (queue visibility, deferred caps). Every requested
   * status is present in the result, 0 when there is none.
   */
  countAgentRunsByStatus(
    tenantId: string,
    opts: { statuses: IAgentRun['status'][]; runClass?: AgentRunClass; projectId?: string },
  ): Promise<Record<string, number>>;
  /** `scheduled` rows of this tenant whose `notBefore` is due, oldest first. */
  listDueScheduledAgentRuns(tenantId: string, now: Date, limit: number): Promise<IAgentRun[]>;
  /**
   * CAS `scheduled` -> `queued`, taking the conversation's active-run slot.
   * Null when the row is no longer `scheduled` (another node promoted or
   * canceled it); throws `AgentRunConflictError` when another run holds the
   * slot (the row stays `scheduled`, retried on the next tick).
   */
  promoteScheduledAgentRun(runId: string, tenantId: string): Promise<IAgentRun | null>;
  /** `deferred` `queued` rows (notBefore absent or <= `dueBefore`), oldest first: the dispatcher's input. */
  listQueuedDeferredAgentRuns(
    tenantId: string,
    options: { limit: number; dueBefore: Date },
  ): Promise<IAgentRun[]>;
  /**
   * Deferred `queued` rows and overdue `scheduled` rows that have waited since
   * before `dueBefore` (their due time — `notBefore`, else `createdAt`) without
   * starting. The reconciler fails them as `expired`.
   */
  listExpiredWaitingAgentRuns(
    tenantId: string,
    options: { dueBefore: Date; limit: number },
  ): Promise<IAgentRun[]>;
  /**
   * CAS `queued` / `scheduled` -> `failed` with `errorReason: 'expired'` (a
   * deferred or scheduled run that never started in time), freeing the
   * conversation slot a queued row holds. Null when the row has moved on.
   * `expiresAt`, when given, is the row's new retention cutoff.
   */
  expireWaitingAgentRun(runId: string, tenantId: string, errorMessage: string, expiresAt?: Date): Promise<IAgentRun | null>;
  /** CAS on `running`: stamps `detachedAt` (the caller of an inline run stopped waiting). */
  markAgentRunDetached(runId: string, tenantId: string, at: Date): Promise<IAgentRun | null>;
  /** Stamps `lastPublishedAt` after a queue publish (no status guard). */
  markAgentRunPublished(runId: string, tenantId: string, at: Date): Promise<IAgentRun | null>;
  /**
   * §12.10 retention, following the `cleanupAgentTracingRetention` precedent.
   * Never deletes `queued`, `running`, `scheduled` or `requires_action` rows.
   */
  cleanupAgentRunRetention(options: {
    olderThan: Date;
    batchSize?: number;
  }): Promise<{ deletedCount: number }>;

  // ── Crawl results (tenant-specific) ──
  createCrawlResult(
    record: Omit<ICrawlResult, '_id' | 'createdAt'>,
  ): Promise<ICrawlResult>;
  listCrawlResults(
    jobId: string,
    options?: { limit?: number; skip?: number; type?: string },
  ): Promise<ICrawlResult[]>;
  findCrawlResultById(id: string): Promise<ICrawlResult | null>;
  /**
   * Patch a crawl result's Knowledge Engine ingest outcome. Used both by the
   * live per-page ingest during a crawl and by a manual re-sync of a
   * previously-fetched job's results (no re-crawl involved).
   */
  updateCrawlResult(
    id: string,
    data: Partial<Pick<ICrawlResult, 'ragDocumentId' | 'ragStatus' | 'errorMessage'>>,
  ): Promise<ICrawlResult | null>;
  countCrawlResults(jobId: string): Promise<number>;
  /**
   * Delete all crawl results for a job. Used when an interrupted job is
   * restarted from scratch so the fresh run doesn't append duplicates to the
   * partial results the dead run already wrote. Returns the number deleted.
   */
  deleteCrawlResultsByJob(jobId: string): Promise<number>;

  // ── OCR jobs (tenant-specific) ──
  createOcrJob(
    record: Omit<IOcrJob, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IOcrJob>;
  updateOcrJob(
    id: string,
    data: Partial<Omit<IOcrJob, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<IOcrJob | null>;
  findOcrJobById(id: string): Promise<IOcrJob | null>;
  listOcrJobs(
    tenantId: string,
    filters?: {
      projectId?: string;
      status?: OcrJobStatus | string;
      limit?: number;
    },
  ): Promise<IOcrJob[]>;
  deleteOcrJob(id: string): Promise<boolean>;

  /**
   * Atomically increment a job's running aggregate counters/usage/cost and
   * return the post-increment job, so callers can detect completion
   * (itemsProcessed + itemsFailed === itemsTotal) exactly once.
   */
  incrementOcrJobAggregates(
    id: string,
    delta: OcrJobAggregateDelta,
    extra?: { costCurrency?: string; lastItemAt?: Date },
  ): Promise<IOcrJob | null>;

  // ── OCR job items (tenant-specific) ──
  createOcrJobItem(
    record: Omit<IOcrJobItem, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IOcrJobItem>;
  createOcrJobItems(
    records: Array<Omit<IOcrJobItem, '_id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<IOcrJobItem[]>;
  updateOcrJobItem(
    id: string,
    data: Partial<Omit<IOcrJobItem, '_id' | 'tenantId' | 'jobId' | 'createdAt'>>,
  ): Promise<IOcrJobItem | null>;
  findOcrJobItemById(id: string): Promise<IOcrJobItem | null>;
  listOcrJobItems(
    jobId: string,
    options?: { limit?: number; skip?: number; status?: string },
  ): Promise<IOcrJobItem[]>;

  // ── Batch API: jobs (tenant-specific) ──
  createBatchJob(
    record: Omit<IBatchJob, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IBatchJob>;
  updateBatchJob(
    id: string,
    data: Partial<Omit<IBatchJob, '_id' | 'tenantId' | 'createdAt'>>,
  ): Promise<IBatchJob | null>;
  findBatchJobById(id: string): Promise<IBatchJob | null>;
  listBatchJobs(
    tenantId: string,
    filters?: {
      projectId?: string;
      status?: BatchJobStatus | string;
      limit?: number;
    },
  ): Promise<IBatchJob[]>;
  deleteBatchJob(id: string): Promise<boolean>;
  /**
   * Atomically apply per-item deltas to the batch aggregates so concurrent
   * item completions never lose updates. The runner finalizes the batch when
   * (itemsSucceeded + itemsFailed + itemsCancelled === itemsTotal).
   */
  incrementBatchJobAggregates(
    id: string,
    delta: BatchJobAggregateDelta,
  ): Promise<IBatchJob | null>;

  // ── Batch API: items (tenant-specific) ──
  createBatchJobItems(
    records: Array<Omit<IBatchJobItem, '_id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<IBatchJobItem[]>;
  updateBatchJobItem(
    id: string,
    data: Partial<Omit<IBatchJobItem, '_id' | 'tenantId' | 'batchId' | 'createdAt'>>,
  ): Promise<IBatchJobItem | null>;
  findBatchJobItemById(id: string): Promise<IBatchJobItem | null>;
  listBatchJobItems(
    batchId: string,
    options?: { limit?: number; skip?: number; status?: string },
  ): Promise<IBatchJobItem[]>;

  // ── Cluster: nodes (main database) ──
  upsertNode(
    record: Omit<INodeRecord, 'lastHeartbeatAt'> & { lastHeartbeatAt?: Date },
  ): Promise<INodeRecord>;
  heartbeatNode(name: string, at?: Date): Promise<void>;
  setNodeStatus(name: string, status: NodeStatus): Promise<void>;
  findNode(name: string): Promise<INodeRecord | null>;
  listNodes(filters?: { status?: NodeStatus }): Promise<INodeRecord[]>;
  markStaleNodesOffline(olderThan: Date): Promise<number>;
  deleteNode(name: string): Promise<boolean>;

  // ── Cluster: instance assignments (main database) ──
  setInstanceAssignment(
    assignment: Omit<IInstanceAssignment, 'updatedAt'> & { updatedAt?: Date },
  ): Promise<IInstanceAssignment>;
  findInstanceAssignment(
    entityType: InstanceEntityType,
    entityId: string,
  ): Promise<IInstanceAssignment | null>;
  listInstanceAssignments(filters?: {
    entityType?: InstanceEntityType;
    nodeName?: string;
  }): Promise<IInstanceAssignment[]>;
  deleteInstanceAssignment(
    entityType: InstanceEntityType,
    entityId: string,
  ): Promise<boolean>;

  // ── Beta access codes (main database) ──
  /** Insert a code if it does not exist yet; returns the stored record either way. */
  createBetaAccessCode(record: { code: string; note?: string | null }): Promise<IBetaAccessCode>;
  findBetaAccessCode(code: string): Promise<IBetaAccessCode | null>;
  listBetaAccessCodes(filters?: { status?: BetaAccessCodeStatus }): Promise<IBetaAccessCode[]>;
  /**
   * Atomically claim an active code (active → used). Returns false when the
   * code does not exist or was already used/disabled.
   */
  consumeBetaAccessCode(code: string, usedBy: { email: string }): Promise<boolean>;
  /** Revert a used code back to active (rollback when registration fails after the claim). */
  releaseBetaAccessCode(code: string): Promise<boolean>;

  // ── IAM document store (tenant-scoped; collections/tables created lazily) ──
  /** One document by id, or null. */
  iamDocGet(collection: IamCollectionName, id: string): Promise<IIamDoc | null>;
  /** Insert-or-replace the whole document. */
  iamDocPut(collection: IamCollectionName, id: string, data: Record<string, unknown>): Promise<IIamDoc>;
  /** Documents of a collection ordered by id; optional id prefix and limit (default 1000). */
  iamDocList(collection: IamCollectionName, options?: { idPrefix?: string; limit?: number }): Promise<IIamDoc[]>;
  iamDocDelete(collection: IamCollectionName, id: string): Promise<boolean>;
  /** Delete every document of the collection (current tenant only); returns the count. */
  iamDocClear(collection: IamCollectionName): Promise<number>;
  /**
   * Atomically add `by` to the numeric `field` of the document (creating the
   * document / field at 0 first) and return the new value.
   */
  iamDocIncrement(collection: IamCollectionName, id: string, field: string, by?: number): Promise<number>;

  // ── IAM directory queries (read-only, offset-paged; for the Authorization center) ──
  /** Users of the tenant ordered by name; the returned `password` is always blank. */
  iamListUsers(query: IamUserQuery): Promise<IamPage<IUser>>;
  /** Groups of the tenant ordered by name. */
  iamListGroups(query: IamGroupQuery): Promise<IamPage<IGroup>>;
  /** Member count per group id (groups without members are 0). */
  iamCountGroupMembers(groupIds: string[]): Promise<Record<string, number>>;
  /** User ids that are members of the group, ordered by user id. */
  iamListGroupMemberIds(groupId: string, page: IamPageRequest): Promise<IamPage<string>>;
  /** API tokens of the tenant, newest first. Never contains a token secret or hash. */
  iamListTokens(query: IamTokenQuery): Promise<IamPage<IApiToken>>;
  /** Audit rows of the tenant, newest first. */
  iamListAuditEvents(query: IamAuditQuery): Promise<IamPage<IAuditLog>>;
  /** How many users match (the same filters as `iamListUsers`, without paging). */
  iamCountUsers(filter: IamUserFilter): Promise<number>;
  /** How many groups match. */
  iamCountGroups(filter: IamGroupFilter): Promise<number>;
  /** How many API tokens match. */
  iamCountTokens(filter: IamTokenFilter): Promise<number>;

  // ── GPU fleet + Agent Runtime Sandbox (tenant-scoped) ──
  // EDITION SPLIT: these enterprise methods were moved to the overlay. In the enterprise
  // build they are re-added to this interface via declaration merging
  // (ee/overlay/src/enterprise/contract-augmentation.ts) and implemented by the
  // SandboxMixin/GpuFleetMixin contributed through the enterprise registry. The community
  // edition does not declare or implement them. See the cognipeer-console-ee repo (docs/licensing/MANIFEST.md).
}
