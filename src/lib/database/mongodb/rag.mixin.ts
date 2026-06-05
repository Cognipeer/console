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

    async listRagDocuments(
      ragModuleKey: string,
      filters?: { projectId?: string; status?: RagDocumentStatus; search?: string },
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
      const docs = await db
        .collection<IRagDocument>(COLLECTIONS.ragDocuments)
        .find(query as Filter<IRagDocument>)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagDocument);
    }

    async countRagDocuments(ragModuleKey: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {
        ragModuleKey,
        ...this.buildProjectScopeFilter(projectId),
      };
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
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    ): Promise<IRagQueryLog[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { ragModuleKey };
      if (options?.from || options?.to) {
        const dateFilter: Record<string, Date> = {};
        if (options.from) dateFilter.$gte = options.from;
        if (options.to) dateFilter.$lte = options.to;
        query.createdAt = dateFilter;
      }
      const cursor = db
        .collection<IRagQueryLog>(COLLECTIONS.ragQueryLogs)
        .find(query as Filter<IRagQueryLog>)
        .sort({ createdAt: -1 });
      if (options?.skip) cursor.skip(options.skip);
      cursor.limit(options?.limit ?? 50);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRagQueryLog);
    }
  };
}
