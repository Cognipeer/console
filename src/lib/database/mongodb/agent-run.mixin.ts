/**
 * MongoDB Provider – Agent Runs mixin (background execution)
 *
 * See docs/guide/agent-background-execution.md §6/§7/§12 for the full design.
 * Deliberately mirrors ICrawlJob's CAS patterns (claim/finalize via
 * `findOneAndUpdate` with a status filter) but diverges on crash recovery:
 * an orphaned agent run is failed, never silently reset and re-run, because
 * agent turns can carry irreversible tool side effects that crawl jobs do not.
 */

import { ObjectId, MongoServerError } from 'mongodb';
import type { IAgentRun } from '../provider.interface';
import { AgentRunConflictError } from '../provider/errors';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

function toId(value: ObjectId | string | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString();
}

function objectId(id: string): ObjectId {
  return new ObjectId(id);
}

/** Mongo's duplicate-key error code, shared across every unique index violation. */
const DUPLICATE_KEY_ERROR_CODE = 11000;

export function AgentRunMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AgentRunOps extends Base {
    /**
     * Per-process memoized index guarantee, mirroring `usage.mixin.ts`'s
     * `ensureUsageDailyIndexes`: `indexManifest.ts`'s `TENANT_DB_INDEXES` is
     * "existence-guarded" (only applies to collections that already exist,
     * so a tenant that has never used a feature doesn't get an empty
     * collection). That is fine for a plain performance index, but the
     * `conversationId` partial unique index here is a correctness guarantee
     * (§12.14) that must exist before the very first `createAgentRun` call
     * for a brand-new tenant — which is exactly the call that would
     * otherwise create the collection for the first time. Ensuring it here,
     * on the write path itself, closes that gap regardless of manifest
     * timing.
     */
    private agentRunsIndexReady = new Set<string>();

    private async ensureAgentRunsIndexes(): Promise<void> {
      const db = this.getTenantDb();
      const dbName = db.databaseName;
      if (this.agentRunsIndexReady.has(dbName)) return;
      this.agentRunsIndexReady.add(dbName);
      try {
        const col = db.collection(COLLECTIONS.agentRuns);
        await col.createIndex(
          { conversationId: 1 },
          {
            name: 'idx_agent_runs_active_per_conversation',
            unique: true,
            partialFilterExpression: { status: { $in: ['queued', 'running'] } },
          },
        );
        await col.createIndex({ status: 1, heartbeatAt: 1 }, { name: 'idx_status_heartbeat' });
        await col.createIndex({ expiresAt: 1 }, { name: 'idx_expiresAt' });
        await col.createIndex(
          { tenantId: 1, projectId: 1, idempotencyKey: 1 },
          { name: 'idx_tenant_project_idempotencyKey' },
        );
      } catch (error) {
        // Non-fatal, mirroring `ensureUsageDailyIndexes`: a connection race
        // or a pre-existing conflicting index (same name, different key)
        // must never wedge a request. `createIndex` is idempotent for an
        // identical spec, so this is retried lazily via `indexManifest.ts`'s
        // periodic tenant-DB sweep even if this particular attempt failed.
        logger.warn('Could not ensure agent_runs indexes', { dbName, error });
      }
    }

    async createAgentRun(
      record: Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentRun> {
      const db = this.getTenantDb();
      await this.ensureAgentRunsIndexes();
      const now = new Date();
      const doc: Omit<IAgentRun, '_id'> = { ...record, createdAt: now, updatedAt: now };
      try {
        const result = await db
          .collection<IAgentRun>(COLLECTIONS.agentRuns)
          .insertOne(doc as unknown as IAgentRun);
        return { ...doc, _id: result.insertedId.toString() };
      } catch (error) {
        if (error instanceof MongoServerError && error.code === DUPLICATE_KEY_ERROR_CODE) {
          throw new AgentRunConflictError(record.conversationId);
        }
        throw error;
      }
    }

    async claimAgentRun(
      id: string,
      tenantId: string,
      workerId: string,
      startedAt: Date,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOneAndUpdate(
          { _id: objectId(id), tenantId, status: 'queued' },
          {
            $set: {
              status: 'running',
              workerId,
              startedAt,
              heartbeatAt: startedAt,
              updatedAt: new Date(),
            },
          },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IAgentRun;
    }

    async updateAgentRunHeartbeat(
      id: string,
      workerId: string,
      heartbeatAt: Date,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOneAndUpdate(
          { _id: objectId(id), workerId, status: 'running' },
          { $set: { heartbeatAt, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IAgentRun;
    }

    async requestAgentRunCancel(
      id: string,
      tenantId: string,
      projectId: string,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const now = new Date();
      // Fast path: run hasn't started yet, cancel it outright.
      const queuedResult = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOneAndUpdate(
          {
            _id: objectId(id),
            tenantId,
            projectId,
            status: 'queued',
          },
          {
            $set: {
              status: 'canceled',
              errorReason: 'canceled_by_caller',
              completedAt: now,
              updatedAt: now,
            },
          },
          { returnDocument: 'after' },
        );
      if (queuedResult) {
        return { ...queuedResult, _id: toId(queuedResult._id) } as IAgentRun;
      }
      // Already running (possibly on another node) — stamp the request so
      // the owning worker observes it on its next heartbeat-cadence poll.
      const runningResult = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOneAndUpdate(
          {
            _id: objectId(id),
            tenantId,
            projectId,
            status: 'running',
          },
          { $set: { cancelRequestedAt: now, updatedAt: now } },
          { returnDocument: 'after' },
        );
      if (!runningResult) return null;
      return { ...runningResult, _id: toId(runningResult._id) } as IAgentRun;
    }

    async finalizeAgentRun(
      id: string,
      tenantId: string,
      data: Partial<Omit<IAgentRun, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const payload: Partial<IAgentRun> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOneAndUpdate(
          { _id: objectId(id), tenantId, status: 'running' },
          { $set: payload },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IAgentRun;
    }

    async updateAgentRunCallback(
      id: string,
      tenantId: string,
      data: { callbackStatus: NonNullable<IAgentRun['callbackStatus']>; callbackAttempts: number },
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOneAndUpdate(
          { _id: objectId(id), tenantId },
          {
            $set: {
              callbackStatus: data.callbackStatus,
              callbackAttempts: data.callbackAttempts,
              updatedAt: new Date(),
            },
          },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IAgentRun;
    }

    async getAgentRunById(
      id: string,
      tenantId: string,
      projectId: string,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IAgentRun>(COLLECTIONS.agentRuns)
          .findOne({ _id: objectId(id), tenantId, projectId });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as IAgentRun;
      } catch {
        return null;
      }
    }

    async getAgentRunByIdempotencyKey(
      tenantId: string,
      projectId: string,
      idempotencyKey: string,
    ): Promise<IAgentRun | null> {
      const db = this.getTenantDb();
      const record = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOne({ tenantId, projectId, idempotencyKey });
      if (!record) return null;
      return { ...record, _id: toId(record._id) } as IAgentRun;
    }

    async listStaleAgentRuns(
      tenantId: string,
      heartbeatBefore: Date,
      limit?: number,
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const cursor = db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .find({
          tenantId,
          status: 'running',
          $or: [
            { heartbeatAt: { $lt: heartbeatBefore } },
            { heartbeatAt: null },
            { heartbeatAt: { $exists: false } },
          ],
        })
        .sort({ heartbeatAt: 1 });
      if (limit && limit > 0) cursor.limit(limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IAgentRun);
    }

    async listQueuedAgentRuns(tenantId: string): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .find({ tenantId, status: 'queued' })
        .sort({ createdAt: 1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IAgentRun);
    }

    async deleteAgentRun(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .deleteOne({ _id: objectId(id) });
      return result.deletedCount > 0;
    }

    async countActiveAgentRuns(tenantId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {
        tenantId,
        status: { $in: ['queued', 'running'] },
      };
      if (projectId) query.projectId = projectId;
      return db.collection<IAgentRun>(COLLECTIONS.agentRuns).countDocuments(query);
    }

    async cleanupAgentRunRetention(options: {
      projectId?: string;
      olderThan: Date;
      batchSize?: number;
    }): Promise<{ deletedCount: number }> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {
        expiresAt: { $lt: options.olderThan },
      };
      if (options.projectId) query.projectId = options.projectId;
      if (options.batchSize && options.batchSize > 0) {
        const ids = await db
          .collection<IAgentRun>(COLLECTIONS.agentRuns)
          .find(query)
          .project({ _id: 1 })
          .limit(options.batchSize)
          .toArray();
        if (ids.length === 0) return { deletedCount: 0 };
        const result = await db
          .collection<IAgentRun>(COLLECTIONS.agentRuns)
          .deleteMany({ _id: { $in: ids.map((d) => d._id) } });
        return { deletedCount: result.deletedCount ?? 0 };
      }
      const result = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .deleteMany(query);
      return { deletedCount: result.deletedCount ?? 0 };
    }
  };
}
