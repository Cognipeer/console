/**
 * MongoDB Provider – Agent Tracing operations mixin
 *
 * Includes sessions, events, and thread management.
 */

import { ObjectId } from 'mongodb';
import type {
  AgentTracingSessionEventDelta,
  IAgentTracingDashboardAggregate,
  IAgentTracingSession,
  IAgentTracingEvent,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';

export function TracingMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class TracingOps extends Base {
    private readonly tracingIndexInit = new Map<string, Promise<void>>();
    private readonly tracingIndexesReady = new Set<string>();
    private readonly threadBackfillTasks = new Map<string, Promise<void>>();

    private buildAgentTracingDashboardMatch(
      filters?: { from?: string; to?: string },
      projectId?: string,
    ): Record<string, unknown> {
      const match: Record<string, unknown> = {};
      if (projectId) {
        match.projectId = projectId;
      }
      if (filters?.from || filters?.to) {
        const startedAt: { $gte?: Date; $lte?: Date } = {};
        if (filters.from) startedAt.$gte = new Date(filters.from);
        if (filters.to) startedAt.$lte = new Date(filters.to);
        match.startedAt = startedAt;
      }
      return match;
    }

    private toAggregateNumber(value: unknown): number {
      const numberValue = Number(value ?? 0);
      return Number.isFinite(numberValue) ? numberValue : 0;
    }

    private toAggregateDate(value: unknown): Date | undefined {
      if (!value) return undefined;
      const date = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(date.getTime()) ? undefined : date;
    }

    private buildEmptyAgentTracingDashboardAggregate(): IAgentTracingDashboardAggregate {
      return {
        recentSessions: [],
        recentAgents: [],
        recentAgentsTotal: 0,
        analytics: {
          totals: {
            sessionsCount: 0,
            totalEvents: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedInputTokens: 0,
            totalTokens: 0,
            totalDurationMs: 0,
            averageInputTokensPerSession: 0,
            averageOutputTokensPerSession: 0,
            averageCachedInputTokensPerSession: 0,
            averageTokensPerSession: 0,
            averageDurationMs: 0,
          },
          tools: {
            totals: {
              totalCalls: 0,
              errorCalls: 0,
              successCalls: 0,
              errorRate: 0,
            },
            items: [],
          },
          statuses: [],
          models: [],
          agents: [],
          daily: [],
        },
      };
    }

    private async ensureTracingIndexes(): Promise<void> {
      const db = this.getTenantDb();
      const dbName = db.databaseName;

      if (this.tracingIndexesReady.has(dbName)) {
        return;
      }

      const existingPromise = this.tracingIndexInit.get(dbName);
      if (existingPromise) {
        await existingPromise;
        return;
      }

      // Upserting on (projectId, sessionId) only collapses concurrent inserts if
      // the key is unique — without this two simultaneous /start requests can
      // still both create a document, and every aggregation counts the session
      // twice. Best-effort: a tenant that already accumulated duplicates cannot
      // build it, and that must not take the rest of the tracing indexes (or the
      // request) down. Such a tenant keeps the old double-count until its
      // duplicates are merged.
      const uniqueSessionIndexPromise = db
        .collection(COLLECTIONS.agentTracingSessions)
        .createIndex({ projectId: 1, sessionId: 1 }, { name: 'uniq_project_sessionId', unique: true })
        .catch((error) => {
          logger.warn('Could not create unique tracing session index; duplicates present?', {
            dbName,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      const setupPromise = Promise.all([
        uniqueSessionIndexPromise,
        db
          .collection(COLLECTIONS.agentTracingSessions)
          .createIndex({ sessionId: 1 }, { name: 'idx_sessionId' }),
        db
          .collection(COLLECTIONS.agentTracingSessions)
          .createIndex({ projectId: 1, sessionId: 1 }, { name: 'idx_project_sessionId' }),
        db
          .collection(COLLECTIONS.agentTracingSessions)
          .createIndex({ projectId: 1, startedAt: -1 }, { name: 'idx_project_startedAt' }),
        db
          .collection(COLLECTIONS.agentTracingSessions)
          .createIndex({ projectId: 1, threadId: 1, startedAt: -1 }, { name: 'idx_project_thread_startedAt' }),
        db
          .collection(COLLECTIONS.agentTracingSessions)
          .createIndex({ projectId: 1, status: 1, startedAt: -1 }, { name: 'idx_project_status_startedAt' }),
        db
          .collection(COLLECTIONS.agentTracingSessions)
          .createIndex({ projectId: 1, agentName: 1, startedAt: -1 }, { name: 'idx_project_agent_startedAt' }),
        db
          .collection(COLLECTIONS.agentTracingEvents)
          .createIndex({ sessionId: 1, sequence: 1, timestamp: 1 }, { name: 'idx_session_sequence_timestamp' }),
        db
          .collection(COLLECTIONS.agentTracingEvents)
          .createIndex({ projectId: 1, sessionId: 1, sequence: 1, timestamp: 1 }, { name: 'idx_project_session_sequence_timestamp' }),
        db
          .collection(COLLECTIONS.agentTracingEvents)
          .createIndex({ projectId: 1, sessionId: 1, id: 1 }, { name: 'idx_project_session_eventId' }),
        db
          .collection(COLLECTIONS.agentTracingThreads)
          .createIndex({ threadId: 1 }, { name: 'idx_threadId' }),
        db
          .collection(COLLECTIONS.agentTracingThreads)
          .createIndex({ projectId: 1, threadId: 1 }, { name: 'idx_project_threadId' }),
        db
          .collection(COLLECTIONS.agentTracingThreads)
          .createIndex({ projectId: 1, startedAt: -1 }, { name: 'idx_project_startedAt' }),
        db
          .collection(COLLECTIONS.agentTracingThreads)
          .createIndex({ projectId: 1, latestStatus: 1, startedAt: -1 }, { name: 'idx_project_latestStatus_startedAt' }),
      ])
        .then(() => {
          this.tracingIndexesReady.add(dbName);
        })
        .catch((error) => {
          logger.warn('Failed to ensure agent tracing indexes', { dbName, error });
          throw error;
        })
        .finally(() => {
          this.tracingIndexInit.delete(dbName);
        });

      this.tracingIndexInit.set(dbName, setupPromise);
      await setupPromise;
    }

    private triggerAgentTracingThreadBackfill(projectId?: string): void {
      const dbName = this.getTenantDb().databaseName;
      const normalizedProjectId =
        typeof projectId === 'string' && projectId.trim().length > 0
          ? projectId.trim()
          : undefined;
      const taskKey = `${dbName}:${normalizedProjectId || '__legacy__'}`;

      if (this.threadBackfillTasks.has(taskKey)) {
        return;
      }

      const task = this.backfillAgentTracingThreads(normalizedProjectId)
        .catch((error) => {
          logger.warn('Agent tracing thread backfill failed', {
            dbName,
            error,
            projectId: normalizedProjectId,
          });
        })
        .finally(() => {
          this.threadBackfillTasks.delete(taskKey);
        });

      this.threadBackfillTasks.set(taskKey, task);
    }

    private async aggregateAgentTracingThreadsFromSessions(
      filters?: Record<string, unknown>,
      projectId?: string,
    ): Promise<{ threads: Array<Record<string, unknown>>; total: number }> {
      const db = this.getTenantDb();
      const sessionMatch: Record<string, unknown> = {
        threadId: { $type: 'string', $ne: '' },
        ...this.buildProjectScopeFilter(projectId),
      };

      const postGroupMatch: Record<string, unknown> = {};
      const normalizedAgentName =
        typeof filters?.agentName === 'string' ? filters.agentName.trim() : '';
      const normalizedThreadId =
        typeof filters?.threadId === 'string' ? filters.threadId.trim() : '';

      if (normalizedThreadId) {
        postGroupMatch.threadId = {
          $regex: this.escapeRegex(normalizedThreadId),
          $options: 'i',
        };
      }

      if (normalizedAgentName) {
        postGroupMatch.agents = {
          $elemMatch: {
            $regex: this.escapeRegex(normalizedAgentName),
            $options: 'i',
          },
        };
      }

      if (typeof filters?.status === 'string' && filters.status.trim()) {
        postGroupMatch.latestStatus = filters.status;
      }

      if (filters?.from || filters?.to) {
        const startedAt: { $gte?: Date; $lte?: Date } = {};
        if (typeof filters?.from === 'string') startedAt.$gte = new Date(filters.from);
        if (typeof filters?.to === 'string') startedAt.$lte = new Date(filters.to);
        postGroupMatch.startedAt = startedAt;
      }

      const limit = Math.max(0, parseInt(String(filters?.limit ?? '50'), 10) || 0);
      const skip = Math.max(0, parseInt(String(filters?.skip ?? '0'), 10) || 0);

      const [result] = await db
        .collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions)
        .aggregate([
          { $match: sessionMatch },
          { $sort: { startedAt: 1, createdAt: 1 } },
          {
            $group: {
              _id: '$threadId',
              threadId: { $first: '$threadId' },
              sessionsCount: { $sum: 1 },
              agents: { $addToSet: '$agentName' },
              statuses: { $addToSet: '$status' },
              startedAt: { $min: '$startedAt' },
              endedAt: { $max: '$endedAt' },
              totalEvents: { $sum: { $ifNull: ['$totalEvents', 0] } },
              totalInputTokens: { $sum: { $ifNull: ['$totalInputTokens', 0] } },
              totalOutputTokens: { $sum: { $ifNull: ['$totalOutputTokens', 0] } },
              totalDurationMs: { $sum: { $ifNull: ['$durationMs', 0] } },
              latestStatus: { $last: '$status' },
              modelsUsed: { $addToSet: '$modelsUsed' },
            },
          },
          ...(Object.keys(postGroupMatch).length > 0 ? [{ $match: postGroupMatch }] : []),
          { $sort: { startedAt: -1 } },
          {
            $facet: {
              items: [{ $skip: skip }, { $limit: limit }],
              total: [{ $count: 'count' }],
            },
          },
        ])
        .toArray() as Array<{
        items: Array<Record<string, unknown>>;
        total: Array<{ count?: number }>;
      }>;

      const items = result?.items ?? [];
      const total = Number(result?.total?.[0]?.count || 0);

      return {
        threads: items.map((thread) => {
          const statuses = this.normalizeStringArray(thread.statuses);
          return {
            threadId: thread.threadId as string,
            sessionsCount: Number(thread.sessionsCount || 0),
            agents: this.normalizeStringArray(thread.agents),
            statuses,
            latestStatus:
              (typeof thread.latestStatus === 'string' && thread.latestStatus) ||
              statuses[statuses.length - 1] ||
              'unknown',
            startedAt: thread.startedAt as Date,
            endedAt: thread.endedAt as Date,
            totalEvents: Number(thread.totalEvents || 0),
            totalInputTokens: Number(thread.totalInputTokens || 0),
            totalOutputTokens: Number(thread.totalOutputTokens || 0),
            totalDurationMs: Number(thread.totalDurationMs || 0),
            modelsUsed: this.normalizeStringArray(thread.modelsUsed),
          };
        }),
        total,
      };
    }

    // ── Private thread helpers ───────────────────────────────────────

    private async syncAgentTracingThread(threadId: string, projectId?: string): Promise<void> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const normalizedThreadId = this.normalizeThreadId(threadId);
      if (!normalizedThreadId) {
        return;
      }

      const sessionMatch: Record<string, unknown> = {
        threadId: normalizedThreadId,
        ...this.buildProjectScopeFilter(projectId),
      };

      const threadFilter: Record<string, unknown> = {
        threadId: normalizedThreadId,
        ...this.buildProjectScopeFilter(projectId),
      };

      const [summary] = await db
        .collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions)
        .aggregate([
          { $match: sessionMatch },
          { $sort: { startedAt: 1, createdAt: 1 } },
          {
            $group: {
              _id: '$threadId',
              tenantId: { $first: '$tenantId' },
              projectId: { $first: '$projectId' },
              sessionsCount: { $sum: 1 },
              agents: { $addToSet: '$agentName' },
              statuses: { $addToSet: '$status' },
              startedAt: { $min: '$startedAt' },
              endedAt: { $max: '$endedAt' },
              totalEvents: { $sum: { $ifNull: ['$totalEvents', 0] } },
              totalInputTokens: { $sum: { $ifNull: ['$totalInputTokens', 0] } },
              totalOutputTokens: { $sum: { $ifNull: ['$totalOutputTokens', 0] } },
              totalDurationMs: { $sum: { $ifNull: ['$durationMs', 0] } },
              latestStatus: { $last: '$status' },
              modelsUsed: { $addToSet: '$modelsUsed' },
              toolsUsed: { $addToSet: '$toolsUsed' },
            },
          },
        ])
        .toArray();

      if (!summary) {
        await db
          .collection(COLLECTIONS.agentTracingThreads)
          .deleteOne(threadFilter);
        return;
      }

      const statuses = this.normalizeStringArray(summary.statuses);
      const latestStatus =
        (typeof summary.latestStatus === 'string' && summary.latestStatus.trim()) ||
        statuses[statuses.length - 1] ||
        'unknown';
      const now = new Date();

      await db
        .collection(COLLECTIONS.agentTracingThreads)
        .updateOne(
          threadFilter,
          {
            $set: {
              threadId: normalizedThreadId,
              tenantId: summary.tenantId,
              projectId:
                typeof summary.projectId === 'string' && summary.projectId.trim()
                  ? summary.projectId
                  : undefined,
              sessionsCount: Number(summary.sessionsCount || 0),
              agents: this.normalizeStringArray(summary.agents),
              statuses,
              latestStatus,
              startedAt: summary.startedAt,
              endedAt: summary.endedAt,
              totalEvents: Number(summary.totalEvents || 0),
              totalInputTokens: Number(summary.totalInputTokens || 0),
              totalOutputTokens: Number(summary.totalOutputTokens || 0),
              totalDurationMs: Number(summary.totalDurationMs || 0),
              modelsUsed: this.normalizeStringArray(summary.modelsUsed),
              toolsUsed: this.normalizeStringArray(summary.toolsUsed),
              updatedAt: now,
            },
            $setOnInsert: {
              createdAt: now,
            },
          },
          { upsert: true },
        );
    }

    private async backfillAgentTracingThreads(projectId?: string): Promise<void> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();

      const match: Record<string, unknown> = {
        threadId: { $type: 'string', $ne: '' },
        ...this.buildProjectScopeFilter(projectId),
      };

      const threadIds = await db
        .collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions)
        .aggregate([
          { $match: match },
          { $group: { _id: '$threadId' } },
          { $project: { _id: 0, threadId: '$_id' } },
        ])
        .toArray();

      for (const item of threadIds) {
        if (typeof item.threadId === 'string' && item.threadId.trim()) {
          await this.syncAgentTracingThread(item.threadId, projectId);
        }
      }
    }

    private async listAgentTracingThreadsFromCollection(
      filters?: Record<string, unknown>,
      projectId?: string,
    ): Promise<{ threads: Array<Record<string, unknown>>; total: number }> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const match: Record<string, unknown> = {
        ...this.buildProjectScopeFilter(projectId),
      };

      const normalizedAgentName =
        typeof filters?.agentName === 'string' ? filters.agentName.trim() : '';
      const normalizedThreadId =
        typeof filters?.threadId === 'string' ? filters.threadId.trim() : '';

      if (normalizedThreadId) {
        match.threadId = {
          $regex: this.escapeRegex(normalizedThreadId),
          $options: 'i',
        };
      }

      if (normalizedAgentName) {
        match.agents = {
          $elemMatch: {
            $regex: this.escapeRegex(normalizedAgentName),
            $options: 'i',
          },
        };
      }

      if (typeof filters?.status === 'string' && filters.status.trim()) {
        match.latestStatus = filters.status;
      }

      if (filters?.from || filters?.to) {
        const startedAt: { $gte?: Date; $lte?: Date } = {};
        if (typeof filters?.from === 'string') startedAt.$gte = new Date(filters.from);
        if (typeof filters?.to === 'string') startedAt.$lte = new Date(filters.to);
        match.startedAt = startedAt;
      }

      // The materialized thread rollup has no metadata of its own (a thread
      // spans several sessions, each with its own bag) — resolve to the
      // threadIds of matching sessions first, same key charset the ingest
      // sanitizer enforces.
      const metadataKey =
        typeof filters?.metadataKey === 'string' ? filters.metadataKey.trim() : '';
      const metadataValue =
        typeof filters?.metadataValue === 'string' ? filters.metadataValue : undefined;
      if (metadataKey && /^[a-zA-Z0-9_]{1,40}$/.test(metadataKey) && metadataValue !== undefined) {
        const matchingThreadIds = await db
          .collection(COLLECTIONS.agentTracingSessions)
          .distinct('threadId', {
            ...this.buildProjectScopeFilter(projectId),
            [`metadata.${metadataKey}`]: metadataValue,
            threadId: { $exists: true, $ne: null },
          });
        match.threadId = { $in: matchingThreadIds };
      }

      const limit = parseInt(String(filters?.limit ?? '50'));
      const skip = parseInt(String(filters?.skip ?? '0'));

      const [threads, total] = await Promise.all([
        db
          .collection(COLLECTIONS.agentTracingThreads)
          .find(match)
          .sort({ startedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        db
          .collection(COLLECTIONS.agentTracingThreads)
          .countDocuments(match),
      ]);

      return {
        threads: threads.map((thread) => ({
          threadId: thread.threadId as string,
          sessionsCount: Number(thread.sessionsCount || 0),
          agents: this.normalizeStringArray(thread.agents),
          statuses: this.normalizeStringArray(thread.statuses),
          latestStatus:
            (typeof thread.latestStatus === 'string' && thread.latestStatus) ||
            'unknown',
          startedAt: thread.startedAt as Date,
          endedAt: thread.endedAt as Date,
          totalEvents: Number(thread.totalEvents || 0),
          totalInputTokens: Number(thread.totalInputTokens || 0),
          totalOutputTokens: Number(thread.totalOutputTokens || 0),
          totalDurationMs: Number(thread.totalDurationMs || 0),
          modelsUsed: this.normalizeStringArray(thread.modelsUsed),
        })),
        total,
      };
    }

    // ── Session operations ───────────────────────────────────────────

    async createAgentTracingSession(
      session: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentTracingSession> {
      const db = this.getTenantDb();
      const now = new Date();
      const normalizedThreadId = this.normalizeThreadId(session.threadId);
      const sessionData = {
        ...session,
        threadId: normalizedThreadId,
        createdAt: now,
        updatedAt: now,
      };

      // Callers decide create-vs-update from a read taken earlier in the request,
      // and the write itself runs in the background. Two starts for one sessionId
      // arriving within that window both saw "no session" and would each insert,
      // leaving duplicate documents that every aggregation counts twice. Upserting
      // on the identity keys collapses that to one document.
      //
      // `_id` is stripped because `$setOnInsert: {_id: undefined}` stores a literal
      // null — after which the next distinct session fails on the `_id_` index.
      // `insertOne` generated an id instead, so the old code was immune.
      const { _id: _ignoredId, ...insertData } = sessionData as typeof sessionData & { _id?: unknown };
      const identity = { sessionId: sessionData.sessionId, projectId: sessionData.projectId };
      const result = await db
        .collection(COLLECTIONS.agentTracingSessions)
        .findOneAndUpdate(identity, { $setOnInsert: insertData }, { upsert: true, returnDocument: 'after' });

      // `$setOnInsert` is a no-op when the document already exists, which would
      // silently discard the caller's payload — the OTLP path in particular
      // arrives with fully merged totals. Apply them explicitly in that case.
      const created = result?.createdAt instanceof Date
        && result.createdAt.getTime() === sessionData.createdAt.getTime();
      if (result && !created) {
        await this.updateAgentTracingSession(sessionData.sessionId, insertData, sessionData.projectId);
      }

      if (normalizedThreadId) {
        await this.syncAgentTracingThread(normalizedThreadId, sessionData.projectId);
      }

      return {
        ...sessionData,
        _id: result?._id?.toString() ?? '',
      };
    }

    async countAgentTracingDistinctAgents(projectId?: string): Promise<number> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const match: Record<string, unknown> = {
        agentName: { $type: 'string', $ne: '' },
      };

      if (projectId) {
        match.projectId = projectId;
      }

      const result = await db
        .collection(COLLECTIONS.agentTracingSessions)
        .aggregate([{ $match: match }, { $group: { _id: '$agentName' } }, { $count: 'count' }])
        .toArray();

      const count = (result[0] as { count?: number } | undefined)?.count;
      return typeof count === 'number' ? count : 0;
    }

    async agentTracingAgentExists(agentName: string, projectId?: string): Promise<boolean> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const trimmed = agentName.trim();
      if (!trimmed) {
        return false;
      }

      const existing = await db
        .collection(COLLECTIONS.agentTracingSessions)
        .findOne(projectId ? { projectId, agentName: trimmed } : { agentName: trimmed }, {
          projection: { _id: 1 },
        });

      return Boolean(existing);
    }

    async cleanupAgentTracingRetention(options: {
      projectId?: string;
      olderThan: Date;
      batchSize?: number;
    }): Promise<{ sessionsDeleted: number; eventsDeleted: number }> {
      const db = this.getTenantDb();

      const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 2000));
      const cutoff = options.olderThan;

      const sessionQuery: Record<string, unknown> = {
        $or: [
          { startedAt: { $lt: cutoff } },
          { startedAt: { $exists: false }, createdAt: { $lt: cutoff } },
        ],
      };
      if (options.projectId) {
        sessionQuery.projectId = options.projectId;
      }

      let sessionsDeleted = 0;
      let eventsDeleted = 0;

      while (true) {
        const sessions = await db
          .collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions)
          .find(sessionQuery, { projection: { sessionId: 1, threadId: 1, projectId: 1 } })
          .limit(batchSize)
          .toArray();

        const affectedThreads = new Map<string, { threadId: string; projectId?: string }>();
        sessions.forEach((session) => {
          const normalizedThreadId = this.normalizeThreadId(session.threadId);
          if (!normalizedThreadId) {
            return;
          }

          const normalizedProjectId =
            typeof session.projectId === 'string' && session.projectId.trim().length > 0
              ? session.projectId.trim()
              : undefined;
          const key = `${normalizedThreadId}::${normalizedProjectId || '__legacy__'}`;

          affectedThreads.set(key, {
            threadId: normalizedThreadId,
            projectId: normalizedProjectId,
          });
        });

        const sessionIds = sessions
          .map((s) => s.sessionId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0);

        if (sessionIds.length === 0) {
          break;
        }

        const eventQuery: Record<string, unknown> = { sessionId: { $in: sessionIds } };
        if (options.projectId) {
          eventQuery.projectId = options.projectId;
        }

        const eventResult = await db
          .collection(COLLECTIONS.agentTracingEvents)
          .deleteMany(eventQuery);
        eventsDeleted += eventResult.deletedCount ?? 0;

        const sessionDeleteQuery: Record<string, unknown> = { sessionId: { $in: sessionIds } };
        if (options.projectId) {
          sessionDeleteQuery.projectId = options.projectId;
        }

        const sessionResult = await db
          .collection(COLLECTIONS.agentTracingSessions)
          .deleteMany(sessionDeleteQuery);
        sessionsDeleted += sessionResult.deletedCount ?? 0;

        for (const affectedThread of affectedThreads.values()) {
          await this.syncAgentTracingThread(
            affectedThread.threadId,
            affectedThread.projectId,
          );
        }
      }

      return { sessionsDeleted, eventsDeleted };
    }

    /**
     * Fold one event into a session's running totals atomically.
     *
     * The alternative — read the session, add, write the sum back — loses events:
     * a session's events are posted concurrently, so several of them read the
     * same baseline and the last write discards the rest. Letting the server do
     * the addition means every event lands exactly once.
     *
     * This is an aggregation-pipeline update rather than plain `$inc` for two
     * reasons. `$inc` rejects the WHOLE update if any incremented path currently
     * holds a non-number — and session fields come from unvalidated client JSON,
     * so one `"500"` in a batch-ingested summary would silently swallow every
     * subsequent event. And the pipeline can read the column it just computed,
     * which keeps `summary.*` equal to the denormalized column instead of letting
     * the two drift apart when they did not start out equal.
     */
    async applyAgentTracingSessionEvent(
      sessionId: string,
      delta: AgentTracingSessionEventDelta,
      projectId?: string,
    ): Promise<void> {
      const db = this.getTenantDb();
      const collection = db.collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions);
      const filter = projectId ? { sessionId, projectId } : { sessionId };

      /** Current value of a field as a number, treating anything unusable as 0. */
      const asNumber = (path: string) => ({
        $convert: { input: `$${path}`, to: 'double', onError: 0, onNull: 0 },
      });
      const plus = (path: string, amount: number | undefined) => ({
        $add: [asNumber(path), typeof amount === 'number' && Number.isFinite(amount) ? amount : 0],
      });
      const asObject = (path: string) => ({
        $cond: [{ $eq: [{ $type: `$${path}` }, 'object'] }, `$${path}`, {}],
      });
      const asArray = (path: string) => ({
        $cond: [{ $isArray: `$${path}` }, `$${path}`, []],
      });

      // Mongo reads `.` and `$` in a field path as structure, so an event type
      // carrying either would land in the wrong place (or be rejected outright).
      const eventType = delta.eventType?.replace(/[.$]/g, '_');
      const eventCounts = eventType
        ? {
            $mergeObjects: [
              asObject('eventCounts'),
              { [eventType]: { $add: [asNumber(`eventCounts.${eventType}`), 1] } },
            ],
          }
        : asObject('eventCounts');

      // An abnormal-but-not-truncated finishReason (e.g. a content filter) isn't
      // counted here — truncatedEvents specifically tracks token/length cutoffs,
      // the usual explanation for a truncated or unparseable answer.
      const isTruncated = isTruncatedFinishReason(normalizeFinishReason(delta.finishReason));

      const totals = {
        totalEvents: plus('totalEvents', 1),
        totalInputTokens: plus('totalInputTokens', delta.inputTokens),
        totalOutputTokens: plus('totalOutputTokens', delta.outputTokens),
        totalCachedInputTokens: plus('totalCachedInputTokens', delta.cachedInputTokens),
        totalReasoningTokens: plus('totalReasoningTokens', delta.reasoningTokens),
        truncatedEvents: plus('truncatedEvents', isTruncated ? 1 : 0),
      };

      await collection.updateOne(filter, [
        { $set: { ...totals, eventCounts } },
        {
          $set: {
            updatedAt: new Date(),
            modelsUsed: { $setUnion: [asArray('modelsUsed'), delta.modelsUsed ?? []] },
            toolsUsed: { $setUnion: [asArray('toolsUsed'), delta.toolsUsed ?? []] },
            // Second stage so these read the totals the first stage just wrote,
            // keeping the summary and the columns from diverging.
            summary: {
              $mergeObjects: [
                asObject('summary'),
                {
                  totalInputTokens: '$totalInputTokens',
                  totalOutputTokens: '$totalOutputTokens',
                  totalCachedInputTokens: '$totalCachedInputTokens',
                  totalDurationMs: plus('summary.totalDurationMs', delta.durationMs),
                  eventCounts: '$eventCounts',
                },
              ],
            },
          },
        },
      ]);

      // The read-modify-write path this replaced went through
      // `updateAgentTracingSession`, which refreshed the materialized thread
      // rollup on every event. Without this the Threads screen reports zeros for
      // the whole life of a running session.
      const session = await collection.findOne(filter, { projection: { threadId: 1, projectId: 1 } });
      const threadId = this.normalizeThreadId(session?.threadId);
      if (threadId) {
        await this.syncAgentTracingThread(threadId, session?.projectId ?? projectId);
      }
    }

    async updateAgentTracingSession(
      sessionId: string,
      data: Partial<IAgentTracingSession>,
      projectId?: string,
    ): Promise<IAgentTracingSession | null> {
      const db = this.getTenantDb();
      const collection = db.collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions);
      const filter = projectId ? { sessionId, projectId } : { sessionId };

      const previousSession = await collection.findOne(filter, {
        projection: { threadId: 1, projectId: 1 },
      });

      const updateData = {
        ...data,
        updatedAt: new Date(),
      };

      if ('threadId' in updateData) {
        updateData.threadId = this.normalizeThreadId(updateData.threadId);
      }

      const result = await collection
        .findOneAndUpdate(
          filter,
          { $set: updateData },
          { returnDocument: 'after' },
        );

      if (!result) return null;

      const updatedSession = {
        ...result,
        _id: result._id.toString(),
      } as IAgentTracingSession;

      const previousThreadId = this.normalizeThreadId(previousSession?.threadId);
      const previousProjectId =
        typeof previousSession?.projectId === 'string' && previousSession.projectId.trim().length > 0
          ? previousSession.projectId.trim()
          : undefined;
      const updatedThreadId = this.normalizeThreadId(updatedSession.threadId);
      const updatedProjectId =
        typeof updatedSession.projectId === 'string' && updatedSession.projectId.trim().length > 0
          ? updatedSession.projectId.trim()
          : projectId;

      if (updatedThreadId) {
        await this.syncAgentTracingThread(updatedThreadId, updatedProjectId);
      }

      if (
        previousThreadId &&
        (previousThreadId !== updatedThreadId || previousProjectId !== updatedProjectId)
      ) {
        await this.syncAgentTracingThread(previousThreadId, previousProjectId);
      }

      return updatedSession;
    }

    async findAgentTracingSessionById(
      sessionId: string,
      projectId?: string,
    ): Promise<IAgentTracingSession | null> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const session = await db
        .collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions)
        .findOne(projectId ? { sessionId, projectId } : { sessionId });

      if (!session) return null;

      return {
        ...session,
        _id: session._id?.toString(),
      };
    }

    async listAgentTracingSessions(
      filters?: Record<string, unknown>,
      projectId?: string,
    ): Promise<{ sessions: IAgentTracingSession[]; total: number }> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};

      if (projectId) {
        query.projectId = projectId;
      }

      const exactAgentName =
        typeof filters?.agentNameExact === 'string' ? filters.agentNameExact.trim() : '';
      const partialAgentName =
        typeof filters?.agentName === 'string' ? filters.agentName.trim() : '';

      if (exactAgentName) {
        query.agentName = exactAgentName;
      } else if (partialAgentName) {
        query.agentName = {
          $regex: this.escapeRegex(partialAgentName),
          $options: 'i',
        };
      }

      if (filters?.status) {
        query.status = filters.status;
      }

      if (filters?.threadId) {
        query.threadId = this.normalizeThreadId(filters.threadId) ?? filters.threadId;
      }

      if (filters?.from || filters?.to) {
        const startedAt: { $gte?: Date; $lte?: Date } = {};
        if (typeof filters.from === 'string') startedAt.$gte = new Date(filters.from);
        if (typeof filters.to === 'string') startedAt.$lte = new Date(filters.to);
        query.startedAt = startedAt;
      }

      const freeText =
        typeof filters?.query === 'string' ? filters.query.trim() : '';
      if (freeText) {
        const escaped = this.escapeRegex(freeText);
        query.$or = [
          { sessionId: { $regex: escaped, $options: 'i' } },
          { threadId: { $regex: escaped, $options: 'i' } },
          { agentName: { $regex: escaped, $options: 'i' } },
        ];
      }

      // Same key charset the ingest sanitizer enforces (client-tracing.ts) —
      // this becomes a literal Mongo field path (`metadata.<key>`), so an
      // unvalidated key would be a query-shape injection surface.
      const metadataKey =
        typeof filters?.metadataKey === 'string' ? filters.metadataKey.trim() : '';
      const metadataValue =
        typeof filters?.metadataValue === 'string' ? filters.metadataValue : undefined;
      if (metadataKey && /^[a-zA-Z0-9_]{1,40}$/.test(metadataKey) && metadataValue !== undefined) {
        query[`metadata.${metadataKey}`] = metadataValue;
      }

      // "Only sessions with truncatedEvents > 0" filter.
      if (filters?.truncated === true) {
        query.truncatedEvents = { $gt: 0 };
      }

      const limit = Math.max(0, parseInt(String(filters?.limit ?? '50'), 10) || 0);
      const skip = Math.max(0, parseInt(String(filters?.skip ?? '0'), 10) || 0);
      const includeTotal = filters?.includeTotal !== false;
      const projection =
        filters?.projection && typeof filters.projection === 'object'
          ? (filters.projection as Record<string, 0 | 1>)
          : undefined;

      const collection = db.collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions);

      const sessionsPromise =
        limit > 0
          ? collection
            .find(query, projection ? { projection } : undefined)
            .sort({ startedAt: -1 })
            .limit(limit)
            .skip(skip)
            .toArray()
          : Promise.resolve([] as IAgentTracingSession[]);

      const totalPromise = includeTotal
        ? collection.countDocuments(query)
        : Promise.resolve<number | null>(null);

      const [sessions, total] = await Promise.all([sessionsPromise, totalPromise]);

      return {
        sessions: sessions.map((session: IAgentTracingSession) => ({
          ...session,
          _id: session._id?.toString(),
        })),
        total: total ?? sessions.length,
      };
    }

    async aggregateAgentTracingDashboard(
      filters?: { from?: string; to?: string; timezone?: string },
      projectId?: string,
    ): Promise<IAgentTracingDashboardAggregate> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const collection = db.collection<IAgentTracingSession>(COLLECTIONS.agentTracingSessions);
      const match = this.buildAgentTracingDashboardMatch(filters, projectId);
      const activityDate = { $ifNull: ['$startedAt', '$createdAt'] };

      const [
        recentSessions,
        totalsRows,
        statusRows,
        modelRows,
        toolRows,
        agentRows,
        dailyRows,
      ] = await Promise.all([
        collection
          .find(match, {
            projection: {
              sessionId: 1,
              agentName: 1,
              status: 1,
              startedAt: 1,
              durationMs: 1,
              totalEvents: 1,
              totalInputTokens: 1,
              totalOutputTokens: 1,
            },
          })
          .sort({ startedAt: -1, createdAt: -1 })
          .limit(10)
          .toArray(),
        collection.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              sessionsCount: { $sum: 1 },
              totalEvents: { $sum: { $ifNull: ['$totalEvents', 0] } },
              totalInputTokens: { $sum: { $ifNull: ['$totalInputTokens', 0] } },
              totalOutputTokens: { $sum: { $ifNull: ['$totalOutputTokens', 0] } },
              totalCachedInputTokens: { $sum: { $ifNull: ['$totalCachedInputTokens', 0] } },
              totalTokens: {
                $sum: {
                  $add: [
                    { $ifNull: ['$totalInputTokens', 0] },
                    { $ifNull: ['$totalOutputTokens', 0] },
                  ],
                },
              },
              totalDurationMs: { $sum: { $ifNull: ['$durationMs', 0] } },
            },
          },
        ]).toArray(),
        collection.aggregate([
          { $match: match },
          { $group: { _id: { $ifNull: ['$status', 'unknown'] }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]).toArray(),
        collection.aggregate([
          { $match: match },
          { $unwind: '$modelsUsed' },
          { $match: { modelsUsed: { $type: 'string', $ne: '' } } },
          { $group: { _id: '$modelsUsed', sessionsCount: { $sum: 1 } } },
          { $sort: { sessionsCount: -1 } },
        ]).toArray(),
        collection.aggregate([
          { $match: match },
          { $unwind: '$toolsUsed' },
          { $match: { toolsUsed: { $type: 'string', $ne: '' } } },
          {
            $group: {
              _id: '$toolsUsed',
              totalCalls: { $sum: 1 },
              errorCalls: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'error'] }, 1, 0],
                },
              },
            },
          },
          { $sort: { totalCalls: -1 } },
        ]).toArray(),
        collection.aggregate([
          { $match: match },
          { $sort: { startedAt: -1, createdAt: -1 } },
          {
            $group: {
              _id: { $ifNull: ['$agentName', 'unknown'] },
              latestSessionAt: { $first: activityDate },
              latestStatus: { $first: '$status' },
              sessionsCount: { $sum: 1 },
              totalEvents: { $sum: { $ifNull: ['$totalEvents', 0] } },
              totalInputTokens: { $sum: { $ifNull: ['$totalInputTokens', 0] } },
              totalOutputTokens: { $sum: { $ifNull: ['$totalOutputTokens', 0] } },
              totalCachedInputTokens: { $sum: { $ifNull: ['$totalCachedInputTokens', 0] } },
              totalTokens: {
                $sum: {
                  $add: [
                    { $ifNull: ['$totalInputTokens', 0] },
                    { $ifNull: ['$totalOutputTokens', 0] },
                  ],
                },
              },
              totalDurationMs: { $sum: { $ifNull: ['$durationMs', 0] } },
            },
          },
        ]).toArray(),
        collection.aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                $dateToString: {
                  date: activityDate,
                  format: '%Y-%m-%d',
                  timezone: 'UTC',
                },
              },
              sessionsCount: { $sum: 1 },
              totalEvents: { $sum: { $ifNull: ['$totalEvents', 0] } },
              totalTokens: {
                $sum: {
                  $add: [
                    { $ifNull: ['$totalInputTokens', 0] },
                    { $ifNull: ['$totalOutputTokens', 0] },
                  ],
                },
              },
              totalDurationMs: { $sum: { $ifNull: ['$durationMs', 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ]).toArray(),
      ]);

      const totalsRow = totalsRows[0];
      const sessionsCount = this.toAggregateNumber(totalsRow?.sessionsCount);
      if (sessionsCount === 0) {
        return this.buildEmptyAgentTracingDashboardAggregate();
      }

      const totalInputTokens = this.toAggregateNumber(totalsRow?.totalInputTokens);
      const totalOutputTokens = this.toAggregateNumber(totalsRow?.totalOutputTokens);
      const totalCachedInputTokens = this.toAggregateNumber(totalsRow?.totalCachedInputTokens);
      const totalTokens = this.toAggregateNumber(totalsRow?.totalTokens);
      const totalDurationMs = this.toAggregateNumber(totalsRow?.totalDurationMs);
      const totals = {
        sessionsCount,
        totalEvents: this.toAggregateNumber(totalsRow?.totalEvents),
        totalInputTokens,
        totalOutputTokens,
        totalCachedInputTokens,
        totalTokens,
        totalDurationMs,
        averageInputTokensPerSession: Math.round(totalInputTokens / sessionsCount),
        averageOutputTokensPerSession: Math.round(totalOutputTokens / sessionsCount),
        averageCachedInputTokensPerSession: Math.round(totalCachedInputTokens / sessionsCount),
        averageTokensPerSession: Math.round(totalTokens / sessionsCount),
        averageDurationMs: Math.round(totalDurationMs / sessionsCount),
      };

      const agents = agentRows.map((row) => {
        const agentSessionsCount = this.toAggregateNumber(row.sessionsCount);
        const agentInputTokens = this.toAggregateNumber(row.totalInputTokens);
        const agentOutputTokens = this.toAggregateNumber(row.totalOutputTokens);
        const agentCachedInputTokens = this.toAggregateNumber(row.totalCachedInputTokens);
        const agentTokens = this.toAggregateNumber(row.totalTokens);
        const agentDurationMs = this.toAggregateNumber(row.totalDurationMs);
        const name = String(row._id ?? 'unknown');

        return {
          name,
          label: name,
          latestSessionAt: this.toAggregateDate(row.latestSessionAt),
          latestStatus: row.latestStatus ? String(row.latestStatus) : undefined,
          sessionsCount: agentSessionsCount,
          totalEvents: this.toAggregateNumber(row.totalEvents),
          totalInputTokens: agentInputTokens,
          totalOutputTokens: agentOutputTokens,
          totalCachedInputTokens: agentCachedInputTokens,
          totalTokens: agentTokens,
          averageInputTokensPerSession:
            agentSessionsCount > 0 ? Math.round(agentInputTokens / agentSessionsCount) : 0,
          averageOutputTokensPerSession:
            agentSessionsCount > 0 ? Math.round(agentOutputTokens / agentSessionsCount) : 0,
          averageCachedInputTokensPerSession:
            agentSessionsCount > 0 ? Math.round(agentCachedInputTokens / agentSessionsCount) : 0,
          averageTokensPerSession:
            agentSessionsCount > 0 ? Math.round(agentTokens / agentSessionsCount) : 0,
          averageDurationMs:
            agentSessionsCount > 0 ? Math.round(agentDurationMs / agentSessionsCount) : 0,
        };
      });

      const toolItems = toolRows.map((row) => {
        const totalCalls = this.toAggregateNumber(row.totalCalls);
        const errorCalls = this.toAggregateNumber(row.errorCalls);
        const successCalls = Math.max(0, totalCalls - errorCalls);
        return {
          toolName: String(row._id ?? 'unknown'),
          totalCalls,
          errorCalls,
          successCalls,
          errorRate: totalCalls > 0 ? errorCalls / totalCalls : 0,
        };
      });
      const toolTotals = {
        totalCalls: toolItems.reduce((sum, item) => sum + item.totalCalls, 0),
        errorCalls: toolItems.reduce((sum, item) => sum + item.errorCalls, 0),
        successCalls: toolItems.reduce((sum, item) => sum + item.successCalls, 0),
        errorRate: 0,
      };
      toolTotals.errorRate = toolTotals.totalCalls > 0
        ? toolTotals.errorCalls / toolTotals.totalCalls
        : 0;

      return {
        recentSessions: recentSessions.map((session) => ({
          sessionId: session.sessionId,
          agentName: session.agentName,
          status: session.status,
          startedAt: this.toAggregateDate(session.startedAt),
          durationMs: this.toAggregateNumber(session.durationMs),
          totalEvents: this.toAggregateNumber(session.totalEvents),
          totalTokens:
            this.toAggregateNumber(session.totalInputTokens)
            + this.toAggregateNumber(session.totalOutputTokens),
        })),
        recentAgents: agents
          .slice()
          .sort((a, b) => (b.latestSessionAt?.getTime() ?? 0) - (a.latestSessionAt?.getTime() ?? 0))
          .slice(0, 20),
        recentAgentsTotal: agents.length,
        analytics: {
          totals,
          tools: {
            totals: toolTotals,
            items: toolItems,
          },
          statuses: statusRows.map((row) => ({
            status: String(row._id ?? 'unknown'),
            count: this.toAggregateNumber(row.count),
          })),
          models: modelRows.map((row) => ({
            model: String(row._id ?? 'unknown'),
            sessionsCount: this.toAggregateNumber(row.sessionsCount),
          })),
          agents: agents
            .slice()
            .sort(
              (a, b) =>
                b.totalTokens - a.totalTokens
                || b.sessionsCount - a.sessionsCount
                || a.name.localeCompare(b.name),
            ),
          daily: dailyRows.map((row) => {
            const daySessionsCount = this.toAggregateNumber(row.sessionsCount);
            const dayDurationMs = this.toAggregateNumber(row.totalDurationMs);
            return {
              date: String(row._id ?? ''),
              sessionsCount: daySessionsCount,
              totalEvents: this.toAggregateNumber(row.totalEvents),
              totalTokens: this.toAggregateNumber(row.totalTokens),
              averageDurationMs:
                daySessionsCount > 0 ? Math.round(dayDurationMs / daySessionsCount) : 0,
            };
          }).slice(-30),
        },
      };
    }

    async listAgentTracingThreads(
      filters?: Record<string, unknown>,
      projectId?: string,
    ): Promise<{ threads: Array<Record<string, unknown>>; total: number }> {
      let result = await this.listAgentTracingThreadsFromCollection(filters, projectId);

      if (result.total > 0) {
        return result;
      }

      const db = this.getTenantDb();
      const sessionMatch: Record<string, unknown> = {
        threadId: { $type: 'string', $ne: '' },
        ...this.buildProjectScopeFilter(projectId),
      };

      if (typeof filters?.threadId === 'string' && filters.threadId.trim()) {
        sessionMatch.threadId = {
          $regex: this.escapeRegex(filters.threadId.trim()),
          $options: 'i',
        };
      }

      const hasThreadedSessions = await db
        .collection(COLLECTIONS.agentTracingSessions)
        .countDocuments(sessionMatch, { limit: 1 });

      if (hasThreadedSessions > 0) {
        this.triggerAgentTracingThreadBackfill(projectId);
        result = await this.aggregateAgentTracingThreadsFromSessions(filters, projectId);
      }

      return result;
    }

    // ── Event operations ─────────────────────────────────────────────

    async createAgentTracingEvent(
      event: Omit<IAgentTracingEvent, '_id' | 'createdAt'>,
    ): Promise<IAgentTracingEvent> {
      const db = this.getTenantDb();
      const eventData = {
        ...event,
        createdAt: new Date(),
      };
      const result = await db
        .collection(COLLECTIONS.agentTracingEvents)
        .insertOne(eventData);
      return {
        ...eventData,
        _id: result.insertedId.toString(),
      };
    }

    async listAgentTracingEvents(
      sessionId: string,
      projectId?: string,
      options?: {
        projection?: Record<string, 0 | 1>;
      },
    ): Promise<IAgentTracingEvent[]> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const events = await db
        .collection<IAgentTracingEvent>(COLLECTIONS.agentTracingEvents)
        .find(
          projectId ? { sessionId, projectId } : { sessionId },
          options?.projection ? { projection: options.projection } : undefined,
        )
        .sort({ sequence: 1, timestamp: 1 })
        .toArray();

      return events.map((event: IAgentTracingEvent) => ({
        ...event,
        _id: event._id?.toString(),
      }));
    }

    async findAgentTracingEventById(
      sessionId: string,
      eventId: string,
      projectId?: string,
    ): Promise<IAgentTracingEvent | null> {
      await this.ensureTracingIndexes();
      const db = this.getTenantDb();
      const scoped = projectId ? { sessionId, projectId } : { sessionId };
      const query: Record<string, unknown> = {
        ...scoped,
        $or: [{ id: eventId }],
      };

      if (/^[a-f0-9]{24}$/i.test(eventId)) {
        query.$or = [...(query.$or as Array<Record<string, unknown>>), { _id: new ObjectId(eventId) }];
      }

      const event = await db
        .collection<IAgentTracingEvent>(COLLECTIONS.agentTracingEvents)
        .findOne(query);

      if (!event) {
        return null;
      }

      return {
        ...event,
        _id: event._id?.toString(),
      };
    }

    async updateAgentTracingEvent(
      sessionId: string,
      eventId: string,
      data: Partial<Pick<IAgentTracingEvent, 'finishReason' | 'reasoningTokens' | 'metadata'>>,
      projectId?: string,
    ): Promise<IAgentTracingEvent | null> {
      const db = this.getTenantDb();
      const scoped = projectId ? { sessionId, projectId } : { sessionId };
      const query: Record<string, unknown> = {
        ...scoped,
        $or: [{ id: eventId }],
      };

      if (/^[a-f0-9]{24}$/i.test(eventId)) {
        query.$or = [...(query.$or as Array<Record<string, unknown>>), { _id: new ObjectId(eventId) }];
      }

      const updateData: Partial<IAgentTracingEvent> = {};
      if (data.finishReason !== undefined) updateData.finishReason = data.finishReason;
      if (data.reasoningTokens !== undefined) updateData.reasoningTokens = data.reasoningTokens;
      if (data.metadata !== undefined) updateData.metadata = data.metadata;

      const collection = db.collection<IAgentTracingEvent>(COLLECTIONS.agentTracingEvents);

      if (Object.keys(updateData).length === 0) {
        const event = await collection.findOne(query);
        return event ? { ...event, _id: event._id?.toString() } : null;
      }

      const result = await collection.findOneAndUpdate(
        query,
        { $set: updateData },
        { returnDocument: 'after' },
      );

      if (!result) return null;

      return {
        ...result,
        _id: result._id.toString(),
      };
    }

    async deleteAgentTracingEvents(sessionId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.agentTracingEvents)
        .deleteMany(projectId ? { sessionId, projectId } : { sessionId });
      return result.deletedCount ?? 0;
    }
  };
}
