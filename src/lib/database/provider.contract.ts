import type {
  AgentStatus,
  AlertEventStatus,
  GuardrailType,
  IAgent,
  IAgentConversation,
  IAgentTracingEvent,
  IAgentTracingSession,
  IAgentVersion,
  IAlertEvent,
  IAlertRule,
  IApiToken,
  IConfigAuditLog,
  IConfigGroup,
  IConfigItem,
  IFileBucketRecord,
  IFileRecord,
  IGuardrail,
  IGuardrailEvalAggregate,
  IGuardrailEvaluationLog,
  IIncident,
  IInferenceServer,
  IInferenceServerMetrics,
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
  ITenant,
  ITenantUserDirectoryEntry,
  ITool,
  IToolRequestAggregate,
  IToolRequestLog,
  IUser,
  IVectorIndexRecord,
  IncidentSeverity,
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
} from './provider/types';

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
}

