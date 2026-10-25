/**
 * SQLite Provider – Base class
 *
 * Holds connection state, shared helpers, and schema initialization.
 * Domain-specific operations are added via mixins (see sibling files).
 */

import { createLogger } from '@/lib/core/logger';
import { foldSearchText } from '@/lib/shared/searchFold';
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
  entityMetrics: 'entity_metrics',
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
  analysisResults: 'analysis_results',
  piiPolicies: 'pii_policies',
  alertRules: 'alert_rules',
  alertEvents: 'alert_events',
  alertDeliveries: 'alert_deliveries',
  alertStates: 'alert_states',
  schedulerClaims: 'scheduler_claims',
  agentTriggers: 'agent_triggers',
  agentTriggerDeliveries: 'agent_trigger_deliveries',
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
  agentConversationStates: 'agent_conversation_states',
  agentSessionEvents: 'agent_session_events',
  agentPendingActions: 'agent_pending_actions',
  agentMessageFeedback: 'agent_message_feedback',
  webhookEndpoints: 'webhook_endpoints',
  webhookDeliveries: 'webhook_deliveries',
  agentSkills: 'agent_skills',
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
  agentRuns: 'agent_runs',
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

// ── Search functions ─────────────────────────────────────────────────

/**
 * Functions the directory searches call. SQLite's own `LIKE` folds the case of
 * ASCII letters only, so searching "şule" or "özlem" never found "Şule" or
 * "Özlem", while MongoDB's case-insensitive `$regex` (Unicode aware) did.
 * `iam_fold(x) LIKE iam_fold(pattern)` folds with `foldSearchText` on both sides:
 * the JavaScript Unicode mapping, with the four letters of the Turkish i family
 * (I, İ, i, ı) meeting at "i" - so "istanbul" finds "İstanbul" and "ısparta"
 * finds "ISPARTA", which a plain `toLowerCase()` gets wrong - and the two
 * backends answer the same (the Mongo side is `foldedRegexSource`). Accents are
 * NOT stripped (neither backend does): "sule" does not find "Şule" on either.
 * Deterministic, so SQLite may cache it within a statement.
 */
function registerSearchFunctions(db: Database.Database): void {
  db.function('iam_fold', { deterministic: true }, (value: unknown) =>
    value === null || value === undefined ? null : foldSearchText(String(value)));
}

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
    registerSearchFunctions(this.mainDb);
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
    registerSearchFunctions(db);
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
    // Optional per-token network allowlist (JSON array of CIDR strings). Legacy
    // rows read as NULL = unrestricted, so nothing changes for existing tokens.
    this.ensureTableColumn(db, TABLES.apiTokens, 'allowedIpRanges', 'allowedIpRanges TEXT');
    // 1 = calls with the token must act for a verified person. Legacy rows read as 0 = optional.
    this.ensureTableColumn(db, TABLES.apiTokens, 'requireUserToken', 'requireUserToken INTEGER NOT NULL DEFAULT 0');
  }

  private applyTenantMigrations(db: Database.Database): void {
    // Browser profiles: an encrypted `storageState` (signed-in cookies) plus
    // its non-secret description. CREATE TABLE IF NOT EXISTS never alters an
    // existing tenant DB, so a browser created before this change would fail
    // its next UPDATE without these.
    this.ensureTableColumn(db, TABLES.browsers, 'storageStateEnc', 'storageStateEnc TEXT');
    this.ensureTableColumn(db, TABLES.browsers, 'storageStateMeta', 'storageStateMeta TEXT');

    // Result of the last "Test connection" of a provider (JSON). Nullable, no backfill.
    this.ensureTableColumn(db, TABLES.providers, 'lastTest', 'lastTest TEXT');

    // Project membership origin ('manual' | 'directory'). Legacy rows read as
    // NULL, which the mapper treats as 'manual' — no data migration needed.
    this.ensureTableColumn(db, TABLES.userProjects, 'source', 'source TEXT');

    // Browser flows: the declared return shape, and the raw captures a run
    // resolved it from. A flow recorded before this change updates through
    // the same UPDATE statement, so the columns have to exist for it too.
    this.ensureTableColumn(db, TABLES.browserFlows, 'outputs', 'outputs TEXT');
    this.ensureTableColumn(db, TABLES.browserFlowRuns, 'captures', 'captures TEXT');

    // Owning cluster node name (see src/lib/core/cluster/nodeRegistry.ts) —
    // without this, boot reconciliation on any replica could only ask "does
    // THIS process know about this session", so a session genuinely alive on
    // another replica looked identical to one truly orphaned by a crash.
    this.ensureTableColumn(db, TABLES.browserSessions, 'ownerNode', 'ownerNode TEXT');

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
    this.ensureTableColumn(db, 'sandbox_instances', 'idleStopSeconds', 'idleStopSeconds INTEGER');
    // Promoting a builder instance now upserts a real sandbox_templates row
    // (see instanceService.promoteInstanceToTemplate) so Template Studio
    // output shows up directly in the normal template list/picker — these
    // mirror the instance-level columns above but on the template itself.
    this.ensureTableColumn(db, 'sandbox_templates', 'studioTemplateKey', 'studioTemplateKey TEXT');
    this.ensureTableColumn(db, 'sandbox_templates', 'studioTemplateVersion', 'studioTemplateVersion INTEGER');
    // Template/instance env is sealed at rest (EE sandbox services); the legacy
    // plaintext `env` column stays for rows that predate sealing.
    for (const table of ['sandbox_templates', 'sandbox_instances']) {
      this.ensureTableColumn(db, table, 'envSealed', 'envSealed TEXT');
      this.ensureTableColumn(db, table, 'envKeys', 'envKeys TEXT');
      // Config references (ids only, never values), resolved at launch.
      this.ensureTableColumn(db, table, 'envRefs', 'envRefs TEXT');
      this.ensureTableColumn(db, table, 'groupRefs', 'groupRefs TEXT');
    }
    // How launch values reach a sandbox; snapshots of a 'file' sandbox carry its sealed env and references.
    this.ensureTableColumn(db, 'sandbox_instances', 'envDelivery', 'envDelivery TEXT');
    for (const column of ['envDelivery', 'envSealed', 'envKeys', 'envRefs', 'groupRefs']) {
      this.ensureTableColumn(db, 'sandbox_snapshots', column, `${column} TEXT`);
    }
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
    this.ensureTableColumn(db, TABLES.models, 'replicas', 'replicas TEXT');
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

    // Entity health: per-session error counters + what was already counted in
    // entity_metrics (idempotency), and alert rule/event/incident v2 fields.
    this.ensureTableColumn(db, TABLES.agentTracingSessions, 'errorEvents', 'errorEvents INTEGER DEFAULT 0');
    this.ensureTableColumn(db, TABLES.agentTracingSessions, 'toolErrors', 'toolErrors INTEGER DEFAULT 0');
    this.ensureTableColumn(db, TABLES.agentTracingSessions, 'aiErrors', 'aiErrors INTEGER DEFAULT 0');
    this.ensureTableColumn(db, TABLES.agentTracingSessions, 'metricsOutcome', 'metricsOutcome TEXT');
    this.ensureTableColumn(db, TABLES.agentTracingSessions, 'statusExplicit', 'statusExplicit INTEGER DEFAULT 0');
    this.ensureTableColumn(db, TABLES.alertRules, 'entity', 'entity TEXT');
    this.ensureTableColumn(db, TABLES.alertRules, 'severity', 'severity TEXT');
    this.ensureTableColumn(db, TABLES.alertRules, 'notifyOnResolve', 'notifyOnResolve INTEGER');
    this.ensureTableColumn(db, TABLES.alertRules, 'renotifyMinutes', 'renotifyMinutes INTEGER');
    this.ensureTableColumn(db, TABLES.alertRules, 'mutedUntil', 'mutedUntil TEXT');
    this.ensureTableColumn(db, TABLES.alertRules, 'mutedBy', 'mutedBy TEXT');
    this.ensureTableColumn(db, TABLES.alertRules, 'muteReason', 'muteReason TEXT');
    this.ensureTableColumn(db, TABLES.alertRules, 'runbookUrl', 'runbookUrl TEXT');
    this.ensureTableColumn(db, TABLES.alertRules, 'lastEvaluation', 'lastEvaluation TEXT');
    this.ensureTableColumn(db, TABLES.alertRules, 'template', 'template TEXT');
    this.ensureTableColumn(db, TABLES.alertEvents, 'entityType', 'entityType TEXT');
    this.ensureTableColumn(db, TABLES.alertEvents, 'entityKey', 'entityKey TEXT');
    this.ensureTableColumn(db, TABLES.alertEvents, 'baselineValue', 'baselineValue REAL');
    this.ensureTableColumn(db, TABLES.alertEvents, 'sampleCount', 'sampleCount INTEGER');
    this.ensureTableColumn(db, TABLES.alertEvents, 'acknowledgedBy', 'acknowledgedBy TEXT');
    this.ensureTableColumn(db, TABLES.alertEvents, 'acknowledgedAt', 'acknowledgedAt TEXT');
    this.ensureTableColumn(db, TABLES.alertEvents, 'kind', 'kind TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'module', 'module TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'entityType', 'entityType TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'entityKey', 'entityKey TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'baselineValue', 'baselineValue REAL');
    this.ensureTableColumn(db, TABLES.incidents, 'lastValue', 'lastValue REAL');
    this.ensureTableColumn(db, TABLES.incidents, 'peakValue', 'peakValue REAL');
    this.ensureTableColumn(db, TABLES.incidents, 'autoResolved', 'autoResolved INTEGER');
    this.ensureTableColumn(db, TABLES.incidents, 'acknowledgedBy', 'acknowledgedBy TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'context', 'context TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'snoozedUntil', 'snoozedUntil TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'snoozedBy', 'snoozedBy TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'reopenedAt', 'reopenedAt TEXT');
    this.ensureTableColumn(db, TABLES.incidents, 'reopenCount', 'reopenCount INTEGER');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'finishReason', 'finishReason TEXT');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'reasoningTokens', 'reasoningTokens INTEGER DEFAULT 0');
    // Agent run attribution on usage rows (the per-turn ledger).
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'agentKey', 'agentKey TEXT');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'channel', 'channel TEXT');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'conversationId', 'conversationId TEXT');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'turnId', 'turnId TEXT');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'runId', 'runId TEXT');
    this.ensureTableColumn(db, TABLES.modelUsageLogs, 'traceSessionId', 'traceSessionId TEXT');
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
    // Agent test revisions: the configuration a target or campaign tests by
    // default (a version number or 'draft'), and what each run asked for and
    // ran. Without the target column a pinned version was dropped on insert,
    // so every "pinned" suite quietly tested the published version.
    this.ensureTableColumn(db, TABLES.evaluationTargets, 'agentVersion', 'agentVersion TEXT');
    this.ensureTableColumn(db, TABLES.evaluationRuns, 'agentRevision', 'agentRevision TEXT');
    this.ensureTableColumn(db, TABLES.redTeamCampaigns, 'agentVersion', 'agentVersion TEXT');
    this.ensureTableColumn(db, TABLES.redTeamRuns, 'agentRevision', 'agentRevision TEXT');
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
    // User lifecycle (disable/enable). All nullable with no default: a NULL
    // status is read back as `undefined`, which every caller treats as active,
    // so existing rows need no backfill.
    this.ensureTableColumn(db, TABLES.users, 'status', 'status TEXT');
    this.ensureTableColumn(db, TABLES.users, 'disabledAt', 'disabledAt TEXT');
    this.ensureTableColumn(db, TABLES.users, 'disabledBy', 'disabledBy TEXT');
    this.ensureTableColumn(db, TABLES.users, 'disabledReason', 'disabledReason TEXT');
    // Last "request access" of a person (JSON `{at, message?}`). Nullable, no backfill.
    this.ensureTableColumn(db, TABLES.users, 'accessRequest', 'accessRequest TEXT');
    // Quota group scope: 'perMember' | 'shared'. Nullable with no default — a
    // NULL is read back as `undefined`, which the guard treats as perMember, and
    // only `scope = 'group'` rows carry it, so existing rows need no backfill.
    this.ensureTableColumn(db, TABLES.quotaPolicies, 'groupMode', 'groupMode TEXT');
    // PII v2 (NLP/dictionary/NER layers): opt-in detection config living
    // alongside categories/customPatterns. Absent/null on old rows, which
    // `mapPiiPolicyRow` reads back as `undefined` — the detector's default
    // ('pattern' mode) then matches pre-v2 behaviour exactly.
    this.ensureTableColumn(db, TABLES.piiPolicies, 'detection', 'detection TEXT');
    // PII engine selector: which detector runs the policy's scan ('regex' /
    // 'cognipeer' — see `PiiEngine`'s own doc comment). Absent on old rows;
    // `mapPiiPolicyRow` reads that back as `undefined`, which every caller
    // (`scanWithPolicy`, etc.) treats as 'regex' — pre-existing behaviour.
    this.ensureTableColumn(db, TABLES.piiPolicies, 'engine', 'engine TEXT');
    // Sealed HMAC secret for agent-run callbacks (agentRunService).
    this.ensureTableColumn(db, TABLES.agentRuns, 'callbackSecret', 'callbackSecret TEXT');
    this.ensureTableColumn(db, TABLES.agentRuns, 'maxDurationMs', 'maxDurationMs INTEGER');
    this.ensureTableColumn(db, TABLES.agentRuns, 'stopReason', 'stopReason TEXT');
    this.ensureTableColumn(db, TABLES.agentRuns, 'resumeActionIds', 'resumeActionIds TEXT');
    // Conversation files that ride the message of a (background) run.
    this.ensureTableColumn(db, TABLES.agentRuns, 'attachments', 'attachments TEXT');
    // Run engine: class (absent = default), scheduled start, detached inline runs,
    // caller labels, origin surface, trigger link, per-request structured output,
    // validated variables, queue generation (job dedup) and last publish time. All
    // nullable; old rows read back as absent. (`runTrigger` because TRIGGER is an SQL keyword.)
    for (const [column, type] of [
      ['runClass', 'TEXT'], ['notBefore', 'TEXT'], ['detachedAt', 'TEXT'], ['metadata', 'TEXT'],
      ['channel', 'TEXT'], ['triggerId', 'TEXT'], ['runTrigger', 'TEXT'], ['responseFormat', 'TEXT'],
      ['variables', 'TEXT'], ['queueGeneration', 'INTEGER'], ['lastPublishedAt', 'TEXT'],
      // Trigger runs: unattended (no one to ask), external content (event values stay out of the system
      // prompt) and the variable names whose values did not come from the event (JSON list).
      ['unattended', 'INTEGER'], ['externalContent', 'INTEGER'], ['literalVariables', 'TEXT'],
      // The request's `background: true` on a run that streams inline.
      ['background', 'INTEGER'],
      // The event the callback bookkeeping belongs to; what continues a paused turn and who
      // answered; the principal a trigger run counts against.
      ['callbackEventId', 'TEXT'], ['resumeTrigger', 'TEXT'], ['resumeUserId', 'TEXT'], ['resumeApiTokenId', 'TEXT'],
      ['accountableUserId', 'TEXT'], ['accountableTokenId', 'TEXT'],
    ] as const) {
      this.ensureTableColumn(db, TABLES.agentRuns, column, `${column} ${type}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_status_class_created ON ${TABLES.agentRuns}(tenantId, status, runClass, createdAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_status_notBefore ON ${TABLES.agentRuns}(status, notBefore)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_trigger_created ON ${TABLES.agentRuns}(tenantId, triggerId, createdAt)`);
    // An incoming webhook finds its trigger by the URL's hook id (copied out of the `webhook` JSON).
    this.ensureTableColumn(db, TABLES.agentTriggers, 'hookId', 'hookId TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_triggers_hook ON ${TABLES.agentTriggers}(hookId)`);
    // Session files: ordinary file records tagged with the conversation they belong
    // to. Indexed here (not in the schema SQL) because an older table has no such
    // column until the lines above add it.
    this.ensureTableColumn(db, TABLES.files, 'purpose', 'purpose TEXT');
    this.ensureTableColumn(db, TABLES.files, 'conversationId', 'conversationId TEXT');
    this.ensureTableColumn(db, TABLES.files, 'agentKey', 'agentKey TEXT');
    this.ensureTableColumn(db, TABLES.files, 'expiresAt', 'expiresAt TEXT');
    this.ensureTableColumn(db, TABLES.files, 'uploadedBy', 'uploadedBy TEXT');
    this.ensureTableColumn(db, TABLES.files, 'origin', 'origin TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_files_purpose_expiresAt ON ${TABLES.files}(purpose, expiresAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_files_conversationId ON ${TABLES.files}(conversationId)`);
    // A bucket's objects by key: the lookup of one object, the prefix / folder
    // listing (a key range), and what the bucket delete guard counts.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_files_bucket_key ON ${TABLES.files}(providerKey, bucketKey, key)`);
    // Agent runtime (session events / human-in-the-loop): runtime fields on the
    // conversation and the paused SDK state. All nullable; absent = idle / not paused.
    this.ensureTableColumn(db, TABLES.agentConversations, 'runtimeStatus', 'runtimeStatus TEXT');
    this.ensureTableColumn(db, TABLES.agentConversations, 'stopReason', 'stopReason TEXT');
    this.ensureTableColumn(db, TABLES.agentConversations, 'pendingActionIds', 'pendingActionIds TEXT');
    this.ensureTableColumn(db, TABLES.agentConversations, 'lastEventSeq', 'lastEventSeq INTEGER');
    // Session spend budget (JSON) and the running total of what the session's turns cost.
    this.ensureTableColumn(db, TABLES.agentConversations, 'budget', 'budget TEXT');
    this.ensureTableColumn(db, TABLES.agentConversations, 'spentUsd', 'spentUsd REAL');
    this.ensureTableColumn(db, TABLES.agentConversations, 'runtimeTurnId', 'runtimeTurnId TEXT');
    // Digest of the transcript a chat-completions client holds, to match a resent transcript back to its session.
    this.ensureTableColumn(db, TABLES.agentConversations, 'transcriptHash', 'transcriptHash TEXT');
    this.ensureTableColumn(db, TABLES.agentConversationStates, 'pausedSnapshot', 'pausedSnapshot TEXT');
    // A client tool call a host page has to answer: its timeout (JSON).
    this.ensureTableColumn(db, TABLES.agentPendingActions, 'clientTool', 'clientTool TEXT');
    // The sub-agent a surfaced child pause belongs to.
    this.ensureTableColumn(db, TABLES.agentPendingActions, 'subagent', 'subagent TEXT');
    this.ensureTableColumn(db, TABLES.agentPendingActions, 'delegationToolCallId', 'delegationToolCallId TEXT');
    // Analysis decision layer: the decision model, where runs read from (JSON) and the review settings (JSON).
    this.ensureTableColumn(db, TABLES.analysisDefinitions, 'decisionModelKey', 'decisionModelKey TEXT');
    this.ensureTableColumn(db, TABLES.analysisDefinitions, 'source', 'source TEXT');
    this.ensureTableColumn(db, TABLES.analysisDefinitions, 'review', 'review TEXT');
    // The client API's session list: a project's sessions newest first (optionally one agent's, or one status).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_aconv_project_created ON ${TABLES.agentConversations}(projectId, createdAt DESC, id DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_aconv_project_agent_created ON ${TABLES.agentConversations}(projectId, agentKey, createdAt DESC, id DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_aconv_transcript ON ${TABLES.agentConversations}(projectId, agentKey, createdBy, transcriptHash, updatedAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_aconv_project_status_created ON ${TABLES.agentConversations}(projectId, runtimeStatus, createdAt DESC, id DESC)`);
    // The dashboard's cross-agent Sessions list: a project's sessions by last activity.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_aconv_project_updated ON ${TABLES.agentConversations}(projectId, updatedAt DESC, id DESC)`);
    // One run per Idempotency-Key per project, race-free (two concurrent
    // requests with the same key must not both execute).
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_idempotency_unique
      ON ${TABLES.agentRuns}(tenantId, projectId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`);
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

    // Stale-session finalizer scan (status 'in_progress' and updatedAt older
    // than a cutoff, tenant-wide) and the alert/incident lookups. Created here
    // because the filtered columns may have been added by ensureTableColumn.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tracing_sessions_status_updatedAt
        ON ${TABLES.agentTracingSessions}(status, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_alert_events_rule_firedAt
        ON ${TABLES.alertEvents}(ruleId, firedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_events_project_firedAt
        ON ${TABLES.alertEvents}(projectId, firedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_deliveries_incident_attemptAt
        ON ${TABLES.alertDeliveries}(tenantId, incidentId, attemptAt DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_deliveries_rule_attemptAt
        ON ${TABLES.alertDeliveries}(tenantId, ruleId, attemptAt DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_project_status_firedAt
        ON ${TABLES.incidents}(projectId, status, firedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_rule_entity
        ON ${TABLES.incidents}(ruleId, entityKey);
      CREATE INDEX IF NOT EXISTS idx_incidents_project_entity_firedAt
        ON ${TABLES.incidents}(projectId, entityKey, firedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_alertEventId
        ON ${TABLES.incidents}(alertEventId);
      CREATE INDEX IF NOT EXISTS idx_incidents_tenant_project_updatedAt
        ON ${TABLES.incidents}(tenantId, projectId, updatedAt);
    `);

    // Attribution index — must be created here (after applyTenantMigrations)
    // rather than in TENANT_SCHEMA_SQL: userId is added to legacy DBs by an
    // ensureTableColumn migration, and referencing it in the schema script
    // aborted the entire schema exec on pre-attribution tenant DBs.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_model_usage_user
        ON ${TABLES.modelUsageLogs}(tenantId, userId, createdAt DESC);
    `);

    // Dynamic LLM analytics: routed (child / decider) rows by router. Same
    // ordering constraint — `routing` reaches legacy DBs via ensureTableColumn.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_model_usage_router
        ON ${TABLES.modelUsageLogs}(json_extract(routing, '$.routerKey'), createdAt DESC);
    `);

    // Agent run ledger: the model calls of one turn. Same ordering constraint —
    // `conversationId` / `turnId` reach legacy DBs via ensureTableColumn.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_model_usage_turn
        ON ${TABLES.modelUsageLogs}(conversationId, turnId, createdAt DESC);
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

  /**
   * SQLite LIKE pattern ("contains" search): the text with a backslash put before %, _ and \ (they are wildcards and the
   * escape character itself), between two %. SQLite reads that backslash as an escape only when the clause names it -
   * build the clause with `likeAny`, or write `ESCAPE '\\'` after the LIKE.
   */
  protected likePattern(value: string): string {
    return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
  }

  /**
   * `(a LIKE @p ESCAPE '\' OR b LIKE @p ESCAPE '\')`: the search clause that goes with `likePattern`. Without the ESCAPE
   * the backslashes of the pattern are literal characters, and a search for `my_prompt` or `100%` finds nothing.
   * `param` is the placeholder as the statement writes it: `@search`, or `?` once for each column.
   */
  protected likeAny(columns: readonly string[], param: string): string {
    return `(${columns.map((column) => `${column} LIKE ${param} ESCAPE '\\'`).join(' OR ')})`;
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
