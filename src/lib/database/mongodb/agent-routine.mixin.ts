/**
 * MongoDB Provider – Agent routines mixin
 *
 * A routine is a saved way of starting an agent (prompt + trigger). The
 * scheduler reads due routines tenant-wide (`(enabled, nextFireAt)`), the APIs
 * by agent (`(tenantId, projectId, agentKey)`). Indexes are plain (Cosmos DB's
 * Mongo API rejects partial ones) and ensured on the write path, memoized per
 * tenant DB, like `ensureAgentRunsIndexes`.
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IAgentRoutine } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

type RoutineDoc = Omit<IAgentRoutine, '_id'> & { _id: ObjectId };

function toRoutine(doc: RoutineDoc): IAgentRoutine {
  return { ...doc, _id: doc._id.toString() };
}

/** Null for an id that cannot be an ObjectId (a lookup of it finds nothing). */
function objectIdOrNull(id: string): ObjectId | null {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : null;
}

export function AgentRoutineMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AgentRoutineOps extends Base {
    private agentRoutinesIndexReady = new Set<string>();

    private async ensureAgentRoutinesIndexes(): Promise<void> {
      const db = this.getTenantDb();
      const dbName = db.databaseName;
      if (this.agentRoutinesIndexReady.has(dbName)) return;
      const col = db.collection(COLLECTIONS.agentRoutines);
      let ok = true;
      for (const [keys, name] of [
        [{ tenantId: 1, projectId: 1, agentKey: 1 }, 'idx_tenant_project_agent'],
        [{ enabled: 1, nextFireAt: 1 }, 'idx_enabled_nextFireAt'],
      ] as Array<[Record<string, 1>, string]>) {
        try {
          await col.createIndex(keys, { name });
        } catch (error) {
          ok = false;
          logger.warn('Could not create agent_routines index', { dbName, index: name, error });
        }
      }
      if (ok) this.agentRoutinesIndexReady.add(dbName);
    }

    private agentRoutines() {
      return this.getTenantDb().collection<RoutineDoc>(COLLECTIONS.agentRoutines);
    }

    async createAgentRoutine(record: Omit<IAgentRoutine, '_id' | 'createdAt' | 'updatedAt'>): Promise<IAgentRoutine> {
      await this.ensureAgentRoutinesIndexes();
      const now = new Date();
      const doc: RoutineDoc = { ...record, _id: new ObjectId(), createdAt: now, updatedAt: now };
      await this.agentRoutines().insertOne(doc);
      return toRoutine(doc);
    }

    async getAgentRoutine(id: string, tenantId: string, projectId: string): Promise<IAgentRoutine | null> {
      const _id = objectIdOrNull(id);
      if (!_id) return null;
      const doc = await this.agentRoutines().findOne({ _id, tenantId, projectId });
      return doc ? toRoutine(doc) : null;
    }

    async listAgentRoutines(filter: { tenantId: string; projectId: string; agentKey?: string }): Promise<IAgentRoutine[]> {
      const query: Filter<RoutineDoc> = { tenantId: filter.tenantId, projectId: filter.projectId };
      if (filter.agentKey) query.agentKey = filter.agentKey;
      const docs = await this.agentRoutines().find(query).sort({ createdAt: 1, _id: 1 }).toArray();
      return docs.map(toRoutine);
    }

    async updateAgentRoutine(
      id: string,
      tenantId: string,
      projectId: string,
      patch: Partial<Omit<IAgentRoutine, '_id' | 'tenantId' | 'projectId' | 'agentKey' | 'createdAt' | 'createdBy'>>,
    ): Promise<IAgentRoutine | null> {
      const _id = objectIdOrNull(id);
      if (!_id) return null;
      await this.ensureAgentRoutinesIndexes();
      const set: Record<string, unknown> = { updatedAt: new Date() };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) set[key] = value;
      }
      const doc = await this.agentRoutines().findOneAndUpdate(
        { _id, tenantId, projectId },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc ? toRoutine(doc) : null;
    }

    async deleteAgentRoutine(id: string, tenantId: string, projectId: string): Promise<boolean> {
      const _id = objectIdOrNull(id);
      if (!_id) return false;
      const res = await this.agentRoutines().deleteOne({ _id, tenantId, projectId });
      return res.deletedCount === 1;
    }

    async deleteAgentRoutinesForAgent(tenantId: string, projectId: string, agentKey: string): Promise<number> {
      const res = await this.agentRoutines().deleteMany({ tenantId, projectId, agentKey });
      return res.deletedCount ?? 0;
    }

    async listDueRoutines(now: Date, limit: number): Promise<IAgentRoutine[]> {
      const docs = await this.agentRoutines()
        .find({ enabled: true, nextFireAt: { $ne: null, $lte: now } })
        .sort({ nextFireAt: 1 })
        .limit(Math.max(1, limit))
        .toArray();
      return docs.map(toRoutine);
    }

    async advanceRoutineNextFire(id: string, from: Date, next: Date | null): Promise<boolean> {
      const _id = objectIdOrNull(id);
      if (!_id) return false;
      const res = await this.agentRoutines().updateOne(
        { _id, nextFireAt: from },
        { $set: { nextFireAt: next, updatedAt: new Date() } },
      );
      return res.modifiedCount === 1;
    }

    async setRoutineFireResult(
      id: string,
      result: { fireAt: Date; status: 'started' | 'failed'; runId?: string | null; error?: string | null },
    ): Promise<boolean> {
      const _id = objectIdOrNull(id);
      if (!_id) return false;
      const res = await this.agentRoutines().updateOne(
        // `null` also matches a routine that never fired (no field).
        { _id, $or: [{ lastFireAt: null }, { lastFireAt: { $lte: result.fireAt } }] },
        {
          $set: {
            lastFireAt: result.fireAt,
            lastStatus: result.status,
            // A failed fire started no run: the last run stays the one that did.
            ...(result.status === 'started' ? { lastRunId: result.runId ?? null } : {}),
            lastError: result.status === 'failed' ? result.error ?? null : null,
          },
        },
      );
      return res.matchedCount === 1;
    }
  };
}
