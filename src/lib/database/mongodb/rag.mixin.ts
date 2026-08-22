/**
 * MongoDB Provider – RAG operations mixin
 *
 * Includes RAG modules, documents, chunks, and query logs.
 */

import { ObjectId, type Filter } from 'mongodb';
import type {
  IRagModule,
  IRagDocument,
  IRagChunk,
  IRagQueryLog,
  RagDocumentStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

/**
 * `$bucket` boundaries are [lower, upper), so an exact 1.0 needs a boundary
 * above it or it falls out of the histogram entirely. Mirrored arithmetically
 * in `sqlite/rag.mixin.ts` — the two must produce identical labels.
 */
const SCORE_BUCKET_BOUNDARIES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.0001];

/** Labels, ascending: '0.0'..'0.9' plus '1.0'. The trailing sentinel is not one. */
const SCORE_BUCKET_LABELS = SCORE_BUCKET_BOUNDARIES.slice(0, -1).map((b) => b.toFixed(1));

/**
 * Scores outside [0, 1.0001) — a provider handing back a raw distance rather
 * than a normalized similarity. `$bucket` errors without a default; these are
 * dropped rather than charted, because they belong to no bucket.
 */
const SCORE_BUCKET_OUT_OF_RANGE = 'out-of-range';

export function RagMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RagOps extends Base {
    // ── RAG Module operations ────────────────────────────────────────

    async createRagModule(
      ragModule: Omit<IRagModule, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagModule> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...ragModule, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.ragModules)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() } as IRagModule;
    }

    async updateRagModule(
      id: string,
      data: Partial<Omit<IRagModule, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IRagModule>(COLLECTIONS.ragModules)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IRagModule;
    }

    async deleteRagModule(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragModules)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    }

    async findRagModuleById(id: string): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IRagModule>(COLLECTIONS.ragModules)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IRagModule;
    }

    async findRagModuleByKey(key: string, projectId?: string): Promise<IRagModule | null> {
      const db = this.getTenantDb();
      // When projectId is provided, scope the lookup to that project.
      // When undefined, find by key alone (tenant-wide) — used by client API where
      // the token authenticates the tenant, not a specific project.
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) {
        Object.assign(filter, this.buildProjectScopeFilter(projectId));
      }
      const doc = await db
        .collection<IRagModule>(COLLECTIONS.ragModules)
        .findOne(filter as Filter<IRagModule>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IRagModule;
    }

    async listRagModules(filters?: {
      projectId?: string;
      status?: IRagModule['status'];
      search?: string;
    }): Promise<IRagModule[]> {
      const db = this.getTenantDb();
      // When projectId is provided, scope to that project.
      // When undefined, list all modules in the tenant (used by client API).
      const query: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(filters.projectId));
      }
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        query.$or = [
          { name: { $regex: this.escapeRegex(filters.search), $options: 'i' } },
          { key: { $regex: this.escapeRegex(filters.search), $options: 'i' } },
        ];
      }
      const docs = await db
        .collection<IRagModule>(COLLECTIONS.ragModules)
        .find(query as Filter<IRagModule>)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagModule);
    }

    // ── RAG Document operations ──────────────────────────────────────

    async createRagDocument(
      doc: Omit<IRagDocument, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagDocument> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...doc, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.ragDocuments)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IRagDocument;
    }

    async updateRagDocument(
      id: string,
      data: Partial<Omit<IRagDocument, 'tenantId' | 'ragModuleKey' | 'createdBy'>>,
    ): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IRagDocument;
    }

    async deleteRagDocument(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragDocuments)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    }

    async findRagDocumentById(id: string): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IRagDocument;
    }

    async findRagDocumentByFileName(
      ragModuleKey: string,
      fileName: string,
      projectId?: string,
    ): Promise<IRagDocument | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { ragModuleKey, fileName };
      if (projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(projectId));
      }
      const doc = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .findOne(query as Filter<IRagDocument>, { sort: { createdAt: -1 } });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IRagDocument;
    }

    async listRagDocuments(
      ragModuleKey: string,
      filters?: {
        projectId?: string;
        status?: RagDocumentStatus;
        search?: string;
        limit?: number;
        offset?: number;
      },
    ): Promise<IRagDocument[]> {
      const db = this.getTenantDb();
      // When projectId is provided, scope to that project.
      // When undefined, list all documents for this module (tenant-wide for client API).
      const query: Record<string, unknown> = { ragModuleKey };
      if (filters?.projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(filters.projectId));
      }
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        query.fileName = { $regex: this.escapeRegex(filters.search), $options: 'i' };
      }
      const cursor = db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .find(query as Filter<IRagDocument>)
        .sort({ createdAt: -1 });
      if (filters?.offset && filters.offset > 0) cursor.skip(filters.offset);
      if (filters?.limit && filters.limit > 0) cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagDocument);
    }

    async countRagDocuments(
      ragModuleKey: string,
      filters?: { projectId?: string; status?: RagDocumentStatus; search?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      // Mirrors listRagDocuments exactly: an absent projectId means "every
      // project", not "documents without one", or the total would disagree
      // with the page it describes.
      const query: Record<string, unknown> = { ragModuleKey };
      if (filters?.projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(filters.projectId));
      }
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        query.fileName = { $regex: this.escapeRegex(filters.search), $options: 'i' };
      }
      return db
        .collection(COLLECTIONS.ragDocuments)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .countDocuments(query as any);
    }

    // ── RAG Chunk operations ─────────────────────────────────────────

    async bulkInsertRagChunks(
      chunks: Omit<IRagChunk, '_id' | 'createdAt'>[],
    ): Promise<void> {
      if (chunks.length === 0) return;
      const db = this.getTenantDb();
      const now = new Date();
      const records = chunks.map((c) => ({ ...c, createdAt: now }));
      await db
        .collection(COLLECTIONS.ragChunks)
        .insertMany(records);
    }

    async findRagChunksByVectorIds(vectorIds: string[]): Promise<IRagChunk[]> {
      if (vectorIds.length === 0) return [];
      const db = this.getTenantDb();
      const docs = await db
        .collection<IRagChunk>(COLLECTIONS.ragChunks)
        .find({ vectorId: { $in: vectorIds } })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagChunk);
    }

    async findRagChunksByDocumentId(documentId: string): Promise<IRagChunk[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection<IRagChunk>(COLLECTIONS.ragChunks)
        .find({ documentId })
        .sort({ chunkIndex: 1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagChunk);
    }

    async deleteRagChunksByDocumentId(documentId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragChunks)
        .deleteMany({ documentId });
      return result.deletedCount;
    }

    // ── RAG Query Log operations ─────────────────────────────────────

    async createRagQueryLog(
      log: Omit<IRagQueryLog, '_id' | 'createdAt'>,
    ): Promise<IRagQueryLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...log, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.ragQueryLogs)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IRagQueryLog;
    }

    async listRagQueryLogs(
      ragModuleKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date; zeroOnly?: boolean; projectId?: string },
    ): Promise<IRagQueryLog[]> {
      const db = this.getTenantDb();
      const query = this.buildRagQueryLogFilter(ragModuleKey, options);
      if (options?.zeroOnly) query.matchCount = 0;
      const cursor = db
        .collection<IRagQueryLog>(COLLECTIONS.ragQueryLogs)
        .find(query as Filter<IRagQueryLog>)
        .sort({ createdAt: -1 });
      if (options?.skip) cursor.skip(options.skip);
      cursor.limit(options?.limit ?? 50);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagQueryLog);
    }

    async countRagQueryLogs(
      ragModuleKey: string,
      options?: { from?: Date; to?: Date; projectId?: string },
    ): Promise<{
      total: number;
      avgLatencyMs: number;
      zeroMatchCount: number;
      minScoreFilteredCount: number;
    }> {
      const db = this.getTenantDb();
      const query = this.buildRagQueryLogFilter(ragModuleKey, options);
      const [agg] = await db
        .collection(COLLECTIONS.ragQueryLogs)
        .aggregate([
          { $match: query },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              avgLatencyMs: { $avg: '$latencyMs' },
              zeroMatchCount: { $sum: { $cond: [{ $eq: ['$matchCount', 0] }, 1, 0] } },
              // A missing preFilterMatchCount compares as null, which is below
              // any number, so pre-change logs never count as filtered-out.
              minScoreFilteredCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$matchCount', 0] },
                        { $gt: ['$preFilterMatchCount', 0] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
        .toArray();
      return {
        total: (agg?.total as number | undefined) ?? 0,
        avgLatencyMs: agg?.avgLatencyMs ? Math.round(agg.avgLatencyMs as number) : 0,
        zeroMatchCount: (agg?.zeroMatchCount as number | undefined) ?? 0,
        minScoreFilteredCount: (agg?.minScoreFilteredCount as number | undefined) ?? 0,
      };
    }

    async aggregateRagQueryScoreDistribution(
      ragModuleKey: string,
      options?: { from?: Date; to?: Date; projectId?: string },
    ): Promise<Array<{ bucket: string; count: number }>> {
      const db = this.getTenantDb();
      const query = this.buildRagQueryLogFilter(ragModuleKey, options);
      // Logs written before topScore existed carry no score to bucket.
      query.topScore = { $type: 'number' };

      const rows = await db
        .collection(COLLECTIONS.ragQueryLogs)
        .aggregate<{ _id: number | string; count: number }>([
          { $match: query },
          {
            $bucket: {
              groupBy: '$topScore',
              boundaries: SCORE_BUCKET_BOUNDARIES,
              default: SCORE_BUCKET_OUT_OF_RANGE,
              output: { count: { $sum: 1 } },
            },
          },
        ])
        .toArray();

      const counts = new Map(
        rows
          .filter((row) => typeof row._id === 'number')
          .map((row) => [(row._id as number).toFixed(1), row.count]),
      );
      // Always every bucket: a histogram missing its empty bars reads as a
      // different distribution, and it is exactly where the two backends' own
      // grouping would otherwise disagree.
      return SCORE_BUCKET_LABELS.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
    }

    async deleteRagQueryLogsOlderThan(before: Date, ragModuleKey?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { createdAt: { $lt: before } };
      if (ragModuleKey) query.ragModuleKey = ragModuleKey;
      const result = await db.collection(COLLECTIONS.ragQueryLogs).deleteMany(query);
      return result.deletedCount;
    }

    // ── RAG module teardown ──────────────────────────────────────────

    async deleteRagDocumentsByModuleKey(ragModuleKey: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragDocuments)
        .deleteMany({ ragModuleKey });
      return result.deletedCount;
    }

    async deleteRagChunksByModuleKey(ragModuleKey: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragChunks)
        .deleteMany({ ragModuleKey });
      return result.deletedCount;
    }

    async countRagModulesByVectorIndexKey(
      vectorIndexKey: string,
      options?: { projectId?: string; excludeKey?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { vectorIndexKey };
      if (options?.projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(options.projectId));
      }
      // The module being edited must not count itself as a co-tenant of its
      // own index.
      if (options?.excludeKey) query.key = { $ne: options.excludeKey };
      return db
        .collection(COLLECTIONS.ragModules)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .countDocuments(query as any);
    }

    /** Shared module + project + date-window match for every query-log read. */
    /**
     * Module keys are unique only WITHIN a project, so a query-log read filtered by
     * ragModuleKey alone picks up the rows of a same-key module in another project
     * of the tenant — including the verbatim end-user query text.
     *
     * Rows written with no projectId (logs predating project stamping, and every
     * query through /client/v1, which passes projectId undefined) cannot be
     * attributed to either module. They stay visible to the module's owner: hiding
     * a project's own history is the worse of the two failure modes, and the caller
     * has already been verified to own a module with this key.
     */
    private buildRagQueryLogFilter(
      ragModuleKey: string,
      options?: { from?: Date; to?: Date; projectId?: string },
    ): Record<string, unknown> {
      const query: Record<string, unknown> = { ragModuleKey };
      if (options?.projectId) {
        query.$or = [
          { projectId: options.projectId },
          { projectId: { $exists: false } },
          { projectId: null },
        ];
      }
      if (options?.from || options?.to) {
        const dateFilter: Record<string, Date> = {};
        if (options.from) dateFilter.$gte = options.from;
        if (options.to) dateFilter.$lte = options.to;
        query.createdAt = dateFilter;
      }
      return query;
    }
  };
}
