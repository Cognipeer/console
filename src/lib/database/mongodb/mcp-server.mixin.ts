/**
 * MongoDB Provider – MCP Server operations mixin
 *
 * Includes MCP server CRUD, request logging, and aggregation.
 */

import { ObjectId } from 'mongodb';
import type {
  IMcpServer,
  IMcpRequestLog,
  IMcpRequestAggregate,
  McpServerStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

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
      data: Partial<Omit<IMcpServer, 'tenantId' | 'key' | 'createdBy'>>,
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

    async findMcpServerByKey(key: string, projectId?: string): Promise<IMcpServer | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db
        .collection(COLLECTIONS.mcpServers)
        .findOne(filter);
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
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
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
      const filter: Record<string, unknown> = { serverKey };
      if (options?.status) filter.status = options.status;
      if (options?.from || options?.to) {
        filter.createdAt = {};
        if (options.from) (filter.createdAt as Record<string, unknown>).$gte = options.from;
        if (options.to) (filter.createdAt as Record<string, unknown>).$lte = options.to;
      }
      if (options?.keyword?.trim()) {
        const keywordRegex = new RegExp(options.keyword.trim(), 'i');
        filter.$or = [
          { toolName: keywordRegex },
          { errorMessage: keywordRegex },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.mcpRequestLogs)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(options?.skip ?? 0)
        .limit(options?.limit ?? 50)
        .toArray();
      return docs as unknown as IMcpRequestLog[];
    }

    async countMcpRequestLogs(
      serverKey: string,
      options?: { from?: Date; to?: Date; status?: string; keyword?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { serverKey };

      if (options?.status) filter.status = options.status;
      if (options?.from || options?.to) {
        filter.createdAt = {};
        if (options.from) (filter.createdAt as Record<string, unknown>).$gte = options.from;
        if (options.to) (filter.createdAt as Record<string, unknown>).$lte = options.to;
      }
      if (options?.keyword?.trim()) {
        const keywordRegex = new RegExp(options.keyword.trim(), 'i');
        filter.$or = [
          { toolName: keywordRegex },
          { errorMessage: keywordRegex },
        ];
      }

      return db.collection(COLLECTIONS.mcpRequestLogs).countDocuments(filter);
    }

    async aggregateMcpRequestLogs(
      serverKey: string,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    ): Promise<IMcpRequestAggregate> {
      const db = this.getTenantDb();
      const match: Record<string, unknown> = { serverKey };
      if (options?.from || options?.to) {
        match.createdAt = {};
        if (options.from) (match.createdAt as Record<string, unknown>).$gte = options.from;
        if (options.to) (match.createdAt as Record<string, unknown>).$lte = options.to;
      }

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
        serverKey,
        totalRequests: (agg?.totalRequests as number) ?? 0,
        successCount: (agg?.successCount as number) ?? 0,
        errorCount: (agg?.errorCount as number) ?? 0,
        avgLatencyMs: (agg?.avgLatencyMs as number) ?? null,
        toolBreakdown,
        timeseries,
      };
    }
  };
}
