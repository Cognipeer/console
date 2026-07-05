/**
 * MongoDB Provider – Base class
 *
 * Holds connection state, collection-name constants, and shared helper methods.
 * Domain-specific operations are added via mixins (see sibling files).
 */

import { MongoClient, Db, type MongoClientOptions } from 'mongodb';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '@/lib/core/logger';

export const logger = createLogger('mongodb');

// ── Collection-name constants ────────────────────────────────────────────

export const COLLECTIONS = {
  tenantUserDirectory: 'tenant_user_directory',
  auditLogs: 'audit_logs',
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
  evaluationTargets: 'evaluation_targets',
  evaluationDatasets: 'evaluation_datasets',
  evaluationSuites: 'evaluation_suites',
  evaluationRuns: 'evaluation_runs',
  redTeamCampaigns: 'redteam_campaigns',
  redTeamRuns: 'redteam_runs',
  redTeamCustomProbes: 'redteam_custom_probes',
  analysisDefinitions: 'analysis_definitions',
  analysisConversations: 'analysis_conversations',
  analysisRuns: 'analysis_runs',
  piiPolicies: 'pii_policies',
  alertRules: 'alert_rules',
  alertEvents: 'alert_events',
  incidents: 'incidents',
  ragModules: 'rag_modules',
  ragDocuments: 'rag_documents',
  ragChunks: 'rag_chunks',
  ragQueryLogs: 'rag_query_logs',
  rerankers: 'rerankers',
  rerankerRunLogs: 'reranker_run_logs',
  websearchRunLogs: 'websearch_run_logs',
  memoryStores: 'memory_stores',
  memoryItems: 'memory_items',
  configGroups: 'config_groups',
  configItems: 'config_items',
  configAuditLogs: 'config_audit_logs',
  mcpServers: 'mcp_servers',
  mcpRequestLogs: 'mcp_request_logs',
  tools: 'tools',
  toolRequestLogs: 'tool_request_logs',
  agents: 'agents',
  agentVersions: 'agent_versions',
  agentConversations: 'agent_conversations',
  tenants: 'tenants',
  users: 'users',
  apiTokens: 'api_tokens',
  models: 'models',
  modelUsageLogs: 'model_usage_logs',
  browsers: 'browsers',
  browserSessions: 'browser_sessions',
  browserSessionEvents: 'browser_session_events',
  crawlers: 'crawlers',
  crawlJobs: 'crawl_jobs',
  crawlResults: 'crawl_results',
  ocrJobs: 'ocr_jobs',
  ocrJobItems: 'ocr_job_items',
  batchJobs: 'batch_jobs',
  batchJobItems: 'batch_job_items',
  realtimeModels: 'realtime_models',
  realtimeSessions: 'realtime_sessions',
  // ── Project membership & future groups ──────────────────────────────
  userProjects: 'user_projects',
  groups: 'groups',
  groupMembers: 'group_members',
  groupProjects: 'group_projects',
  // ── Cluster (main database) ────────────────────────────────────────
  nodes: 'nodes',
  instanceAssignments: 'instance_assignments',
  // ── GPU fleet (tenant database) ───────────────────────────────────
  gpuHosts: 'gpu_hosts',
  gpuSlices: 'gpu_slices',
  llmDeployments: 'llm_deployments',
  gpuFleetCommands: 'gpu_fleet_commands',
  gpuFleetEvents: 'gpu_fleet_events',
  gpuFleetSettings: 'gpu_fleet_settings',
  llmPools: 'llm_pools',
} as const;

// ── Base class ───────────────────────────────────────────────────────────

export class MongoDBProviderBase {
  protected client: MongoClient | null = null;
  protected mainDb: Db | null = null;
  protected tenantDb: Db | null = null;
  private readonly tenantContext = new AsyncLocalStorage<Db>();
  private readonly tenantNameContext = new AsyncLocalStorage<string>();
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
      this.tenantContext.disable();
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
    const tenantDb = this.client.db(tenantDbName);
    this.tenantDb = tenantDb;
    this.tenantContext.enterWith(tenantDb);
    this.tenantNameContext.enterWith(tenantDbName);
  }

  /**
   * Run `fn` with the tenant DB bound for its entire (sync + async) execution
   * via a real AsyncLocalStorage scope. `switchToTenant` uses `enterWith`,
   * whose binding does NOT propagate to the caller's continuation after an
   * `await` — so a caller that does not establish a tenant scope at request
   * top falls back to the process-global `this.tenantDb`, which a concurrent
   * request for another tenant can overwrite (cross-tenant data leakage).
   * `runWithTenant` is immune to both problems.
   */
  async runWithTenant<T>(tenantDbName: string, fn: () => T | Promise<T>): Promise<T> {
    if (!this.client) {
      throw new Error('Database client not connected. Call connect() first.');
    }
    const tenantDb = this.client.db(tenantDbName);
    return this.tenantContext.run(tenantDb, () =>
      this.tenantNameContext.run(tenantDbName, () => fn()),
    );
  }

  /**
   * Name of the tenant DB currently bound to this request context.
   * Returns `null` when no tenant is active (request hasn't called switchToTenant).
   */
  getCurrentTenantDbName(): string | null {
    return this.tenantNameContext.getStore() ?? null;
  }

  /**
   * Defense-in-depth guard: throws if the caller's expected tenant does not
   * match the currently bound tenant.
   */
  assertTenantContext(expectedTenantDbName: string): void {
    const active = this.tenantNameContext.getStore();
    if (!active) {
      throw new Error(`Tenant context not initialized (expected ${expectedTenantDbName}).`);
    }
    if (active !== expectedTenantDbName) {
      throw new Error(
        `Tenant context mismatch: active=${active}, expected=${expectedTenantDbName}. Refusing to operate on the wrong tenant.`,
      );
    }
  }

  // ── Protected helpers ────────────────────────────────────────────────

  protected getMainDb(): Db {
    if (!this.mainDb) {
      throw new Error('Main database not connected. Call connect() first.');
    }
    return this.mainDb;
  }

  protected getTenantDb(): Db {
    const tenantDb = this.tenantContext.getStore() ?? this.tenantDb;
    if (!tenantDb) {
      throw new Error('Tenant database not set. Call switchToTenant() first.');
    }
    return tenantDb;
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
