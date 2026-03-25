/**
 * SQLite Provider – Tool operations mixin
 *
 * Includes unified tool CRUD (OpenAPI and MCP source types) + request logs.
 */

import type {
  ITool,
  IToolRequestLog,
  IToolRequestAggregate,
  ToolSourceType,
  ToolStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function ToolMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class ToolOps extends Base {
    // ── Tool CRUD ────────────────────────────────────────────────────

    async createTool(
      tool: Omit<ITool, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ITool> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.tools}
        (id, tenantId, projectId, key, name, description, type, status,
         actions, openApiSpec, upstreamBaseUrl, upstreamAuth,
         mcpEndpoint, mcpTransport, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        tool.tenantId,
        tool.projectId ?? null,
        tool.key,
        tool.name,
        tool.description ?? null,
        tool.type,
        tool.status,
        JSON.stringify(tool.actions ?? []),
        tool.openApiSpec ?? null,
        tool.upstreamBaseUrl ?? null,
        JSON.stringify(tool.upstreamAuth ?? {}),
        tool.mcpEndpoint ?? null,
        tool.mcpTransport ?? null,
        JSON.stringify(tool.metadata ?? {}),
        tool.createdBy,
        tool.updatedBy ?? null,
        now,
        now,
      );

      return { ...tool, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateTool(
      id: string,
      data: Partial<Omit<ITool, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<ITool | null> {
      const db = this.getTenantDb();
      const setClauses: string[] = [];
      const values: unknown[] = [];

      if (data.name !== undefined) { setClauses.push('name = ?'); values.push(data.name); }
      if (data.description !== undefined) { setClauses.push('description = ?'); values.push(data.description); }
      if (data.type !== undefined) { setClauses.push('type = ?'); values.push(data.type); }
      if (data.status !== undefined) { setClauses.push('status = ?'); values.push(data.status); }
      if (data.actions !== undefined) { setClauses.push('actions = ?'); values.push(JSON.stringify(data.actions)); }
      if (data.openApiSpec !== undefined) { setClauses.push('openApiSpec = ?'); values.push(data.openApiSpec); }
      if (data.upstreamBaseUrl !== undefined) { setClauses.push('upstreamBaseUrl = ?'); values.push(data.upstreamBaseUrl); }
      if (data.upstreamAuth !== undefined) { setClauses.push('upstreamAuth = ?'); values.push(JSON.stringify(data.upstreamAuth)); }
      if (data.mcpEndpoint !== undefined) { setClauses.push('mcpEndpoint = ?'); values.push(data.mcpEndpoint); }
      if (data.mcpTransport !== undefined) { setClauses.push('mcpTransport = ?'); values.push(data.mcpTransport); }
      if (data.metadata !== undefined) { setClauses.push('metadata = ?'); values.push(JSON.stringify(data.metadata)); }
      if (data.updatedBy !== undefined) { setClauses.push('updatedBy = ?'); values.push(data.updatedBy); }

      setClauses.push('updatedAt = ?');
      values.push(this.now());
      values.push(id);

      if (setClauses.length === 0) return this.findToolById(id);
      db.prepare(`UPDATE ${TABLES.tools} SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
      return this.findToolById(id);
    }

    async deleteTool(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(`DELETE FROM ${TABLES.tools} WHERE id = ?`).run(id);
      return result.changes === 1;
    }

    async findToolById(id: string): Promise<ITool | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.tools} WHERE id = ?`).get(id) as SqliteRow | undefined;
      return row ? this.mapToolRow(row) : null;
    }

    async findToolByKey(key: string, projectId?: string): Promise<ITool | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.tools} WHERE key = ?`;
      const params: unknown[] = [key];
      if (projectId) { sql += ' AND projectId = ?'; params.push(projectId); }
      const row = db.prepare(sql).get(...params) as SqliteRow | undefined;
      return row ? this.mapToolRow(row) : null;
    }

    async listTools(filters?: {
      projectId?: string;
      type?: ToolSourceType;
      status?: ToolStatus;
      search?: string;
    }): Promise<ITool[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (filters?.projectId) { clauses.push('projectId = ?'); params.push(filters.projectId); }
      if (filters?.type) { clauses.push('type = ?'); params.push(filters.type); }
      if (filters?.status) { clauses.push('status = ?'); params.push(filters.status); }
      if (filters?.search) {
        clauses.push('(name LIKE ? OR description LIKE ? OR key LIKE ?)');
        const term = `%${filters.search}%`;
        params.push(term, term, term);
      }

      let sql = `SELECT * FROM ${TABLES.tools}`;
      if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
      sql += ' ORDER BY createdAt DESC';

      const rows = db.prepare(sql).all(...params) as SqliteRow[];
      return rows.map((r) => this.mapToolRow(r));
    }

    async countTools(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(*) as cnt FROM ${TABLES.tools}`;
      const params: unknown[] = [];
      if (projectId) { sql += ' WHERE projectId = ?'; params.push(projectId); }
      const row = db.prepare(sql).get(...params) as SqliteRow;
      return Number(row.cnt);
    }

    // ── Row mapper ─────────────────────────────────────────────────

    private mapToolRow(row: SqliteRow): ITool {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: row.projectId ? String(row.projectId) : undefined,
        key: String(row.key),
        name: String(row.name),
        description: row.description ? String(row.description) : undefined,
        type: String(row.type) as ITool['type'],
        status: String(row.status) as ITool['status'],
        actions: JSON.parse(String(row.actions || '[]')),
        openApiSpec: row.openApiSpec ? String(row.openApiSpec) : undefined,
        upstreamBaseUrl: row.upstreamBaseUrl ? String(row.upstreamBaseUrl) : undefined,
        upstreamAuth: row.upstreamAuth ? JSON.parse(String(row.upstreamAuth)) : undefined,
        mcpEndpoint: row.mcpEndpoint ? String(row.mcpEndpoint) : undefined,
        mcpTransport: row.mcpTransport ? String(row.mcpTransport) as ITool['mcpTransport'] : undefined,
        metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
        createdBy: String(row.createdBy),
        updatedBy: row.updatedBy ? String(row.updatedBy) : undefined,
        createdAt: row.createdAt ? new Date(String(row.createdAt)) : undefined,
        updatedAt: row.updatedAt ? new Date(String(row.updatedAt)) : undefined,
      };
    }

    // ── Tool Request Logs ────────────────────────────────────────────

    async createToolRequestLog(
      log: Omit<IToolRequestLog, '_id' | 'createdAt'>,
    ): Promise<IToolRequestLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.toolRequestLogs}
        (id, tenantId, projectId, toolKey, actionKey, actionName, status,
         requestPayload, responsePayload, errorMessage, latencyMs, callerType, callerTokenId, createdAt)
        VALUES (@id, @tenantId, @projectId, @toolKey, @actionKey, @actionName, @status,
         @requestPayload, @responsePayload, @errorMessage, @latencyMs, @callerType, @callerTokenId, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        toolKey: log.toolKey,
        actionKey: log.actionKey,
        actionName: log.actionName,
        status: log.status,
        requestPayload: this.toJson(log.requestPayload ?? {}),
        responsePayload: this.toJson(log.responsePayload ?? {}),
        errorMessage: log.errorMessage ?? null,
        latencyMs: log.latencyMs ?? null,
        callerType: log.callerType ?? null,
        callerTokenId: log.callerTokenId ?? null,
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) };
    }

    async listToolRequestLogs(
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
    ): Promise<IToolRequestLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['toolKey = @toolKey'];
      const params: Record<string, unknown> = { toolKey };
      if (options?.status) { clauses.push('status = @status'); params.status = options.status; }
      if (options?.actionKey) { clauses.push('actionKey = @actionKey'); params.actionKey = options.actionKey; }
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }
      if (options?.keyword?.trim()) {
        clauses.push('(actionName LIKE @keyword OR actionKey LIKE @keyword OR errorMessage LIKE @keyword)');
        params.keyword = `%${options.keyword.trim()}%`;
      }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.toolRequestLogs} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapToolRequestLogRow(r));
    }

    async countToolRequestLogs(
      toolKey: string,
      options?: { from?: Date; to?: Date; status?: string; actionKey?: string; keyword?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ['toolKey = @toolKey'];
      const params: Record<string, unknown> = { toolKey };
      if (options?.status) { clauses.push('status = @status'); params.status = options.status; }
      if (options?.actionKey) { clauses.push('actionKey = @actionKey'); params.actionKey = options.actionKey; }
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }
      if (options?.keyword?.trim()) {
        clauses.push('(actionName LIKE @keyword OR actionKey LIKE @keyword OR errorMessage LIKE @keyword)');
        params.keyword = `%${options.keyword.trim()}%`;
      }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const row = db.prepare(
        `SELECT COUNT(*) as count FROM ${TABLES.toolRequestLogs} ${where}`,
      ).get(params) as SqliteRow | undefined;

      return (row?.count as number) ?? 0;
    }

    async aggregateToolRequestLogs(
      toolKey: string,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    ): Promise<IToolRequestAggregate> {
      const db = this.getTenantDb();
      const clauses: string[] = ['toolKey = @toolKey'];
      const params: Record<string, unknown> = { toolKey };
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }
      const where = `WHERE ${clauses.join(' AND ')}`;

      const totalsRow = db.prepare(`
        SELECT
          COUNT(*) as totalRequests,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errorCount,
          AVG(latencyMs) as avgLatencyMs
        FROM ${TABLES.toolRequestLogs} ${where}
      `).get(params) as SqliteRow;

      // Action breakdown
      const actionRows = db.prepare(`
        SELECT actionKey, COUNT(*) as cnt
        FROM ${TABLES.toolRequestLogs} ${where}
        GROUP BY actionKey
      `).all(params) as SqliteRow[];

      const actionBreakdown: Record<string, number> = {};
      for (const a of actionRows) {
        if (a.actionKey) actionBreakdown[a.actionKey as string] = a.cnt as number;
      }

      // Timeseries
      const groupBy = options?.groupBy || 'day';
      let dateFormat: string;
      if (groupBy === 'hour') dateFormat = '%Y-%m-%dT%H:00';
      else if (groupBy === 'month') dateFormat = '%Y-%m';
      else dateFormat = '%Y-%m-%d';

      const tsRows = db.prepare(`
        SELECT strftime('${dateFormat}', createdAt) as period,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
        FROM ${TABLES.toolRequestLogs} ${where}
        GROUP BY period ORDER BY period ASC
      `).all(params) as SqliteRow[];

      const timeseries = tsRows.map((r) => ({
        period: r.period as string,
        total: r.total as number,
        success: r.success as number,
        errors: r.errors as number,
      }));

      return {
        toolKey,
        totalRequests: (totalsRow?.totalRequests as number) ?? 0,
        successCount: (totalsRow?.successCount as number) ?? 0,
        errorCount: (totalsRow?.errorCount as number) ?? 0,
        avgLatencyMs: (totalsRow?.avgLatencyMs as number) ?? null,
        actionBreakdown,
        timeseries,
      };
    }

    private mapToolRequestLogRow(r: SqliteRow): IToolRequestLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        toolKey: r.toolKey as string,
        actionKey: r.actionKey as string,
        actionName: r.actionName as string,
        status: r.status as IToolRequestLog['status'],
        requestPayload: this.parseJson(r.requestPayload, {}),
        responsePayload: this.parseJson(r.responsePayload, {}),
        errorMessage: r.errorMessage as string | undefined,
        latencyMs: r.latencyMs as number | undefined,
        callerType: r.callerType as IToolRequestLog['callerType'],
        callerTokenId: r.callerTokenId as string | undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
