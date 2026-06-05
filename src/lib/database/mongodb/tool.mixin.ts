/**
 * MongoDB Provider – Tool operations mixin
 *
 * Includes unified tool CRUD (OpenAPI and MCP source types) + request logs.
 */

import { ObjectId } from 'mongodb';
import type {
  ITool,
  IToolRequestLog,
  IToolRequestAggregate,
  ToolSourceType,
  ToolStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function ToolMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class ToolOps extends Base {
    // ── Tool CRUD ────────────────────────────────────────────────────

    async createTool(
      tool: Omit<ITool, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ITool> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...tool, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.tools)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateTool(
      id: string,
      data: Partial<Omit<ITool, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<ITool | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<ITool>(COLLECTIONS.tools)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as ITool;
    }

    async deleteTool(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.tools)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findToolById(id: string): Promise<ITool | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.tools)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as ITool;
    }

    async findToolByKey(key: string, projectId?: string): Promise<ITool | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId) filter.projectId = projectId;
      const doc = await db
        .collection(COLLECTIONS.tools)
        .findOne(filter);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as ITool;
    }

    async listTools(filters?: {
      projectId?: string;
      type?: ToolSourceType;
      status?: ToolStatus;
      search?: string;
    }): Promise<ITool[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId) filter.projectId = filters.projectId;
      if (filters?.type) filter.type = filters.type;
      if (filters?.status) filter.status = filters.status;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.tools)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() })) as unknown as ITool[];
    }

    async countTools(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (projectId) filter.projectId = projectId;
      return db.collection(COLLECTIONS.tools).countDocuments(filter);
    }

    // ── Tool Request Logs ────────────────────────────────────────────

    async createToolRequestLog(
      log: Omit<IToolRequestLog, '_id' | 'createdAt'>,
    ): Promise<IToolRequestLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...log, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.toolRequestLogs)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
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
      const filter: Record<string, unknown> = { toolKey };
      if (options?.status) filter.status = options.status;
      if (options?.actionKey) filter.actionKey = options.actionKey;
      if (options?.from || options?.to) {
        filter.createdAt = {};
        if (options.from) (filter.createdAt as Record<string, unknown>).$gte = options.from;
        if (options.to) (filter.createdAt as Record<string, unknown>).$lte = options.to;
      }
      if (options?.keyword?.trim()) {
        const keywordRegex = new RegExp(options.keyword.trim(), 'i');
        filter.$or = [
          { actionName: keywordRegex },
          { actionKey: keywordRegex },
          { errorMessage: keywordRegex },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.toolRequestLogs)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(options?.skip ?? 0)
        .limit(options?.limit ?? 50)
        .toArray();
      return docs as unknown as IToolRequestLog[];
    }

    async countToolRequestLogs(
      toolKey: string,
      options?: { from?: Date; to?: Date; status?: string; actionKey?: string; keyword?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { toolKey };
      if (options?.status) filter.status = options.status;
      if (options?.actionKey) filter.actionKey = options.actionKey;
      if (options?.from || options?.to) {
        filter.createdAt = {};
        if (options.from) (filter.createdAt as Record<string, unknown>).$gte = options.from;
        if (options.to) (filter.createdAt as Record<string, unknown>).$lte = options.to;
      }
      if (options?.keyword?.trim()) {
        const keywordRegex = new RegExp(options.keyword.trim(), 'i');
        filter.$or = [
          { actionName: keywordRegex },
          { actionKey: keywordRegex },
          { errorMessage: keywordRegex },
        ];
      }
      return db.collection(COLLECTIONS.toolRequestLogs).countDocuments(filter);
    }

    async aggregateToolRequestLogs(
      toolKey: string,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    ): Promise<IToolRequestAggregate> {
      const db = this.getTenantDb();
      const match: Record<string, unknown> = { toolKey };
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
        .collection(COLLECTIONS.toolRequestLogs)
        .aggregate(pipeline)
        .toArray();

      // Action breakdown
      const actionPipeline = [
        { $match: match },
        { $group: { _id: '$actionKey', count: { $sum: 1 } } },
      ];
      const actionResults = await db
        .collection(COLLECTIONS.toolRequestLogs)
        .aggregate(actionPipeline)
        .toArray();

      const actionBreakdown: Record<string, number> = {};
      for (const a of actionResults) {
        if (a._id) actionBreakdown[a._id as string] = a.count as number;
      }

      // Timeseries (optional)
      let timeseries: IToolRequestAggregate['timeseries'];
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
          .collection(COLLECTIONS.toolRequestLogs)
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
        toolKey,
        totalRequests: (agg?.totalRequests as number) ?? 0,
        successCount: (agg?.successCount as number) ?? 0,
        errorCount: (agg?.errorCount as number) ?? 0,
        avgLatencyMs: (agg?.avgLatencyMs as number) ?? null,
        actionBreakdown,
        timeseries,
      };
    }
  };
}
