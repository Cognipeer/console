/**
 * SQLite Provider – MCP Server operations mixin
 *
 * Includes MCP server CRUD, request logging, and aggregation.
 */

import type {
  IMcpServer,
  IMcpRequestLog,
  IMcpRequestAggregate,
  McpServerStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function McpServerMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class McpServerOps extends Base {
    // ── MCP Server CRUD ──────────────────────────────────────────────

    async createMcpServer(
      server: Omit<IMcpServer, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IMcpServer> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.mcpServers}
        (id, tenantId, projectId, key, name, description, openApiSpec, tools,
         upstreamBaseUrl, upstreamAuth, status, endpointSlug, totalRequests,
         metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @openApiSpec, @tools,
         @upstreamBaseUrl, @upstreamAuth, @status, @endpointSlug, @totalRequests,
         @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: server.tenantId,
        projectId: server.projectId ?? null,
        key: server.key,
        name: server.name,
        description: server.description ?? null,
        openApiSpec: server.openApiSpec,
        tools: this.toJson(server.tools ?? []),
        upstreamBaseUrl: server.upstreamBaseUrl,
        upstreamAuth: this.toJson(server.upstreamAuth ?? {}),
        status: server.status,
        endpointSlug: server.endpointSlug,
        totalRequests: server.totalRequests ?? 0,
        metadata: this.toJson(server.metadata ?? {}),
        createdBy: server.createdBy,
        updatedBy: server.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...server, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateMcpServer(
      id: string,
      data: Partial<Omit<IMcpServer, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.openApiSpec !== undefined) { sets.push('openApiSpec = @openApiSpec'); params.openApiSpec = data.openApiSpec; }
      if (data.tools !== undefined) { sets.push('tools = @tools'); params.tools = this.toJson(data.tools); }
      if (data.upstreamBaseUrl !== undefined) { sets.push('upstreamBaseUrl = @upstreamBaseUrl'); params.upstreamBaseUrl = data.upstreamBaseUrl; }
      if (data.upstreamAuth !== undefined) { sets.push('upstreamAuth = @upstreamAuth'); params.upstreamAuth = this.toJson(data.upstreamAuth); }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.endpointSlug !== undefined) { sets.push('endpointSlug = @endpointSlug'); params.endpointSlug = data.endpointSlug; }
      if (data.totalRequests !== undefined) { sets.push('totalRequests = @totalRequests'); params.totalRequests = data.totalRequests; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.mcpServers} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findMcpServerById(id);
    }

    async deleteMcpServer(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.mcpServers} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findMcpServerById(id: string): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.mcpServers} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapMcpServerRow(row) : null;
    }

    async findMcpServerByKey(key: string, projectId?: string): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const clauses: string[] = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(
        `SELECT * FROM ${TABLES.mcpServers} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow | undefined;
      return row ? this.mapMcpServerRow(row) : null;
    }

    async listMcpServers(filters?: {
      projectId?: string;
      status?: McpServerStatus;
      search?: string;
    }): Promise<IMcpServer[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status !== undefined) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.search) {
        clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)');
        params.search = this.likePattern(filters.search);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.mcpServers} ${where} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapMcpServerRow(r));
    }

    async countMcpServers(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.mcpServers} ${where}`,
      ).get(params) as SqliteRow;
      return (row?.cnt as number) || 0;
    }

    // ── MCP Request Logs ─────────────────────────────────────────────

    async createMcpRequestLog(
      log: Omit<IMcpRequestLog, '_id' | 'createdAt'>,
    ): Promise<IMcpRequestLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.mcpRequestLogs}
        (id, tenantId, projectId, serverKey, toolName, status,
         requestPayload, responsePayload, errorMessage, latencyMs, callerTokenId, createdAt)
        VALUES (@id, @tenantId, @projectId, @serverKey, @toolName, @status,
         @requestPayload, @responsePayload, @errorMessage, @latencyMs, @callerTokenId, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        serverKey: log.serverKey,
        toolName: log.toolName,
        status: log.status,
        requestPayload: this.toJson(log.requestPayload ?? {}),
        responsePayload: this.toJson(log.responsePayload ?? {}),
        errorMessage: log.errorMessage ?? null,
        latencyMs: log.latencyMs ?? null,
        callerTokenId: log.callerTokenId ?? null,
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) };
    }

    async listMcpRequestLogs(
      serverKey: string,
      options?: {
        limit?: number;
        skip?: number;
        from?: Date;
        to?: Date;
        status?: string;
        keyword?: string;
      },
    ): Promise<IMcpRequestLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['serverKey = @serverKey'];
      const params: Record<string, unknown> = { serverKey };
      if (options?.status) { clauses.push('status = @status'); params.status = options.status; }
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }
      if (options?.keyword?.trim()) {
        clauses.push('(toolName LIKE @keyword OR errorMessage LIKE @keyword)');
        params.keyword = `%${options.keyword.trim()}%`;
      }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.mcpRequestLogs} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapMcpRequestLogRow(r));
    }

    async countMcpRequestLogs(
      serverKey: string,
      options?: { from?: Date; to?: Date; status?: string; keyword?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ['serverKey = @serverKey'];
      const params: Record<string, unknown> = { serverKey };

      if (options?.status) { clauses.push('status = @status'); params.status = options.status; }
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }
      if (options?.keyword?.trim()) {
        clauses.push('(toolName LIKE @keyword OR errorMessage LIKE @keyword)');
        params.keyword = `%${options.keyword.trim()}%`;
      }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const row = db.prepare(
        `SELECT COUNT(*) as count FROM ${TABLES.mcpRequestLogs} ${where}`,
      ).get(params) as SqliteRow | undefined;

      return (row?.count as number) ?? 0;
    }

    async aggregateMcpRequestLogs(
      serverKey: string,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    ): Promise<IMcpRequestAggregate> {
      const db = this.getTenantDb();
      const clauses: string[] = ['serverKey = @serverKey'];
      const params: Record<string, unknown> = { serverKey };
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }
      const where = `WHERE ${clauses.join(' AND ')}`;

      const totalsRow = db.prepare(`
        SELECT
          COUNT(*) as totalRequests,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errorCount,
          AVG(latencyMs) as avgLatencyMs
        FROM ${TABLES.mcpRequestLogs} ${where}
      `).get(params) as SqliteRow;

      // Tool breakdown
      const toolRows = db.prepare(`
        SELECT toolName, COUNT(*) as cnt
        FROM ${TABLES.mcpRequestLogs} ${where}
        GROUP BY toolName
      `).all(params) as SqliteRow[];

      const toolBreakdown: Record<string, number> = {};
      for (const t of toolRows) {
        if (t.toolName) toolBreakdown[t.toolName as string] = t.cnt as number;
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
        FROM ${TABLES.mcpRequestLogs} ${where}
        GROUP BY period ORDER BY period ASC
      `).all(params) as SqliteRow[];

      const timeseries = tsRows.map((r) => ({
        period: r.period as string,
        total: r.total as number,
        success: r.success as number,
        errors: r.errors as number,
      }));

      return {
        serverKey,
        totalRequests: (totalsRow?.totalRequests as number) ?? 0,
        successCount: (totalsRow?.successCount as number) ?? 0,
        errorCount: (totalsRow?.errorCount as number) ?? 0,
        avgLatencyMs: (totalsRow?.avgLatencyMs as number) ?? null,
        toolBreakdown,
        timeseries,
      };
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapMcpServerRow(r: SqliteRow): IMcpServer {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        openApiSpec: r.openApiSpec as string,
        tools: this.parseJson(r.tools, []),
        upstreamBaseUrl: r.upstreamBaseUrl as string,
        upstreamAuth: this.parseJson(r.upstreamAuth, { type: 'none' }),
        status: r.status as IMcpServer['status'],
        endpointSlug: r.endpointSlug as string,
        totalRequests: (r.totalRequests as number) ?? 0,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapMcpRequestLogRow(r: SqliteRow): IMcpRequestLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        serverKey: r.serverKey as string,
        toolName: r.toolName as string,
        status: r.status as IMcpRequestLog['status'],
        requestPayload: this.parseJson(r.requestPayload, {}),
        responsePayload: this.parseJson(r.responsePayload, {}),
        errorMessage: r.errorMessage as string | undefined,
        latencyMs: r.latencyMs as number | undefined,
        callerTokenId: r.callerTokenId as string | undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
