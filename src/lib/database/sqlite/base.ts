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
import { createLogger } from '@/lib/core/logger';
import { MAIN_SCHEMA_SQL, TENANT_SCHEMA_SQL } from './schema';

export const logger = createLogger('sqlite');

// ── Table-name constants (mirrors MongoDB COLLECTIONS) ──────────────

export const TABLES = {
  tenants: 'tenants',
  tenantUserDirectory: 'tenant_user_directory',
  users: 'users',
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
  tools: 'tools',
  toolRequestLogs: 'tool_request_logs',
  agents: 'agents',
  agentVersions: 'agent_versions',
  agentConversations: 'agent_conversations',
  vectorCounters: 'vector_counters',
  vectorMigrations: 'vector_migrations',
  vectorMigrationLogs: 'vector_migration_logs',
} as const;

// ── Base class ───────────────────────────────────────────────────────

export class SQLiteProviderBase {
  protected mainDb: Database.Database | null = null;
  protected tenantDb: Database.Database | null = null;
  protected readonly dataDir: string;
  protected readonly mainDbName: string;
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

    logger.info('SQLite main DB connected', { path: mainPath });
  }

  async disconnect(): Promise<void> {
    for (const db of this.tenantDbCache.values()) {
      db.close();
    }
    this.tenantDbCache.clear();
    this.tenantDb = null;

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
      return;
    }

    const tenantPath = path.join(this.dataDir, `${tenantDbName}.db`);
    const db = new Database(tenantPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(TENANT_SCHEMA_SQL);
    this.applyTenantMigrations(db);

    this.tenantDbCache.set(tenantDbName, db);
    this.tenantDb = db;
  }

  private applyTenantMigrations(db: Database.Database): void {
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
    if (!this.tenantDb) {
      throw new Error('Tenant database not set. Call switchToTenant() first.');
    }
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
