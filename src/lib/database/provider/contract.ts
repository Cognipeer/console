import type {
  AgentStatus,
  AlertEventStatus,
  BrowserSessionStatus,
  BrowserStatus,
  GuardrailType,
  IAgent,
  IAgentConversation,
  IAgentTracingEvent,
  IAgentTracingDashboardAggregate,
  IAgentTracingSession,
  IAgentVersion,
  IAuditLog,
  IAlertEvent,
  IAlertRule,
  IApiToken,
  IBrowser,
  IBrowserSession,
  IBrowserSessionEvent,
  ICrawler,
  ICrawlJob,
  ICrawlResult,
  CrawlJobStatus,
  CrawlerStatus,
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
  IGuardrail,
  IGuardrailEvalAggregate,
  IGuardrailEvaluationLog,
  IPiiPolicy,
  IIncident,
  IInferenceServer,
  IInferenceServerMetrics,
  IJsSandboxExecution,
  IJsSandboxRuntime,
  IMcpRequestAggregate,
  IMcpRequestLog,
  IMcpServer,
  IModel,
  IModelUsageAggregate,
  IModelUsageLog,
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
  IReranker,
  IRerankerRunLog,
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
  IVectorMigration,
  IVectorMigrationLog,
  VectorMigrationStatus,
  VectorMigrationLogStatus,
  IncidentSeverity,
  IncidentStatus,
  JsSandboxExecutionStatus,
  JsSandboxRuntimeStatus,
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
  createUser(
    user: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IUser>;
  updateUser(id: string, data: Partial<IUser>): Promise<IUser | null>;
  deleteUser(id: string): Promise<boolean>;
  listUsers(): Promise<IUser[]>;

  // Project membership (UserProject — replaces user.projectIds)
  findUserProject(userId: string, projectId: string): Promise<IUserProject | null>;
  listUserProjectsByUser(userId: string): Promise<IUserProject[]>;
  listUserProjectsByProject(projectId: string): Promise<IUserProject[]>;
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
  findApiTokenByHash(tokenHash: string): Promise<IApiToken | null>;
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
  listAgentTracingEvents(
    sessionId: string,
    projectId?: string,
    options?: {
      projection?: Record<string, 0 | 1>;
    },
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
  }): Promise<IVectorMigration[]>;
  findVectorMigrationByKey(key: string): Promise<IVectorMigration | null>;
  createVectorMigrationLog(
    log: Omit<IVectorMigrationLog, '_id' | 'createdAt'>,
  ): Promise<IVectorMigrationLog>;
  listVectorMigrationLogs(
    migrationKey: string,
    options?: { limit?: number; offset?: number },
  ): Promise<IVectorMigrationLog[]>;
  countVectorMigrationLogs(
    migrationKey: string,
    status?: VectorMigrationLogStatus,
  ): Promise<number>;

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
  findPiiPolicyByKey(key: string, projectId?: string): Promise<IPiiPolicy | null>;
  listPiiPolicies(filters?: {
    projectId?: string;
    enabled?: boolean;
    search?: string;
  }): Promise<IPiiPolicy[]>;

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

  // ── Incident operations (tenant-specific) ──
  createIncident(
    incident: Omit<IIncident, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IIncident>;
  updateIncident(
    id: string,
    data: Partial<Omit<IIncident, 'tenantId' | 'alertEventId' | 'ruleId'>>,
  ): Promise<IIncident | null>;
  findIncidentById(id: string): Promise<IIncident | null>;
  findIncidentByAlertEventId(alertEventId: string): Promise<IIncident | null>;
  listIncidents(
    tenantId: string,
    options?: {
      projectId?: string;
      ruleId?: string;
      status?: IncidentStatus;
      severity?: IncidentSeverity;
      limit?: number;
      skip?: number;
    },
  ): Promise<IIncident[]>;
  countIncidents(
    tenantId: string,
    options?: { projectId?: string; status?: IncidentStatus },
  ): Promise<number>;

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

  // ── JS Sandbox runtime operations (tenant-specific) ──
  createJsSandboxRuntime(
    runtime: Omit<IJsSandboxRuntime, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IJsSandboxRuntime>;
  updateJsSandboxRuntime(
    id: string,
    data: Partial<Omit<IJsSandboxRuntime, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt'>>,
  ): Promise<IJsSandboxRuntime | null>;
  deleteJsSandboxRuntime(id: string): Promise<boolean>;
  findJsSandboxRuntimeById(id: string): Promise<IJsSandboxRuntime | null>;
  findJsSandboxRuntimeByKey(
    tenantId: string,
    key: string,
    projectId?: string,
  ): Promise<IJsSandboxRuntime | null>;
  listJsSandboxRuntimes(
    tenantId: string,
    filters?: {
      projectId?: string;
      status?: JsSandboxRuntimeStatus | string;
      search?: string;
    },
  ): Promise<IJsSandboxRuntime[]>;
  countJsSandboxRuntimes(tenantId: string, projectId?: string): Promise<number>;

  // ── JS Sandbox execution logs (tenant-specific) ──
  createJsSandboxExecution(
    execution: Omit<IJsSandboxExecution, '_id' | 'createdAt'>,
  ): Promise<IJsSandboxExecution>;
  findJsSandboxExecutionById(id: string): Promise<IJsSandboxExecution | null>;
  listJsSandboxExecutions(
    tenantId: string,
    filters?: {
      projectId?: string;
      runtimeId?: string;
      runtimeKey?: string;
      status?: JsSandboxExecutionStatus | string;
      from?: Date;
      to?: Date;
      limit?: number;
      skip?: number;
    },
  ): Promise<IJsSandboxExecution[]>;
  countJsSandboxExecutions(
    tenantId: string,
    filters?: {
      projectId?: string;
      runtimeId?: string;
      runtimeKey?: string;
      status?: JsSandboxExecutionStatus | string;
      from?: Date;
      to?: Date;
    },
  ): Promise<number>;

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
  findToolByKey(key: string, projectId?: string): Promise<ITool | null>;
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
  deleteAgentConversation(id: string): Promise<boolean>;
  findAgentConversationById(id: string): Promise<IAgentConversation | null>;
  listAgentConversations(
    agentKey: string,
    filters?: { projectId?: string; limit?: number; skip?: number },
  ): Promise<IAgentConversation[]>;

  // ── MCP Server operations (tenant-specific) ──
  createMcpServer(
    server: Omit<IMcpServer, '_id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IMcpServer>;
  updateMcpServer(
    id: string,
    data: Partial<Omit<IMcpServer, 'tenantId' | 'key' | 'createdBy'>>,
  ): Promise<IMcpServer | null>;
  deleteMcpServer(id: string): Promise<boolean>;
  findMcpServerById(id: string): Promise<IMcpServer | null>;
  findMcpServerByKey(key: string, projectId?: string): Promise<IMcpServer | null>;
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
    serverKey: string,
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
    serverKey: string,
    options?: { from?: Date; to?: Date; status?: string; keyword?: string },
  ): Promise<number>;
  aggregateMcpRequestLogs(
    serverKey: string,
    options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
  ): Promise<IMcpRequestAggregate>;

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

  // ── Crawl results (tenant-specific) ──
  createCrawlResult(
    record: Omit<ICrawlResult, '_id' | 'createdAt'>,
  ): Promise<ICrawlResult>;
  listCrawlResults(
    jobId: string,
    options?: { limit?: number; skip?: number; type?: string },
  ): Promise<ICrawlResult[]>;
  findCrawlResultById(id: string): Promise<ICrawlResult | null>;
  countCrawlResults(jobId: string): Promise<number>;

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

  // ── GPU fleet + Agent Runtime Sandbox (tenant-scoped) ──
  // EDITION SPLIT: these enterprise methods were moved to the overlay. In the enterprise
  // build they are re-added to this interface via declaration merging
  // (ee/overlay/src/enterprise/contract-augmentation.ts) and implemented by the
  // SandboxMixin/GpuFleetMixin contributed through the enterprise registry. The community
  // edition does not declare or implement them. See the cognipeer-console-ee repo (docs/licensing/MANIFEST.md).
}
