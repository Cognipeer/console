/**
 * Agent Tracing Service
 * Business logic for agent tracing operations
 */

import {
  getDatabase,
  IAgentTracingSession,
  IAgentTracingEvent,
} from '@/lib/database';
import dayjs from 'dayjs';

export interface DashboardOverview {
  recentSessions: any[];
  recentAgents: any[];
  recentAgentsTotal: number;
  analytics: {
    totals: {
      sessionsCount: number;
      totalEvents: number;
      totalTokens: number;
      totalDurationMs: number;
      averageTokensPerSession: number;
      averageDurationMs: number;
    };
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
    daily: Array<{
      date: string;
      sessionsCount: number;
      totalEvents: number;
      totalTokens: number;
      averageDurationMs: number;
    }>;
  };
}

export class AgentTracingService {
  /**
   * Get dashboard overview with analytics
   */
  static async getDashboardOverview(
    tenantDbName: string,
    projectId: string,
    filters?: { from?: string; to?: string; timezone?: string },
  ): Promise<DashboardOverview> {
    try {
      console.log(
        'Getting dashboard overview for tenant:',
        tenantDbName,
        'filters:',
        filters,
      );

      const db = await getDatabase();
      await db.switchToTenant(tenantDbName);

      const query: any = {};
      if (filters?.from || filters?.to) {
        query.startedAt = {};
        if (filters.from) query.startedAt.$gte = new Date(filters.from);
        if (filters.to) query.startedAt.$lte = new Date(filters.to);
      }

      console.log('Fetching recent sessions...');
      // Get recent sessions
      const { sessions: recentSessions } = await db.listAgentTracingSessions({
        ...query,
        limit: 10,
        skip: 0,
      }, projectId);

      console.log('Recent sessions count:', recentSessions.length);

      // Aggregate analytics
      const allSessions = await db.listAgentTracingSessions({
        ...query,
        limit: 1000,
      }, projectId);
      const sessions = allSessions.sessions || [];

      console.log('Total sessions for analytics:', sessions.length);

      // If no sessions, return empty analytics
      if (sessions.length === 0) {
        console.log('No sessions found, returning empty analytics');
        return {
          recentSessions: [],
          recentAgents: [],
          recentAgentsTotal: 0,
          analytics: {
            totals: {
              sessionsCount: 0,
              totalEvents: 0,
              totalTokens: 0,
              totalDurationMs: 0,
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
            daily: [],
          },
        };
      }

      // Calculate totals
      const totals = {
        sessionsCount: sessions.length,
        totalEvents: sessions.reduce((sum, s) => sum + (s.totalEvents || 0), 0),
        totalTokens: sessions.reduce(
          (sum, s) =>
            sum + ((s.totalInputTokens || 0) + (s.totalOutputTokens || 0)),
          0,
        ),
        totalDurationMs: sessions.reduce(
          (sum, s) => sum + (s.durationMs || 0),
          0,
        ),
        averageTokensPerSession: 0,
        averageDurationMs: 0,
      };

      if (totals.sessionsCount > 0) {
        totals.averageTokensPerSession = Math.round(
          totals.totalTokens / totals.sessionsCount,
        );
        totals.averageDurationMs = Math.round(
          totals.totalDurationMs / totals.sessionsCount,
        );
      }

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
      const agentMap = new Map<string, any>();
      sessions.forEach((session) => {
        const agentName = session.agentName || 'unknown';
        if (!agentMap.has(agentName)) {
          agentMap.set(agentName, {
            name: agentName,
            label: agentName,
            latestSessionAt: session.startedAt,
            sessionsCount: 0,
          });
        }
        const agent = agentMap.get(agentName)!;
        agent.sessionsCount++;
        if (session.startedAt && session.startedAt > agent.latestSessionAt) {
          agent.latestSessionAt = session.startedAt;
        }
      });

      const recentAgents = Array.from(agentMap.values())
        .sort(
          (a, b) =>
            new Date(b.latestSessionAt).getTime() -
            new Date(a.latestSessionAt).getTime(),
        )
        .slice(0, 20);

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
          daily,
        },
      };
    } catch (error) {
      console.error('Error in getDashboardOverview:', error);
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
  static async getSessionDetail(tenantDbName: string, projectId: string, sessionId: string) {
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
        agentName: session.agentName,
        agentVersion: session.agentVersion,
        status: session.status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
        totalEvents: session.totalEvents,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCachedInputTokens: session.totalCachedInputTokens,
        summary: session.summary,
        modelsUsed: session.modelsUsed,
        toolsUsed: session.toolsUsed,
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
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cachedInputTokens: e.cachedInputTokens,
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

    const query: any = { agentName };
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
            totalTokens: 0,
            totalDurationMs: 0,
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

    const totals = {
      sessionsCount: sessions.length,
      totalEvents: sessions.reduce((sum, s) => sum + (s.totalEvents || 0), 0),
      totalTokens: sessions.reduce(
        (sum, s) =>
          sum + ((s.totalInputTokens || 0) + (s.totalOutputTokens || 0)),
        0,
      ),
      totalDurationMs: sessions.reduce(
        (sum, s) => sum + (s.durationMs || 0),
        0,
      ),
      averageTokensPerSession: 0,
      averageDurationMs: 0,
    };

    if (totals.sessionsCount > 0) {
      totals.averageTokensPerSession = Math.round(
        totals.totalTokens / totals.sessionsCount,
      );
      totals.averageDurationMs = Math.round(
        totals.totalDurationMs / totals.sessionsCount,
      );
    }

    const recentSessions = sortedSessions.slice(0, 10).map((s) => ({
      sessionId: s.sessionId,
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
