/**
 * Agent Tracing Service
 * Business logic for agent tracing operations
 */

import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import dayjs from 'dayjs';

const logger = createLogger('agent-tracing');

type SessionListQuery = Record<string, unknown> & {
  startedAt?: {
    $gte?: Date;
    $lte?: Date;
  };
  agentName?: string;
  from?: string;
  to?: string;
};

export interface AgentTracingSessionSummary {
  sessionId: string;
  agentName?: string;
  status?: string;
  startedAt?: Date;
  durationMs?: number;
  totalEvents?: number;
  totalTokens: number;
}

export interface AgentTracingTokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalTokens: number;
  averageInputTokensPerSession: number;
  averageOutputTokensPerSession: number;
  averageCachedInputTokensPerSession: number;
  averageTokensPerSession: number;
}

export interface AgentTracingAggregateTotals extends AgentTracingTokenSummary {
  sessionsCount: number;
  totalEvents: number;
  totalDurationMs: number;
  averageDurationMs: number;
}

export interface AgentTracingAgentSummary extends AgentTracingTokenSummary {
  name: string;
  label: string;
  latestSessionAt?: Date;
  latestStatus?: string;
  sessionsCount: number;
  totalEvents: number;
  averageDurationMs: number;
}

export interface DashboardOverview {
  recentSessions: AgentTracingSessionSummary[];
  recentAgents: AgentTracingAgentSummary[];
  recentAgentsTotal: number;
  analytics: {
    totals: AgentTracingAggregateTotals;
    tools: {
      totals: {
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      };
      items: Array<{
        toolName: string;
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      }>;
    };
    statuses: Array<{
      status: string;
      count: number;
    }>;
    models: Array<{
      model: string;
      sessionsCount: number;
    }>;
    agents: AgentTracingAgentSummary[];
    daily: Array<{
      date: string;
      sessionsCount: number;
      totalEvents: number;
      totalTokens: number;
      averageDurationMs: number;
    }>;
  };
}

type SessionMetricsSource = {
  totalEvents?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCachedInputTokens?: number;
  durationMs?: number;
};

type AgentSummaryAccumulator = AgentTracingAgentSummary & {
  totalDurationMs: number;
};

function getSessionTokenSummary(session: SessionMetricsSource) {
  const totalInputTokens = session.totalInputTokens || 0;
  const totalOutputTokens = session.totalOutputTokens || 0;
  const totalCachedInputTokens = session.totalCachedInputTokens || 0;

  return {
    totalEvents: session.totalEvents || 0,
    totalInputTokens,
    totalOutputTokens,
    totalCachedInputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalDurationMs: session.durationMs || 0,
  };
}

function buildAggregateTotals(sessions: SessionMetricsSource[]): AgentTracingAggregateTotals {
  const totals = sessions.reduce(
    (aggregate, session) => {
      const sessionSummary = getSessionTokenSummary(session);

      aggregate.totalEvents += sessionSummary.totalEvents;
      aggregate.totalInputTokens += sessionSummary.totalInputTokens;
      aggregate.totalOutputTokens += sessionSummary.totalOutputTokens;
      aggregate.totalCachedInputTokens += sessionSummary.totalCachedInputTokens;
      aggregate.totalTokens += sessionSummary.totalTokens;
      aggregate.totalDurationMs += sessionSummary.totalDurationMs;

      return aggregate;
    },
    {
      totalEvents: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedInputTokens: 0,
      totalTokens: 0,
      totalDurationMs: 0,
    },
  );

  const sessionsCount = sessions.length;

  return {
    sessionsCount,
    totalEvents: totals.totalEvents,
    totalInputTokens: totals.totalInputTokens,
    totalOutputTokens: totals.totalOutputTokens,
    totalCachedInputTokens: totals.totalCachedInputTokens,
    totalTokens: totals.totalTokens,
    totalDurationMs: totals.totalDurationMs,
    averageInputTokensPerSession:
      sessionsCount > 0 ? Math.round(totals.totalInputTokens / sessionsCount) : 0,
    averageOutputTokensPerSession:
      sessionsCount > 0 ? Math.round(totals.totalOutputTokens / sessionsCount) : 0,
    averageCachedInputTokensPerSession:
      sessionsCount > 0 ? Math.round(totals.totalCachedInputTokens / sessionsCount) : 0,
    averageTokensPerSession:
      sessionsCount > 0 ? Math.round(totals.totalTokens / sessionsCount) : 0,
    averageDurationMs:
      sessionsCount > 0 ? Math.round(totals.totalDurationMs / sessionsCount) : 0,
  };
}

export class AgentTracingService {
  /**
   * List threads (grouped sessions by threadId)
   */
  static async listThreads(
    tenantDbName: string,
    projectId: string,
    filters?: {
      threadId?: string;
      agent?: string;
      status?: string;
      from?: string;
      to?: string;
      limit?: string;
      skip?: string;
    },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const result = await db.listAgentTracingThreads({
      threadId: filters?.threadId,
      agentName: filters?.agent,
      status: filters?.status,
      from: filters?.from,
      to: filters?.to,
      limit: filters?.limit || '50',
      skip: filters?.skip || '0',
    }, projectId);

    return result;
  }

  /**
   * Get thread detail - all sessions belonging to a threadId, with aggregated stats
   */
  static async getThreadDetail(
    tenantDbName: string,
    projectId: string,
    threadId: string,
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const { sessions } = await db.listAgentTracingSessions({
      threadId,
      limit: 1000,
    }, projectId);

    if (sessions.length === 0) {
      return null;
    }

    const sorted = sessions
      .slice()
      .sort(
        (a, b) =>
          new Date(a.startedAt || 0).getTime() -
          new Date(b.startedAt || 0).getTime(),
      );

    const agents = [...new Set(sorted.map((s) => s.agentName).filter(Boolean))] as string[];
    const statuses = sorted.map((s) => s.status || 'unknown');
    const hasError = statuses.includes('error');
    const allDone = statuses.every((s) => s === 'success' || s === 'error' || s === 'completed');
    const overallStatus = hasError ? 'error' : allDone ? 'success' : 'in_progress';

    const totalInputTokens = sorted.reduce((sum, s) => sum + (s.totalInputTokens || 0), 0);
    const totalOutputTokens = sorted.reduce((sum, s) => sum + (s.totalOutputTokens || 0), 0);
    const totalCachedInputTokens = sorted.reduce((sum, s) => sum + (s.totalCachedInputTokens || 0), 0);
    const totalEvents = sorted.reduce((sum, s) => sum + (s.totalEvents || 0), 0);
    const totalDurationMs = sorted.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const modelsUsed = [...new Set(sorted.flatMap((s) => s.modelsUsed || []))];
    const toolsUsed = [...new Set(sorted.flatMap((s) => s.toolsUsed || []))];

    return {
      threadId,
      status: overallStatus,
      agents,
      sessionsCount: sorted.length,
      startedAt: sorted[0]?.startedAt,
      endedAt: sorted[sorted.length - 1]?.endedAt,
      totalDurationMs,
      totalEvents,
      totalInputTokens,
      totalOutputTokens,
      totalCachedInputTokens,
      modelsUsed,
      toolsUsed,
      sessions: sorted.map((s) => ({
        sessionId: s.sessionId,
        agentName: s.agentName,
        agentVersion: s.agentVersion,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        totalEvents: s.totalEvents,
        totalTokens: (s.totalInputTokens || 0) + (s.totalOutputTokens || 0),
        totalInputTokens: s.totalInputTokens,
        totalOutputTokens: s.totalOutputTokens,
        modelsUsed: s.modelsUsed,
        toolsUsed: s.toolsUsed,
      })),
    };
  }

  /**
   * Get dashboard overview with analytics
   */
  static async getDashboardOverview(
    tenantDbName: string,
    projectId: string,
    filters?: { from?: string; to?: string; timezone?: string },
  ): Promise<DashboardOverview> {
    try {
      logger.debug('Getting dashboard overview', { tenantDbName, filters });

      const db = await getDatabase();
      await db.switchToTenant(tenantDbName);

      const query: SessionListQuery = {};
      if (filters?.from || filters?.to) {
        query.startedAt = {};
        if (filters.from) query.startedAt.$gte = new Date(filters.from);
        if (filters.to) query.startedAt.$lte = new Date(filters.to);
      }

      logger.debug('Fetching recent sessions...');
      // Get recent sessions
      const { sessions: recentSessions } = await db.listAgentTracingSessions({
        ...query,
        limit: 10,
        skip: 0,
      }, projectId);

      logger.debug('Recent sessions count', { count: recentSessions.length });

      // Aggregate analytics
      const allSessions = await db.listAgentTracingSessions({
        ...query,
        limit: 1000,
      }, projectId);
      const sessions = allSessions.sessions || [];

      logger.debug('Total sessions for analytics', { count: sessions.length });

      // If no sessions, return empty analytics
      if (sessions.length === 0) {
        logger.debug('No sessions found, returning empty analytics');
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

      // Calculate totals
      const totals = buildAggregateTotals(sessions);

      // Tool analytics
      const toolMap = new Map<
        string,
        { totalCalls: number; errorCalls: number; successCalls: number }
      >();
      sessions.forEach((session) => {
        (session.toolsUsed || []).forEach((tool) => {
          if (!toolMap.has(tool)) {
            toolMap.set(tool, {
              totalCalls: 0,
              errorCalls: 0,
              successCalls: 0,
            });
          }
          const toolStats = toolMap.get(tool)!;
          toolStats.totalCalls++;
          if (session.status === 'error') {
            toolStats.errorCalls++;
          } else {
            toolStats.successCalls++;
          }
        });
      });

      const toolItems = Array.from(toolMap.entries())
        .map(([toolName, stats]) => ({
          toolName,
          ...stats,
          errorRate:
            stats.totalCalls > 0 ? stats.errorCalls / stats.totalCalls : 0,
        }))
        .sort((a, b) => b.totalCalls - a.totalCalls);

      const toolTotals = {
        totalCalls: toolItems.reduce((sum, t) => sum + t.totalCalls, 0),
        errorCalls: toolItems.reduce((sum, t) => sum + t.errorCalls, 0),
        successCalls: toolItems.reduce((sum, t) => sum + t.successCalls, 0),
        errorRate: 0,
      };

      if (toolTotals.totalCalls > 0) {
        toolTotals.errorRate = toolTotals.errorCalls / toolTotals.totalCalls;
      }

      // Status breakdown
      const statusMap = new Map<string, number>();
      sessions.forEach((session) => {
        const status = session.status || 'unknown';
        statusMap.set(status, (statusMap.get(status) || 0) + 1);
      });

      const statuses = Array.from(statusMap.entries())
        .map(([status, count]) => ({
          status,
          count,
        }))
        .sort((a, b) => b.count - a.count);

      // Model breakdown
      const modelMap = new Map<string, number>();
      sessions.forEach((session) => {
        (session.modelsUsed || []).forEach((model) => {
          modelMap.set(model, (modelMap.get(model) || 0) + 1);
        });
      });

      const models = Array.from(modelMap.entries())
        .map(([model, sessionsCount]) => ({
          model,
          sessionsCount,
        }))
        .sort((a, b) => b.sessionsCount - a.sessionsCount);

      // Recent agents
      const agentMap = new Map<string, AgentSummaryAccumulator>();
      sessions.forEach((session) => {
        const agentName = session.agentName || 'unknown';
        const sessionSummary = getSessionTokenSummary(session);

        if (!agentMap.has(agentName)) {
          agentMap.set(agentName, {
            name: agentName,
            label: agentName,
            latestSessionAt: session.startedAt,
            latestStatus: session.status,
            sessionsCount: 0,
            totalEvents: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedInputTokens: 0,
            totalTokens: 0,
            averageInputTokensPerSession: 0,
            averageOutputTokensPerSession: 0,
            averageCachedInputTokensPerSession: 0,
            averageTokensPerSession: 0,
            averageDurationMs: 0,
            totalDurationMs: 0,
          });
        }
        const agent = agentMap.get(agentName)!;
        agent.sessionsCount++;
        agent.totalEvents += sessionSummary.totalEvents;
        agent.totalInputTokens += sessionSummary.totalInputTokens;
        agent.totalOutputTokens += sessionSummary.totalOutputTokens;
        agent.totalCachedInputTokens += sessionSummary.totalCachedInputTokens;
        agent.totalTokens += sessionSummary.totalTokens;
        agent.totalDurationMs += sessionSummary.totalDurationMs;
        if (!agent.latestSessionAt) {
          agent.latestSessionAt = session.startedAt;
          agent.latestStatus = session.status;
        } else if (session.startedAt && session.startedAt > agent.latestSessionAt) {
          agent.latestSessionAt = session.startedAt;
          agent.latestStatus = session.status;
        } else if (!agent.latestStatus && session.status) {
          agent.latestStatus = session.status;
        }
      });

      const agentSummaries = Array.from(agentMap.values()).map((agent) => ({
        ...agent,
        averageInputTokensPerSession:
          agent.sessionsCount > 0
            ? Math.round(agent.totalInputTokens / agent.sessionsCount)
            : 0,
        averageOutputTokensPerSession:
          agent.sessionsCount > 0
            ? Math.round(agent.totalOutputTokens / agent.sessionsCount)
            : 0,
        averageCachedInputTokensPerSession:
          agent.sessionsCount > 0
            ? Math.round(agent.totalCachedInputTokens / agent.sessionsCount)
            : 0,
        averageTokensPerSession:
          agent.sessionsCount > 0
            ? Math.round(agent.totalTokens / agent.sessionsCount)
            : 0,
        averageDurationMs:
          agent.sessionsCount > 0
            ? Math.round(agent.totalDurationMs / agent.sessionsCount)
            : 0,
      }));

      const toTime = (value?: Date) => (value ? value.getTime() : 0);
      const recentAgents = agentSummaries
        .sort((a, b) => toTime(b.latestSessionAt) - toTime(a.latestSessionAt))
        .slice(0, 20);
      const agentAnalytics = agentSummaries
        .slice()
        .sort(
          (a, b) =>
            b.totalTokens - a.totalTokens
            || b.sessionsCount - a.sessionsCount
            || a.name.localeCompare(b.name),
        );

      // Daily trend (last 30 days window)
      const dailyMap = new Map<
        string,
        {
          sessionsCount: number;
          totalEvents: number;
          totalTokens: number;
          totalDurationMs: number;
        }
      >();
      sessions.forEach((session) => {
        if (!session.startedAt) {
          return;
        }
        const dateKey = dayjs(session.startedAt).format('YYYY-MM-DD');
        if (!dailyMap.has(dateKey)) {
          dailyMap.set(dateKey, {
            sessionsCount: 0,
            totalEvents: 0,
            totalTokens: 0,
            totalDurationMs: 0,
          });
        }
        const entry = dailyMap.get(dateKey)!;
        entry.sessionsCount += 1;
        entry.totalEvents += session.totalEvents || 0;
        entry.totalTokens +=
          (session.totalInputTokens || 0) + (session.totalOutputTokens || 0);
        entry.totalDurationMs += session.durationMs || 0;
      });

      const daily = Array.from(dailyMap.entries())
        .sort((a, b) => dayjs(a[0]).valueOf() - dayjs(b[0]).valueOf())
        .map(([date, stats]) => ({
          date,
          sessionsCount: stats.sessionsCount,
          totalEvents: stats.totalEvents,
          totalTokens: stats.totalTokens,
          averageDurationMs:
            stats.sessionsCount > 0
              ? Math.round(stats.totalDurationMs / stats.sessionsCount)
              : 0,
        }))
        .slice(-30);

      return {
        recentSessions: recentSessions.map((s) => ({
          sessionId: s.sessionId,
          agentName: s.agentName,
          status: s.status,
          startedAt: s.startedAt,
          durationMs: s.durationMs,
          totalEvents: s.totalEvents,
          totalTokens: (s.totalInputTokens || 0) + (s.totalOutputTokens || 0),
        })),
        recentAgents,
        recentAgentsTotal: agentMap.size,
        analytics: {
          totals,
          tools: {
            totals: toolTotals,
            items: toolItems,
          },
          statuses,
          models,
          agents: agentAnalytics,
          daily,
        },
      };
    } catch (error) {
      logger.error('Error in getDashboardOverview', { error });
      throw error;
    }
  }

  /**
   * List sessions with filters
   */
  static async listSessions(
    tenantDbName: string,
    projectId: string,
    filters?: {
      query?: string;
      agent?: string;
      status?: string;
      from?: string;
      to?: string;
      limit?: string;
      skip?: string;
    },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const result = await db.listAgentTracingSessions({
      agentName: filters?.agent,
      status: filters?.status,
      from: filters?.from,
      to: filters?.to,
      limit: filters?.limit || '50',
      skip: filters?.skip || '0',
    }, projectId);

    return {
      sessions: result.sessions.map((s) => ({
        sessionId: s.sessionId,
        threadId: s.threadId,
        agentName: s.agentName,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        totalEvents: s.totalEvents,
        totalTokens: (s.totalInputTokens || 0) + (s.totalOutputTokens || 0),
        totalInputTokens: s.totalInputTokens,
        totalOutputTokens: s.totalOutputTokens,
        totalCachedInputTokens: s.totalCachedInputTokens,
      })),
      total: result.total,
    };
  }

  /**
   * Get session detail with events
   */
  static async getSessionDetail(
    tenantDbName: string,
    projectId: string,
    sessionId: string,
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const session = await db.findAgentTracingSessionById(sessionId, projectId);
    if (!session) {
      return null;
    }

    const events = await db.listAgentTracingEvents(sessionId, projectId);

    return {
      session: {
        sessionId: session.sessionId,
        threadId: session.threadId,
        traceId: session.traceId,
        rootSpanId: session.rootSpanId,
        source: session.source,
        agentName: session.agentName,
        agentVersion: session.agentVersion,
        agentModel: session.agentModel,
        status: session.status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
        totalEvents: session.totalEvents,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCachedInputTokens: session.totalCachedInputTokens,
        totalBytesIn: session.totalBytesIn,
        totalBytesOut: session.totalBytesOut,
        summary: session.summary,
        modelsUsed: session.modelsUsed,
        toolsUsed: session.toolsUsed,
        eventCounts: session.eventCounts,
        errors: session.errors,
      },
      events: events.map((e) => ({
        id: e.id || e._id,
        sequence: e.sequence,
        type: e.type,
        label: e.label,
        timestamp: e.timestamp,
        status: e.status,
        actor: e.actor,
        metadata: e.metadata,
        sections: e.sections,
        model: e.model,
        error: e.error,
        durationMs: e.durationMs,
        toolName: e.toolName,
        toolExecutionId: e.toolExecutionId,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        totalTokens: e.totalTokens,
        cachedInputTokens: e.cachedInputTokens,
        requestBytes: e.requestBytes,
        responseBytes: e.responseBytes,
        traceId: e.traceId,
        spanId: e.spanId,
        parentSpanId: e.parentSpanId,
        actorName: e.actorName,
        actorRole: e.actorRole,
      })),
    };
  }

  /**
   * Get agent overview with analytics
   */
  static async getAgentOverview(
    tenantDbName: string,
    projectId: string,
    agentName: string,
    filters?: { from?: string; to?: string; timezone?: string },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const query: SessionListQuery = { agentName };
    if (filters?.from || filters?.to) {
      query.from = filters.from;
      query.to = filters.to;
    }

    const { sessions } = await db.listAgentTracingSessions({
      ...query,
      limit: 1000,
    }, projectId);

    if (sessions.length === 0) {
      return {
        agent: {
          name: agentName,
          label: agentName,
          latestStatus: null,
          latestVersion: null,
          latestSessionAt: null,
          versions: [],
          sessionsCount: 0,
        },
        recentSessions: [],
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
          versions: [],
          daily: [],
        },
      };
    }

    const sortedSessions = sessions
      .slice()
      .sort(
        (a, b) =>
          new Date(b.startedAt || 0).getTime() -
          new Date(a.startedAt || 0).getTime(),
      );

    const totals = buildAggregateTotals(sessions);

    const recentSessions = sortedSessions.slice(0, 10).map((s) => ({
      sessionId: s.sessionId,
      threadId: s.threadId,
      status: s.status,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      totalEvents: s.totalEvents,
      totalTokens: (s.totalInputTokens || 0) + (s.totalOutputTokens || 0),
    }));

    // Agent info
    const latestSession = sortedSessions[0];
    const agent = {
      name: agentName,
      label: agentName,
      latestStatus: latestSession?.status || null,
      latestVersion: latestSession?.agentVersion || null,
      latestSessionAt: latestSession?.startedAt || null,
      versions: Array.from(
        new Set(sortedSessions.map((s) => s.agentVersion).filter(Boolean)),
      ),
      sessionsCount: sessions.length,
    };

    // Status breakdown
    const statusMap = new Map<string, number>();
    sortedSessions.forEach((session) => {
      const status = session.status || 'unknown';
      statusMap.set(status, (statusMap.get(status) || 0) + 1);
    });
    const statuses = Array.from(statusMap.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    // Versions breakdown
    const versionMap = new Map<string, number>();
    sortedSessions.forEach((session) => {
      const version = session.agentVersion || 'unknown';
      versionMap.set(version, (versionMap.get(version) || 0) + 1);
    });
    const versions = Array.from(versionMap.entries())
      .map(([version, sessionsCount]) => ({
        version: version === 'unknown' ? null : version,
        sessionsCount,
      }))
      .sort((a, b) => b.sessionsCount - a.sessionsCount);

    // Model usage
    const modelMap = new Map<string, number>();
    sortedSessions.forEach((session) => {
      (session.modelsUsed || []).forEach((model) => {
        modelMap.set(model, (modelMap.get(model) || 0) + 1);
      });
    });
    const models = Array.from(modelMap.entries())
      .map(([model, sessionsCount]) => ({ model, sessionsCount }))
      .sort((a, b) => b.sessionsCount - a.sessionsCount);

    // Tool analytics
    const toolMap = new Map<
      string,
      { totalCalls: number; errorCalls: number; successCalls: number }
    >();
    sortedSessions.forEach((session) => {
      (session.toolsUsed || []).forEach((tool) => {
        if (!toolMap.has(tool)) {
          toolMap.set(tool, { totalCalls: 0, errorCalls: 0, successCalls: 0 });
        }
        const toolStats = toolMap.get(tool)!;
        toolStats.totalCalls++;
        if (session.status === 'error') {
          toolStats.errorCalls++;
        } else {
          toolStats.successCalls++;
        }
      });
    });

    const toolItems = Array.from(toolMap.entries())
      .map(([toolName, stats]) => ({
        toolName,
        ...stats,
        errorRate:
          stats.totalCalls > 0 ? stats.errorCalls / stats.totalCalls : 0,
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls);

    const toolTotals = {
      totalCalls: toolItems.reduce((sum, t) => sum + t.totalCalls, 0),
      errorCalls: toolItems.reduce((sum, t) => sum + t.errorCalls, 0),
      successCalls: toolItems.reduce((sum, t) => sum + t.successCalls, 0),
      errorRate: 0,
    };
    if (toolTotals.totalCalls > 0) {
      toolTotals.errorRate = toolTotals.errorCalls / toolTotals.totalCalls;
    }

    // Daily trend
    const dailyMap = new Map<
      string,
      {
        sessionsCount: number;
        totalEvents: number;
        totalTokens: number;
        totalDurationMs: number;
      }
    >();
    sortedSessions.forEach((session) => {
      if (!session.startedAt) {
        return;
      }
      const dateKey = dayjs(session.startedAt).format('YYYY-MM-DD');
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          sessionsCount: 0,
          totalEvents: 0,
          totalTokens: 0,
          totalDurationMs: 0,
        });
      }
      const entry = dailyMap.get(dateKey)!;
      entry.sessionsCount += 1;
      entry.totalEvents += session.totalEvents || 0;
      entry.totalTokens +=
        (session.totalInputTokens || 0) + (session.totalOutputTokens || 0);
      entry.totalDurationMs += session.durationMs || 0;
    });

    const daily = Array.from(dailyMap.entries())
      .sort((a, b) => dayjs(a[0]).valueOf() - dayjs(b[0]).valueOf())
      .map(([date, stats]) => ({
        date,
        sessionsCount: stats.sessionsCount,
        totalEvents: stats.totalEvents,
        totalTokens: stats.totalTokens,
        averageDurationMs:
          stats.sessionsCount > 0
            ? Math.round(stats.totalDurationMs / stats.sessionsCount)
            : 0,
      }))
      .slice(-30);

    return {
      agent,
      recentSessions,
      analytics: {
        totals: {
          sessionsCount: totals.sessionsCount,
          totalEvents: totals.totalEvents,
          totalTokens: totals.totalTokens,
          totalDurationMs: totals.totalDurationMs,
          averageTokensPerSession: totals.averageTokensPerSession,
          averageDurationMs: totals.averageDurationMs,
        },
        tools: {
          totals: toolTotals,
          items: toolItems,
        },
        statuses,
        models,
        versions,
        daily,
      },
    };
  }
}
