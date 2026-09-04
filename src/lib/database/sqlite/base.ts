/**
 * SQLite Provider – Base class
 *
 * Holds connection state, shared helpers, and schema initialization.
 * Domain-specific operations are added via mixins (see sibling files).
 */

import { createLogger } from '@/lib/core/logger';
import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { warnGlobalTenantFallback } from '../tenantScopeGuard';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAIN_SCHEMA_SQL,
  OCR_TENANT_SCHEMA_SQL,
  TENANT_SCHEMA_SQL,
} from './schema';

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
  usageDaily: 'usage_daily',
  externalModelPricing: 'external_model_pricing',
  vectorIndexes: 'vector_indexes',
  vectorQueryLogs: 'vector_query_logs',
  fileBuckets: 'file_buckets',
  files: 'files',
  providers: 'providers',
  inferenceServers: 'inference_servers',
  inferenceServerMetrics: 'inference_server_metrics',
  guardrails: 'guardrails',
  guardrailEvalLogs: 'guardrail_evaluation_logs',
  guardrailWordLists: 'guardrail_word_lists',
  evaluationTargets: 'evaluation_targets',
  evaluationDatasets: 'evaluation_datasets',
  evaluationDatasetItems: 'evaluation_dataset_items',
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
  prescriptionReports: 'prescription_reports',
  incidents: 'incidents',
  ragModules: 'rag_modules',
  ragDocuments: 'rag_documents',
  ragChunks: 'rag_chunks',
  ragQueryLogs: 'rag_query_logs',
  ragReindexRuns: 'rag_reindex_runs',
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
  mcpAuditLogs: 'mcp_audit_logs',
  mcpHubs: 'mcp_hubs',
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
  browserFlows: 'browser_flows',
  browserFlowRuns: 'browser_flow_runs',
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
  // ── Signup gating (main database) ──────────────────────────────────
  betaAccessCodes: 'beta_access_codes',
  // ── GPU fleet (tenant database) ───────────────────────────────────
  gpuHosts: 'gpu_hosts',
  gpuSlices: 'gpu_slices',
  llmDeployments: 'llm_deployments',
  gpuFleetCommands: 'gpu_fleet_commands',
  gpuFleetEvents: 'gpu_fleet_events',
  gpuFleetSettings: 'gpu_fleet_settings',
  gpuHostMetrics: 'gpu_host_metrics',
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
   * Run `fn` with the tenant DB bound for its entire (sync + async) execution
   * via a real AsyncLocalStorage scope — immune to the `enterWith`
   * across-`await` binding loss and to process-global overwrites by concurrent
   * requests for other tenants. See the MongoDB provider for the rationale.
   */
  async runWithTenant<T>(
    tenantDbName: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    // Ensure the tenant DB is opened/cached and the global fallback is warm.
    await this.switchToTenant(tenantDbName);
    const db = this.tenantDbCache.get(tenantDbName);
    if (!db) {
      throw new Error(`Tenant database not available: ${tenantDbName}`);
    }
    return this.tenantContext.run(db, () =>
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
   * match the currently bound tenant. Use this in cross-cutting code paths
   * that operate on session-derived tenantDbName.
   */
  assertTenantContext(expectedTenantDbName: string): void {
    const active = this.tenantNameContext.getStore();
    if (!active) {
      throw new Error(
        `Tenant context not initialized (expected ${expectedTenantDbName}).`,
      );
    }
    if (active !== expectedTenantDbName) {
      throw new Error(
        `Tenant context mismatch: active=${active}, expected=${expectedTenantDbName}. Refusing to operate on the wrong tenant.`,
      );
    }
  }

  private applyMainMigrations(db: Database.Database): void {
    this.ensureTableColumn(db, TABLES.tenants, 'licenseId', 'licenseId TEXT');
    this.ensureTableColumn(db, TABLES.tenants, 'licenseKey', 'licenseKey TEXT');
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
    // Per-token least-privilege scope (JSON UserServicePermissions). Legacy rows
    // read as NULL = unscoped (inherit owner). API tokens live in the main DB.
    this.ensureTableColumn(
      db,
      TABLES.apiTokens,
      'servicePermissions',
      'servicePermissions TEXT',
    );
    // Session user that minted the token — differs from `userId` when an
    // admin mints on behalf of another (e.g. login-disabled) user.
    this.ensureTableColumn(db, TABLES.apiTokens, 'createdBy', 'createdBy TEXT');
  }

  private applyTenantMigrations(db: Database.Database): void {
    // Browser profiles: an encrypted `storageState` (signed-in cookies) plus
    // its non-secret description. CREATE TABLE IF NOT EXISTS never alters an
    // existing tenant DB, so a browser created before this change would fail
    // its next UPDATE without these.
    this.ensureTableColumn(db, TABLES.browsers, 'storageStateEnc', 'storageStateEnc TEXT');
    this.ensureTableColumn(db, TABLES.browsers, 'storageStateMeta', 'storageStateMeta TEXT');

    // Knowledge Engine: richer chunking (offsets, heading path, real token
    // counts) plus the stored source a re-index rebuilds from. CREATE TABLE IF
    // NOT EXISTS never alters an existing tenant DB, so without these the
    // INSERTs would throw on every tenant provisioned before this change.
    for (const [column, ddl] of [
      ['fileBucketKey', 'fileBucketKey TEXT'],
      ['fileProviderKey', 'fileProviderKey TEXT'],
      ['chunkConfig', 'chunkConfig TEXT'],
      ['sourceText', 'sourceText TEXT'],
      ['sourceTextKey', 'sourceTextKey TEXT'],
      ['sourceHash', 'sourceHash TEXT'],
    ] as const) {
      this.ensureTableColumn(db, TABLES.ragDocuments, column, ddl);
    }
    // Cross-replica ownership of a re-index run.
    for (const [column, ddl] of [
      ['claimedBy', 'claimedBy TEXT'],
      ['claimedAt', 'claimedAt TEXT'],
      ['heartbeatAt', 'heartbeatAt TEXT'],
    ] as const) {
      this.ensureTableColumn(db, TABLES.ragReindexRuns, column, ddl);
    }
    // Vector query logs record whether the keyword channel ran.
    this.ensureTableColumn(db, TABLES.vectorQueryLogs, 'hybrid', 'hybrid INTEGER');
    // `rag` evaluation targets: without these the three retrieval fields are
    // dropped on insert and every run fails with "has no ragModuleKey".
    for (const [column, ddl] of [
      ['ragModuleKey', 'ragModuleKey TEXT'],
      ['retrievalTopK', 'retrievalTopK INTEGER'],
      ['retrievalMinScore', 'retrievalMinScore REAL'],
    ] as const) {
      this.ensureTableColumn(db, TABLES.evaluationTargets, column, ddl);
    }
    for (const [column, ddl] of [
      ['charStart', 'charStart INTEGER'],
      ['charEnd', 'charEnd INTEGER'],
      ['headingPath', 'headingPath TEXT'],
      ['tokenCount', 'tokenCount INTEGER'],
    ] as const) {
      this.ensureTableColumn(db, TABLES.ragChunks, column, ddl);
    }
    // Query analytics: what the store returned before minScore, and the scores
    // themselves. Without preFilterMatchCount a zero-result query cannot be
    // told apart from a threshold that discarded everything.
    for (const [column, ddl] of [
      ['preFilterMatchCount', 'preFilterMatchCount INTEGER'],
      ['topScore', 'topScore REAL'],
      ['avgScore', 'avgScore REAL'],
      ['minScoreApplied', 'minScoreApplied REAL'],
      ['hybrid', 'hybrid INTEGER'],
    ] as const) {
      this.ensureTableColumn(db, TABLES.ragQueryLogs, column, ddl);
    }
    // Retrieval controls and the re-index handshake. Existing rows read NULL,
    // which the mapper turns back into `undefined` = "feature off".
    for (const [column, ddl] of [
      ['defaultFilter', 'defaultFilter TEXT'],
      ['filterableFields', 'filterableFields TEXT'],
      ['hybrid', 'hybrid TEXT'],
      ['isolateByModule', 'isolateByModule INTEGER'],
      ['reindexRequired', 'reindexRequired INTEGER'],
      ['activeReindexRunKey', 'activeReindexRunKey TEXT'],
      ['lastReindexAt', 'lastReindexAt TEXT'],
    ] as const) {
      this.ensureTableColumn(db, TABLES.ragModules, column, ddl);
    }
    this.ensureTableColumn(
      db,
      TABLES.users,
      'servicePermissions',
      "servicePermissions TEXT DEFAULT '{}'",
    );
    this.ensureTableColumn(
      db,
      TABLES.users,
      'passwordChangedAt',
      'passwordChangedAt TEXT',
    );
    this.ensureTableColumn(db, TABLES.quotaPolicies, 'scopeId', 'scopeId TEXT');
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
    this.ensureTableColumn(db, TABLES.quotaPolicies, 'label', 'label TEXT');
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
    // Query defaults + response shape. These were added to the Mongo tree and
    // the UI without ever reaching SQLite, so on SQLite they silently vanished.
    this.ensureTableColumn(
      db,
      TABLES.ragModules,
      'defaultTopK',
      'defaultTopK INTEGER',
    );
    this.ensureTableColumn(
      db,
      TABLES.ragModules,
      'defaultMinScore',
      'defaultMinScore REAL',
    );
    this.ensureTableColumn(
      db,
      TABLES.ragModules,
      'responseDetail',
      'responseDetail TEXT',
    );
    // GPU fleet host extensions (added 2026-05-22). Safe to ensure on every boot.
    this.ensureTableColumn(
      db,
      TABLES.gpuHosts,
      'accelerator',
      "accelerator TEXT NOT NULL DEFAULT 'cpu'",
    );
    this.ensureTableColumn(
      db,
      TABLES.gpuHosts,
      'gpuFramework',
      "gpuFramework TEXT NOT NULL DEFAULT 'none'",
    );
    this.ensureTableColumn(
      db,
      TABLES.gpuHosts,
      'serviceAddress',
      'serviceAddress TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.gpuHosts,
      'terminalEnabled',
      'terminalEnabled INTEGER NOT NULL DEFAULT 0',
    );
    // GPU fleet slices: a slice can now host multiple deployments at once
    // (added 2026-07-13). Additive column + one-time backfill from the old
    // singular `assignedDeploymentId` so existing bindings aren't lost.
    this.ensureTableColumn(
      db,
      TABLES.gpuSlices,
      'assignedDeploymentIds',
      "assignedDeploymentIds TEXT NOT NULL DEFAULT '[]'",
    );
    this.backfillGpuSliceAssignments(db);
    // GPU fleet tenant-wide Hugging Face token, auto-injected into vLLM/TGI/
    // Ollama deployments for gated model downloads (added 2026-07-13).
    this.ensureTableColumn(
      db,
      TABLES.gpuFleetSettings,
      'huggingFaceTokenEnc',
      'huggingFaceTokenEnc TEXT',
    );
    // GPU fleet deployment → project link, chosen by the operator at deploy
    // time so auto-published Model Hub rows land in the right project
    // instead of always the tenant default (added 2026-07-15).
    this.ensureTableColumn(
      db,
      TABLES.llmDeployments,
      'projectId',
      'projectId TEXT',
    );
    // Sandbox instance per-instance env (added later). Safe to ensure on boot.
    this.ensureTableColumn(db, 'sandbox_instances', 'env', 'env TEXT');
    this.ensureTableColumn(
      db,
      'sandbox_instances',
      'persist',
      'persist INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureTableColumn(
      db,
      'sandbox_instances',
      'blockNetwork',
      'blockNetwork INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureTableColumn(
      db,
      'sandbox_instances',
      'resources',
      'resources TEXT',
    );
    this.ensureTableColumn(
      db,
      'sandbox_templates',
      'idleReapSeconds',
      'idleReapSeconds INTEGER',
    );
    this.ensureTableColumn(
      db,
      'sandbox_templates',
      'warmPoolSize',
      'warmPoolSize INTEGER',
    );
    this.ensureTableColumn(
      db,
      'sandbox_instances',
      'warm',
      'warm INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureTableColumn(db, 'sandbox_instances', 'warmKey', 'warmKey TEXT');
    // Template Studio (plan §7): distinguishes an ordinary read-only jail
    // from a writable builder instance used to promote a new template.
    // Docker-mode instances are always 'runtime' — the column exists either
    // way so the sandbox_instances row shape doesn't fork per executor.
    this.ensureTableColumn(db, 'sandbox_instances', 'class', "class TEXT NOT NULL DEFAULT 'runtime'");
    // The Template Studio (sandbox-host) source a builder/runtime jail instance
    // was launched from — persisted so boot redrive/restart relaunches from the
    // same rootfs instead of silently falling back to the seed template (the
    // same failure mode imageRef exists to prevent for docker-mode snapshots).
    this.ensureTableColumn(db, 'sandbox_instances', 'studioTemplateKey', 'studioTemplateKey TEXT');
    this.ensureTableColumn(db, 'sandbox_instances', 'studioTemplateVersion', 'studioTemplateVersion INTEGER');
    // Promoting a builder instance now upserts a real sandbox_templates row
    // (see instanceService.promoteInstanceToTemplate) so Template Studio
    // output shows up directly in the normal template list/picker — these
    // mirror the instance-level columns above but on the template itself.
    this.ensureTableColumn(db, 'sandbox_templates', 'studioTemplateKey', 'studioTemplateKey TEXT');
    this.ensureTableColumn(db, 'sandbox_templates', 'studioTemplateVersion', 'studioTemplateVersion INTEGER');
    this.ensureTableColumn(
      db,
      'sandbox_snapshots',
      'warmPoolSize',
      'warmPoolSize INTEGER',
    );
    this.ensureTableColumn(
      db,
      'sandbox_volumes',
      'bucketKey',
      'bucketKey TEXT',
    );
    this.ensureTableColumn(
      db,
      'sandbox_snapshots',
      'blockNetwork',
      'blockNetwork INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureTableColumn(
      db,
      'sandbox_snapshots',
      'resources',
      'resources TEXT',
    );
    // OCR jobs v2: the container model replaced the v1 batch layout (which had
    // incompatible NOT NULL columns like `mode`). Drop+recreate the brand-new
    // tables when an old schema is detected; additive columns otherwise.
    this.migrateOcrJobsSchema(db);
    // OCR usage split aggregates (added later). Safe to ensure on boot.
    this.ensureTableColumn(
      db,
      'ocr_jobs',
      'usageOcrTokens',
      'usageOcrTokens INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureTableColumn(
      db,
      'ocr_jobs',
      'usageLlmTokens',
      'usageLlmTokens INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureTableColumn(
      db,
      'ocr_jobs',
      'costOcr',
      'costOcr REAL NOT NULL DEFAULT 0',
    );
    this.ensureTableColumn(
      db,
      'ocr_jobs',
      'costLlm',
      'costLlm REAL NOT NULL DEFAULT 0',
    );
    // Red-team campaign cron schedule (added with the scheduler). Safe on boot.
    this.ensureTableColumn(
      db,
      TABLES.redTeamCampaigns,
      'schedule',
      "schedule TEXT DEFAULT '{}'",
    );
    // Dynamic LLM routing decision metadata on usage logs (added with the
    // Dynamic LLM router). Safe to ensure on boot.
    this.ensureTableColumn(
      db,
      TABLES.modelUsageLogs,
      'routing',
      'routing TEXT',
    );
    // Analysis conversation tags for grouping/filtering (added later). Safe on boot.
    this.ensureTableColumn(
      db,
      TABLES.analysisConversations,
      'tags',
      "tags TEXT DEFAULT '[]'",
    );
    // Group tenant-level grants + directory-sync provenance (added with user
    // groups). Safe to ensure on boot for tenants created before the feature.
    this.ensureTableColumn(db, TABLES.groups, 'tenantRole', 'tenantRole TEXT');
    this.ensureTableColumn(
      db,
      TABLES.groups,
      'servicePermissions',
      "servicePermissions TEXT DEFAULT '{}'",
    );
    this.ensureTableColumn(
      db,
      TABLES.groups,
      'source',
      "source TEXT NOT NULL DEFAULT 'local'",
    );
    this.ensureTableColumn(db, TABLES.groups, 'externalId', 'externalId TEXT');
    this.ensureTableColumn(
      db,
      TABLES.groupMembers,
      'source',
      "source TEXT NOT NULL DEFAULT 'local'",
    );
    // External identity provenance on users (LDAP/SSO JIT provisioning). Added
    // with directory auth; safe to ensure on boot for pre-existing tenants.
    this.ensureTableColumn(
      db,
      TABLES.users,
      'authProvider',
      "authProvider TEXT NOT NULL DEFAULT 'local'",
    );
    this.ensureTableColumn(db, TABLES.users, 'externalId', 'externalId TEXT');
    // Realtime models can generate responses through an agent instead of a
    // raw chat model (added later). Safe to ensure on boot.
    this.ensureTableColumn(
      db,
      TABLES.realtimeModels,
      'agentKey',
      'agentKey TEXT',
    );
    // Parametric "agent is using tools" filler line (added with tool-call
    // progress events). Safe to ensure on boot.
    this.ensureTableColumn(
      db,
      TABLES.realtimeModels,
      'toolStatusMessage',
      'toolStatusMessage TEXT',
    );
    // Per-project sandbox resource defaults (added with port preview + resource
    // limits). Safe to ensure on boot for tenants created before the feature.
    this.ensureTableColumn(
      db,
      'sandbox_settings',
      'projectResourceDefaults',
      'projectResourceDefaults TEXT',
    );
    // Per-sandbox preview toggles (enabled + public/private). Safe to ensure on
    // boot; default enabled=on, public=off (private behind login).
    this.ensureTableColumn(
      db,
      'sandbox_instances',
      'previewEnabled',
      'previewEnabled INTEGER NOT NULL DEFAULT 1',
    );
    this.ensureTableColumn(
      db,
      'sandbox_instances',
      'previewPublic',
      'previewPublic INTEGER NOT NULL DEFAULT 0',
    );
    // Launch image an instance was created from (snapshot/fork restore). Persisted
    // so start/redrive/attach relaunch from the SAME image instead of silently
    // reverting to template.baseImage (the meeting-bot "snapshot rot" failure).
    // Safe to ensure on boot for tenants created before the feature.
    this.ensureTableColumn(
      db,
      'sandbox_instances',
      'imageRef',
      'imageRef TEXT',
    );
    // Web search run logs: inline answer + returned results (added with the
    // AI-answer feature). Safe to ensure on boot.
    this.ensureTableColumn(
      db,
      TABLES.websearchRunLogs,
      'answer',
      'answer TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.websearchRunLogs,
      'results',
      'results TEXT',
    );
    // Guardrail hardening: enforcement direction was never in the SQLite
    // schema even though the mixin writes it, and failMode is new. Safe to
    // ensure on boot for tenants created before the feature.
    this.ensureTableColumn(
      db,
      TABLES.guardrails,
      'target',
      "target TEXT NOT NULL DEFAULT 'input'",
    );
    this.ensureTableColumn(
      db,
      TABLES.guardrails,
      'failMode',
      "failMode TEXT NOT NULL DEFAULT 'open'",
    );
    // Guardrail hook plane (v2). The whole configuration is ONE JSON blob so
    // adding a check family later costs no further migration. '{}' is the
    // "not authored" sentinel — mapGuardrailRow turns it into undefined so
    // ensureHooks() re-derives from the legacy columns, which stay populated.
    // hooksVersion 0 means exactly that; >= 1 means an operator authored it.
    this.ensureTableColumn(
      db,
      TABLES.guardrails,
      'hooks',
      "hooks TEXT DEFAULT '{}'",
    );
    this.ensureTableColumn(
      db,
      TABLES.guardrails,
      'hooksVersion',
      'hooksVersion INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureTableColumn(
      db,
      TABLES.guardrails,
      'mode',
      "mode TEXT NOT NULL DEFAULT 'enforce'",
    );
    // Multi-guardrail binding on models (IGuardrailBinding[] as one JSON
    // blob). No DEFAULT: a NULL column is the "never authored" sentinel that
    // mapModelRow maps to undefined, which is what makes resolveBindings fall
    // back to inputGuardrailKey/outputGuardrailKey. A DEFAULT '[]' would tell
    // every pre-existing model "bound to nothing" and disarm it on upgrade.
    //
    // Nothing indexes this column, so unlike guardrail_evaluation_logs.hook it
    // needs no companion entry in applyTenantIndexes().
    //
    // The AGENT side needs no migration: its bindings live in IAgentConfig and
    // ride the existing `config` JSON column on both backends.
    this.ensureTableColumn(db, TABLES.models, 'guardrails', 'guardrails TEXT');
    // Evaluation log: without these, all five hooks collapse into the two
    // legacy `target` values and a tool.pre block is indistinguishable from an
    // output.pre redaction in the audit trail. riskScore has no other home.
    this.ensureTableColumn(db, TABLES.guardrailEvalLogs, 'hook', 'hook TEXT');
    this.ensureTableColumn(
      db,
      TABLES.guardrailEvalLogs,
      'decision',
      'decision TEXT',
    );
    this.ensureTableColumn(
      db,
      TABLES.guardrailEvalLogs,
      'riskScore',
      'riskScore INTEGER',
    );
    this.ensureTableColumn(
      db,
      TABLES.crawlJobs,
      'cancelRequestedAt',
      'cancelRequestedAt TEXT',
    );

    // Usage attribution envelope (userId/apiTokenId/actorType) on every
    // per-service usage/log table — filled centrally from the request context
    // (lib/services/usage/usageEvents.ts). Safe to ensure on boot for tenants
    // created before the feature.
    const usageAttributionTables = [
      TABLES.modelUsageLogs,
      TABLES.guardrailEvalLogs,
      TABLES.websearchRunLogs,
      TABLES.mcpRequestLogs,
      TABLES.toolRequestLogs,
      TABLES.ragQueryLogs,
      TABLES.vectorQueryLogs,
      TABLES.rerankerRunLogs,
      TABLES.crawlJobs,
      TABLES.browserSessions,
      TABLES.batchJobs,
      TABLES.ocrJobs,
      TABLES.agentTracingSessions,
      TABLES.realtimeSessions,
      // EE sandbox instances (table lives in the shared tenant schema; the
      // service/mixin code is enterprise-only).
      'sandbox_instances',
    ];
    for (const table of usageAttributionTables) {
      this.ensureTableColumn(db, table, 'userId', 'userId TEXT');
      this.ensureTableColumn(db, table, 'apiTokenId', 'apiTokenId TEXT');
      this.ensureTableColumn(db, table, 'actorType', 'actorType TEXT');
    }

    // usage_daily.dayDate (real Date for the reports engine) was added after
    // the table shipped; ensure on boot for DBs created in between.
    this.ensureTableColumn(db, TABLES.usageDaily, 'dayDate', 'dayDate TEXT');

    // usage_daily.agentKey (agent attribution dimension). Existing rows get
    // '' via the column default; the v2 unique index that includes it is
    // created in applyTenantIndexes (must run after this migration).
    this.ensureTableColumn(
      db,
      TABLES.usageDaily,
      'agentKey',
      "agentKey TEXT NOT NULL DEFAULT ''",
    );

    // usage_daily.metadata (free-form caller-supplied attribution tags, e.g.
    // `{ complexity: 'complex' }`). metadataJson is the JSON blob; metadataKey
    // is its canonical serialization and the actual rollup/unique-index
    // dimension (SQLite can't uniquely-index a JSON column's contents). The
    // v3 unique index that includes metadataKey is created in
    // applyTenantIndexes (must run after this migration).
    this.ensureTableColumn(db, TABLES.usageDaily, 'metadataJson', 'metadataJson TEXT');
    this.ensureTableColumn(
      db,
      TABLES.usageDaily,
      'metadataKey',
      "metadataKey TEXT NOT NULL DEFAULT ''",
    );

    // agent_tracing_sessions.metadata (free-form caller-supplied attribution
    // tags, sibling of `agent`) was added after the table shipped — the CREATE
    // TABLE below already declares it for fresh DBs, but existing SQLite files
    // need it backfilled the same way agentModel/agentVersion were.
    this.ensureTableColumn(db, TABLES.agentTracingSessions, 'metadata', "metadata TEXT DEFAULT '{}'");

    // finishReason/reasoningTokens promoted from the events' `metadata` JSON
    // blob to first-class columns, plus their session/log rollups. reasoningTokens
    // is always a subset of outputTokens (OpenAI-style reasoning models) and must
    // never be summed into totalTokens/cost. Ensure on boot for pre-existing
    // tenant DB files, which predate these columns.
    this.ensureTableColumn(db, TABLES.agentTracingEvents, 'finishReason', 'finishReason TEXT');
    this.ensureTableColumn(db, TABLES.agentTracingEvents, 'reasoningTokens', 'reasoningTokens INTEGER DEFAULT 0');
    this.ensureTableColumn(db, TABLES.agentTracingSessions, 'totalReasoningTokens', 'totalReasoningTokens INTEGER DEFAULT 0');
    this.ensureTableColumn(db, TABLES.agentTracingSessions, 'truncatedEvents', 'truncatedEvents INTEGER DEFAULT 0');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'finishReason', 'finishReason TEXT');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'reasoningTokens', 'reasoningTokens INTEGER DEFAULT 0');
    this.ensureTableColumn(db, TABLES.usageDaily, 'reasoningTokens', 'reasoningTokens INTEGER NOT NULL DEFAULT 0');

    // external_model_pricing.versions (effective-dated price history) was
    // added after the table shipped; ensure on boot for DBs created before.
    this.ensureTableColumn(db, TABLES.externalModelPricing, 'versions', 'versions TEXT');

    // MCP Hub: multi-source servers (remote URL / stdio packages), exposure
    // config, Aegis binding and richer request logs. Safe to ensure on boot
    // for tenants created before the feature. NOTE: legacy DBs keep the
    // NOT NULL constraint on openApiSpec/upstreamBaseUrl — the mixin writes
    // '' for non-openapi sources and maps '' back to undefined on read.
    this.ensureTableColumn(
      db,
      TABLES.mcpServers,
      'sourceType',
      "sourceType TEXT NOT NULL DEFAULT 'openapi'",
    );
    this.ensureTableColumn(db, TABLES.mcpServers, 'remoteConfig', 'remoteConfig TEXT');
    this.ensureTableColumn(db, TABLES.mcpServers, 'stdioConfig', 'stdioConfig TEXT');
    this.ensureTableColumn(db, TABLES.mcpServers, 'toolsDiscoveredAt', 'toolsDiscoveredAt TEXT');
    this.ensureTableColumn(db, TABLES.mcpServers, 'exposure', 'exposure TEXT');
    this.ensureTableColumn(db, TABLES.mcpServers, 'aegis', 'aegis TEXT');
    // Guardrail binding, successor to `aegis`. Both columns are written for
    // one release: every stored row still carries `aegis` and the read-time
    // normaliser needs it to keep an existing binding armed.
    this.ensureTableColumn(db, TABLES.mcpServers, 'guardrail', 'guardrail TEXT');
    this.ensureTableColumn(db, TABLES.mcpServers, 'lastError', 'lastError TEXT');
    this.ensureTableColumn(db, TABLES.mcpRequestLogs, 'callerType', 'callerType TEXT');
    this.ensureTableColumn(db, TABLES.mcpRequestLogs, 'callerUserId', 'callerUserId TEXT');
    this.ensureTableColumn(db, TABLES.mcpRequestLogs, 'transport', 'transport TEXT');
    this.ensureTableColumn(db, TABLES.mcpRequestLogs, 'sourceType', 'sourceType TEXT');
    this.ensureTableColumn(db, TABLES.mcpRequestLogs, 'sessionId', 'sessionId TEXT');
    // Composite MCP servers (sourceType 'composite'): a member-scoped log row
    // records the composite's key here so the member's own Logs tab can show
    // "via <composite>" alongside calls that hit it directly.
    this.ensureTableColumn(db, TABLES.mcpRequestLogs, 'viaServerKey', 'viaServerKey TEXT');
    // serverId: durable FK to mcp_servers.id, replacing serverKey (a slug of
    // the server's name) as the log-query scope. serverKey is recycled when
    // a server is deleted and recreated under the same name, which used to
    // make a new server's Logs tab show its predecessor's history — see
    // mcpLogScopeClause in mcp-server.mixin.ts. Rows written before this
    // column existed are matched by the legacy fallback in that clause.
    this.ensureTableColumn(db, TABLES.mcpRequestLogs, 'serverId', 'serverId TEXT');

    // Evaluation: dataset items moved to their own table; the denormalised
    // itemCount rides on the dataset row. Suites were missing the
    // embeddingModelKey column entirely (semantic scorer's embedding model
    // silently dropped on SQLite) — ensure both on boot for existing DBs.
    this.ensureTableColumn(db, TABLES.evaluationDatasets, 'itemCount', 'itemCount INTEGER');
    this.ensureTableColumn(db, TABLES.evaluationSuites, 'embeddingModelKey', 'embeddingModelKey TEXT');
    // System-prompt override on model targets: lets a suite test a prompt that
    // differs from the one baked into captured dataset items.
    this.ensureTableColumn(db, TABLES.evaluationTargets, 'systemPrompt', 'systemPrompt TEXT');
    this.ensureTableColumn(db, TABLES.evaluationTargets, 'promptKey', 'promptKey TEXT');
    this.ensureTableColumn(db, TABLES.evaluationTargets, 'promptVersion', 'promptVersion INTEGER');
    this.ensureTableColumn(db, TABLES.evaluationTargets, 'responseFormat', 'responseFormat TEXT');
    this.ensureTableColumn(db, TABLES.evaluationTargets, 'maxTokens', 'maxTokens INTEGER');
    // AI labeling: structured labels + their provenance on dataset items, and
    // the run target that says an analysis run labelled a dataset rather than
    // the conversation corpus.
    this.ensureTableColumn(db, TABLES.evaluationDatasetItems, 'labels', 'labels TEXT');
    this.ensureTableColumn(db, TABLES.evaluationDatasetItems, 'labelMeta', 'labelMeta TEXT');
    this.ensureTableColumn(db, TABLES.analysisRuns, 'target', 'target TEXT');
    // Structured-output contract captured with the item, so a replay reproduces
    // the request shape production ran under (see tracingResponseFormat.ts).
    this.ensureTableColumn(db, TABLES.evaluationDatasetItems, 'responseFormat', 'responseFormat TEXT');
    // Vector migrations: `attempt` groups a restarted migration's batch logs
    // into their own run instead of mixing with the previous run's batches
    // (both reuse batchIndex starting from 0).
    this.ensureTableColumn(db, TABLES.vectorMigrations, 'attempt', 'attempt INTEGER NOT NULL DEFAULT 0');
    this.ensureTableColumn(db, TABLES.vectorMigrationLogs, 'attempt', 'attempt INTEGER NOT NULL DEFAULT 1');
    // Encrypted-at-rest inference server monitoring apiKey (AES-256-GCM); see
    // apiKeyVault.ts. The legacy plaintext `apiKey` column stays for rows
    // written before this vault existed.
    this.ensureTableColumn(db, TABLES.inferenceServers, 'apiKeySealed', 'apiKeySealed TEXT');
    // "Programmatic User" support (Add User canLogin toggle): users created with
    // canLogin=false have no password login capability. Missing/undefined is
    // treated as true everywhere it's read, so existing rows default to 1.
    this.ensureTableColumn(db, TABLES.users, 'canLogin', 'canLogin INTEGER NOT NULL DEFAULT 1');
  }

  private migrateOcrJobsSchema(db: Database.Database): void {
    const exists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='ocr_jobs'`,
      )
      .get() as { name?: unknown } | undefined;
    if (exists) {
      const columns = db.prepare(`PRAGMA table_info(ocr_jobs)`).all() as Array<{
        name?: unknown;
      }>;
      const names = new Set(columns.map((c) => String(c.name)));
      const isV1 = names.has('mode') || !names.has('bucketKey');
      if (isV1) {
        db.exec(
          `DROP TABLE IF EXISTS ocr_job_items; DROP TABLE IF EXISTS ocr_jobs;`,
        );
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

    // Attribution index — must be created here (after applyTenantMigrations)
    // rather than in TENANT_SCHEMA_SQL: userId is added to legacy DBs by an
    // ensureTableColumn migration, and referencing it in the schema script
    // aborted the entire schema exec on pre-attribution tenant DBs.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_model_usage_user
        ON ${TABLES.modelUsageLogs}(tenantId, userId, createdAt DESC);
    `);

    // mcp_request_logs.serverId index — must be created here (after
    // applyTenantMigrations), same ordering constraint as above: serverId
    // reaches legacy DBs via ensureTableColumn, and referencing it in
    // TENANT_SCHEMA_SQL directly aborted the whole schema exec on tenants
    // created before the column existed.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mcp_request_logs_serverId
        ON ${TABLES.mcpRequestLogs}(serverId);
    `);

    // guardrail_evaluation_logs.hook index — same ordering constraint again:
    // `hook` reaches legacy DBs via ensureTableColumn above, so this cannot
    // live in TENANT_SCHEMA_SQL. It backs the hook-filtered eval-log views.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_guardrail_eval_hook
        ON ${TABLES.guardrailEvalLogs}(hook);
    `);

    // vector_migration_logs.attempt index — same ordering constraint again.
    // `attempt` reaches legacy DBs via ensureTableColumn above, so while this
    // index sat in TENANT_SCHEMA_SQL it aborted the whole schema exec with
    // "no such column: attempt" on every pre-existing tenant, leaving later
    // tables in that script uncreated.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vml_migrationKey_attempt
        ON ${TABLES.vectorMigrationLogs}(migrationKey, attempt);
    `);

    // usage_daily unique dimension index v3 (adds metadataKey, on top of v2's
    // agentKey). Same ordering constraint as above: agentKey/metadataKey
    // reach legacy DBs via ensureTableColumn. v2 would reject rows differing
    // only in metadataKey.
    db.exec(`
      DROP INDEX IF EXISTS uniq_usage_daily_dims;
      DROP INDEX IF EXISTS uniq_usage_daily_dims_v2;
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_usage_daily_dims_v3
        ON ${TABLES.usageDaily}(tenantId, projectId, userId, apiTokenId, source, service, refKey, agentKey, metadataKey, day);
      CREATE INDEX IF NOT EXISTS idx_usage_daily_agent_day
        ON ${TABLES.usageDaily}(tenantId, agentKey, day DESC);
    `);

    // Enforce unique provider/model keys at the DB layer so a concurrent
    // create race cannot insert duplicates (matches the MongoDB unique
    // indexes). The base schema creates these as plain indexes; upgrade them
    // in place, best-effort — skipped if pre-existing duplicates would violate
    // the constraint, and never leaving the table without an index.
    this.upgradeToUniqueIndex(db, 'idx_models_key', TABLES.models, '(key)');
    this.upgradeToUniqueIndex(
      db,
      'idx_providers_key',
      TABLES.providers,
      '(key)',
    );
  }

  private upgradeToUniqueIndex(
    db: Database.Database,
    indexName: string,
    tableName: string,
    columns: string,
  ): void {
    const uniqueName = `${indexName}_uniq`;
    const already = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`)
      .get(uniqueName);
    if (already) return;
    try {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueName} ON ${tableName}${columns};` +
          `DROP INDEX IF EXISTS ${indexName};`,
      );
    } catch (error) {
      logger.warn(
        `Could not upgrade ${indexName} to unique (pre-existing duplicates?)`,
        {
          tableName,
          error,
        },
      );
    }
  }

  private ensureTableColumn(
    db: Database.Database,
    tableName: string,
    columnName: string,
    columnDefinition: string,
  ): void {
    const columns = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: unknown }>;
    const hasColumn = columns.some(
      (column) => String(column.name) === columnName,
    );
    if (hasColumn) return;

    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
    logger.info('SQLite schema migration applied', { tableName, columnName });
  }

  /**
   * One-time data migration for the gpu_slices multi-deployment change: a
   * pre-existing tenant DB still has the legacy singular `assignedDeploymentId`
   * column populated. Fold it into the new `assignedDeploymentIds` JSON array
   * so bindings created before the upgrade aren't silently dropped. Safe to
   * call on every boot — once a row's array is populated it's skipped.
   */
  private backfillGpuSliceAssignments(db: Database.Database): void {
    const columns = db
      .prepare(`PRAGMA table_info(${TABLES.gpuSlices})`)
      .all() as Array<{ name?: unknown }>;
    if (
      !columns.some((column) => String(column.name) === 'assignedDeploymentId')
    )
      return;

    const rows = db
      .prepare(
        `SELECT uuid, assignedDeploymentId FROM ${TABLES.gpuSlices}
         WHERE assignedDeploymentId IS NOT NULL AND (assignedDeploymentIds IS NULL OR assignedDeploymentIds = '[]')`,
      )
      .all() as Array<{ uuid: string; assignedDeploymentId: string }>;
    if (rows.length === 0) return;

    const update = db.prepare(
      `UPDATE ${TABLES.gpuSlices} SET assignedDeploymentIds = @ids WHERE uuid = @uuid`,
    );
    for (const row of rows) {
      update.run({
        uuid: row.uuid,
        ids: JSON.stringify([row.assignedDeploymentId]),
      });
    }
    logger.info('SQLite schema migration applied', {
      tableName: TABLES.gpuSlices,
      migration: 'backfill assignedDeploymentIds from assignedDeploymentId',
      rows: rows.length,
    });
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
    const scoped = this.tenantContext.getStore();
    if (scoped) return scoped;
    if (!this.tenantDb) {
      throw new Error('Tenant database not set. Call switchToTenant() first.');
    }
    // See tenantScopeGuard: unwrapped callers fall back to the process-global
    // handle, which is a cross-tenant race under concurrent load.
    warnGlobalTenantFallback(this.tenantDb.name);
    return this.tenantDb;
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
    // Programmatic users (canLogin=false) may have no email at all — guard
    // against undefined/empty input rather than throwing on `.trim()`.
    if (!email) return '';
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
    const flattened = value.flatMap((item) =>
      Array.isArray(item) ? item : [item],
    );
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
      return {
        clause: 'projectId = @projectId',
        params: { projectId: projectId.trim() },
      };
    }
    return { clause: "(projectId IS NULL OR projectId = '')", params: {} };
  }
}
