/**
 * Mock factory for DatabaseProvider.
 *
 * Usage:
 *   vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
 *   const db = createMockDb();
 *   (getDatabase as Mock).mockResolvedValue(db);
 */

import { vi, type Mocked } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';

// MockDb satisfies DatabaseProvider (callable) AND exposes .mock* assertion helpers
export type MockDb = Mocked<DatabaseProvider>;

export function createMockDb(overrides: Partial<MockDb> = {}): MockDb {
  const base = {
    // Connection
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),

    // Tenant ops
    createTenant: vi.fn().mockResolvedValue({ _id: 'tenant-1', slug: 'acme', dbName: 'tenant_acme', licenseType: 'FREE', companyName: 'Acme' }),
    findTenantBySlug: vi.fn().mockResolvedValue(null),
    findTenantById: vi.fn().mockResolvedValue(null),
    listTenants: vi.fn().mockResolvedValue([]),
    updateTenant: vi.fn().mockResolvedValue(null),

    // Tenant switching
    switchToTenant: vi.fn().mockResolvedValue(undefined),

    // Cross-tenant user directory
    registerUserInDirectory: vi.fn().mockResolvedValue(undefined),
    unregisterUserFromDirectory: vi.fn().mockResolvedValue(undefined),
    listTenantsForUser: vi.fn().mockResolvedValue([]),

    // User ops
    findUserByEmail: vi.fn().mockResolvedValue(null),
    findUserById: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockResolvedValue({ _id: 'user-1', email: 'test@example.com' }),
    updateUser: vi.fn().mockResolvedValue(null),
    deleteUser: vi.fn().mockResolvedValue(true),
    listUsers: vi.fn().mockResolvedValue([]),

    // Project ops
    createProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: 'default', name: 'Default Project', tenantId: 'tenant-1', createdBy: 'user-1' }),
    updateProject: vi.fn().mockResolvedValue(null),
    deleteProject: vi.fn().mockResolvedValue(true),
    findProjectById: vi.fn().mockResolvedValue(null),
    findProjectByKey: vi.fn().mockResolvedValue(null),
    listProjects: vi.fn().mockResolvedValue([]),
    assignProjectIdToLegacyRecords: vi.fn().mockResolvedValue(undefined),

    // Quota policies
    createQuotaPolicy: vi.fn().mockResolvedValue({}),
    listQuotaPolicies: vi.fn().mockResolvedValue([]),
    updateQuotaPolicy: vi.fn().mockResolvedValue(null),
    deleteQuotaPolicy: vi.fn().mockResolvedValue(true),

    // API tokens
    createApiToken: vi.fn().mockResolvedValue({}),
    listApiTokens: vi.fn().mockResolvedValue([]),
    listTenantApiTokens: vi.fn().mockResolvedValue([]),
    listProjectApiTokens: vi.fn().mockResolvedValue([]),
    findApiTokenByToken: vi.fn().mockResolvedValue(null),
    deleteApiToken: vi.fn().mockResolvedValue(true),
    deleteTenantApiToken: vi.fn().mockResolvedValue(true),
    deleteProjectApiToken: vi.fn().mockResolvedValue(true),
    updateTokenLastUsed: vi.fn().mockResolvedValue(undefined),

    // Agent tracing sessions
    createAgentTracingSession: vi.fn().mockResolvedValue({}),
    countAgentTracingDistinctAgents: vi.fn().mockResolvedValue(0),
    agentTracingAgentExists: vi.fn().mockResolvedValue(false),
    cleanupAgentTracingRetention: vi.fn().mockResolvedValue({ sessionsDeleted: 0, eventsDeleted: 0 }),
    updateAgentTracingSession: vi.fn().mockResolvedValue(null),
    findAgentTracingSessionById: vi.fn().mockResolvedValue(null),
    listAgentTracingSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    listAgentTracingThreads: vi.fn().mockResolvedValue({ threads: [], total: 0 }),

    // Agent tracing events
    createAgentTracingEvent: vi.fn().mockResolvedValue({}),
    listAgentTracingEvents: vi.fn().mockResolvedValue([]),
    deleteAgentTracingEvents: vi.fn().mockResolvedValue(0),

    // Model management
    createModel: vi.fn().mockResolvedValue({}),
    updateModel: vi.fn().mockResolvedValue(null),
    deleteModel: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([]),
    findModelById: vi.fn().mockResolvedValue(null),
    findModelByKey: vi.fn().mockResolvedValue(null),

    // Prompt management
    createPrompt: vi.fn().mockResolvedValue({}),
    updatePrompt: vi.fn().mockResolvedValue(null),
    deletePrompt: vi.fn().mockResolvedValue(true),
    listPrompts: vi.fn().mockResolvedValue([]),
    findPromptById: vi.fn().mockResolvedValue(null),
    findPromptByKey: vi.fn().mockResolvedValue(null),
    createPromptVersion: vi.fn().mockResolvedValue({}),
    listPromptVersions: vi.fn().mockResolvedValue([]),
    findPromptVersionById: vi.fn().mockResolvedValue(null),
    deletePromptVersions: vi.fn().mockResolvedValue(0),

    // Prompt comments
    createPromptComment: vi.fn().mockResolvedValue({}),
    listPromptComments: vi.fn().mockResolvedValue([]),
    updatePromptComment: vi.fn().mockResolvedValue(null),
    deletePromptComment: vi.fn().mockResolvedValue(true),
    deletePromptCommentsByPromptId: vi.fn().mockResolvedValue(0),

    // Model usage logging — add additional methods as they appear in the interface
    createModelUsageLog: vi.fn().mockResolvedValue({}),
    listModelUsageLogs: vi.fn().mockResolvedValue([]),
    aggregateModelUsage: vi.fn().mockResolvedValue([]),
    deleteModelUsageLogsByModel: vi.fn().mockResolvedValue(0),
    getModelUsageCostSnapshot: vi.fn().mockResolvedValue(null),
    upsertModelUsageCostSnapshot: vi.fn().mockResolvedValue({}),
    listModelUsageCostSnapshots: vi.fn().mockResolvedValue([]),

    // Provider configs (matching DatabaseProvider interface)
    createProvider: vi.fn().mockResolvedValue({}),
    updateProvider: vi.fn().mockResolvedValue(null),
    deleteProvider: vi.fn().mockResolvedValue(true),
    listProviders: vi.fn().mockResolvedValue([]),
    findProviderByKey: vi.fn().mockResolvedValue(null),
    findProviderById: vi.fn().mockResolvedValue(null),

    // Vector indexes
    createVectorIndex: vi.fn().mockResolvedValue({}),
    updateVectorIndex: vi.fn().mockResolvedValue(null),
    deleteVectorIndex: vi.fn().mockResolvedValue(true),
    listVectorIndexes: vi.fn().mockResolvedValue([]),
    findVectorIndexByExternalId: vi.fn().mockResolvedValue(null),
    findVectorIndexById: vi.fn().mockResolvedValue(null),

    // Files
    createFileBucket: vi.fn().mockResolvedValue({}),
    updateFileBucket: vi.fn().mockResolvedValue(null),
    deleteFileBucket: vi.fn().mockResolvedValue(true),
    listFileBuckets: vi.fn().mockResolvedValue([]),
    findFileBucketByKey: vi.fn().mockResolvedValue(null),
    findFileBucketById: vi.fn().mockResolvedValue(null),
    createFileRecord: vi.fn().mockResolvedValue({}),
    updateFileRecord: vi.fn().mockResolvedValue(null),
    deleteFileRecord: vi.fn().mockResolvedValue(true),
    listFileRecords: vi.fn().mockResolvedValue({ records: [], total: 0 }),
    findFileRecordById: vi.fn().mockResolvedValue(null),
    countFileRecordsByBucket: vi.fn().mockResolvedValue(0),

    // Inference monitoring
    createInferenceServer: vi.fn().mockResolvedValue({}),
    updateInferenceServer: vi.fn().mockResolvedValue(null),
    deleteInferenceServer: vi.fn().mockResolvedValue(true),
    listInferenceServers: vi.fn().mockResolvedValue([]),
    findInferenceServerById: vi.fn().mockResolvedValue(null),
    findInferenceServerByKey: vi.fn().mockResolvedValue(null),
    upsertInferenceServerMetrics: vi.fn().mockResolvedValue({}),
    createInferenceServerMetrics: vi.fn().mockResolvedValue({}),
    deleteInferenceServerMetrics: vi.fn().mockResolvedValue(0),
    listInferenceServerMetrics: vi.fn().mockResolvedValue([]),
    findLatestInferenceServerMetrics: vi.fn().mockResolvedValue(null),

    // Guardrails
    createGuardrail: vi.fn().mockResolvedValue({}),
    updateGuardrail: vi.fn().mockResolvedValue(null),
    deleteGuardrail: vi.fn().mockResolvedValue(true),
    listGuardrails: vi.fn().mockResolvedValue([]),
    findGuardrailById: vi.fn().mockResolvedValue(null),
    findGuardrailByKey: vi.fn().mockResolvedValue(null),
    createGuardrailEvaluation: vi.fn().mockResolvedValue({}),
    listGuardrailEvaluations: vi.fn().mockResolvedValue({ evaluations: [], total: 0 }),

    // Alerts
    createAlertRule: vi.fn().mockResolvedValue({}),
    updateAlertRule: vi.fn().mockResolvedValue(null),
    deleteAlertRule: vi.fn().mockResolvedValue(true),
    listAlertRules: vi.fn().mockResolvedValue([]),
    findAlertRuleById: vi.fn().mockResolvedValue(null),
    createAlertEvent: vi.fn().mockResolvedValue({}),
    listAlertEvents: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    findAlertEventById: vi.fn().mockResolvedValue(null),
    updateAlertEvent: vi.fn().mockResolvedValue(null),
    countActiveAlerts: vi.fn().mockResolvedValue(0),

    // Memory
    createMemoryStore: vi.fn().mockResolvedValue({}),
    updateMemoryStore: vi.fn().mockResolvedValue(null),
    deleteMemoryStore: vi.fn().mockResolvedValue(true),
    listMemoryStores: vi.fn().mockResolvedValue([]),
    findMemoryStoreById: vi.fn().mockResolvedValue(null),
    findMemoryStoreByKey: vi.fn().mockResolvedValue(null),
    upsertMemoryEntry: vi.fn().mockResolvedValue({}),
    listMemoryEntries: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    findMemoryEntryById: vi.fn().mockResolvedValue(null),
    deleteMemoryEntry: vi.fn().mockResolvedValue(true),
    deleteMemoryEntriesByStore: vi.fn().mockResolvedValue(0),
    // Memory item methods (IMemoryItem based)
    createMemoryItem: vi.fn().mockResolvedValue({}),
    listMemoryItems: vi.fn().mockResolvedValue([]),
    findMemoryItemById: vi.fn().mockResolvedValue(null),
    findMemoryItemByHash: vi.fn().mockResolvedValue(null),
    updateMemoryItem: vi.fn().mockResolvedValue(null),
    deleteMemoryItem: vi.fn().mockResolvedValue(true),
    deleteMemoryItems: vi.fn().mockResolvedValue(0),
    incrementMemoryAccess: vi.fn().mockResolvedValue(undefined),

    // Semantic cache
    getSemanticCacheConfig: vi.fn().mockResolvedValue(null),
    upsertSemanticCacheConfig: vi.fn().mockResolvedValue({}),

    // RAG pipeline (legacy)
    createRagPipeline: vi.fn().mockResolvedValue({}),
    updateRagPipeline: vi.fn().mockResolvedValue(null),
    deleteRagPipeline: vi.fn().mockResolvedValue(true),
    listRagPipelines: vi.fn().mockResolvedValue([]),
    findRagPipelineById: vi.fn().mockResolvedValue(null),
    findRagPipelineByKey: vi.fn().mockResolvedValue(null),

    // RAG modules
    createRagModule: vi.fn().mockResolvedValue({ _id: 'ragmod-1', key: 'mod-key', status: 'active', totalDocuments: 0, totalChunks: 0 }),
    updateRagModule: vi.fn().mockResolvedValue(null),
    deleteRagModule: vi.fn().mockResolvedValue(true),
    listRagModules: vi.fn().mockResolvedValue([]),
    findRagModuleById: vi.fn().mockResolvedValue(null),
    findRagModuleByKey: vi.fn().mockResolvedValue(null),

    // RAG documents
    createRagDocument: vi.fn().mockResolvedValue({ _id: 'ragdoc-1', status: 'processing', chunkCount: 0 }),
    updateRagDocument: vi.fn().mockResolvedValue(null),
    deleteRagDocument: vi.fn().mockResolvedValue(true),
    listRagDocuments: vi.fn().mockResolvedValue([]),
    findRagDocumentById: vi.fn().mockResolvedValue(null),

    // RAG chunks
    bulkInsertRagChunks: vi.fn().mockResolvedValue(undefined),
    findRagChunksByVectorIds: vi.fn().mockResolvedValue([]),
    deleteRagChunksByDocumentId: vi.fn().mockResolvedValue(0),

    // RAG query logs
    createRagQueryLog: vi.fn().mockResolvedValue({}),
    listRagQueryLogs: vi.fn().mockResolvedValue([]),
  } as unknown as MockDb;

  return { ...base, ...overrides } as MockDb;
}

/** Convenience: tenant record fixture */
export const TENANT_ACME = {
  _id: 'tenant-acme-id',
  companyName: 'Acme Corp',
  slug: 'acme',
  dbName: 'tenant_acme',
  licenseType: 'FREE',
  createdAt: new Date('2025-01-01'),
};

/** Convenience: user record fixture */
export const USER_ALICE = {
  _id: 'user-alice-id',
  tenantId: 'tenant-acme-id',
  email: 'alice@acme.com',
  name: 'Alice',
  role: 'owner' as const,
  password: '$2b$10$xxx',
  licenseId: 'FREE',
  passwordHash: '$2b$10$xxx',
  licenseType: 'FREE',
  createdAt: new Date('2025-01-01'),
};

/** Convenience: API token fixture */
export const API_TOKEN_VALID = {
  _id: 'token-id-1',
  tenantId: 'tenant-acme-id',
  userId: 'user-alice-id',
  token: 'sk-test-valid-token-abc123',
  label: 'Test Token',
  name: 'Test Token',
  projectId: 'proj-default-id',
  createdAt: new Date('2025-01-01'),
};
