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
  AgentSessionRuntimeStatus,
  IAgentConversation,
  IAgentConversationActivityRow,
  IAgentConversationListItem,
  IAgentConversationSearchHit,
  IAgentConversationState,
  IAgentPendingAction,
  IAgentMessageFeedback,
  AgentMessageFeedbackFilter,
  AgentMessageFeedbackTotals,
  AgentFeedbackReason,
  IAgentSessionEvent,
  IAgentVersion,
  NewAgentSessionEvent,
} from '../provider.interface';
import { AgentSessionEventSeqConflictError } from '../provider/errors';
import { buildMongoConversationSearchCondition, findConversationSearchMatch, normalizeConversationSearch } from '../provider/conversationSearch';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

/** A conversation as the rest of the app sees it: without the internal turn-owner marker. */
function withoutTurnOwner<T extends object>(conversation: T): Omit<T, 'runtimeTurnId'> {
  const { runtimeTurnId: _owner, ...rest } = conversation as T & { runtimeTurnId?: unknown };
  void _owner;
  return rest;
}

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

    /** Per-process memo: the session-list indexes are ensured on the first conversation written per tenant DB. */
    private conversationListIndexesReady = new Set<string>();

    /**
     * The client API's session list (a project's sessions newest first, optionally
     * one agent's or one status) and the dashboard's (by last activity). Ensured on the write path as well as in the boot
     * manifest, for a tenant whose first conversation is created after it was bound.
     * Names/keys are IDENTICAL to the manifest's.
     */
    private async ensureConversationListIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.conversationListIndexesReady.has(dbName)) return;
      const coll = db.collection(COLLECTIONS.agentConversations);
      await Promise.all([
        coll.createIndex({ agentKey: 1, createdBy: 1, updatedAt: -1 }, { name: 'idx_agent_creator_updatedAt' }),
        coll.createIndex({ projectId: 1, createdAt: -1, _id: -1 }, { name: 'idx_project_createdAt' }),
        coll.createIndex({ projectId: 1, agentKey: 1, createdAt: -1, _id: -1 }, { name: 'idx_project_agent_createdAt' }),
        coll.createIndex({ projectId: 1, runtimeStatus: 1, createdAt: -1, _id: -1 }, { name: 'idx_project_status_createdAt' }),
        coll.createIndex({ projectId: 1, updatedAt: -1, _id: -1 }, { name: 'idx_project_updatedAt' }),
        coll.createIndex({ projectId: 1, agentKey: 1, createdBy: 1, transcriptHash: 1, updatedAt: -1 }, { name: 'idx_transcript_hash' }),
      ]);
      this.conversationListIndexesReady.add(dbName);
    }

    async createAgentConversation(
      conversation: Omit<IAgentConversation, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentConversation> {
      const db = this.getTenantDb();
      await this.ensureConversationListIndexes(db).catch(() => undefined);
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
      // Only grows, through addAgentConversationRestriction: a caller writing back a copy it read earlier must not
      // shrink it.
      delete updateData.kbRestricted;
      const result = await db
        .collection<IAgentConversation>(COLLECTIONS.agentConversations)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return withoutTurnOwner({ ...result, _id: result._id?.toString() }) as IAgentConversation;
    }

    async updateAgentConversationRuntime(
      id: string,
      patch: Partial<Pick<IAgentConversation, 'runtimeStatus' | 'stopReason' | 'pendingActionIds' | 'lastEventSeq' | 'budget' | 'spentUsd' | 'runtimeTurnId' | 'transcriptHash'>>,
      options?: { onlyIfTurn?: string },
    ): Promise<boolean> {
      const set: Record<string, unknown> = {};
      for (const key of ['runtimeStatus', 'stopReason', 'pendingActionIds', 'lastEventSeq', 'budget', 'spentUsd', 'runtimeTurnId', 'transcriptHash'] as const) {
        if (patch[key] !== undefined) set[key] = patch[key];
      }
      if (Object.keys(set).length === 0) return true;
      // The lookup by this field is served by an index; it is created on the write path, like the list indexes.
      if (set.transcriptHash !== undefined) await this.ensureConversationListIndexes(this.getTenantDb()).catch(() => undefined);
      // The condition is part of the filter, so "is it still my turn?" and the write are one atomic step.
      const filter: Record<string, unknown> = { _id: new ObjectId(id) };
      if (options?.onlyIfTurn !== undefined) {
        filter.$or = [{ runtimeTurnId: options.onlyIfTurn }, { runtimeTurnId: null }];
      }
      const result = await this.getTenantDb()
        .collection(COLLECTIONS.agentConversations)
        .updateOne(filter, { $set: set });
      return result.matchedCount > 0;
    }

    async addAgentConversationSpend(id: string, change: { addUsd?: number; atLeastUsd?: number }): Promise<void> {
      const addUsd = typeof change.addUsd === 'number' && Number.isFinite(change.addUsd) ? Math.max(0, change.addUsd) : 0;
      const atLeastUsd = typeof change.atLeastUsd === 'number' && Number.isFinite(change.atLeastUsd) ? Math.max(0, change.atLeastUsd) : 0;
      if (addUsd === 0 && atLeastUsd === 0) return;
      // An aggregation-pipeline update, so the server does the arithmetic in one
      // atomic step. Plain `$inc` would reject a total that is not a number, and
      // could not raise to a floor and add in the same write.
      await this.getTenantDb()
        .collection(COLLECTIONS.agentConversations)
        .updateOne({ _id: new ObjectId(id) }, [{
          $set: {
            spentUsd: {
              $add: [
                { $max: [{ $convert: { input: '$spentUsd', to: 'double', onError: 0, onNull: 0 } }, atLeastUsd] },
                addUsd,
              ],
            },
          },
        }]);
    }

    async addAgentConversationRestriction(id: string, tags: string[]): Promise<void> {
      const clean = [...new Set(tags.filter((tag) => typeof tag === 'string' && tag.length > 0))];
      if (clean.length === 0 || !/^[0-9a-fA-F]{24}$/.test(id)) return;
      await this.getTenantDb()
        .collection(COLLECTIONS.agentConversations)
        .updateOne({ _id: new ObjectId(id) }, { $addToSet: { kbRestricted: { $each: clean } } });
    }

    async findRestrictedAgentConversations(ids: string[]): Promise<Array<Pick<IAgentConversation, '_id' | 'createdBy' | 'kbRestricted'>>> {
      const objectIds = [...new Set(ids)].filter((id) => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)).map((id) => new ObjectId(id));
      if (objectIds.length === 0) return [];
      const docs = await this.getTenantDb()
        .collection(COLLECTIONS.agentConversations)
        .find({ _id: { $in: objectIds }, 'kbRestricted.0': { $exists: true } }, { projection: { createdBy: 1, kbRestricted: 1 } })
        .toArray();
      return docs.map((doc) => ({ _id: String(doc._id), createdBy: doc.createdBy, kbRestricted: doc.kbRestricted as string[] }));
    }

    async deleteAgentConversation(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.agentConversationStates).deleteOne({ conversationId: id });
      // The session's event log and pending approvals die with it.
      await db.collection(COLLECTIONS.agentSessionEvents).deleteMany({ conversationId: id });
      await db.collection(COLLECTIONS.agentPendingActions).deleteMany({ conversationId: id });
      await db.collection(COLLECTIONS.agentMessageFeedback).deleteMany({ conversationId: id });
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
      // An id that cannot be one of ours (another producer's thread id, a typo) names no conversation: not found,
      // not an error - so a caller can tell "no such session" from a store that failed.
      if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) return null;
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.agentConversations)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return withoutTurnOwner({ ...doc, _id: doc._id?.toString() }) as unknown as IAgentConversation;
    }

    async findAgentConversationsByTranscriptHash(filter: {
      projectId: string;
      agentKey: string;
      createdBy: string;
      transcriptHash: string;
    }, limit: number): Promise<IAgentConversation[]> {
      const docs = await this.getTenantDb()
        .collection(COLLECTIONS.agentConversations)
        .find({ projectId: filter.projectId, agentKey: filter.agentKey, createdBy: filter.createdBy, transcriptHash: filter.transcriptHash })
        .sort({ updatedAt: -1 })
        .limit(Math.max(1, Math.floor(limit)))
        .toArray();
      return docs.map((doc) => withoutTurnOwner({ ...doc, _id: doc._id?.toString() }) as unknown as IAgentConversation);
    }

    async listAgentConversations(
      agentKey: string,
      filters?: { projectId?: string; limit?: number; skip?: number; createdBy?: string },
    ): Promise<IAgentConversation[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { agentKey };
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.createdBy !== undefined) filter.createdBy = filters.createdBy;
      let cursor = db
        .collection(COLLECTIONS.agentConversations)
        .find(filter)
        .sort({ updatedAt: -1 });
      if (filters?.skip) cursor = cursor.skip(filters.skip);
      if (filters?.limit) cursor = cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => withoutTurnOwner({ ...d, _id: d._id?.toString() })) as unknown as IAgentConversation[];
    }

    async listAgentConversationPage(filters: {
      projectId: string;
      agentKey?: string;
      runtimeStatus?: AgentSessionRuntimeStatus;
      limit: number;
      after?: { createdAt: Date; id: string };
      ownOnly?: { userId: string; viewableAgentKeys?: string[] };
    }): Promise<IAgentConversationListItem[]> {
      const db = this.getTenantDb();
      const match: Record<string, unknown> = { projectId: filters.projectId };
      if (filters.agentKey) match.agentKey = filters.agentKey;
      if (filters.ownOnly) {
        // The caller's own sessions, and every session of the agents they may view; nothing else - an agent that
        // is not named (including one that no longer exists) shows only what the caller started.
        const keys = filters.ownOnly.viewableAgentKeys ?? [];
        if (keys.length === 0) match.createdBy = filters.ownOnly.userId;
        else match.$and = [{ $or: [{ createdBy: filters.ownOnly.userId }, { agentKey: { $in: keys } }] }];
      }
      // A conversation that never ran has no status: "idle" covers it.
      if (filters.runtimeStatus === 'idle') match.runtimeStatus = { $in: [null, 'idle'] };
      else if (filters.runtimeStatus) match.runtimeStatus = filters.runtimeStatus;
      if (filters.after) {
        // Keyset on (createdAt, _id), newest first.
        match.$or = ObjectId.isValid(filters.after.id)
          ? [
            { createdAt: { $lt: filters.after.createdAt } },
            { createdAt: filters.after.createdAt, _id: { $lt: new ObjectId(filters.after.id) } },
          ]
          : [{ createdAt: { $lt: filters.after.createdAt } }];
      }
      // Sorted and limited BEFORE the transcript is touched; it is only counted, never returned.
      const docs = await db
        .collection(COLLECTIONS.agentConversations)
        .aggregate([
          { $match: match },
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: filters.limit },
          { $addFields: { messageCount: { $cond: [{ $isArray: '$messages' }, { $size: '$messages' }, 0] } } },
          { $project: { messages: 0, runtimeTurnId: 0 } },
        ])
        .toArray();
      return docs.map((doc) => ({ ...doc, _id: doc._id?.toString() })) as unknown as IAgentConversationListItem[];
    }

    async listProjectAgentConversations(filters: {
      projectId: string;
      runtimeStatuses?: AgentSessionRuntimeStatus[];
      ids?: string[];
      ownOnly?: { userId: string; viewableAgentKeys?: string[] };
      before?: { updatedAt: Date; id: string };
      limit: number;
    }): Promise<IAgentConversationActivityRow[]> {
      const match: Record<string, unknown> = { projectId: filters.projectId };
      // Narrowing lists that cannot match anything need no query.
      if (filters.runtimeStatuses?.length === 0 || filters.ids?.length === 0) return [];
      if (filters.ids) {
        const objectIds = filters.ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
        if (objectIds.length === 0) return [];
        match._id = { $in: objectIds };
      }
      // Conditions that are themselves a $or, so they are combined with $and rather than overwriting each other.
      const all: Record<string, unknown>[] = [];
      if (filters.runtimeStatuses) {
        // A conversation that never ran has no status: "idle" covers it.
        const statuses: (string | null)[] = [...filters.runtimeStatuses];
        if (statuses.includes('idle')) statuses.push(null);
        all.push({ runtimeStatus: { $in: statuses } });
      }
      if (filters.ownOnly) {
        // The caller's own sessions, and every session of the agents they may view; nothing else.
        const keys = filters.ownOnly.viewableAgentKeys ?? [];
        if (keys.length === 0) match.createdBy = filters.ownOnly.userId;
        else all.push({ $or: [{ createdBy: filters.ownOnly.userId }, { agentKey: { $in: keys } }] });
      }
      if (filters.before) {
        // Keyset on (updatedAt, _id), newest first.
        all.push({
          $or: ObjectId.isValid(filters.before.id)
            ? [
              { updatedAt: { $lt: filters.before.updatedAt } },
              { updatedAt: filters.before.updatedAt, _id: { $lt: new ObjectId(filters.before.id) } },
            ]
            : [{ updatedAt: { $lt: filters.before.updatedAt } }],
        });
      }
      if (all.length > 0) match.$and = all;
      // Sorted and limited BEFORE the transcript is touched; each message is cut down to what a summary counts.
      const docs = await this.getTenantDb()
        .collection(COLLECTIONS.agentConversations)
        .aggregate([
          { $match: match },
          { $sort: { updatedAt: -1, _id: -1 } },
          { $limit: filters.limit },
          {
            $addFields: {
              messages: {
                $map: {
                  input: { $cond: [{ $isArray: '$messages' }, '$messages', []] },
                  as: 'm',
                  in: {
                    role: '$$m.role',
                    usage: '$$m.usage',
                    latencyMs: '$$m.latencyMs',
                    stopReason: '$$m.stopReason',
                    outputError: '$$m.outputError',
                    steps: {
                      $map: {
                        input: { $cond: [{ $isArray: '$$m.steps' }, '$$m.steps', []] },
                        as: 's',
                        in: { status: '$$s.status', error: '$$s.error' },
                      },
                    },
                  },
                },
              },
            },
          },
          { $project: { runtimeTurnId: 0 } },
        ])
        .toArray();
      return docs.map((doc) => withoutTurnOwner({ ...doc, _id: doc._id?.toString() })) as unknown as IAgentConversationActivityRow[];
    }

    async listAgentConversationsForAnalysis(filters: {
      projectId: string;
      agentKeys?: string[];
      ids?: string[];
      updatedFrom?: Date;
      updatedTo?: Date;
      ownOnly?: { userId: string; viewableAgentKeys?: string[] };
      before?: { updatedAt: Date; id: string };
      limit: number;
      fields: 'meta' | 'full';
    }): Promise<IAgentConversation[]> {
      // Narrowing lists that cannot match anything need no query.
      if (filters.agentKeys?.length === 0 || filters.ids?.length === 0) return [];
      const match: Record<string, unknown> = { projectId: filters.projectId };
      if (filters.agentKeys) match.agentKey = { $in: filters.agentKeys };
      if (filters.ids) {
        const objectIds = filters.ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
        if (objectIds.length === 0) return [];
        match._id = { $in: objectIds };
      }
      if (filters.updatedFrom || filters.updatedTo) {
        match.updatedAt = {
          ...(filters.updatedFrom ? { $gte: filters.updatedFrom } : {}),
          ...(filters.updatedTo ? { $lt: filters.updatedTo } : {}),
        };
      }
      // Conditions that are themselves a $or, so they are combined with $and rather than overwriting each other.
      const all: Record<string, unknown>[] = [];
      if (filters.ownOnly) {
        // Same rule as listProjectAgentConversations: the caller's own sessions plus every session of viewable agents.
        const keys = filters.ownOnly.viewableAgentKeys ?? [];
        if (keys.length === 0) match.createdBy = filters.ownOnly.userId;
        else all.push({ $or: [{ createdBy: filters.ownOnly.userId }, { agentKey: { $in: keys } }] });
      }
      if (filters.before) {
        // Keyset on (updatedAt, _id), newest first.
        all.push({
          $or: ObjectId.isValid(filters.before.id)
            ? [
              { updatedAt: { $lt: filters.before.updatedAt } },
              { updatedAt: filters.before.updatedAt, _id: { $lt: new ObjectId(filters.before.id) } },
            ]
            : [{ updatedAt: { $lt: filters.before.updatedAt } }],
        });
      }
      if (all.length > 0) match.$and = all;
      const limit = Math.min(Math.max(Math.trunc(filters.limit), 1), 500);
      // Sorted and limited BEFORE the transcript is touched. 'meta' cuts each message down to role and
      // timestamp inside the pipeline, so steps and content never leave the database.
      const docs = await this.getTenantDb()
        .collection(COLLECTIONS.agentConversations)
        .aggregate([
          { $match: match },
          { $sort: { updatedAt: -1, _id: -1 } },
          { $limit: limit },
          ...(filters.fields === 'meta'
            ? [{
              $addFields: {
                messages: {
                  $map: {
                    input: { $cond: [{ $isArray: '$messages' }, '$messages', []] },
                    as: 'm',
                    in: { role: '$$m.role', content: '', timestamp: '$$m.timestamp' },
                  },
                },
              },
            }]
            : []),
          { $project: { runtimeTurnId: 0 } },
        ])
        .toArray();
      return docs.map((doc) => {
        const row = withoutTurnOwner({ ...doc, _id: doc._id?.toString() }) as Record<string, unknown>;
        return row as unknown as IAgentConversation;
      });
    }

    async searchAgentConversations(filters: {
      projectId: string;
      search: string;
      agentKeys?: string[];
      createdBy?: string;
      limit?: number;
      skip?: number;
    }): Promise<IAgentConversationSearchHit[]> {
      const needle = normalizeConversationSearch(filters.search);
      if (!needle || filters.agentKeys?.length === 0) return [];
      const db = this.getTenantDb();
      const match: Record<string, unknown> = {
        projectId: filters.projectId,
        ...buildMongoConversationSearchCondition(needle),
      };
      if (filters.agentKeys) match.agentKey = { $in: filters.agentKeys };
      if (filters.createdBy !== undefined) match.createdBy = filters.createdBy;
      let cursor = db
        .collection(COLLECTIONS.agentConversations)
        .find(match, { projection: { runtimeTurnId: 0 } })
        .sort({ updatedAt: -1, _id: -1 });
      if (filters.skip) cursor = cursor.skip(filters.skip);
      cursor = cursor.limit(filters.limit ?? 20);
      const docs = await cursor.toArray();
      return docs.map((doc) => {
        const { messages, ...rest } = doc as Record<string, unknown> & { messages?: IAgentConversation['messages']; title?: string };
        const searchMatch = findConversationSearchMatch(rest.title, messages, needle);
        return {
          ...rest,
          _id: String(doc._id),
          messageCount: Array.isArray(messages) ? messages.length : 0,
          ...(searchMatch ? { searchMatch } : {}),
        };
      }) as unknown as IAgentConversationSearchHit[];
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
      options?: { afterSeq?: number; types?: string[]; limit?: number; runId?: string },
    ): Promise<IAgentSessionEvent[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { conversationId };
      if (options?.runId) filter.runId = options.runId;
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

    /** Per-process memo: the pending-action indexes are ensured on the first write per tenant DB. */
    private pendingActionIndexesReady = new Set<string>();

    /**
     * Ensured on the write path as well as in the boot manifest, for the same
     * reason as the event indexes: the manifest only covers collections that
     * exist when a tenant DB is first bound. Names/keys are IDENTICAL to it.
     */
    private async ensurePendingActionIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.pendingActionIndexesReady.has(dbName)) return;
      const coll = db.collection(COLLECTIONS.agentPendingActions);
      await Promise.all([
        coll.createIndex({ conversationId: 1, status: 1 }, { name: 'idx_conversation_status' }),
        coll.createIndex({ status: 1, expiresAt: 1 }, { name: 'idx_status_expiresAt' }),
        coll.createIndex({ tenantId: 1, projectId: 1, status: 1 }, { name: 'idx_tenant_project_status' }),
      ]);
      this.pendingActionIndexesReady.add(dbName);
    }

    async createAgentPendingActions(
      actions: Array<Omit<IAgentPendingAction, '_id'>>,
    ): Promise<IAgentPendingAction[]> {
      if (actions.length === 0) return [];
      const db = this.getTenantDb();
      await this.ensurePendingActionIndexes(db).catch(() => undefined);
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

    // ── Message feedback ─────────────────────────────────────────

    private feedbackIndexesReady = new Set<string>();

    /** Same indexes as the boot manifest (which skips collections that do not exist yet); the unique one makes the upsert race-free. */
    private async ensureFeedbackIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.feedbackIndexesReady.has(dbName)) return;
      const coll = db.collection(COLLECTIONS.agentMessageFeedback);
      await Promise.all([
        coll.createIndex({ conversationId: 1, messageId: 1, userId: 1 }, { name: 'idx_message_user', unique: true }),
        coll.createIndex({ projectId: 1, agentKey: 1, createdAt: -1 }, { name: 'idx_agent_createdAt' }),
        coll.createIndex({ portalId: 1, createdAt: -1 }, { name: 'idx_portal_createdAt' }),
      ]);
      this.feedbackIndexesReady.add(dbName);
    }

    private toFeedback(doc: Record<string, unknown>): IAgentMessageFeedback {
      return { ...doc, _id: String(doc._id) } as unknown as IAgentMessageFeedback;
    }

    private feedbackFilter(filter: AgentMessageFeedbackFilter): Record<string, unknown> {
      const query: Record<string, unknown> = { projectId: filter.projectId, agentKey: filter.agentKey };
      if (filter.rating) query.rating = filter.rating;
      if (filter.portalId) query.portalId = filter.portalId;
      if (filter.reason) query.reasons = filter.reason;
      if (filter.hasComment) query.comment = { $exists: true, $nin: [null, ''] };
      if (filter.from || filter.to) {
        query.createdAt = { ...(filter.from ? { $gte: filter.from } : {}), ...(filter.to ? { $lte: filter.to } : {}) };
      }
      return query;
    }

    async upsertAgentMessageFeedback(
      feedback: Omit<IAgentMessageFeedback, '_id' | 'createdAt' | 'updatedAt' | 'removedAt'>,
    ): Promise<{ feedback: IAgentMessageFeedback; created: boolean }> {
      const db = this.getTenantDb();
      await this.ensureFeedbackIndexes(db).catch(() => undefined);
      const now = new Date();
      const { conversationId, messageId, userId } = feedback;
      const set: Record<string, unknown> = {
        tenantId: feedback.tenantId,
        projectId: feedback.projectId,
        agentKey: feedback.agentKey,
        agentVersion: feedback.agentVersion ?? null,
        messageIndex: feedback.messageIndex,
        channel: feedback.channel,
        rating: feedback.rating,
        reasons: feedback.reasons ?? [],
        updatedAt: now,
        removedAt: null,
      };
      const unset: Record<string, ''> = {};
      if (feedback.portalId) set.portalId = feedback.portalId; else unset.portalId = '';
      if (feedback.comment) set.comment = feedback.comment; else unset.comment = '';
      const coll = db.collection(COLLECTIONS.agentMessageFeedback);
      const doc = await coll.findOneAndUpdate(
        { conversationId, messageId, userId },
        {
          $set: set,
          ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
          $setOnInsert: { _id: `fb_${randomUUID().replace(/-/g, '').slice(0, 24)}` as never, createdAt: now },
        },
        { upsert: true, returnDocument: 'after', includeResultMetadata: true },
      );
      const stored = doc.value as Record<string, unknown>;
      return { feedback: this.toFeedback(stored), created: doc.lastErrorObject?.updatedExisting !== true };
    }

    async findAgentMessageFeedback(conversationId: string, messageId: string, userId: string): Promise<IAgentMessageFeedback | null> {
      const doc = await this.getTenantDb().collection(COLLECTIONS.agentMessageFeedback).findOne({ conversationId, messageId, userId });
      return doc ? this.toFeedback(doc) : null;
    }

    async deleteAgentMessageFeedback(conversationId: string, messageId: string, userId: string): Promise<boolean> {
      const result = await this.getTenantDb().collection(COLLECTIONS.agentMessageFeedback).deleteOne({ conversationId, messageId, userId });
      return (result.deletedCount ?? 0) > 0;
    }

    async listAgentMessageFeedbackByConversation(conversationId: string, options?: { userId?: string }): Promise<IAgentMessageFeedback[]> {
      const docs = await this.getTenantDb()
        .collection(COLLECTIONS.agentMessageFeedback)
        .find({ conversationId, ...(options?.userId ? { userId: options.userId } : {}) })
        .sort({ messageIndex: 1, createdAt: 1 })
        .toArray();
      return docs.map((doc) => this.toFeedback(doc));
    }

    async listAgentMessageFeedback(
      filter: AgentMessageFeedbackFilter,
      options?: { limit?: number; skip?: number },
    ): Promise<{ items: IAgentMessageFeedback[]; total: number }> {
      const coll = this.getTenantDb().collection(COLLECTIONS.agentMessageFeedback);
      const query = this.feedbackFilter(filter);
      const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));
      const skip = Math.max(0, options?.skip ?? 0);
      const [total, docs] = await Promise.all([
        coll.countDocuments(query),
        coll.find(query).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
      ]);
      return { items: docs.map((doc) => this.toFeedback(doc)), total };
    }

    async aggregateAgentMessageFeedback(filter: AgentMessageFeedbackFilter): Promise<AgentMessageFeedbackTotals> {
      const coll = this.getTenantDb().collection(COLLECTIONS.agentMessageFeedback);
      const query = this.feedbackFilter(filter);
      const [counts] = await coll.aggregate<{ up: number; down: number; withComment: number }>([
        { $match: query },
        {
          $group: {
            _id: null,
            up: { $sum: { $cond: [{ $eq: ['$rating', 'up'] }, 1, 0] } },
            down: { $sum: { $cond: [{ $eq: ['$rating', 'down'] }, 1, 0] } },
            withComment: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$comment', ''] } }, 0] }, 1, 0] } },
          },
        },
      ]).toArray();
      const reasonRows = await coll.aggregate<{ _id: string; cnt: number }>([
        { $match: query },
        { $unwind: '$reasons' },
        { $group: { _id: '$reasons', cnt: { $sum: 1 } } },
      ]).toArray();
      const reasons: Partial<Record<AgentFeedbackReason, number>> = {};
      for (const row of reasonRows) reasons[row._id as AgentFeedbackReason] = row.cnt;
      return { up: counts?.up ?? 0, down: counts?.down ?? 0, withComment: counts?.withComment ?? 0, reasons };
    }

    async markAgentMessageFeedbackRemoved(conversationId: string, fromIndex: number, at: Date = new Date()): Promise<number> {
      const result = await this.getTenantDb().collection(COLLECTIONS.agentMessageFeedback).updateMany(
        { conversationId, messageIndex: { $gte: fromIndex }, $or: [{ removedAt: null }, { removedAt: { $exists: false } }] },
        { $set: { removedAt: at } },
      );
      return result.modifiedCount;
    }

    async deleteAgentMessageFeedbackByConversation(conversationId: string): Promise<number> {
      const result = await this.getTenantDb().collection(COLLECTIONS.agentMessageFeedback).deleteMany({ conversationId });
      return result.deletedCount ?? 0;
    }
  };
}
