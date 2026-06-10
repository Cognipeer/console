/**
 * SQLite Provider – Base class
 *
 * Holds connection state, shared helpers, and schema initialization.
 * Domain-specific operations are added via mixins (see sibling files).
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '@/lib/core/logger';
import { MAIN_SCHEMA_SQL, TENANT_SCHEMA_SQL, OCR_TENANT_SCHEMA_SQL } from './schema';

export const logger = createLogger('sqlite');

// ── Table-name constants (mirrors MongoDB COLLECTIONS) ──────────────

export const TABLES = {
  tenants: 'tenants',
  tenantUserDirectory: 'tenant_user_directory',
  users: 'users',
  auditLogs: 'audit_logs',
  projects: 'projects',
  apiTokens: 'api_tokens',
  prompts: 'prompts',
  promptVersions: 'prompt_versions',
  promptComments: 'prompt_comments',
  quotaPolicies: 'quota_policies',
  rateLimits: 'rate_limits',
  agentTracingSessions: 'agent_tracing_sessions',
  agentTracingEvents: 'agent_tracing_events',
  models: 'models',
  modelUsageLogs: 'model_usage_logs',
  vectorIndexes: 'vector_indexes',
  fileBuckets: 'file_buckets',
  files: 'files',
  providers: 'providers',
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
  memoryStores: 'memory_stores',
  memoryItems: 'memory_items',
  configGroups: 'config_groups',
  configItems: 'config_items',
  configAuditLogs: 'config_audit_logs',
  mcpServers: 'mcp_servers',
  mcpRequestLogs: 'mcp_request_logs',
  jsSandboxRuntimes: 'js_sandbox_runtimes',
  jsSandboxExecutions: 'js_sandbox_executions',
  tools: 'tools',
  toolRequestLogs: 'tool_request_logs',
  agents: 'agents',
  agentVersions: 'agent_versions',
  agentConversations: 'agent_conversations',
  vectorCounters: 'vector_counters',
  vectorMigrations: 'vector_migrations',
  vectorMigrationLogs: 'vector_migration_logs',
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

// ── Base class ───────────────────────────────────────────────────────

export class SQLiteProviderBase {
  protected mainDb: Database.Database | null = null;
  protected tenantDb: Database.Database | null = null;
  protected readonly dataDir: string;
  protected readonly mainDbName: string;
  private readonly tenantContext = new AsyncLocalStorage<Database.Database>();
  private readonly tenantNameContext = new AsyncLocalStorage<string>();
  /** Cache of already-opened tenant DB file handles */
  private tenantDbCache: Map<string, Database.Database> = new Map();

  constructor(dataDir: string, mainDbName: string = 'console_main') {
    this.dataDir = dataDir;
    this.mainDbName = mainDbName;
  }

  // ── Connection lifecycle ─────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.mainDb) return;

    fs.mkdirSync(this.dataDir, { recursive: true });

    const mainPath = path.join(this.dataDir, `${this.mainDbName}.db`);
    this.mainDb = new Database(mainPath);
    this.mainDb.pragma('journal_mode = WAL');
    this.mainDb.pragma('foreign_keys = ON');
    this.mainDb.exec(MAIN_SCHEMA_SQL);
    this.applyMainMigrations(this.mainDb);

    logger.info('SQLite main DB connected', { path: mainPath });
  }

  async disconnect(): Promise<void> {
    for (const db of this.tenantDbCache.values()) {
      db.close();
    }
    this.tenantDbCache.clear();
    this.tenantDb = null;
    this.tenantContext.disable();

    if (this.mainDb) {
      this.mainDb.close();
      this.mainDb = null;
    }
  }

  async switchToTenant(tenantDbName: string): Promise<void> {
    if (!this.mainDb) {
      throw new Error('Database not connected. Call connect() first.');
    }

    // Reuse cached connection
    const cached = this.tenantDbCache.get(tenantDbName);
    if (cached) {
      this.tenantDb = cached;
      this.tenantContext.enterWith(cached);
      this.tenantNameContext.enterWith(tenantDbName);
      return;
    }

    const tenantPath = path.join(this.dataDir, `${tenantDbName}.db`);
    const db = new Database(tenantPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(TENANT_SCHEMA_SQL);
    this.applyTenantMigrations(db);
    this.applyTenantIndexes(db);

    this.tenantDbCache.set(tenantDbName, db);
    this.tenantDb = db;
    this.tenantContext.enterWith(db);
    this.tenantNameContext.enterWith(tenantDbName);
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
   * match the currently bound tenant. Use this in cross-cutting code paths
   * that operate on session-derived tenantDbName.
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

  private applyMainMigrations(db: Database.Database): void {
    this.ensureTableColumn(
      db,
      TABLES.tenants,
      'licenseId',
      'licenseId TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.tenants,
      'licenseKey',
      'licenseKey TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.tenants,
      'licenseStatus',
      "licenseStatus TEXT NOT NULL DEFAULT 'free'",
    );
    this.ensureTableColumn(
      db,
      TABLES.tenants,
      'licensePayload',
      "licensePayload TEXT DEFAULT '{}'",
    );
    this.ensureTableColumn(
      db,
      TABLES.tenants,
      'licenseActivatedAt',
      'licenseActivatedAt TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.tenants,
      'licenseLastVerifiedAt',
      'licenseLastVerifiedAt TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.tenants,
      'licenseExpiresAt',
      'licenseExpiresAt TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.tenants,
      'licenseError',
      'licenseError TEXT',
    );
  }

  private applyTenantMigrations(db: Database.Database): void {
    this.ensureTableColumn(
      db,
      TABLES.users,
      'servicePermissions',
      'servicePermissions TEXT DEFAULT \'{}\'',
    );
    this.ensureTableColumn(
      db,
      TABLES.users,
      'passwordChangedAt',
      'passwordChangedAt TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.quotaPolicies,
      'scopeId',
      'scopeId TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.quotaPolicies,
      'priority',
      'priority INTEGER NOT NULL DEFAULT 100',
    );
    this.ensureTableColumn(
      db,
      TABLES.quotaPolicies,
      'enabled',
      'enabled INTEGER NOT NULL DEFAULT 1',
    );
    this.ensureTableColumn(
      db,
      TABLES.quotaPolicies,
      'label',
      'label TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.quotaPolicies,
      'description',
      'description TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.quotaPolicies,
      'createdBy',
      'createdBy TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.quotaPolicies,
      'updatedBy',
      'updatedBy TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.agentTracingSessions,
      'traceId',
      'traceId TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.agentTracingSessions,
      'rootSpanId',
      'rootSpanId TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.agentTracingSessions,
      'source',
      'source TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.agentTracingEvents,
      'traceId',
      'traceId TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.agentTracingEvents,
      'spanId',
      'spanId TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.agentTracingEvents,
      'parentSpanId',
      'parentSpanId TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.ragModules,
      'rerankerKey',
      'rerankerKey TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.ragModules,
      'rerankerOversample',
      'rerankerOversample INTEGER',
    );
    // GPU fleet host extensions (added 2026-05-22). Safe to ensure on every boot.
    this.ensureTableColumn(db, TABLES.gpuHosts, 'accelerator', "accelerator TEXT NOT NULL DEFAULT 'cpu'");
    this.ensureTableColumn(db, TABLES.gpuHosts, 'gpuFramework', "gpuFramework TEXT NOT NULL DEFAULT 'none'");
    this.ensureTableColumn(db, TABLES.gpuHosts, 'serviceAddress', 'serviceAddress TEXT');
    this.ensureTableColumn(db, TABLES.gpuHosts, 'terminalEnabled', 'terminalEnabled INTEGER NOT NULL DEFAULT 0');
    // Sandbox instance per-instance env (added later). Safe to ensure on boot.
    this.ensureTableColumn(db, 'sandbox_instances', 'env', 'env TEXT');
    // OCR jobs v2: the container model replaced the v1 batch layout (which had
    // incompatible NOT NULL columns like `mode`). Drop+recreate the brand-new
    // tables when an old schema is detected; additive columns otherwise.
    this.migrateOcrJobsSchema(db);
    // OCR usage split aggregates (added later). Safe to ensure on boot.
    this.ensureTableColumn(db, 'ocr_jobs', 'usageOcrTokens', 'usageOcrTokens INTEGER NOT NULL DEFAULT 0');
    this.ensureTableColumn(db, 'ocr_jobs', 'usageLlmTokens', 'usageLlmTokens INTEGER NOT NULL DEFAULT 0');
    this.ensureTableColumn(db, 'ocr_jobs', 'costOcr', 'costOcr REAL NOT NULL DEFAULT 0');
    this.ensureTableColumn(db, 'ocr_jobs', 'costLlm', 'costLlm REAL NOT NULL DEFAULT 0');
    // Red-team campaign cron schedule (added with the scheduler). Safe on boot.
    this.ensureTableColumn(db, TABLES.redTeamCampaigns, 'schedule', "schedule TEXT DEFAULT '{}'");
    // Dynamic LLM routing decision metadata on usage logs (added with the
    // Dynamic LLM router). Safe to ensure on boot.
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'routing', 'routing TEXT');
    // Analysis conversation tags for grouping/filtering (added later). Safe on boot.
    this.ensureTableColumn(db, TABLES.analysisConversations, 'tags', "tags TEXT DEFAULT '[]'");
    // Group tenant-level grants + directory-sync provenance (added with user
    // groups). Safe to ensure on boot for tenants created before the feature.
    this.ensureTableColumn(db, TABLES.groups, 'tenantRole', 'tenantRole TEXT');
    this.ensureTableColumn(db, TABLES.groups, 'servicePermissions', "servicePermissions TEXT DEFAULT '{}'");
    this.ensureTableColumn(db, TABLES.groups, 'source', "source TEXT NOT NULL DEFAULT 'local'");
    this.ensureTableColumn(db, TABLES.groups, 'externalId', 'externalId TEXT');
    this.ensureTableColumn(db, TABLES.groupMembers, 'source', "source TEXT NOT NULL DEFAULT 'local'");
    // External identity provenance on users (LDAP/SSO JIT provisioning). Added
    // with directory auth; safe to ensure on boot for pre-existing tenants.
    this.ensureTableColumn(db, TABLES.users, 'authProvider', "authProvider TEXT NOT NULL DEFAULT 'local'");
    this.ensureTableColumn(db, TABLES.users, 'externalId', 'externalId TEXT');
    // Realtime models can generate responses through an agent instead of a
    // raw chat model (added later). Safe to ensure on boot.
    this.ensureTableColumn(db, TABLES.realtimeModels, 'agentKey', 'agentKey TEXT');
  }

  private migrateOcrJobsSchema(db: Database.Database): void {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ocr_jobs'`)
      .get() as { name?: unknown } | undefined;
    if (exists) {
      const columns = db.prepare(`PRAGMA table_info(ocr_jobs)`).all() as Array<{ name?: unknown }>;
      const names = new Set(columns.map((c) => String(c.name)));
      const isV1 = names.has('mode') || !names.has('bucketKey');
      if (isV1) {
        db.exec(`DROP TABLE IF EXISTS ocr_job_items; DROP TABLE IF EXISTS ocr_jobs;`);
        db.exec(OCR_TENANT_SCHEMA_SQL);
        logger.info('OCR jobs schema migrated to v2 (drop+recreate)');
      }
    }
  }

  private applyTenantIndexes(db: Database.Database): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_groups_externalId
        ON ${TABLES.groups}(tenantId, externalId);
      CREATE INDEX IF NOT EXISTS idx_tracing_sessions_project_startedAt
        ON ${TABLES.agentTracingSessions}(projectId, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_tracing_sessions_project_createdAt
        ON ${TABLES.agentTracingSessions}(projectId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_tracing_sessions_project_status_startedAt
        ON ${TABLES.agentTracingSessions}(projectId, status, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_tracing_sessions_project_agent_startedAt
        ON ${TABLES.agentTracingSessions}(projectId, agentName, startedAt DESC);
    `);
  }

  private ensureTableColumn(
    db: Database.Database,
    tableName: string,
    columnName: string,
    columnDefinition: string,
  ): void {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
    const hasColumn = columns.some((column) => String(column.name) === columnName);
    if (hasColumn) return;

    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
    logger.info('SQLite schema migration applied', { tableName, columnName });
  }

  // ── Public helpers ────────────────────────────────────────────────

  /** Expose the main database handle for health checks. */
  getMainDbHandle(): Database.Database | null {
    return this.mainDb;
  }

  // ── Protected helpers ────────────────────────────────────────────

  protected getMainDb(): Database.Database {
    if (!this.mainDb) {
      throw new Error('Main database not connected. Call connect() first.');
    }
    return this.mainDb;
  }

  protected getTenantDb(): Database.Database {
    const tenantDb = this.tenantContext.getStore() ?? this.tenantDb;
    if (!tenantDb) {
      throw new Error('Tenant database not set. Call switchToTenant() first.');
    }
    return tenantDb;
  }

  /** Generate a new random ID (replaces MongoDB ObjectId). */
  protected newId(): string {
    return randomUUID();
  }

  /** Current ISO timestamp string for storage. */
  protected now(): string {
    return new Date().toISOString();
  }

  protected normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  protected escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** SQLite LIKE pattern ("contains" search). */
  protected likePattern(value: string): string {
    // Escape %, _ which are special in LIKE
    const escaped = value.replace(/%/g, '\\%').replace(/_/g, '\\_');
    return `%${escaped}%`;
  }

  protected normalizeThreadId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  protected normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const flattened = value.flatMap((item) => (Array.isArray(item) ? item : [item]));
    return [
      ...new Set(
        flattened
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  }

  // ── JSON column helpers ──────────────────────────────────────────

  /** Safely parse a JSON string column. Returns fallback on failure. */
  protected parseJson<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as T;
      } catch {
        return fallback;
      }
    }
    return value as T;
  }

  /** Stringify a value for storage in a TEXT column. */
  protected toJson(value: unknown): string {
    return JSON.stringify(value ?? null);
  }

  /** Convert boolean to SQLite integer (0/1). */
  protected toBoolInt(value: unknown): number {
    return value ? 1 : 0;
  }

  /** Convert SQLite integer (0/1) to boolean. */
  protected fromBoolInt(value: unknown): boolean {
    return value === 1 || value === '1' || value === true;
  }

  /** Parse ISO string to Date, or return undefined. */
  protected toDate(value: unknown): Date | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    return undefined;
  }

  /** Build a project-scope WHERE clause fragment. */
  protected buildProjectScopeFilter(projectId?: string): {
    clause: string;
    params: Record<string, unknown>;
  } {
    if (typeof projectId === 'string' && projectId.trim().length > 0) {
      return { clause: 'projectId = @projectId', params: { projectId: projectId.trim() } };
    }
    return { clause: '(projectId IS NULL OR projectId = \'\')', params: {} };
  }
}
