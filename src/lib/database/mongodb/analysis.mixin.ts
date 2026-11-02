/**
 * MongoDB Provider – Analysis operations mixin
 *
 * CRUD for analysis definitions, conversations, and runs. Documents store
 * nested structures natively. Mirrors the evaluation mixin conventions.
 */

import { ObjectId, type Db } from 'mongodb';
import type {
  IAnalysisDefinition,
  IAnalysisConversation,
  IAnalysisRun,
  IAnalysisResult,
  IAnalysisResultReview,
  AnalysisResultFilter,
  AnalysisConversationSource,
  AnalysisRunStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

/** IAnalysisResult fields a re-analysis may drop; removed when the new result lacks them. */
const ANALYSIS_RESULT_OPTIONAL_FIELDS = [
  'title', 'agentKey', 'ownerId', 'kbRestricted', 'sourceVersion', 'judge', 'accuracy', 'rationale', 'reviewReason',
] as const;

export function AnalysisMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AnalysisOps extends Base {
    private analysisResultIndexesReady = new Set<string>();
    private analysisResultIndexInit = new Map<string, Promise<void>>();

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
        // The text as typed, not a pattern: a `\` or a `(` in a name is a character of the name.
        const pattern = this.escapeRegex(filters.search);
        filter.$or = [
          { name: { $regex: pattern, $options: 'i' } },
          { description: { $regex: pattern, $options: 'i' } },
          { key: { $regex: pattern, $options: 'i' } },
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
        const pattern = this.escapeRegex(filters.search);
        filter.$or = [
          { name: { $regex: pattern, $options: 'i' } },
          { description: { $regex: pattern, $options: 'i' } },
          { key: { $regex: pattern, $options: 'i' } },
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

    // ── Results (latest decision per conversation) ───────────────────

    /**
     * Created lazily on the write path: the unique key must hold from the very first upsert, and the
     * boot-time manifest only runs at process start. Names/keys are identical to indexManifest.ts.
     */
    private async ensureAnalysisResultIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.analysisResultIndexesReady.has(dbName)) return;
      const existing = this.analysisResultIndexInit.get(dbName);
      if (existing) {
        await existing;
        return;
      }
      const coll = db.collection(COLLECTIONS.analysisResults);
      const setup = Promise.all([
        coll.createIndex(
          { projectId: 1, definitionKey: 1, sourceKind: 1, sourceId: 1 },
          { name: 'uniq_analysis_result_source', unique: true },
        ),
        coll.createIndex(
          { projectId: 1, definitionKey: 1, needsReview: 1, minConfidence: 1, analyzedAt: -1 },
          { name: 'idx_analysis_result_review' },
        ),
        coll.createIndex(
          { projectId: 1, definitionKey: 1, analyzedAt: -1 },
          { name: 'idx_analysis_result_definition' },
        ),
        coll.createIndex({ projectId: 1, analyzedAt: -1 }, { name: 'idx_analysis_result_project' }),
      ])
        .then(() => {
          this.analysisResultIndexesReady.add(dbName);
        })
        .finally(() => {
          this.analysisResultIndexInit.delete(dbName);
        });
      this.analysisResultIndexInit.set(dbName, setup);
      await setup;
    }

    private buildAnalysisResultFilter(filters: AnalysisResultFilter): Record<string, unknown> {
      const filter: Record<string, unknown> = { projectId: filters.projectId };
      if (filters.definitionKey !== undefined) filter.definitionKey = filters.definitionKey;
      if (filters.sourceKind !== undefined) filter.sourceKind = filters.sourceKind;
      if (filters.sourceIds !== undefined) filter.sourceId = { $in: filters.sourceIds };
      if (filters.needsReview !== undefined) filter.needsReview = filters.needsReview;
      // `review` is stored as null when absent, so "no review" is an equality match.
      if (filters.reviewed === true) filter.review = { $ne: null };
      else if (filters.reviewed === false) filter.review = null;
      if (filters.viewer) {
        // Agent-session rows only where the viewer may see the agent or started the session; other kinds pass.
        filter.$or = [
          { sourceKind: { $ne: 'agent_session' } },
          { agentKey: { $in: filters.viewer.agentKeys } },
          { ownerId: filters.viewer.userId },
        ];
      }
      return filter;
    }

    private toAnalysisResult(doc: Record<string, unknown>): IAnalysisResult {
      return { ...doc, _id: (doc._id as ObjectId | string | undefined)?.toString() } as unknown as IAnalysisResult;
    }

    async upsertAnalysisResult(
      result: Omit<IAnalysisResult, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAnalysisResult> {
      const db = this.getTenantDb();
      await this.ensureAnalysisResultIndexes(db);
      const now = new Date();
      const set: Record<string, unknown> = { ...result, review: result.review ?? null, updatedAt: now };
      delete set._id;
      delete set.createdAt;
      // A full replace, like the SQLite upsert: an optional field the new result
      // lacks (no rationale, no judge, no longer flagged) must not keep the old value.
      const unset: Record<string, ''> = {};
      for (const key of ANALYSIS_RESULT_OPTIONAL_FIELDS) {
        if (set[key] === undefined) {
          delete set[key];
          unset[key] = '';
        }
      }
      const coll = db.collection(COLLECTIONS.analysisResults);
      const run = () =>
        coll.findOneAndUpdate(
          {
            projectId: result.projectId,
            definitionKey: result.definitionKey,
            sourceKind: result.sourceKind,
            sourceId: result.sourceId,
          },
          { $set: set, $setOnInsert: { createdAt: now }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
          { upsert: true, returnDocument: 'after' },
        );
      let doc;
      try {
        doc = await run();
      } catch (error) {
        // Two runs upserting the same conversation concurrently: the loser hits the unique index;
        // the retry then matches the winner's doc.
        if ((error as { code?: number })?.code !== 11000) throw error;
        doc = await run();
      }
      return this.toAnalysisResult(doc as unknown as Record<string, unknown>);
    }

    async findAnalysisResultById(id: string): Promise<IAnalysisResult | null> {
      if (!ObjectId.isValid(id)) return null;
      const doc = await this.getTenantDb()
        .collection(COLLECTIONS.analysisResults)
        .findOne({ _id: new ObjectId(id) });
      return doc ? this.toAnalysisResult(doc as unknown as Record<string, unknown>) : null;
    }

    async listAnalysisResults(
      filters: AnalysisResultFilter & { sort?: 'recent' | 'confidence'; limit?: number; skip?: number },
    ): Promise<IAnalysisResult[]> {
      if (filters.sourceIds?.length === 0) return [];
      const sort: Record<string, 1 | -1> =
        filters.sort === 'confidence' ? { minConfidence: 1, analyzedAt: -1 } : { analyzedAt: -1 };
      const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 50), 1), 5000);
      const docs = await this.getTenantDb()
        .collection(COLLECTIONS.analysisResults)
        .find(this.buildAnalysisResultFilter(filters))
        // _id last keeps pages stable when analyzedAt ties.
        .sort({ ...sort, _id: -1 })
        .skip(Math.max(filters.skip ?? 0, 0))
        .limit(limit)
        .toArray();
      return docs.map((doc) => this.toAnalysisResult(doc as unknown as Record<string, unknown>));
    }

    async countAnalysisResults(filters: AnalysisResultFilter): Promise<number> {
      if (filters.sourceIds?.length === 0) return 0;
      return this.getTenantDb()
        .collection(COLLECTIONS.analysisResults)
        .countDocuments(this.buildAnalysisResultFilter(filters));
    }

    async updateAnalysisResultReview(id: string, review: IAnalysisResultReview): Promise<IAnalysisResult | null> {
      if (!ObjectId.isValid(id)) return null;
      const doc = await this.getTenantDb()
        .collection(COLLECTIONS.analysisResults)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { review, needsReview: false, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      return doc ? this.toAnalysisResult(doc as unknown as Record<string, unknown>) : null;
    }

    async deleteAnalysisResultsForDefinition(projectId: string, definitionKey: string): Promise<number> {
      const result = await this.getTenantDb()
        .collection(COLLECTIONS.analysisResults)
        .deleteMany({ projectId, definitionKey });
      return result.deletedCount ?? 0;
    }
  };
}
