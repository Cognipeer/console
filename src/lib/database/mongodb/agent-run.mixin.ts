/**
 * MongoDB Provider – Agent Runs mixin (background execution)
 *
 * See docs/guide/agent-background-execution.md §6/§7/§12 for the full design.
 * Deliberately mirrors ICrawlJob's CAS patterns (claim/finalize via
 * `findOneAndUpdate` with a status filter) but diverges on crash recovery:
 * an orphaned agent run is failed, never silently reset and re-run, because
 * agent turns can carry irreversible tool side effects that crawl jobs do not.
 */

import type { Filter } from 'mongodb';
import type { AgentRunCheckpointWrite, AgentRunClass, AgentRunExecutionGuard, IAgentRun, IAgentRunCheckpoint } from '../provider.interface';
import { AgentRunConflictError, AgentRunIdempotencyKeyTakenError } from '../provider/errors';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';
import { ensureTenantCollectionsIndexes } from './indexManifest';
import { toIdString, toObjectIdOrThrow } from './docIds';
import { isDuplicateKeyError } from './errors';

const toId = toIdString;
const objectId = toObjectIdOrThrow;

const toRun = (doc: IAgentRun): IAgentRun => ({ ...doc, _id: toId(doc._id) });

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

const isDuplicateKey = isDuplicateKeyError;

/** A row written before generations existed counts as generation 1 (`not > 1` also matches a missing field). */
const executionFilter = (guard?: AgentRunExecutionGuard): Filter<IAgentRun> => {
  if (guard?.generation === undefined) return {};
  return { queueGeneration: guard.generation === 1 ? { $not: { $gt: 1 } } : guard.generation };
};

/**
 * A durable run's checkpoint, as stored: one small document per run naming the
 * segments that make it up (in order), and one insert-only document per write
 * holding that write's chunks. A write costs an insert of its own delta and a
 * small update, never a rewrite of everything written before.
 */
interface CheckpointRunDoc {
  _id: string;
  tenantId: string;
  conversationId: string;
  generation: number;
  segments: number[];
  schema: number;
  messageCount: number;
  toolHistoryCount: number;
  sizeBytes: number;
  sealed?: 'too_large' | null;
  createdAt?: Date;
  updatedAt?: Date;
  expiresAt: Date;
}

interface CheckpointSegmentDoc {
  /** `<runId>:<generation>:<seq>`: a run's segments are one _id range. */
  _id: string;
  tenantId: string;
  head?: string;
  messageChunks: string[];
  toolHistoryChunks: string[];
  expiresAt: Date;
}

const checkpointSegmentId = (runId: string, generation: number, seq: number) => `${runId}:${generation}:${seq}`;
/** Every segment of a run: ids start with `<runId>:`, and `;` sorts right after `:`. */
const checkpointSegmentRange = (runId: string) => ({ $gt: `${runId}:`, $lt: `${runId};` });

let checkpointSeqFallback = 0;
/** For a write that names no sequence number: unique within this process. */
const nextCheckpointSeq = () => Date.now() * 1000 + (checkpointSeqFallback++ % 1000);

const checkpointFields = (run: CheckpointRunDoc): Omit<IAgentRunCheckpoint, 'head' | 'messageChunks' | 'toolHistoryChunks'> => ({
  _id: run._id,
  runId: run._id,
  tenantId: run.tenantId,
  conversationId: run.conversationId,
  generation: run.generation,
  schema: run.schema,
  messageCount: run.messageCount,
  toolHistoryCount: run.toolHistoryCount,
  sizeBytes: run.sizeBytes,
  sealed: run.sealed ?? null,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  expiresAt: run.expiresAt,
});

type IAgentRunListFn = (filter: {
  tenantId: string;
  projectId: string;
  agentKey?: string;
  conversationId?: string;
  status?: IAgentRun['status'][];
  mode?: IAgentRun['mode'] | IAgentRun['mode'][];
  excludeModes?: IAgentRun['mode'][];
  runClass?: AgentRunClass;
  triggerId?: string;
  channel?: NonNullable<IAgentRun['channel']>;
  trigger?: NonNullable<IAgentRun['trigger']>;
  metadata?: Record<string, string>;
  createdAfter?: Date;
  createdBefore?: Date;
  cursor?: string;
  userId?: string;
  excludeAgentKeys?: string[];
  limit?: number;
}) => Promise<IAgentRun[]>;

/** `default` also matches rows with no class (every row from before run classes). */
const runClassFilter = (runClass: AgentRunClass): Record<string, unknown> =>
  runClass === 'default' ? { runClass: { $in: ['default', null] } } : { runClass };

/**
 * `metadata.<key> = value`. A key with a dot would be read as a nested path, so
 * those go through `$getField` (MongoDB 5.0+).
 */
const metadataFilter = (key: string, value: string): Record<string, unknown> =>
  key.includes('.')
    ? { $expr: { $eq: [{ $getField: { field: { $literal: key }, input: '$metadata' } }, value] } }
    : { [`metadata.${key}`]: value };

const conversationLockId = (conversationId: string) => `conv:${conversationId}`;
const idempotencyLockId = (tenantId: string, projectId: string, key: string) => `idem:${tenantId}:${projectId}:${key}`;

export function AgentRunMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AgentRunOps extends Base {
    /**
     * The `conversationId` partial unique index is a correctness guarantee
     * (§12.14) that must exist before the very first `createAgentRun` of a
     * brand-new tenant, which is exactly the call that creates the collection;
     * the boot pass is existence-guarded, so the write path ensures the
     * manifest's indexes itself (memoised per tenant database).
     */
    private async ensureAgentRunsIndexes(): Promise<void> {
      await ensureTenantCollectionsIndexes(this.getTenantDb(), [COLLECTIONS.agentRuns, COLLECTIONS.agentRunLocks]);
    }


    /**
     * Take a lock document keyed by `_id`. `_id` uniqueness is the one
     * uniqueness guarantee every Mongo-compatible backend we run on honours
     * (Cosmos included), which is why the single-active-run and idempotency
     * guarantees live here rather than in a partial unique index.
     *
     * A conversation lock whose run is already terminal (or never got
     * inserted) is stale — reclaimed with a CAS on the old holder. An
     * idempotency lock is reclaimed only when its run never got inserted (a
     * crash between the two inserts): one bound to a run lives as long as it.
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
      const held = await locks.findOne({ _id: lockId });
      if (!held) return this.acquireAgentRunLock(lockId, kind, expiresAt);
      let stale = false;
      if (!held.runId) {
        stale = Date.now() - new Date(held.createdAt).getTime() > ORPHAN_LOCK_GRACE_MS;
      } else if (kind === 'conversation') {
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
      // An empty list is stored as none, like the SQLite provider does.
      const doc: Omit<IAgentRun, '_id'> = {
        ...record,
        attachments: record.attachments?.length ? record.attachments : null,
        queueGeneration: record.queueGeneration ?? 1,
        createdAt: now,
        updatedAt: now,
      };
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

    private agentRunsCollection() {
      return this.getTenantDb().collection<IAgentRun>(COLLECTIONS.agentRuns);
    }

    /** findOneAndUpdate($set) → the updated run, or null when the filter (a CAS guard) matched nothing. */
    private async setAgentRun(filter: Filter<IAgentRun>, set: Partial<IAgentRun>): Promise<IAgentRun | null> {
      const doc = await this.agentRunsCollection().findOneAndUpdate(filter, { $set: set }, { returnDocument: 'after' });
      return doc ? toRun(doc) : null;
    }

    async claimAgentRun(
      id: string,
      tenantId: string,
      workerId: string,
      startedAt: Date,
      options?: { durable?: boolean },
    ): Promise<IAgentRun | null> {
      return this.setAgentRun(
        { _id: objectId(id), tenantId, status: 'queued' },
        { status: 'running', workerId, startedAt, heartbeatAt: startedAt, durable: options?.durable === true, updatedAt: new Date() },
      );
    }

    async updateAgentRunHeartbeat(
      id: string,
      workerId: string,
      heartbeatAt: Date,
      guard?: AgentRunExecutionGuard,
    ): Promise<IAgentRun | null> {
      return this.setAgentRun(
        { _id: objectId(id), workerId, status: 'running', ...executionFilter(guard) },
        { heartbeatAt, updatedAt: new Date() },
      );
    }

    async requestAgentRunCancel(
      id: string,
      tenantId: string,
      projectId: string,
    ): Promise<IAgentRun | null> {
      const now = new Date();
      const scope = { _id: objectId(id), tenantId, projectId };
      // Fast path: run hasn't started yet (queued, or scheduled for later),
      // cancel it outright. A scheduled row holds no slot; the release below is
      // a no-op for it (it only deletes a lock this run holds).
      const canceled = await this.setAgentRun(
        { ...scope, status: { $in: ['queued', 'scheduled'] } },
        { status: 'canceled', errorReason: 'canceled_by_caller', completedAt: now, updatedAt: now },
      );
      if (canceled) {
        await this.releaseConversationLock(canceled.conversationId, id);
        return canceled;
      }
      // Already running (possibly on another node) — stamp the request so
      // the owning worker observes it on its next heartbeat-cadence poll.
      return this.setAgentRun({ ...scope, status: 'running' }, { cancelRequestedAt: now, updatedAt: now });
    }

    async finalizeAgentRun(
      id: string,
      tenantId: string,
      data: Partial<Omit<IAgentRun, '_id' | 'tenantId' | 'createdAt'>>,
      guard?: AgentRunExecutionGuard,
    ): Promise<IAgentRun | null> {
      // A paused (`requires_action`) run can be finalized too: cancelled, or
      // settled by a continuation that ran inline.
      const run = await this.setAgentRun(
        { _id: objectId(id), tenantId, status: { $in: ['running', 'requires_action'] }, ...executionFilter(guard) },
        { ...data, updatedAt: new Date() },
      );
      if (run && !ACTIVE_STATUSES.has(run.status)) await this.releaseConversationLock(run.conversationId, id);
      if (run && data.expiresAt) await this.extendIdempotencyLock(run, data.expiresAt);
      return run;
    }

    /** The idempotency lock lives as long as its run row: a new retention cutoff moves both. */
    private async extendIdempotencyLock(run: IAgentRun, expiresAt: Date): Promise<void> {
      if (!run.idempotencyKey) return;
      await this.getTenantDb().collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks)
        .updateOne(
          { _id: idempotencyLockId(run.tenantId, run.projectId, run.idempotencyKey), runId: String(run._id) },
          { $set: { expiresAt } },
        )
        .catch((error) => logger.warn('Could not move the agent run idempotency lock expiry', { runId: run._id, error }));
    }

    async requeueAgentRunForResume(
      id: string,
      tenantId: string,
      resumeActionIds: string[],
      continuation?: { trigger: 'resume' | 'timeout'; userId?: string | null; apiTokenId?: string | null },
    ): Promise<IAgentRun | null> {
      const paused = await this.agentRunsCollection().findOne({ _id: objectId(id), tenantId, status: 'requires_action' });
      if (!paused) return null;
      await this.ensureAgentRunsIndexes();
      // The slot is taken again before the row goes back to `queued`.
      const lockId = conversationLockId(paused.conversationId);
      if (!(await this.acquireAgentRunLock(lockId, 'conversation'))) throw new AgentRunConflictError(paused.conversationId);
      const run = await this.setAgentRun(
        { _id: objectId(id), tenantId, status: 'requires_action' },
        {
          status: 'queued',
          // A resume is a new execution (its job dedup key differs) and the
          // moment the run became due again (a deferred run's wait restarts).
          queueGeneration: (paused.queueGeneration ?? 1) + 1,
          notBefore: new Date(),
          resumeActionIds,
          resumeTrigger: continuation?.trigger ?? null,
          resumeUserId: continuation?.userId ?? null,
          resumeApiTokenId: continuation?.apiTokenId ?? null,
          stopReason: null,
          result: null,
          errorReason: null,
          errorMessage: null,
          workerId: null,
          cancelRequestedAt: null,
          completedAt: null,
          // A new turn: not a recovery of the one before.
          lastRecoveredAt: null,
          lastRecoveryReason: null,
          recoveryDeadlineAt: null,
          updatedAt: new Date(),
        },
      );
      if (!run) {
        await this.getTenantDb().collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks)
          .deleteOne({ _id: lockId, runId: null }).catch(() => undefined);
        return null;
      }
      await this.bindAgentRunLock(lockId, id);
      return run;
    }

    async requeueAgentRunForRecovery(
      id: string,
      tenantId: string,
      guard: { fromWorkerId?: string; staleBefore?: Date },
      recovery: { reason: 'handoff' | 'orphaned'; deadlineAt: Date },
    ): Promise<IAgentRun | null> {
      const { reason } = recovery;
      const filter: Filter<IAgentRun> = { _id: objectId(id), tenantId, status: 'running' };
      if (guard.fromWorkerId !== undefined) filter.workerId = guard.fromWorkerId;
      if (guard.staleBefore) filter.heartbeatAt = { $lt: guard.staleBefore };
      const now = new Date();
      // The row stays active (queued), so it keeps the conversation's lock.
      const doc = await this.agentRunsCollection().findOneAndUpdate(
        filter,
        {
          $set: {
            status: 'queued',
            workerId: null,
            notBefore: now,
            lastRecoveredAt: now,
            lastRecoveryReason: reason,
            recoveryDeadlineAt: recovery.deadlineAt,
            updatedAt: now,
          },
          // Only an orphan counts toward the limit: a run that keeps killing its node.
          $inc: { queueGeneration: 1, ...(reason === 'orphaned' ? { recoveryCount: 1 } : {}) },
        },
        { returnDocument: 'after' },
      );
      return doc ? toRun(doc) : null;
    }

    async writeAgentRunCheckpoint(write: AgentRunCheckpointWrite): Promise<boolean> {
      // Stored as a small run document plus one insert-only segment per write (see
      // CheckpointRunDoc). A document store rewrites a whole document on every update,
      // so appending to one growing document would cost the full checkpoint per write.
      const runs = this.getTenantDb().collection<CheckpointRunDoc>(COLLECTIONS.agentRunCheckpoints);
      const segments = this.getTenantDb().collection<CheckpointSegmentDoc>(COLLECTIONS.agentRunCheckpointSegments);
      const now = new Date();
      const seq = write.seq ?? nextCheckpointSeq();
      const segmentId = checkpointSegmentId(write.runId, write.generation, seq);
      if (write.mode === 'reset') {
        await ensureTenantCollectionsIndexes(this.getTenantDb(), [
          COLLECTIONS.agentRunCheckpoints,
          COLLECTIONS.agentRunCheckpointSegments,
        ]);
      }
      // The segment first: the run document only ever names segments that exist.
      await segments.insertOne({
        _id: segmentId,
        tenantId: write.tenantId,
        ...(write.head !== undefined ? { head: write.head } : {}),
        messageChunks: write.messageChunks,
        toolHistoryChunks: write.toolHistoryChunks,
        expiresAt: write.expiresAt,
      });
      const common = {
        messageCount: write.messageCount,
        toolHistoryCount: write.toolHistoryCount,
        sizeBytes: write.sizeBytes,
        schema: write.schema,
        sealed: write.sealed ?? null,
        updatedAt: now,
        expiresAt: write.expiresAt,
      };
      if (write.mode === 'append') {
        // Only onto this execution's own checkpoint: an older or newer generation's is not ours to extend.
        const result = await runs.updateOne(
          { _id: write.runId, tenantId: write.tenantId, generation: write.generation },
          { $set: common, $push: { segments: seq } },
        );
        if (result.matchedCount === 1) return true;
        await segments.deleteOne({ _id: segmentId }).catch(() => undefined);
        return false;
      }
      try {
        // A newer execution's checkpoint does not match the filter; the upsert then collides on _id.
        await runs.updateOne(
          { _id: write.runId, tenantId: write.tenantId, generation: { $lte: write.generation } },
          {
            $set: { ...common, conversationId: write.conversationId, generation: write.generation, segments: [seq] },
            $setOnInsert: { tenantId: write.tenantId, createdAt: now },
          },
          { upsert: true },
        );
      } catch (error) {
        await segments.deleteOne({ _id: segmentId }).catch(() => undefined);
        if (isDuplicateKeyError(error)) return false;
        throw error;
      }
      // The segments a reset replaced are not read any more.
      await segments
        .deleteMany({ _id: { ...checkpointSegmentRange(write.runId), $ne: segmentId } })
        .catch(() => undefined);
      return true;
    }

    async findAgentRunCheckpoint(runId: string, tenantId: string): Promise<IAgentRunCheckpoint | null> {
      const run = await this.getTenantDb()
        .collection<CheckpointRunDoc>(COLLECTIONS.agentRunCheckpoints)
        .findOne({ _id: runId, tenantId });
      if (!run) return null;
      const ids = (run.segments ?? []).map((seq) => checkpointSegmentId(runId, run.generation, seq));
      const found = ids.length === 0 ? [] : await this.getTenantDb()
        .collection<CheckpointSegmentDoc>(COLLECTIONS.agentRunCheckpointSegments)
        .find({ _id: { $in: ids } })
        .toArray();
      const byId = new Map(found.map((segment) => [segment._id, segment]));
      let head: string | undefined;
      const messageChunks: string[] = [];
      const toolHistoryChunks: string[] = [];
      for (const id of ids) {
        const segment = byId.get(id);
        // A named segment that is gone: the checkpoint cannot be put back together (reads as unreadable).
        if (!segment) return { ...checkpointFields(run), head: '', messageChunks: [], toolHistoryChunks: [] };
        if (segment.head !== undefined) head = segment.head;
        messageChunks.push(...segment.messageChunks);
        toolHistoryChunks.push(...segment.toolHistoryChunks);
      }
      return { ...checkpointFields(run), head: head ?? '', messageChunks, toolHistoryChunks };
    }

    async deleteAgentRunCheckpoint(runId: string, tenantId: string): Promise<void> {
      await this.getTenantDb()
        .collection<CheckpointRunDoc>(COLLECTIONS.agentRunCheckpoints)
        .deleteOne({ _id: runId, tenantId });
      await this.getTenantDb()
        .collection<CheckpointSegmentDoc>(COLLECTIONS.agentRunCheckpointSegments)
        .deleteMany({ _id: checkpointSegmentRange(runId), tenantId });
    }

    async updateAgentRunCallback(
      id: string,
      tenantId: string,
      data: { callbackStatus: NonNullable<IAgentRun['callbackStatus']>; callbackAttempts: number; callbackEventId?: string | null },
      options?: { onlyIfEventId?: string },
    ): Promise<IAgentRun | null> {
      const filter: Filter<IAgentRun> = { _id: objectId(id), tenantId };
      if (options?.onlyIfEventId !== undefined) {
        (filter as Record<string, unknown>).callbackEventId = { $in: [options.onlyIfEventId, null] };
      }
      return this.setAgentRun(filter, {
        callbackStatus: data.callbackStatus,
        callbackAttempts: data.callbackAttempts,
        ...(data.callbackEventId !== undefined ? { callbackEventId: data.callbackEventId } : {}),
        updatedAt: new Date(),
      });
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
        return record ? toRun(record) : null;
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
      return record ? toRun(record) : null;
    }

    async listStaleAgentRuns(
      tenantId: string,
      heartbeatBefore: Date,
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const docs = await db
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
        .sort({ heartbeatAt: 1 })
        .toArray();
      return docs.map(toRun);
    }

    async listQueuedAgentRuns(
      tenantId: string,
      options?: { createdBefore?: Date; limit?: number },
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      // Deferred rows are published by their dispatcher, never by the requeue sweep.
      const query: Record<string, unknown> = { tenantId, status: 'queued', runClass: { $ne: 'deferred' } };
      if (options?.createdBefore) query.createdAt = { $lt: options.createdBefore };
      const cursor = db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .find(query)
        .sort({ createdAt: 1 });
      if (options?.limit && options.limit > 0) cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs.map(toRun);
    }

    async listAgentRunsWithUndeliveredCallbacks(
      tenantId: string,
      options: { updatedBefore: Date; maxAttempts: number; limit?: number },
    ): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .find({
          tenantId,
          callbackUrl: { $nin: [null, ''] },
          callbackStatus: { $in: ['pending', 'failed', 'waiting'] },
          callbackAttempts: { $not: { $gte: options.maxAttempts } },
          status: { $in: ['succeeded', 'failed', 'canceled', 'requires_action'] },
          updatedAt: { $lt: options.updatedBefore },
        })
        .sort({ updatedAt: 1 })
        .limit(options.limit && options.limit > 0 ? options.limit : 100)
        .toArray();
      return docs.map(toRun);
    }

    async listAgentRuns(filter: Parameters<IAgentRunListFn>[0]): Promise<IAgentRun[]> {
      const db = this.getTenantDb();
      const col = db.collection<IAgentRun>(COLLECTIONS.agentRuns);
      const and: Record<string, unknown>[] = [{ tenantId: filter.tenantId, projectId: filter.projectId }];
      if (filter.agentKey) and.push({ agentKey: filter.agentKey });
      if (filter.excludeAgentKeys && filter.excludeAgentKeys.length > 0) and.push({ agentKey: { $nin: filter.excludeAgentKeys } });
      if (filter.conversationId) and.push({ conversationId: filter.conversationId });
      if (filter.status && filter.status.length > 0) and.push({ status: { $in: filter.status } });
      const modes = filter.mode === undefined ? [] : Array.isArray(filter.mode) ? filter.mode : [filter.mode];
      if (modes.length > 0) and.push({ mode: { $in: modes } });
      if (filter.excludeModes && filter.excludeModes.length > 0) and.push({ mode: { $nin: filter.excludeModes } });
      if (filter.runClass) and.push(runClassFilter(filter.runClass));
      if (filter.triggerId) and.push({ triggerId: filter.triggerId });
      if (filter.channel) and.push({ channel: filter.channel });
      if (filter.trigger) and.push({ trigger: filter.trigger });
      if (filter.userId) and.push({ userId: filter.userId });
      for (const [key, value] of Object.entries(filter.metadata ?? {})) and.push(metadataFilter(key, value));
      if (filter.createdAfter) and.push({ createdAt: { $gt: filter.createdAfter } });
      if (filter.createdBefore) and.push({ createdAt: { $lt: filter.createdBefore } });
      if (filter.cursor) {
        let cursorDoc: IAgentRun | null = null;
        try {
          cursorDoc = await col.findOne({ _id: objectId(filter.cursor), tenantId: filter.tenantId, projectId: filter.projectId });
        } catch {
          cursorDoc = null;
        }
        // An unknown cursor ends the listing instead of restarting it.
        if (!cursorDoc) return [];
        and.push({ $or: [
          { createdAt: { $lt: cursorDoc.createdAt } },
          { createdAt: cursorDoc.createdAt, _id: { $lt: cursorDoc._id } },
        ] });
      }
      const docs = await col
        .find({ $and: and })
        .sort({ createdAt: -1, _id: -1 })
        .limit(Math.min(Math.max(filter.limit ?? 50, 1), 1000))
        .toArray();
      return docs.map(toRun);
    }

    async listDueScheduledAgentRuns(tenantId: string, now: Date, limit: number): Promise<IAgentRun[]> {
      const docs = await this.agentRunsCollection()
        .find({ tenantId, status: 'scheduled', notBefore: { $lte: now } })
        .sort({ notBefore: 1, _id: 1 })
        .limit(Math.max(limit, 1))
        .toArray();
      return docs.map(toRun);
    }

    async promoteScheduledAgentRun(runId: string, tenantId: string, options: { notBefore?: Date } = {}): Promise<IAgentRun | null> {
      const scheduled = await this.agentRunsCollection().findOne({ _id: objectId(runId), tenantId, status: 'scheduled' });
      if (!scheduled) return null;
      await this.ensureAgentRunsIndexes();
      // The slot is taken before the row becomes active, like a resume.
      const lockId = conversationLockId(scheduled.conversationId);
      if (!(await this.acquireAgentRunLock(lockId, 'conversation'))) throw new AgentRunConflictError(scheduled.conversationId);
      const locks = this.getTenantDb().collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks);
      let run: IAgentRun | null;
      try {
        run = await this.setAgentRun(
          { _id: objectId(runId), tenantId, status: 'scheduled' },
          { status: 'queued', updatedAt: new Date(), ...(options.notBefore ? { notBefore: options.notBefore } : {}) },
        );
      } catch (error) {
        await locks.deleteOne({ _id: lockId, runId: null }).catch(() => undefined);
        if (isDuplicateKey(error)) throw new AgentRunConflictError(scheduled.conversationId);
        throw error;
      }
      if (!run) {
        await locks.deleteOne({ _id: lockId, runId: null }).catch(() => undefined);
        return null;
      }
      await this.bindAgentRunLock(lockId, runId);
      return run;
    }

    async listQueuedDeferredAgentRuns(
      tenantId: string,
      options: { limit: number; dueBefore: Date },
    ): Promise<IAgentRun[]> {
      const docs = await this.agentRunsCollection()
        .find({
          tenantId,
          status: 'queued',
          runClass: 'deferred',
          $or: [{ notBefore: null }, { notBefore: { $lte: options.dueBefore } }],
        })
        .sort({ createdAt: 1, _id: 1 })
        .limit(Math.max(options.limit, 1))
        .toArray();
      return docs.map(toRun);
    }

    async listExpiredWaitingAgentRuns(
      tenantId: string,
      options: { dueBefore: Date; limit: number },
    ): Promise<IAgentRun[]> {
      // The due moment is `notBefore`, else `createdAt` (a run that was never scheduled).
      const docs = await this.agentRunsCollection()
        .find({
          tenantId,
          $and: [
            { $or: [{ status: 'scheduled' }, { status: 'queued', runClass: 'deferred' }] },
            { $or: [
              { notBefore: { $lt: options.dueBefore } },
              { notBefore: null, createdAt: { $lt: options.dueBefore } },
            ] },
          ],
        })
        .sort({ createdAt: 1, _id: 1 })
        .limit(Math.max(options.limit, 1))
        .toArray();
      return docs.map(toRun);
    }

    async expireWaitingAgentRun(runId: string, tenantId: string, errorMessage: string, expiresAt?: Date): Promise<IAgentRun | null> {
      const now = new Date();
      const run = await this.setAgentRun(
        { _id: objectId(runId), tenantId, status: { $in: ['queued', 'scheduled'] } },
        {
          status: 'failed', errorReason: 'expired', errorMessage, stopReason: 'error', completedAt: now, updatedAt: now,
          ...(expiresAt ? { expiresAt } : {}),
        },
      );
      // A queued row holds the conversation's slot; a scheduled one never took it (no-op).
      if (run) await this.releaseConversationLock(run.conversationId, runId);
      if (run && expiresAt) await this.extendIdempotencyLock(run, expiresAt);
      return run;
    }

    async markAgentRunDetached(runId: string, tenantId: string, at: Date): Promise<IAgentRun | null> {
      return this.setAgentRun(
        { _id: objectId(runId), tenantId, status: 'running' },
        { detachedAt: at, updatedAt: new Date() },
      );
    }

    async markAgentRunPublished(runId: string, tenantId: string, at: Date): Promise<IAgentRun | null> {
      return this.setAgentRun({ _id: objectId(runId), tenantId }, { lastPublishedAt: at, updatedAt: new Date() });
    }

    async deleteAgentRun(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const existing = await db
        .collection<IAgentRun>(COLLECTIONS.agentRuns)
        .findOneAndDelete({ _id: objectId(id) });
      if (!existing) return false;
      await this.releaseConversationLock(existing.conversationId, id);
      // A deleted row (cap overflow, publish failure) never ran, so its
      // Idempotency-Key must be free for the caller's retry — a lock still
      // bound to a vanished run would turn every retry into a 409 until
      // retention expired it (SQLite's unique index frees it with the row).
      if (existing.idempotencyKey) {
        await db.collection<AgentRunLockDoc>(COLLECTIONS.agentRunLocks)
          .deleteOne({ _id: idempotencyLockId(existing.tenantId, existing.projectId, existing.idempotencyKey), runId: id })
          .catch((error) => logger.warn('Could not release agent run idempotency lock', { runId: id, error }));
      }
      return true;
    }

    async countActiveAgentRuns(
      tenantId: string,
      projectId?: string,
      opts?: { mode?: IAgentRun['mode']; runClass?: AgentRunClass },
    ): Promise<number> {
      const and: Record<string, unknown>[] = [{ tenantId, status: { $in: ['queued', 'running'] } }];
      if (projectId) and.push({ projectId });
      if (opts?.mode) and.push({ mode: opts.mode });
      if (opts?.runClass) and.push(runClassFilter(opts.runClass));
      return this.agentRunsCollection().countDocuments({ $and: and });
    }

    async countAgentRunsByStatus(
      tenantId: string,
      opts: { statuses: IAgentRun['status'][]; runClass?: AgentRunClass; projectId?: string; channel?: NonNullable<IAgentRun['channel']>; createdAfter?: Date },
    ): Promise<Record<string, number>> {
      const entries = await Promise.all(opts.statuses.map(async (status) => {
        const and: Record<string, unknown>[] = [{ tenantId, status }];
        if (opts.projectId) and.push({ projectId: opts.projectId });
        if (opts.runClass) and.push(runClassFilter(opts.runClass));
        if (opts.channel) and.push({ channel: opts.channel });
        if (opts.createdAfter) and.push({ createdAt: { $gt: opts.createdAfter } });
        return [status, await this.agentRunsCollection().countDocuments({ $and: and })] as const;
      }));
      return Object.fromEntries(entries);
    }

    async cleanupAgentRunRetention(options: {
      olderThan: Date;
      batchSize?: number;
    }): Promise<{ deletedCount: number }> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {
        expiresAt: { $lt: options.olderThan },
        // A queued/running/scheduled/paused row is never retention's to delete,
        // whatever its expiresAt says (AGENT_RUN_RETENTION_DAYS=0 would otherwise
        // delete a run right after it is created, and a paused run is waiting
        // for a person).
        status: { $nin: ['queued', 'running', 'scheduled', 'requires_action'] },
      };
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
