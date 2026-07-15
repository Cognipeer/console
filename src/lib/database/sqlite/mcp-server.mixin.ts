/**
 * SQLite Provider – MCP Server operations mixin
 *
 * Includes MCP server CRUD, request logging, audit logging and aggregation.
 *
 * Legacy-schema note: tenant DBs created before the MCP Hub keep NOT NULL on
 * `openApiSpec`/`upstreamBaseUrl`. Non-openapi sources therefore persist ''
 * and the row mappers translate '' back to undefined.
 */

import type {
  IMcpServer,
  IMcpAuditLog,
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
        (id, tenantId, projectId, key, name, description, sourceType, openApiSpec, remoteConfig,
         stdioConfig, tools, toolsDiscoveredAt, upstreamBaseUrl, upstreamAuth, exposure, aegis,
         status, endpointSlug, totalRequests, lastError, metadata, createdBy, updatedBy,
         createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @sourceType, @openApiSpec,
         @remoteConfig, @stdioConfig, @tools, @toolsDiscoveredAt, @upstreamBaseUrl, @upstreamAuth,
         @exposure, @aegis, @status, @endpointSlug, @totalRequests, @lastError, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: server.tenantId,
        projectId: server.projectId ?? null,
        key: server.key,
        name: server.name,
        description: server.description ?? null,
        sourceType: server.sourceType ?? 'openapi',
        openApiSpec: server.openApiSpec ?? '',
        remoteConfig: server.remoteConfig ? this.toJson(server.remoteConfig) : null,
        stdioConfig: server.stdioConfig ? this.toJson(server.stdioConfig) : null,
        tools: this.toJson(server.tools ?? []),
        toolsDiscoveredAt: server.toolsDiscoveredAt ? server.toolsDiscoveredAt.toISOString() : null,
        upstreamBaseUrl: server.upstreamBaseUrl ?? '',
        upstreamAuth: this.toJson(server.upstreamAuth ?? {}),
        exposure: server.exposure ? this.toJson(server.exposure) : null,
        aegis: server.aegis ? this.toJson(server.aegis) : null,
        status: server.status,
        endpointSlug: server.endpointSlug,
        totalRequests: server.totalRequests ?? 0,
        lastError: server.lastError ? this.toJson(server.lastError) : null,
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
      if (data.sourceType !== undefined) { sets.push('sourceType = @sourceType'); params.sourceType = data.sourceType; }
      if (data.openApiSpec !== undefined) { sets.push('openApiSpec = @openApiSpec'); params.openApiSpec = data.openApiSpec ?? ''; }
      if (data.remoteConfig !== undefined) { sets.push('remoteConfig = @remoteConfig'); params.remoteConfig = data.remoteConfig ? this.toJson(data.remoteConfig) : null; }
      if (data.stdioConfig !== undefined) { sets.push('stdioConfig = @stdioConfig'); params.stdioConfig = data.stdioConfig ? this.toJson(data.stdioConfig) : null; }
      if (data.tools !== undefined) { sets.push('tools = @tools'); params.tools = this.toJson(data.tools); }
      if (data.toolsDiscoveredAt !== undefined) { sets.push('toolsDiscoveredAt = @toolsDiscoveredAt'); params.toolsDiscoveredAt = data.toolsDiscoveredAt ? data.toolsDiscoveredAt.toISOString() : null; }
      if (data.upstreamBaseUrl !== undefined) { sets.push('upstreamBaseUrl = @upstreamBaseUrl'); params.upstreamBaseUrl = data.upstreamBaseUrl ?? ''; }
      if (data.upstreamAuth !== undefined) { sets.push('upstreamAuth = @upstreamAuth'); params.upstreamAuth = this.toJson(data.upstreamAuth); }
      if (data.exposure !== undefined) { sets.push('exposure = @exposure'); params.exposure = data.exposure ? this.toJson(data.exposure) : null; }
      if (data.aegis !== undefined) { sets.push('aegis = @aegis'); params.aegis = data.aegis ? this.toJson(data.aegis) : null; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.endpointSlug !== undefined) { sets.push('endpointSlug = @endpointSlug'); params.endpointSlug = data.endpointSlug; }
      if (data.totalRequests !== undefined) { sets.push('totalRequests = @totalRequests'); params.totalRequests = data.totalRequests; }
      if (data.lastError !== undefined) { sets.push('lastError = @lastError'); params.lastError = data.lastError ? this.toJson(data.lastError) : null; }
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

    async findMcpServerByEndpointSlug(endpointSlug: string): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.mcpServers} WHERE endpointSlug = @endpointSlug`,
      ).get({ endpointSlug }) as SqliteRow | undefined;
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
         requestPayload, responsePayload, errorMessage, latencyMs, callerTokenId,
         callerType, callerUserId, transport, sourceType, sessionId,
         userId, apiTokenId, actorType, createdAt)
        VALUES (@id, @tenantId, @projectId, @serverKey, @toolName, @status,
         @requestPayload, @responsePayload, @errorMessage, @latencyMs, @callerTokenId,
         @callerType, @callerUserId, @transport, @sourceType, @sessionId,
         @userId, @apiTokenId, @actorType, @createdAt)
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
        callerType: log.callerType ?? null,
        callerUserId: log.callerUserId ?? null,
        transport: log.transport ?? null,
        sourceType: log.sourceType ?? null,
        sessionId: log.sessionId ?? null,
        userId: log.userId ?? null,
        apiTokenId: log.apiTokenId ?? null,
        actorType: log.actorType ?? null,
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

    async listRecentMcpRequestLogs(options?: {
      projectId?: string;
      limit?: number;
      status?: string;
    }): Promise<IMcpRequestLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (options?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = options.projectId; }
      if (options?.status) { clauses.push('status = @status'); params.status = options.status; }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(options?.limit ?? 50, 500);
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.mcpRequestLogs} ${where} ORDER BY createdAt DESC LIMIT ${limit}`,
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

    // ── MCP Audit Logs ───────────────────────────────────────────────

    async createMcpAuditLog(
      log: Omit<IMcpAuditLog, '_id' | 'createdAt'>,
    ): Promise<IMcpAuditLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.mcpAuditLogs}
        (id, tenantId, projectId, serverId, serverKey, action, changes,
         performedBy, ipAddress, userAgent, metadata, createdAt)
        VALUES (@id, @tenantId, @projectId, @serverId, @serverKey, @action, @changes,
         @performedBy, @ipAddress, @userAgent, @metadata, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        serverId: log.serverId ?? null,
        serverKey: log.serverKey,
        action: log.action,
        changes: log.changes ? this.toJson(log.changes) : null,
        performedBy: log.performedBy,
        ipAddress: log.ipAddress ?? null,
        userAgent: log.userAgent ?? null,
        metadata: this.toJson(log.metadata ?? {}),
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) };
    }

    async listMcpAuditLogs(options?: {
      projectId?: string;
      serverKey?: string;
      action?: string;
      limit?: number;
      skip?: number;
    }): Promise<IMcpAuditLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (options?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = options.projectId; }
      if (options?.serverKey) { clauses.push('serverKey = @serverKey'); params.serverKey = options.serverKey; }
      if (options?.action) { clauses.push('action = @action'); params.action = options.action; }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(options?.limit ?? 50, 500);
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.mcpAuditLogs} ${where} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapMcpAuditLogRow(r));
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
        sourceType: (r.sourceType as IMcpServer['sourceType']) ?? 'openapi',
        openApiSpec: (r.openApiSpec as string) || undefined,
        remoteConfig: r.remoteConfig ? this.parseJson(r.remoteConfig, undefined) : undefined,
        stdioConfig: r.stdioConfig ? this.parseJson(r.stdioConfig, undefined) : undefined,
        tools: this.parseJson(r.tools, []),
        toolsDiscoveredAt: r.toolsDiscoveredAt ? this.toDate(r.toolsDiscoveredAt) : undefined,
        upstreamBaseUrl: (r.upstreamBaseUrl as string) || undefined,
        upstreamAuth: this.parseJson(r.upstreamAuth, { type: 'none' }),
        exposure: r.exposure ? this.parseJson(r.exposure, undefined) : undefined,
        aegis: r.aegis ? this.parseJson(r.aegis, undefined) : undefined,
        status: r.status as IMcpServer['status'],
        endpointSlug: r.endpointSlug as string,
        totalRequests: (r.totalRequests as number) ?? 0,
        lastError: r.lastError ? this.parseJson(r.lastError, null) : null,
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
        callerType: (r.callerType as IMcpRequestLog['callerType'] | null) ?? undefined,
        callerUserId: (r.callerUserId as string | null) ?? undefined,
        transport: (r.transport as IMcpRequestLog['transport'] | null) ?? undefined,
        sourceType: (r.sourceType as IMcpRequestLog['sourceType'] | null) ?? undefined,
        sessionId: (r.sessionId as string | null) ?? undefined,
        userId: (r.userId as string | null) ?? undefined,
        apiTokenId: (r.apiTokenId as string | null) ?? undefined,
        actorType: (r.actorType as IMcpRequestLog['actorType'] | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }

    protected mapMcpAuditLogRow(r: SqliteRow): IMcpAuditLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        serverId: r.serverId as string | undefined,
        serverKey: r.serverKey as string,
        action: r.action as IMcpAuditLog['action'],
        changes: r.changes ? this.parseJson(r.changes, undefined) : undefined,
        performedBy: r.performedBy as string,
        ipAddress: r.ipAddress as string | undefined,
        userAgent: r.userAgent as string | undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
