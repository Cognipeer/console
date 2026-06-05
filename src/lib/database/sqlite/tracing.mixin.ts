/**
 * SQLite Provider – Agent tracing operations mixin
 */

import type {
  IAgentTracingDashboardAggregate,
  IAgentTracingEvent,
  IAgentTracingSession,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function TracingMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class TracingOps extends Base {
    private buildAgentTracingSessionWhere(
      filters?: Record<string, unknown>,
      projectId?: string,
      alias?: string,
    ): { params: Record<string, unknown>; where: string } {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      const column = (name: string) => (alias ? `${alias}.${name}` : name);
      const activityDate = `COALESCE(${column('startedAt')}, ${column('createdAt')})`;

      if (projectId) {
        clauses.push(`${column('projectId')} = @projectId`);
        params.projectId = projectId;
      }
      if (filters?.from) {
        clauses.push(`${activityDate} >= @from`);
        params.from = String(filters.from);
      }
      if (filters?.to) {
        clauses.push(`${activityDate} <= @to`);
        params.to = String(filters.to);
      }

      return {
        params,
        where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      };
    }

    private toAggregateNumber(value: unknown): number {
      const numberValue = Number(value ?? 0);
      return Number.isFinite(numberValue) ? numberValue : 0;
    }

    private toAggregateDate(value: unknown): Date | undefined {
      if (!value) return undefined;
      const date = new Date(String(value));
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

    async createAgentTracingSession(
      session: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentTracingSession> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.agentTracingSessions}
        (id, sessionId, traceId, rootSpanId, threadId, tenantId, projectId, source, agent, agentName, agentVersion, agentModel,
         config, summary, status, startedAt, endedAt, durationMs, errors, modelsUsed, toolsUsed,
         eventCounts, totalEvents, totalInputTokens, totalOutputTokens, totalCachedInputTokens,
         totalBytesIn, totalBytesOut, totalRequestBytes, totalResponseBytes, createdAt, updatedAt)
        VALUES (@id, @sessionId, @traceId, @rootSpanId, @threadId, @tenantId, @projectId, @source, @agent, @agentName, @agentVersion, @agentModel,
         @config, @summary, @status, @startedAt, @endedAt, @durationMs, @errors, @modelsUsed, @toolsUsed,
         @eventCounts, @totalEvents, @totalInputTokens, @totalOutputTokens, @totalCachedInputTokens,
         @totalBytesIn, @totalBytesOut, @totalRequestBytes, @totalResponseBytes, @createdAt, @updatedAt)
      `).run({
        id,
        sessionId: session.sessionId,
        traceId: session.traceId ?? null,
        rootSpanId: session.rootSpanId ?? null,
        threadId: this.normalizeThreadId(session.threadId) ?? null,
        tenantId: session.tenantId,
        projectId: session.projectId ?? null,
        source: session.source ?? null,
        agent: this.toJson(session.agent),
        agentName: session.agentName ?? null,
        agentVersion: session.agentVersion ?? null,
        agentModel: session.agentModel ?? null,
        config: this.toJson(session.config),
        summary: this.toJson(session.summary),
        status: session.status ?? null,
        startedAt: session.startedAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
        durationMs: session.durationMs ?? null,
        errors: this.toJson(session.errors ?? []),
        modelsUsed: this.toJson(this.normalizeStringArray(session.modelsUsed)),
        toolsUsed: this.toJson(this.normalizeStringArray(session.toolsUsed)),
        eventCounts: this.toJson(session.eventCounts ?? {}),
        totalEvents: session.totalEvents ?? 0,
        totalInputTokens: session.totalInputTokens ?? 0,
        totalOutputTokens: session.totalOutputTokens ?? 0,
        totalCachedInputTokens: session.totalCachedInputTokens ?? 0,
        totalBytesIn: session.totalBytesIn ?? 0,
        totalBytesOut: session.totalBytesOut ?? 0,
        totalRequestBytes: session.totalRequestBytes ?? 0,
        totalResponseBytes: session.totalResponseBytes ?? 0,
        createdAt: now,
        updatedAt: now,
      });

      return { ...session, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async countAgentTracingDistinctAgents(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `SELECT COUNT(DISTINCT agentName) as cnt FROM ${TABLES.agentTracingSessions} WHERE agentName IS NOT NULL`;
      const params: Record<string, unknown> = {};
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow;
      return (row?.cnt as number) ?? 0;
    }

    async agentTracingAgentExists(agentName: string, projectId?: string): Promise<boolean> {
      const db = this.getTenantDb();
      let sql = `SELECT 1 FROM ${TABLES.agentTracingSessions} WHERE agentName = @agentName`;
      const params: Record<string, unknown> = { agentName };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      sql += ' LIMIT 1';
      return db.prepare(sql).get(params) !== undefined;
    }

    async cleanupAgentTracingRetention(options: {
      projectId?: string; olderThan: Date; batchSize?: number;
    }): Promise<{ sessionsDeleted: number; eventsDeleted: number }> {
      const db = this.getTenantDb();
      const cutoff = options.olderThan.toISOString();

      let sessionWhere = `createdAt < @cutoff`;
      const params: Record<string, unknown> = { cutoff };
      if (options.projectId) { sessionWhere += ' AND projectId = @projectId'; params.projectId = options.projectId; }

      // Get session IDs to delete
      const limit = options.batchSize ?? 1000;
      const sessions = db.prepare(
        `SELECT sessionId FROM ${TABLES.agentTracingSessions} WHERE ${sessionWhere} LIMIT @limit`,
      ).all({ ...params, limit }) as SqliteRow[];

      if (sessions.length === 0) return { sessionsDeleted: 0, eventsDeleted: 0 };

      const sessionIds = sessions.map((s) => s.sessionId as string);
      let eventsDeleted = 0;

      const tx = db.transaction(() => {
        for (const sid of sessionIds) {
          eventsDeleted += db.prepare(`DELETE FROM ${TABLES.agentTracingEvents} WHERE sessionId = @sid`).run({ sid }).changes;
        }
        // Delete sessions
        for (const sid of sessionIds) {
          db.prepare(`DELETE FROM ${TABLES.agentTracingSessions} WHERE sessionId = @sid`).run({ sid });
        }
      });
      tx();

      return { sessionsDeleted: sessionIds.length, eventsDeleted };
    }

    async updateAgentTracingSession(
      sessionId: string,
      data: Partial<IAgentTracingSession>,
      projectId?: string,
    ): Promise<IAgentTracingSession | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { sessionId, updatedAt: now };
      let where = 'sessionId = @sessionId';
      if (projectId) { where += ' AND projectId = @projectId'; params.projectId = projectId; }

      if (data.threadId !== undefined) { sets.push('threadId = @threadId'); params.threadId = this.normalizeThreadId(data.threadId) ?? null; }
      if (data.traceId !== undefined) { sets.push('traceId = @traceId'); params.traceId = data.traceId ?? null; }
      if (data.rootSpanId !== undefined) { sets.push('rootSpanId = @rootSpanId'); params.rootSpanId = data.rootSpanId ?? null; }
      if (data.source !== undefined) { sets.push('source = @source'); params.source = data.source ?? null; }
      if (data.agent !== undefined) { sets.push('agent = @agent'); params.agent = this.toJson(data.agent); }
      if (data.agentName !== undefined) { sets.push('agentName = @agentName'); params.agentName = data.agentName; }
      if (data.agentVersion !== undefined) { sets.push('agentVersion = @agentVersion'); params.agentVersion = data.agentVersion; }
      if (data.agentModel !== undefined) { sets.push('agentModel = @agentModel'); params.agentModel = data.agentModel; }
      if (data.config !== undefined) { sets.push('config = @config'); params.config = this.toJson(data.config); }
      if (data.summary !== undefined) { sets.push('summary = @summary'); params.summary = this.toJson(data.summary); }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.startedAt !== undefined) { sets.push('startedAt = @startedAt'); params.startedAt = data.startedAt?.toISOString() ?? null; }
      if (data.endedAt !== undefined) { sets.push('endedAt = @endedAt'); params.endedAt = data.endedAt?.toISOString() ?? null; }
      if (data.durationMs !== undefined) { sets.push('durationMs = @durationMs'); params.durationMs = data.durationMs; }
      if (data.errors !== undefined) { sets.push('errors = @errors'); params.errors = this.toJson(data.errors); }
      if (data.modelsUsed !== undefined) { sets.push('modelsUsed = @modelsUsed'); params.modelsUsed = this.toJson(this.normalizeStringArray(data.modelsUsed)); }
      if (data.toolsUsed !== undefined) { sets.push('toolsUsed = @toolsUsed'); params.toolsUsed = this.toJson(this.normalizeStringArray(data.toolsUsed)); }
      if (data.eventCounts !== undefined) { sets.push('eventCounts = @eventCounts'); params.eventCounts = this.toJson(data.eventCounts); }
      if (data.totalEvents !== undefined) { sets.push('totalEvents = @totalEvents'); params.totalEvents = data.totalEvents; }
      if (data.totalInputTokens !== undefined) { sets.push('totalInputTokens = @totalInputTokens'); params.totalInputTokens = data.totalInputTokens; }
      if (data.totalOutputTokens !== undefined) { sets.push('totalOutputTokens = @totalOutputTokens'); params.totalOutputTokens = data.totalOutputTokens; }
      if (data.totalCachedInputTokens !== undefined) { sets.push('totalCachedInputTokens = @totalCachedInputTokens'); params.totalCachedInputTokens = data.totalCachedInputTokens; }
      if (data.totalBytesIn !== undefined) { sets.push('totalBytesIn = @totalBytesIn'); params.totalBytesIn = data.totalBytesIn; }
      if (data.totalBytesOut !== undefined) { sets.push('totalBytesOut = @totalBytesOut'); params.totalBytesOut = data.totalBytesOut; }
      if (data.totalRequestBytes !== undefined) { sets.push('totalRequestBytes = @totalRequestBytes'); params.totalRequestBytes = data.totalRequestBytes; }
      if (data.totalResponseBytes !== undefined) { sets.push('totalResponseBytes = @totalResponseBytes'); params.totalResponseBytes = data.totalResponseBytes; }

      db.prepare(`UPDATE ${TABLES.agentTracingSessions} SET ${sets.join(', ')} WHERE ${where}`).run(params);

      const row = db.prepare(`SELECT * FROM ${TABLES.agentTracingSessions} WHERE sessionId = @sessionId`)
        .get({ sessionId }) as SqliteRow | undefined;
      return row ? this.mapAgentTracingSessionRow(row) : null;
    }

    async findAgentTracingSessionById(sessionId: string, projectId?: string): Promise<IAgentTracingSession | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.agentTracingSessions} WHERE sessionId = @sessionId`;
      const params: Record<string, unknown> = { sessionId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapAgentTracingSessionRow(row) : null;
    }

    async listAgentTracingSessions(
      filters?: Record<string, unknown>,
      projectId?: string,
    ): Promise<{ sessions: IAgentTracingSession[]; total: number }> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (projectId) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const exactAgentName =
        typeof filters?.agentNameExact === 'string' ? filters.agentNameExact.trim() : '';
      if (exactAgentName) {
        clauses.push('agentName = @agentNameExact');
        params.agentNameExact = exactAgentName;
      } else if (filters?.agentName) {
        clauses.push('agentName = @agentName');
        params.agentName = filters.agentName;
      }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.threadId) { clauses.push('threadId = @threadId'); params.threadId = filters.threadId; }
      if (filters?.from) { clauses.push('COALESCE(startedAt, createdAt) >= @from'); params.from = String(filters.from); }
      if (filters?.to) { clauses.push('COALESCE(startedAt, createdAt) <= @to'); params.to = String(filters.to); }

      const freeText =
        typeof filters?.query === 'string' ? filters.query.trim() : '';
      if (freeText) {
        clauses.push('(sessionId LIKE @freeText OR threadId LIKE @freeText OR agentName LIKE @freeText)');
        params.freeText = `%${freeText}%`;
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limitValue = Number.parseInt(String(filters?.limit ?? '50'), 10);
      const skipValue = Number.parseInt(String(filters?.skip ?? '0'), 10);
      const limit = Number.isFinite(limitValue) ? Math.max(0, limitValue) : 50;
      const skip = Number.isFinite(skipValue) ? Math.max(0, skipValue) : 0;
      const includeTotal = filters?.includeTotal !== false;

      const total = includeTotal
        ? ((db.prepare(`SELECT COUNT(*) as cnt FROM ${TABLES.agentTracingSessions} ${where}`).get(params) as SqliteRow | undefined)?.cnt as number) ?? 0
        : 0;

      const rows = limit > 0
        ? (db.prepare(
          `SELECT * FROM ${TABLES.agentTracingSessions} ${where} ORDER BY COALESCE(startedAt, createdAt) DESC LIMIT @limit OFFSET @skip`,
        ).all({ ...params, limit, skip }) as SqliteRow[])
        : [];

      return {
        sessions: rows.map((r) => this.mapAgentTracingSessionRow(r)),
        total: includeTotal ? total : rows.length,
      };
    }

    async aggregateAgentTracingDashboard(
      filters?: { from?: string; to?: string; timezone?: string },
      projectId?: string,
    ): Promise<IAgentTracingDashboardAggregate> {
      const db = this.getTenantDb();
      const { params, where } = this.buildAgentTracingSessionWhere(filters, projectId, 's');

      const totalsRow = db.prepare(`
        SELECT
          COUNT(*) as sessionsCount,
          COALESCE(SUM(COALESCE(s.totalEvents, 0)), 0) as totalEvents,
          COALESCE(SUM(COALESCE(s.totalInputTokens, 0)), 0) as totalInputTokens,
          COALESCE(SUM(COALESCE(s.totalOutputTokens, 0)), 0) as totalOutputTokens,
          COALESCE(SUM(COALESCE(s.totalCachedInputTokens, 0)), 0) as totalCachedInputTokens,
          COALESCE(SUM(COALESCE(s.totalInputTokens, 0) + COALESCE(s.totalOutputTokens, 0)), 0) as totalTokens,
          COALESCE(SUM(COALESCE(s.durationMs, 0)), 0) as totalDurationMs
        FROM ${TABLES.agentTracingSessions} s
        ${where}
      `).get(params) as SqliteRow | undefined;

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

      const recentRows = db.prepare(`
        SELECT
          s.sessionId,
          s.agentName,
          s.status,
          s.startedAt,
          s.durationMs,
          s.totalEvents,
          s.totalInputTokens,
          s.totalOutputTokens
        FROM ${TABLES.agentTracingSessions} s
        ${where}
        ORDER BY COALESCE(s.startedAt, s.createdAt) DESC
        LIMIT 10
      `).all(params) as SqliteRow[];

      const recentSessions = recentRows.map((row) => ({
        sessionId: String(row.sessionId ?? ''),
        agentName: row.agentName ? String(row.agentName) : undefined,
        status: row.status ? String(row.status) : undefined,
        startedAt: this.toAggregateDate(row.startedAt),
        durationMs: this.toAggregateNumber(row.durationMs),
        totalEvents: this.toAggregateNumber(row.totalEvents),
        totalTokens:
          this.toAggregateNumber(row.totalInputTokens)
          + this.toAggregateNumber(row.totalOutputTokens),
      }));

      const statusRows = db.prepare(`
        SELECT COALESCE(s.status, 'unknown') as status, COUNT(*) as count
        FROM ${TABLES.agentTracingSessions} s
        ${where}
        GROUP BY COALESCE(s.status, 'unknown')
        ORDER BY count DESC
      `).all(params) as SqliteRow[];

      const modelRows = db.prepare(`
        SELECT model.value as model, COUNT(*) as sessionsCount
        FROM ${TABLES.agentTracingSessions} s
        JOIN json_each(CASE WHEN json_valid(s.modelsUsed) THEN s.modelsUsed ELSE '[]' END) model
        ${where}
        GROUP BY model.value
        ORDER BY sessionsCount DESC
      `).all(params) as SqliteRow[];

      const toolRows = db.prepare(`
        SELECT
          tool.value as toolName,
          COUNT(*) as totalCalls,
          COALESCE(SUM(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END), 0) as errorCalls
        FROM ${TABLES.agentTracingSessions} s
        JOIN json_each(CASE WHEN json_valid(s.toolsUsed) THEN s.toolsUsed ELSE '[]' END) tool
        ${where}
        GROUP BY tool.value
        ORDER BY totalCalls DESC
      `).all(params) as SqliteRow[];

      const agentRows = db.prepare(`
        SELECT
          COALESCE(s.agentName, 'unknown') as name,
          COUNT(*) as sessionsCount,
          MAX(COALESCE(s.startedAt, s.createdAt)) as latestSessionAt,
          COALESCE(SUM(COALESCE(s.totalEvents, 0)), 0) as totalEvents,
          COALESCE(SUM(COALESCE(s.totalInputTokens, 0)), 0) as totalInputTokens,
          COALESCE(SUM(COALESCE(s.totalOutputTokens, 0)), 0) as totalOutputTokens,
          COALESCE(SUM(COALESCE(s.totalCachedInputTokens, 0)), 0) as totalCachedInputTokens,
          COALESCE(SUM(COALESCE(s.totalInputTokens, 0) + COALESCE(s.totalOutputTokens, 0)), 0) as totalTokens,
          COALESCE(SUM(COALESCE(s.durationMs, 0)), 0) as totalDurationMs
        FROM ${TABLES.agentTracingSessions} s
        ${where}
        GROUP BY COALESCE(s.agentName, 'unknown')
      `).all(params) as SqliteRow[];

      const agents = agentRows.map((row) => {
        const agentSessionsCount = this.toAggregateNumber(row.sessionsCount);
        const agentInputTokens = this.toAggregateNumber(row.totalInputTokens);
        const agentOutputTokens = this.toAggregateNumber(row.totalOutputTokens);
        const agentCachedInputTokens = this.toAggregateNumber(row.totalCachedInputTokens);
        const agentTokens = this.toAggregateNumber(row.totalTokens);
        const agentDurationMs = this.toAggregateNumber(row.totalDurationMs);
        const name = String(row.name ?? 'unknown');

        return {
          name,
          label: name,
          latestSessionAt: this.toAggregateDate(row.latestSessionAt),
          latestStatus: undefined,
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

      const dailyRows = db.prepare(`
        SELECT
          substr(COALESCE(s.startedAt, s.createdAt), 1, 10) as date,
          COUNT(*) as sessionsCount,
          COALESCE(SUM(COALESCE(s.totalEvents, 0)), 0) as totalEvents,
          COALESCE(SUM(COALESCE(s.totalInputTokens, 0) + COALESCE(s.totalOutputTokens, 0)), 0) as totalTokens,
          COALESCE(SUM(COALESCE(s.durationMs, 0)), 0) as totalDurationMs
        FROM ${TABLES.agentTracingSessions} s
        ${where}
        GROUP BY substr(COALESCE(s.startedAt, s.createdAt), 1, 10)
        ORDER BY date ASC
      `).all(params) as SqliteRow[];

      const toolItems = toolRows.map((row) => {
        const totalCalls = this.toAggregateNumber(row.totalCalls);
        const errorCalls = this.toAggregateNumber(row.errorCalls);
        const successCalls = Math.max(0, totalCalls - errorCalls);
        return {
          toolName: String(row.toolName ?? 'unknown'),
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
        recentSessions,
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
            status: String(row.status ?? 'unknown'),
            count: this.toAggregateNumber(row.count),
          })),
          models: modelRows.map((row) => ({
            model: String(row.model ?? 'unknown'),
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
              date: String(row.date ?? ''),
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
      const db = this.getTenantDb();
      const clauses: string[] = ['threadId IS NOT NULL', "threadId != ''"];
      const params: Record<string, unknown> = {};

      if (projectId) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      if (filters?.from) { clauses.push('createdAt >= @from'); params.from = (filters.from as Date).toISOString(); }
      if (filters?.to) { clauses.push('createdAt <= @to'); params.to = (filters.to as Date).toISOString(); }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const limit = (filters?.limit as number) ?? 50;
      const skip = (filters?.skip as number) ?? 0;

      const countRow = db.prepare(
        `SELECT COUNT(DISTINCT threadId) as cnt FROM ${TABLES.agentTracingSessions} ${where}`,
      ).get(params) as SqliteRow;
      const total = (countRow?.cnt as number) ?? 0;

      const rows = db.prepare(`
        SELECT threadId,
               COUNT(*) as sessionCount,
               MIN(createdAt) as firstSession,
               MAX(createdAt) as lastSession,
               GROUP_CONCAT(DISTINCT agentName) as agents
        FROM ${TABLES.agentTracingSessions} ${where}
        GROUP BY threadId
        ORDER BY MAX(createdAt) DESC
        LIMIT @limit OFFSET @skip
      `).all({ ...params, limit, skip }) as SqliteRow[];

      const threads = rows.map((r) => ({
        threadId: r.threadId,
        sessionCount: r.sessionCount,
        firstSession: r.firstSession,
        lastSession: r.lastSession,
        agents: (r.agents as string | null)?.split(',').filter(Boolean) ?? [],
      }));

      return { threads, total };
    }

    // ── Agent Tracing Events ────────────────────────────────────────

    async createAgentTracingEvent(
      event: Omit<IAgentTracingEvent, '_id' | 'createdAt'>,
    ): Promise<IAgentTracingEvent> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.agentTracingEvents}
        (id, sessionId, traceId, spanId, parentSpanId, tenantId, projectId, eventId, type, label, sequence, timestamp, status,
         actor, metadata, sections, modelNames, model, error, durationMs, actorName, actorRole,
         toolName, toolExecutionId, inputTokens, outputTokens, totalTokens, cachedInputTokens,
         bytesIn, bytesOut, requestBytes, responseBytes, createdAt)
        VALUES (@id, @sessionId, @traceId, @spanId, @parentSpanId, @tenantId, @projectId, @eventId, @type, @label, @sequence, @timestamp, @status,
         @actor, @metadata, @sections, @modelNames, @model, @error, @durationMs, @actorName, @actorRole,
         @toolName, @toolExecutionId, @inputTokens, @outputTokens, @totalTokens, @cachedInputTokens,
         @bytesIn, @bytesOut, @requestBytes, @responseBytes, @createdAt)
      `).run({
        id,
        sessionId: event.sessionId,
        traceId: event.traceId ?? null,
        spanId: event.spanId ?? null,
        parentSpanId: event.parentSpanId ?? null,
        tenantId: event.tenantId,
        projectId: event.projectId ?? null,
        eventId: event.id ?? null,
        type: event.type ?? null,
        label: event.label ?? null,
        sequence: event.sequence ?? null,
        timestamp: event.timestamp?.toISOString() ?? null,
        status: event.status ?? null,
        actor: this.toJson(event.actor),
        metadata: this.toJson(event.metadata),
        sections: this.toJson(event.sections ?? []),
        modelNames: this.toJson(event.modelNames ?? []),
        model: event.model ?? null,
        error: this.toJson(event.error),
        durationMs: event.durationMs ?? null,
        actorName: event.actorName ?? null,
        actorRole: event.actorRole ?? null,
        toolName: event.toolName ?? null,
        toolExecutionId: event.toolExecutionId ?? null,
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        totalTokens: event.totalTokens ?? 0,
        cachedInputTokens: event.cachedInputTokens ?? 0,
        bytesIn: event.bytesIn ?? 0,
        bytesOut: event.bytesOut ?? 0,
        requestBytes: event.requestBytes ?? 0,
        responseBytes: event.responseBytes ?? 0,
        createdAt: now,
      });

      return { ...event, _id: id, createdAt: new Date(now) };
    }

    async listAgentTracingEvents(
      sessionId: string,
      projectId?: string,
      _options?: {
        projection?: Record<string, 0 | 1>;
      },
    ): Promise<IAgentTracingEvent[]> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.agentTracingEvents} WHERE sessionId = @sessionId`;
      const params: Record<string, unknown> = { sessionId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      sql += ' ORDER BY sequence ASC, createdAt ASC';
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapAgentTracingEventRow(r));
    }

    async findAgentTracingEventById(
      sessionId: string,
      eventId: string,
      projectId?: string,
    ): Promise<IAgentTracingEvent | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.agentTracingEvents} WHERE sessionId = @sessionId AND (eventId = @eventId OR id = @eventId)`;
      const params: Record<string, unknown> = {
        eventId,
        sessionId,
      };

      if (projectId) {
        sql += ' AND projectId = @projectId';
        params.projectId = projectId;
      }

      const row = db.prepare(sql).get(params) as SqliteRow | undefined;

      return row ? this.mapAgentTracingEventRow(row) : null;
    }

    async deleteAgentTracingEvents(sessionId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      let sql = `DELETE FROM ${TABLES.agentTracingEvents} WHERE sessionId = @sessionId`;
      const params: Record<string, unknown> = { sessionId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      return db.prepare(sql).run(params).changes;
    }

    // ── Row mappers ────────────────────────────────────────────────

    protected mapAgentTracingSessionRow(r: SqliteRow): IAgentTracingSession {
      return {
        _id: r.id as string,
        sessionId: r.sessionId as string,
        traceId: r.traceId as string | undefined,
        rootSpanId: r.rootSpanId as string | undefined,
        threadId: r.threadId as string | undefined,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        source: r.source as 'custom' | 'otlp' | undefined,
        agent: this.parseJson(r.agent, {}),
        agentName: r.agentName as string | undefined,
        agentVersion: r.agentVersion as string | undefined,
        agentModel: r.agentModel as string | undefined,
        config: this.parseJson(r.config, {}),
        summary: this.parseJson(r.summary, {}),
        status: r.status as string | undefined,
        startedAt: this.toDate(r.startedAt),
        endedAt: this.toDate(r.endedAt),
        durationMs: r.durationMs as number | undefined,
        errors: this.parseJson(r.errors, []),
        modelsUsed: this.parseJson(r.modelsUsed, []),
        toolsUsed: this.parseJson(r.toolsUsed, []),
        eventCounts: this.parseJson(r.eventCounts, {}),
        totalEvents: (r.totalEvents as number) ?? 0,
        totalInputTokens: (r.totalInputTokens as number) ?? 0,
        totalOutputTokens: (r.totalOutputTokens as number) ?? 0,
        totalCachedInputTokens: (r.totalCachedInputTokens as number) ?? 0,
        totalBytesIn: (r.totalBytesIn as number) ?? 0,
        totalBytesOut: (r.totalBytesOut as number) ?? 0,
        totalRequestBytes: (r.totalRequestBytes as number) ?? 0,
        totalResponseBytes: (r.totalResponseBytes as number) ?? 0,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapAgentTracingEventRow(r: SqliteRow): IAgentTracingEvent {
      return {
        _id: r.id as string,
        sessionId: r.sessionId as string,
        traceId: r.traceId as string | undefined,
        spanId: r.spanId as string | undefined,
        parentSpanId: r.parentSpanId as string | undefined,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        id: r.eventId as string | undefined,
        type: r.type as string | undefined,
        label: r.label as string | undefined,
        sequence: r.sequence as number | undefined,
        timestamp: this.toDate(r.timestamp),
        status: r.status as string | undefined,
        actor: this.parseJson(r.actor, {}),
        metadata: this.parseJson(r.metadata, {}),
        sections: this.parseJson(r.sections, []),
        modelNames: this.parseJson(r.modelNames, []),
        model: r.model as string | undefined,
        error: this.parseJson(r.error, {}),
        durationMs: r.durationMs as number | undefined,
        actorName: r.actorName as string | undefined,
        actorRole: r.actorRole as string | undefined,
        toolName: r.toolName as string | undefined,
        toolExecutionId: r.toolExecutionId as string | undefined,
        inputTokens: (r.inputTokens as number) ?? 0,
        outputTokens: (r.outputTokens as number) ?? 0,
        totalTokens: (r.totalTokens as number) ?? 0,
        cachedInputTokens: (r.cachedInputTokens as number) ?? 0,
        bytesIn: (r.bytesIn as number) ?? 0,
        bytesOut: (r.bytesOut as number) ?? 0,
        requestBytes: (r.requestBytes as number) ?? 0,
        responseBytes: (r.responseBytes as number) ?? 0,
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
