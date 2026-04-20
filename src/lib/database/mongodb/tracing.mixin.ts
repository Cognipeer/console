/**
 * MongoDB Provider – Agent Tracing operations mixin
 *
 * Includes sessions, events, and thread management.
 */

import { ObjectId } from 'mongodb';
import type { IAgentTracingSession, IAgentTracingEvent } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

export function TracingMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class TracingOps extends Base {
    private readonly tracingIndexInit = new Map<string, Promise<void>>();
    private readonly tracingIndexesReady = new Set<string>();
    private readonly threadBackfillTasks = new Map<string, Promise<void>>();

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

      const setupPromise = Promise.all([
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

      const result = await db
        .collection(COLLECTIONS.agentTracingSessions)
        .insertOne(sessionData);

      if (normalizedThreadId) {
        await this.syncAgentTracingThread(normalizedThreadId, sessionData.projectId);
      }

      return {
        ...sessionData,
        _id: result.insertedId.toString(),
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

    async deleteAgentTracingEvents(sessionId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.agentTracingEvents)
        .deleteMany(projectId ? { sessionId, projectId } : { sessionId });
      return result.deletedCount ?? 0;
    }
  };
}
