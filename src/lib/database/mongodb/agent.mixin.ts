/**
 * MongoDB Provider – Agent operations mixin
 *
 * Includes agent CRUD and conversation management.
 */

import { randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import type {
  IAgent,
  AgentStatus,
  IAgentConversation,
  IAgentConversationState,
  IAgentPendingAction,
  IAgentSessionEvent,
  IAgentVersion,
  NewAgentSessionEvent,
} from '../provider.interface';
import { AgentSessionEventSeqConflictError } from '../provider/errors';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function AgentMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AgentOps extends Base {
    // ── Agent CRUD ───────────────────────────────────────────────

    async createAgent(
      agent: Omit<IAgent, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgent> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...agent, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.agents)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateAgent(
      id: string,
      data: Partial<Omit<IAgent, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IAgent | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAgent>(COLLECTIONS.agents)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAgent;
    }

    async deleteAgent(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.agents)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findAgentById(id: string): Promise<IAgent | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.agents)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgent;
    }

    async findAgentByKey(key: string, projectId?: string): Promise<IAgent | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db
        .collection(COLLECTIONS.agents)
        .findOne(filter);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgent;
    }

    async listAgents(filters?: {
      projectId?: string;
      status?: AgentStatus;
      search?: string;
    }): Promise<IAgent[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.status) filter.status = filters.status;
      if (filters?.search) {
        const escaped = this.escapeRegex(filters.search);
        filter.$or = [
          { name: { $regex: escaped, $options: 'i' } },
          { key: { $regex: escaped, $options: 'i' } },
          { description: { $regex: escaped, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.agents)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() })) as unknown as IAgent[];
    }

    async countAgents(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (projectId !== undefined) filter.projectId = projectId;
      return db.collection(COLLECTIONS.agents).countDocuments(filter);
    }

    // ── Agent Version operations ───────────────────────────────

    async createAgentVersion(
      version: Omit<IAgentVersion, '_id' | 'createdAt'>,
    ): Promise<IAgentVersion> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...version, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.agentVersions)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async findAgentVersion(
      agentId: string,
      version: number,
    ): Promise<IAgentVersion | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.agentVersions)
        .findOne({ agentId, version });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgentVersion;
    }

    async findLatestAgentVersion(
      agentId: string,
    ): Promise<IAgentVersion | null> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.agentVersions)
        .find({ agentId })
        .sort({ version: -1 })
        .limit(1)
        .toArray();
      if (docs.length === 0) return null;
      const doc = docs[0];
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgentVersion;
    }

    async listAgentVersions(
      agentId: string,
      options?: { limit?: number; skip?: number },
    ): Promise<{ versions: IAgentVersion[]; total: number }> {
      const db = this.getTenantDb();
      const filter = { agentId };
      const total = await db
        .collection(COLLECTIONS.agentVersions)
        .countDocuments(filter);
      let cursor = db
        .collection(COLLECTIONS.agentVersions)
        .find(filter)
        .sort({ version: -1 });
      if (options?.skip) cursor = cursor.skip(options.skip);
      if (options?.limit) cursor = cursor.limit(options.limit);
      const docs = await cursor.toArray();
      const versions = docs.map((d) => ({
        ...d,
        _id: d._id?.toString(),
      })) as unknown as IAgentVersion[];
      return { versions, total };
    }

    // ── Agent Conversation operations ────────────────────────────

    async createAgentConversation(
      conversation: Omit<IAgentConversation, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentConversation> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...conversation, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.agentConversations)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateAgentConversation(
      id: string,
      data: Partial<Omit<IAgentConversation, 'tenantId' | 'agentKey' | 'createdBy'>>,
    ): Promise<IAgentConversation | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAgentConversation>(COLLECTIONS.agentConversations)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAgentConversation;
    }

    async updateAgentConversationRuntime(
      id: string,
      patch: Partial<Pick<IAgentConversation, 'runtimeStatus' | 'stopReason' | 'pendingActionIds' | 'lastEventSeq' | 'budget' | 'spentUsd'>>,
    ): Promise<void> {
      const set: Record<string, unknown> = {};
      for (const key of ['runtimeStatus', 'stopReason', 'pendingActionIds', 'lastEventSeq', 'budget', 'spentUsd'] as const) {
        if (patch[key] !== undefined) set[key] = patch[key];
      }
      if (Object.keys(set).length === 0) return;
      await this.getTenantDb()
        .collection(COLLECTIONS.agentConversations)
        .updateOne({ _id: new ObjectId(id) }, { $set: set });
    }

    async deleteAgentConversation(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.agentConversationStates).deleteOne({ conversationId: id });
      // The session's event log and pending approvals die with it.
      await db.collection(COLLECTIONS.agentSessionEvents).deleteMany({ conversationId: id });
      await db.collection(COLLECTIONS.agentPendingActions).deleteMany({ conversationId: id });
      const result = await db
        .collection(COLLECTIONS.agentConversations)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findAgentConversationState(conversationId: string): Promise<IAgentConversationState | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.agentConversationStates)
        .findOne({ conversationId });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgentConversationState;
    }

    async saveAgentConversationState(
      state: Omit<IAgentConversationState, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<void> {
      const db = this.getTenantDb();
      const now = new Date();
      // A save without `pausedSnapshot` clears one left by an earlier pause.
      const { pausedSnapshot, ...rest } = state;
      await db.collection(COLLECTIONS.agentConversationStates).updateOne(
        { conversationId: state.conversationId },
        {
          $set: { ...rest, ...(pausedSnapshot !== undefined ? { pausedSnapshot } : {}), updatedAt: now },
          ...(pausedSnapshot === undefined ? { $unset: { pausedSnapshot: '' } } : {}),
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    }

    async deleteAgentConversationState(conversationId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.agentConversationStates)
        .deleteOne({ conversationId });
      return result.deletedCount === 1;
    }

    async findAgentConversationById(id: string): Promise<IAgentConversation | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.agentConversations)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgentConversation;
    }

    async listAgentConversations(
      agentKey: string,
      filters?: { projectId?: string; limit?: number; skip?: number },
    ): Promise<IAgentConversation[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { agentKey };
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      let cursor = db
        .collection(COLLECTIONS.agentConversations)
        .find(filter)
        .sort({ updatedAt: -1 });
      if (filters?.skip) cursor = cursor.skip(filters.skip);
      if (filters?.limit) cursor = cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() })) as unknown as IAgentConversation[];
    }

    // ── Agent session event log ──────────────────────────────────

    /** Per-process memo: the unique/TTL indexes are ensured on the first write per tenant DB. */
    private sessionEventIndexesReady = new Set<string>();
    private sessionEventIndexInit = new Map<string, Promise<void>>();

    /**
     * Ensured on the WRITE path as well as in the boot manifest: the manifest is
     * existence-guarded, so a collection created after the tenant's first bind
     * would stay without its unique (conversationId, seq) guard until a restart.
     */
    private async ensureSessionEventIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.sessionEventIndexesReady.has(dbName)) return;
      const existing = this.sessionEventIndexInit.get(dbName);
      if (existing) {
        await existing;
        return;
      }
      const coll = db.collection(COLLECTIONS.agentSessionEvents);
      const setup = Promise.all([
        coll.createIndex({ conversationId: 1, seq: 1 }, { name: 'uniq_conversation_seq', unique: true }),
        coll.createIndex({ expiresAt: 1 }, { name: 'ttl_expiresAt', expireAfterSeconds: 0 }),
      ])
        .then(() => {
          this.sessionEventIndexesReady.add(dbName);
        })
        .finally(() => {
          this.sessionEventIndexInit.delete(dbName);
        });
      this.sessionEventIndexInit.set(dbName, setup);
      await setup;
    }

    async appendAgentSessionEvents(events: NewAgentSessionEvent[]): Promise<void> {
      if (events.length === 0) return;
      const db = this.getTenantDb();
      await this.ensureSessionEventIndexes(db);
      const docs = events.map((event) => ({ ...event, _id: event._id ?? `sevt_${randomUUID().replace(/-/g, '').slice(0, 24)}` }));
      const collection = db.collection(COLLECTIONS.agentSessionEvents);
      try {
        await collection.insertMany(docs as never[], { ordered: true });
      } catch (error) {
        if ((error as { code?: number } | null)?.code === 11000) {
          // An ordered insert keeps the documents before the one that failed.
          // Say which, by what is actually stored (a primary-key lookup) rather
          // than by what the driver reports, which differs between backends:
          // the caller must not store them a second time under new seq numbers.
          const ids = docs.map((doc) => doc._id);
          const stored = await collection
            .find({ _id: { $in: ids } } as never)
            .project({ _id: 1 })
            .toArray()
            .catch(() => []);
          const storedIds = new Set(stored.map((doc) => String(doc._id)));
          throw new AgentSessionEventSeqConflictError(
            events[0].conversationId,
            ids.filter((id) => storedIds.has(id)),
          );
        }
        throw error;
      }
    }

    async listAgentSessionEvents(
      conversationId: string,
      options?: { afterSeq?: number; types?: string[]; limit?: number },
    ): Promise<IAgentSessionEvent[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { conversationId };
      if (options?.afterSeq !== undefined && options.afterSeq > 0) filter.seq = { $gt: options.afterSeq };
      if (options?.types && options.types.length > 0) filter.type = { $in: options.types };
      let cursor = db.collection(COLLECTIONS.agentSessionEvents).find(filter).sort({ seq: 1 });
      if (options?.limit) cursor = cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() })) as unknown as IAgentSessionEvent[];
    }

    async getAgentSessionMaxSeq(conversationId: string): Promise<number> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.agentSessionEvents)
        .find({ conversationId })
        .sort({ seq: -1 })
        .limit(1)
        .project({ seq: 1 })
        .next();
      return typeof doc?.seq === 'number' ? doc.seq : 0;
    }

    async deleteAgentSessionEvents(conversationId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.agentSessionEvents).deleteMany({ conversationId });
      return result.deletedCount ?? 0;
    }

    async cleanupAgentSessionEventRetention(options: { olderThan: Date; batchSize?: number }): Promise<{ deletedCount: number }> {
      // The TTL index normally does this; the sweep covers a deployment whose
      // TTL monitor is off (some Cosmos tiers) and costs one indexed delete.
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.agentSessionEvents)
        .deleteMany({ expiresAt: { $lt: options.olderThan } });
      return { deletedCount: result.deletedCount ?? 0 };
    }

    // ── Agent pending actions ────────────────────────────────────

    async createAgentPendingActions(
      actions: Array<Omit<IAgentPendingAction, '_id'>>,
    ): Promise<IAgentPendingAction[]> {
      if (actions.length === 0) return [];
      const db = this.getTenantDb();
      const docs = actions.map((action) => ({ ...action, _id: `act_${randomUUID().replace(/-/g, '').slice(0, 24)}` }));
      await db.collection(COLLECTIONS.agentPendingActions).insertMany(docs as never[]);
      return docs as unknown as IAgentPendingAction[];
    }

    async findAgentPendingActionById(id: string): Promise<IAgentPendingAction | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.agentPendingActions).findOne({ _id: id as never });
      return doc ? ({ ...doc, _id: String(doc._id) } as unknown as IAgentPendingAction) : null;
    }

    async listAgentPendingActions(
      conversationId: string,
      options?: { status?: IAgentPendingAction['status'] },
    ): Promise<IAgentPendingAction[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { conversationId };
      if (options?.status) filter.status = options.status;
      const docs = await db.collection(COLLECTIONS.agentPendingActions).find(filter).sort({ requestedAt: 1 }).toArray();
      return docs.map((d) => ({ ...d, _id: String(d._id) })) as unknown as IAgentPendingAction[];
    }

    async updateAgentPendingAction(
      id: string,
      data: Partial<Omit<IAgentPendingAction, '_id' | 'tenantId' | 'projectId' | 'conversationId'>>,
      options?: { onlyIfStatus?: IAgentPendingAction['status'] },
    ): Promise<IAgentPendingAction | null> {
      const db = this.getTenantDb();
      const set: Record<string, unknown> = { ...data };
      delete set._id;
      const doc = await db.collection(COLLECTIONS.agentPendingActions).findOneAndUpdate(
        { _id: id as never, status: options?.onlyIfStatus ?? 'pending' },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc ? ({ ...doc, _id: String(doc._id) } as unknown as IAgentPendingAction) : null;
    }

    async listExpiredAgentPendingActions(now: Date, limit = 100): Promise<IAgentPendingAction[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.agentPendingActions)
        .find({ status: 'pending', expiresAt: { $lt: now } })
        .sort({ expiresAt: 1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => ({ ...d, _id: String(d._id) })) as unknown as IAgentPendingAction[];
    }

    async deleteAgentPendingActions(conversationId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.agentPendingActions).deleteMany({ conversationId });
      return result.deletedCount ?? 0;
    }
  };
}
