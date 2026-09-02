/**
 * MongoDB Provider – MCP Server operations mixin
 *
 * Includes MCP server CRUD, request logging, audit logging and aggregation.
 */

import { ObjectId } from 'mongodb';
import type {
  IMcpServer,
  IMcpAuditLog,
  IMcpRequestLog,
  IMcpRequestAggregate,
  McpLogServerScope,
  McpServerStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, escapeRegex } from './base';

/**
 * Match a server's request logs by durable `serverId` primarily. The second
 * `$or` branch only extends the match to rows written before `serverId`
 * existed (`serverId` absent) — scoped to this server's own `serverKey` +
 * `projectId`, and no older than this server's own `createdAt`, so a
 * deleted-and-recreated server can never adopt its predecessor's logs just
 * because they share the same name-derived key.
 */
function mcpLogScopeFilter(scope: McpLogServerScope): Record<string, unknown> {
  const legacy: Record<string, unknown> = {
    serverId: { $exists: false },
    serverKey: scope.serverKey,
  };
  if (scope.projectId !== undefined) legacy.projectId = scope.projectId;
  if (scope.createdAt) legacy.createdAt = { $gte: scope.createdAt };
  return { $or: [{ serverId: scope.serverId }, legacy] };
}

/** Combine the scope filter with the caller's own query options via `$and` (the scope filter already uses `$or`, which can't be merged by object-spread without colliding keys). */
function buildMcpLogFilter(
  scope: McpLogServerScope,
  options?: { status?: string; from?: Date; to?: Date; keyword?: string },
): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [mcpLogScopeFilter(scope)];
  if (options?.status) clauses.push({ status: options.status });
  if (options?.from || options?.to) {
    const range: Record<string, unknown> = {};
    if (options.from) range.$gte = options.from;
    if (options.to) range.$lte = options.to;
    clauses.push({ createdAt: range });
  }
  if (options?.keyword?.trim()) {
    const keywordRegex = new RegExp(escapeRegex(options.keyword.trim()), 'i');
    clauses.push({ $or: [{ toolName: keywordRegex }, { errorMessage: keywordRegex }] });
  }
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

export function McpServerMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class McpServerOps extends Base {
    // ── MCP Server CRUD ──────────────────────────────────────────────

    async createMcpServer(
      server: Omit<IMcpServer, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IMcpServer> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...server, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.mcpServers)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateMcpServer(
      id: string,
      data: Partial<Omit<IMcpServer, 'tenantId' | 'createdBy'>>,
    ): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IMcpServer>(COLLECTIONS.mcpServers)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IMcpServer;
    }

    async deleteMcpServer(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.mcpServers)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findMcpServerById(id: string): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.mcpServers)
        .findOne({ _id: new ObjectId(id) });
      return doc as unknown as IMcpServer | null;
    }

    async findMcpServerByKey(key: string, projectId?: string | null): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      // `null` matches both a stored null and a missing field — the two
      // spellings tenant-wide rows have on disk; a string is exact; `undefined`
      // adds no clause.
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db
        .collection(COLLECTIONS.mcpServers)
        .findOne(filter);
      return doc as unknown as IMcpServer | null;
    }

    async findMcpServerByEndpointSlug(endpointSlug: string): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.mcpServers)
        .findOne({ endpointSlug });
      return doc as unknown as IMcpServer | null;
    }

    async listMcpServers(filters?: {
      projectId?: string;
      status?: McpServerStatus;
      search?: string;
    }): Promise<IMcpServer[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.status !== undefined) filter.status = filters.status;
      if (filters?.search) {
        const escapedSearch = this.escapeRegex(filters.search);
        filter.$or = [
          { name: { $regex: escapedSearch, $options: 'i' } },
          { description: { $regex: escapedSearch, $options: 'i' } },
          { key: { $regex: escapedSearch, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.mcpServers)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return docs as unknown as IMcpServer[];
    }

    async countMcpServers(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (projectId !== undefined) filter.projectId = projectId;
      return db.collection(COLLECTIONS.mcpServers).countDocuments(filter);
    }

    // ── MCP Request Logs ─────────────────────────────────────────────

    async createMcpRequestLog(
      log: Omit<IMcpRequestLog, '_id' | 'createdAt'>,
    ): Promise<IMcpRequestLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...log, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.mcpRequestLogs)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async listMcpRequestLogs(
      scope: McpLogServerScope,
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
      const filter = buildMcpLogFilter(scope, options);
      const docs = await db
        .collection(COLLECTIONS.mcpRequestLogs)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(options?.skip ?? 0)
        .limit(options?.limit ?? 50)
        .toArray();
      return docs as unknown as IMcpRequestLog[];
    }

    async listRecentMcpRequestLogs(options?: {
      projectId?: string;
      limit?: number;
      status?: string;
    }): Promise<IMcpRequestLog[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (options?.projectId !== undefined) filter.projectId = options.projectId;
      if (options?.status) filter.status = options.status;
      const docs = await db
        .collection(COLLECTIONS.mcpRequestLogs)
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(options?.limit ?? 50, 500))
        .toArray();
      return docs as unknown as IMcpRequestLog[];
    }

    async countMcpRequestLogs(
      scope: McpLogServerScope,
      options?: { from?: Date; to?: Date; status?: string; keyword?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const filter = buildMcpLogFilter(scope, options);
      return db.collection(COLLECTIONS.mcpRequestLogs).countDocuments(filter);
    }

    async aggregateMcpRequestLogs(
      scope: McpLogServerScope,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    ): Promise<IMcpRequestAggregate> {
      const db = this.getTenantDb();
      const match = buildMcpLogFilter(scope, { from: options?.from, to: options?.to });

      const pipeline = [
        { $match: match },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            successCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            errorCount: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
            avgLatencyMs: { $avg: '$latencyMs' },
          },
        },
      ];

      const [agg] = await db
        .collection(COLLECTIONS.mcpRequestLogs)
        .aggregate(pipeline)
        .toArray();

      // Tool breakdown
      const toolPipeline = [
        { $match: match },
        { $group: { _id: '$toolName', count: { $sum: 1 } } },
      ];
      const toolResults = await db
        .collection(COLLECTIONS.mcpRequestLogs)
        .aggregate(toolPipeline)
        .toArray();

      const toolBreakdown: Record<string, number> = {};
      for (const t of toolResults) {
        if (t._id) toolBreakdown[t._id as string] = t.count as number;
      }

      // Timeseries (optional)
      let timeseries: IMcpRequestAggregate['timeseries'];
      if (options?.groupBy) {
        const dateFormat: Record<string, string> = {
          hour: '%Y-%m-%dT%H:00:00Z',
          day: '%Y-%m-%d',
          month: '%Y-%m',
        };
        const tsPipeline = [
          { $match: match },
          {
            $group: {
              _id: { $dateToString: { format: dateFormat[options.groupBy], date: '$createdAt' } },
              total: { $sum: 1 },
              success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
              errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ];
        const tsResults = await db
          .collection(COLLECTIONS.mcpRequestLogs)
          .aggregate(tsPipeline)
          .toArray();
        timeseries = tsResults.map((r) => ({
          period: r._id as string,
          total: r.total as number,
          success: r.success as number,
          errors: r.errors as number,
        }));
      }

      return {
        serverKey: scope.serverKey,
        totalRequests: (agg?.totalRequests as number) ?? 0,
        successCount: (agg?.successCount as number) ?? 0,
        errorCount: (agg?.errorCount as number) ?? 0,
        avgLatencyMs: (agg?.avgLatencyMs as number) ?? null,
        toolBreakdown,
        timeseries,
      };
    }

    // ── MCP Audit Logs ───────────────────────────────────────────────

    async createMcpAuditLog(
      log: Omit<IMcpAuditLog, '_id' | 'createdAt'>,
    ): Promise<IMcpAuditLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...log, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.mcpAuditLogs)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async listMcpAuditLogs(options?: {
      projectId?: string;
      serverKey?: string;
      action?: string;
      limit?: number;
      skip?: number;
    }): Promise<IMcpAuditLog[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (options?.projectId !== undefined) filter.projectId = options.projectId;
      if (options?.serverKey) filter.serverKey = options.serverKey;
      if (options?.action) filter.action = options.action;
      const docs = await db
        .collection(COLLECTIONS.mcpAuditLogs)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(options?.skip ?? 0)
        .limit(Math.min(options?.limit ?? 50, 500))
        .toArray();
      return docs as unknown as IMcpAuditLog[];
    }
  };
}
