/**
 * MongoDB Provider – Base class
 *
 * Holds connection state, collection-name constants, and shared helper methods.
 * Domain-specific operations are added via mixins (see sibling files).
 */

import { MongoClient, Db, type MongoClientOptions } from 'mongodb';
import { createLogger } from '@/lib/core/logger';

export const logger = createLogger('mongodb');

// ── Collection-name constants ────────────────────────────────────────────

export const COLLECTIONS = {
  tenantUserDirectory: 'tenant_user_directory',
  providers: 'providers',
  vectorIndexes: 'vector_indexes',
  fileBuckets: 'file_buckets',
  files: 'files',
  prompts: 'prompts',
  promptVersions: 'prompt_versions',
  promptComments: 'prompt_comments',
  quotaPolicies: 'quota_policies',
  rateLimits: 'rate_limits',
  projects: 'projects',
  vectorCounters: 'vector_counters',
  agentTracingThreads: 'agent_tracing_threads',
  agentTracingSessions: 'agent_tracing_sessions',
  agentTracingEvents: 'agent_tracing_events',
  inferenceServers: 'inference_servers',
  inferenceServerMetrics: 'inference_server_metrics',
  guardrails: 'guardrails',
  guardrailEvalLogs: 'guardrail_evaluation_logs',
  alertRules: 'alert_rules',
  alertEvents: 'alert_events',
  incidents: 'incidents',
  ragModules: 'rag_modules',
  ragDocuments: 'rag_documents',
  ragChunks: 'rag_chunks',
  ragQueryLogs: 'rag_query_logs',
  memoryStores: 'memory_stores',
  memoryItems: 'memory_items',
  configGroups: 'config_groups',
  configItems: 'config_items',
  configAuditLogs: 'config_audit_logs',
  mcpServers: 'mcp_servers',
  mcpRequestLogs: 'mcp_request_logs',
  agents: 'agents',
  agentConversations: 'agent_conversations',
  tenants: 'tenants',
  users: 'users',
  apiTokens: 'api_tokens',
  models: 'models',
  modelUsageLogs: 'model_usage_logs',
} as const;

// ── Base class ───────────────────────────────────────────────────────────

export class MongoDBProviderBase {
  protected client: MongoClient | null = null;
  protected mainDb: Db | null = null;
  protected tenantDb: Db | null = null;
  protected readonly uri: string;
  protected readonly mainDbName: string;
  protected readonly clientOptions?: MongoClientOptions;

  constructor(uri: string, mainDbName: string = 'console_main', clientOptions?: MongoClientOptions) {
    this.uri = uri;
    this.mainDbName = mainDbName;
    this.clientOptions = clientOptions;
  }

  // ── Connection lifecycle ─────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    try {
      this.client = new MongoClient(this.uri, this.clientOptions);
      await this.client.connect();
      this.mainDb = this.client.db(this.mainDbName);
    } catch (error) {
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.mainDb = null;
      this.tenantDb = null;
    }
  }

  /**
   * Get the underlying MongoClient for health checks / diagnostics.
   */
  getClient(): MongoClient | null {
    return this.client;
  }

  async switchToTenant(tenantDbName: string): Promise<void> {
    if (!this.client) {
      throw new Error('Database client not connected. Call connect() first.');
    }
    this.tenantDb = this.client.db(tenantDbName);
  }

  // ── Protected helpers ────────────────────────────────────────────────

  protected getMainDb(): Db {
    if (!this.mainDb) {
      throw new Error('Main database not connected. Call connect() first.');
    }
    return this.mainDb;
  }

  protected getTenantDb(): Db {
    if (!this.tenantDb) {
      throw new Error('Tenant database not set. Call switchToTenant() first.');
    }
    return this.tenantDb;
  }

  protected normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  protected escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  protected buildProjectScopeFilter(projectId?: string): Record<string, unknown> {
    if (typeof projectId === 'string' && projectId.trim().length > 0) {
      return { projectId: projectId.trim() };
    }

    return {
      $or: [{ projectId: { $exists: false } }, { projectId: null }],
    };
  }

  protected normalizeThreadId(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  protected normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const flattened = value.flatMap((item) => (Array.isArray(item) ? item : [item]));

    return [...new Set(
      flattened
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    )];
  }
}
