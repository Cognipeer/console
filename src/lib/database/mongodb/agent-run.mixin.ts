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
import { AgentRunConflictError, AgentRunIdempotencyKeyTakenError } from '../provider/errors';
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

const ACTIVE_STATUSES = new Set(['queued', 'running']);
/**
 * A lock whose run row never appeared (crash between the lock insert and the
 * run insert) is reclaimable after this long — far beyond any insert gap.
 */
const ORPHAN_LOCK_GRACE_MS = 60_000;

interface AgentRunLockDoc {
  _id: string;
  runId: string | null;
  kind: 'conversation' | 'idempotency';
  createdAt: Date;
  /** Idempotency locks live as long as the run row they point to. */
  expiresAt?: Date | null;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === DUPLICATE_KEY_ERROR_CODE;
}

const conversationLockId = (conversationId: string) => `conv:${conversationId}`;
const idempotencyLockId = (tenantId: string, projectId: string, key: string) => `idem:${tenantId}:${projectId}:${key}`;

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
      const col = db.collection(COLLECTIONS.agentRuns);
      // Each index on its own: one the backend rejects must not take the
      // others down with it. The partial unique index is a belt on top of the
      // lock documents below — Cosmos DB (Mongo API) rejects partial indexes,
      // and the one-active-run guarantee must not depend on it.
      const specs: Array<[Record<string, 1 | -1>, Record<string, unknown>, boolean]> = [
        [{ conversationId: 1 }, {
          name: 'idx_agent_runs_active_per_conversation',
          unique: true,
          partialFilterExpression: { status: { $in: ['queued', 'running'] } },
        }, false],
        [{ status: 1, heartbeatAt: 1 }, { name: 'idx_status_heartbeat' }, true],
        [{ status: 1, createdAt: 1 }, { name: 'idx_status_createdAt' }, true],
        [{ expiresAt: 1 }, { name: 'idx_expiresAt' }, true],
        [{ tenantId: 1, projectId: 1, idempotencyKey: 1 }, { name: 'idx_tenant_project_idempotencyKey' }, true],
        [{ tenantId: 1, projectId: 1, agentKey: 1, createdAt: -1 }, { name: 'idx_tenant_project_agent_createdAt' }, true],
      ];
      let requiredOk = true;
      for (const [keys, options, required] of specs) {
        try {
          await col.createIndex(keys, options);
        } catch (error) {
          if (required) requiredOk = false;
          logger.warn('Could not create agent_runs index', { dbName, index: options.name, required, error });
        }
      }
      try {
        await db.collection(COLLECTIONS.agentRunLocks).createIndex({ expiresAt: 1 }, { name: 'idx_expiresAt' });
      } catch (error) {
        logger.warn('Could not create agent_run_locks index', { dbName, error });
      }
      // Only remembered once the indexes the queries rely on exist, so a
      // transient failure is retried on the next write instead of never.
      if (requiredOk) this.agentRunsIndexReady.add(dbName);
    }

    /**
     * Take a lock document keyed by `_id`. `_id` uniqueness is the one
     * uniqueness guarantee every Mongo-compatible backend we run on honours
     * (Cosmos included), which is why the single-active-run and idempotency
     * guarantees live here rather than in a partial unique index.
     *
     * A conversation lock whose run is already terminal (or never got
     * inserted) is stale — reclaimed with a CAS on the old holder.
     */
    private async acquireAgentRunLock(lockId: string, kind: AgentRunLockDoc['kind'], expiresAt?: Date | null): Promise<boolean> {
      const locks = this.getTenantDb().collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks);
      const doc: AgentRunLockDoc = { _id: lockId, runId: null, kind, createdAt: new Date(), expiresAt: expiresAt ?? null };
      try {
        await locks.insertOne(doc);
        return true;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      if (kind !== 'conversation') return false;
      const held = await locks.findOne({ _id: lockId });
      if (!held) return this.acquireAgentRunLock(lockId, kind, expiresAt);
      let stale = false;
      if (!held.runId) {
        stale = Date.now() - new Date(held.createdAt).getTime() > ORPHAN_LOCK_GRACE_MS;
      } else {
        let holder: IAgentRun | null = null;
        try {
          holder = await this.getTenantDb().collection<IAgentRun>(COLLECTIONS.agentRuns)
            .findOne({ _id: objectId(held.runId) } as never) as IAgentRun | null;
        } catch {
          holder = null;
        }
        stale = !holder || !ACTIVE_STATUSES.has(holder.status);
      }
      if (!stale) return false;
      const reclaimed = await locks.findOneAndUpdate(
        { _id: lockId, runId: held.runId, createdAt: held.createdAt },
        { $set: { runId: null, createdAt: new Date(), expiresAt: expiresAt ?? null } },
        { returnDocument: 'after' },
      );
      return Boolean(reclaimed);
    }

    private async bindAgentRunLock(lockId: string, runId: string): Promise<void> {
      await this.getTenantDb().collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks)
        .updateOne({ _id: lockId, runId: null }, { $set: { runId } });
    }

    /** Releases the conversation lock only if THIS run still holds it. */
    private async releaseConversationLock(conversationId: string | undefined, runId: string): Promise<void> {
      if (!conversationId) return;
      await this.getTenantDb().collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks)
        .deleteOne({ _id: conversationLockId(conversationId), runId })
        .catch((error) => logger.warn('Could not release agent run conversation lock', { conversationId, runId, error }));
    }

    async createAgentRun(
      record: Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentRun> {
      const db = this.getTenantDb();
      await this.ensureAgentRunsIndexes();
      const active = ACTIVE_STATUSES.has(record.status);
      const convLock = active ? conversationLockId(record.conversationId) : null;
      const idemLock = record.idempotencyKey
        ? idempotencyLockId(record.tenantId, record.projectId, record.idempotencyKey)
        : null;

      if (idemLock && !(await this.acquireAgentRunLock(idemLock, 'idempotency', record.expiresAt ?? null))) {
        throw new AgentRunIdempotencyKeyTakenError(record.idempotencyKey!);
      }
      if (convLock && !(await this.acquireAgentRunLock(convLock, 'conversation'))) {
        if (idemLock) await db.collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks).deleteOne({ _id: idemLock, runId: null });
        throw new AgentRunConflictError(record.conversationId);
      }

      const now = new Date();
      const doc: Omit<IAgentRun, '_id'> = { ...record, createdAt: now, updatedAt: now };
      try {
        const result = await db
          .collection<IAgentRun>(COLLECTIONS.agentRuns)
          .insertOne(doc as unknown as IAgentRun);
        const runId = result.insertedId.toString();
        if (convLock) await this.bindAgentRunLock(convLock, runId);
        if (idemLock) await this.bindAgentRunLock(idemLock, runId);
        return { ...doc, _id: runId };
      } catch (error) {
        const locks = db.collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks);
        if (convLock) await locks.deleteOne({ _id: convLock, runId: null }).catch(() => undefined);
        if (idemLock) await locks.deleteOne({ _id: idemLock, runId: null }).catch(() => undefined);
        if (isDuplicateKey(error)) {
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
        await this.releaseConversationLock(queuedResult.conversationId, id);
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
      if (!ACTIVE_STATUSES.has(result.status)) await this.releaseConversationLock(result.conversationId, id);
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
        .findOne({ tenantId, projectId, idempotencyKey }, { sort: { createdAt: -1 } });
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

    async listQueuedAgentRuns(
      tenantId: string,
      options?: { createdBefore?: Date; limit?: number },
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId, status: 'queued' };
      if (options?.createdBefore) query.createdAt = { $lt: options.createdBefore };
      const cursor = db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .find(query)
        .sort({ createdAt: 1 });
      if (options?.limit && options.limit > 0) cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IAgentRun);
    }

    async listAgentRuns(filter: {
      tenantId: string;
      projectId: string;
      agentKey?: string;
      conversationId?: string;
      status?: IAgentRun['status'][];
      mode?: IAgentRun['mode'];
      limit?: number;
    }): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId: filter.tenantId, projectId: filter.projectId };
      if (filter.agentKey) query.agentKey = filter.agentKey;
      if (filter.conversationId) query.conversationId = filter.conversationId;
      if (filter.status && filter.status.length > 0) query.status = { $in: filter.status };
      if (filter.mode) query.mode = filter.mode;
      const docs = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .find(query)
        .sort({ createdAt: -1 })
        .limit(Math.min(Math.max(filter.limit ?? 50, 1), 500))
        .toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IAgentRun);
    }

    async deleteAgentRun(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const existing = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOneAndDelete({ _id: objectId(id) });
      if (!existing) return false;
      await this.releaseConversationLock(existing.conversationId, id);
      return true;
    }

    async countActiveAgentRuns(tenantId: string, projectId?: string, mode?: IAgentRun['mode']): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {
        tenantId,
        status: { $in: ['queued', 'running'] },
      };
      if (projectId) query.projectId = projectId;
      if (mode) query.mode = mode;
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
        // A queued/running row is never retention's to delete, whatever its
        // expiresAt says (AGENT_RUN_RETENTION_DAYS=0 would otherwise delete a
        // run right after it is created).
        status: { $nin: ['queued', 'running'] },
      };
      if (options.projectId) query.projectId = options.projectId;
      await db.collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks)
        .deleteMany({ kind: 'idempotency', expiresAt: { $lt: options.olderThan } })
        .catch(() => undefined);
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
