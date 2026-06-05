/**
 * MongoDB Provider – Analysis operations mixin
 *
 * CRUD for analysis definitions, conversations, and runs. Documents store
 * nested structures natively. Mirrors the evaluation mixin conventions.
 */

import { ObjectId } from 'mongodb';
import type {
  IAnalysisDefinition,
  IAnalysisConversation,
  IAnalysisRun,
  AnalysisConversationSource,
  AnalysisRunStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function AnalysisMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AnalysisOps extends Base {
    // ── Definitions ──────────────────────────────────────────────────

    async createAnalysisDefinition(
      definition: Omit<IAnalysisDefinition, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAnalysisDefinition> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...definition, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.analysisDefinitions).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateAnalysisDefinition(
      id: string,
      data: Partial<Omit<IAnalysisDefinition, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IAnalysisDefinition | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAnalysisDefinition>(COLLECTIONS.analysisDefinitions)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAnalysisDefinition;
    }

    async deleteAnalysisDefinition(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.analysisDefinitions).deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findAnalysisDefinitionById(id: string): Promise<IAnalysisDefinition | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.analysisDefinitions).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IAnalysisDefinition | null;
    }

    async findAnalysisDefinitionByKey(key: string, projectId?: string): Promise<IAnalysisDefinition | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db.collection(COLLECTIONS.analysisDefinitions).findOne(filter);
      return doc as unknown as IAnalysisDefinition | null;
    }

    async listAnalysisDefinitions(filters?: { projectId?: string; search?: string }): Promise<IAnalysisDefinition[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db.collection(COLLECTIONS.analysisDefinitions).find(filter).sort({ createdAt: -1 }).toArray();
      return docs as unknown as IAnalysisDefinition[];
    }

    // ── Conversations ────────────────────────────────────────────────

    async createAnalysisConversation(
      conversation: Omit<IAnalysisConversation, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAnalysisConversation> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...conversation, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.analysisConversations).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateAnalysisConversation(
      id: string,
      data: Partial<Omit<IAnalysisConversation, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IAnalysisConversation | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAnalysisConversation>(COLLECTIONS.analysisConversations)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAnalysisConversation;
    }

    async deleteAnalysisConversation(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.analysisConversations).deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findAnalysisConversationById(id: string): Promise<IAnalysisConversation | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.analysisConversations).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IAnalysisConversation | null;
    }

    async findAnalysisConversationByKey(key: string, projectId?: string): Promise<IAnalysisConversation | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db.collection(COLLECTIONS.analysisConversations).findOne(filter);
      return doc as unknown as IAnalysisConversation | null;
    }

    async listAnalysisConversations(filters?: { projectId?: string; source?: AnalysisConversationSource; tag?: string; search?: string; limit?: number; skip?: number }): Promise<IAnalysisConversation[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.source !== undefined) filter.source = filters.source;
      if (filters?.tag) filter.tags = filters.tag;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.analysisConversations)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(filters?.skip ?? 0)
        .limit(filters?.limit ?? 100)
        .toArray();
      return docs as unknown as IAnalysisConversation[];
    }

    // ── Runs ─────────────────────────────────────────────────────────

    async createAnalysisRun(
      run: Omit<IAnalysisRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAnalysisRun> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...run, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.analysisRuns).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateAnalysisRun(
      id: string,
      data: Partial<Omit<IAnalysisRun, 'tenantId' | 'definitionKey' | 'createdBy'>>,
    ): Promise<IAnalysisRun | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAnalysisRun>(COLLECTIONS.analysisRuns)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAnalysisRun;
    }

    async findAnalysisRunById(id: string): Promise<IAnalysisRun | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.analysisRuns).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IAnalysisRun | null;
    }

    async listAnalysisRuns(filters?: { projectId?: string; definitionKey?: string; status?: AnalysisRunStatus; limit?: number; skip?: number }): Promise<IAnalysisRun[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.definitionKey !== undefined) filter.definitionKey = filters.definitionKey;
      if (filters?.status !== undefined) filter.status = filters.status;
      const docs = await db
        .collection(COLLECTIONS.analysisRuns)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(filters?.skip ?? 0)
        .limit(filters?.limit ?? 50)
        .toArray();
      return docs as unknown as IAnalysisRun[];
    }
  };
}
