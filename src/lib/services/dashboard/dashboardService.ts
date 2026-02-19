/**
 * Dashboard Service
 * Aggregates data from various services for the main dashboard
 */

import { getDatabase } from '@/lib/database';
import type { AgentTracingSessionSummary } from '@/lib/services/agentTracing';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { listModels } from '@/lib/services/models/modelService';
import { listVectorProviders, listVectorIndexes } from '@/lib/services/vector/vectorService';
import { isDateInDashboardRange } from '@/lib/utils/dashboardDateFilter';

export interface DashboardStats {
  models: {
    total: number;
    llm: number;
    embedding: number;
  };
  vectors: {
    providers: number;
    indexes: number;
  };
  tracing: {
    totalSessions: number;
    totalTokens: number;
    activeSessions: number;
  };
  apiCalls: {
    total: number;
    trend: number; // percentage change
  };
}

export interface RecentActivity {
  id: string;
  type: 'chat' | 'embedding' | 'vector' | 'agent';
  service: string;
  endpoint: string;
  status: 'success' | 'error';
  timestamp: Date;
  details?: string;
}

export interface DashboardData {
  stats: DashboardStats;
  recentActivity: RecentActivity[];
  recentSessions: AgentTracingSessionSummary[];
  daily: Array<{
    date: string;
    sessionsCount: number;
    totalTokens: number;
  }>;
}

interface DashboardDateFilterInput {
  from?: Date;
  to?: Date;
}

export async function getDashboardData(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  dateFilter?: DashboardDateFilterInput,
): Promise<DashboardData> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const filter = {
    from: dateFilter?.from,
    to: dateFilter?.to,
  };

  // Fetch models
  const models = await listModels(tenantDbName, projectId, {});
  const filteredModels = models.filter((model) =>
    isDateInDashboardRange(model.createdAt, filter),
  );
  const llmModels = filteredModels.filter((m) => m.category === 'llm');
  const embeddingModels = filteredModels.filter((m) => m.category === 'embedding');

  // Fetch vector providers and indexes
  const vectorProviders = await listVectorProviders(tenantDbName, tenantId, projectId, {});
  const filteredProviders = vectorProviders.filter((provider) =>
    isDateInDashboardRange(provider.createdAt, filter),
  );
  let totalIndexes = 0;
  for (const provider of vectorProviders) {
    try {
      const indexes = await listVectorIndexes(tenantDbName, tenantId, provider.key, projectId);
      totalIndexes += indexes.filter((index) => isDateInDashboardRange(index.createdAt, filter)).length;
    } catch (error) {
      console.warn('Failed to list vector indexes for provider', provider.key, error);
    }
  }

  // Fetch tracing analytics
  const tracingOverview = await AgentTracingService.getDashboardOverview(
    tenantDbName,
    projectId,
    {
      from: filter.from?.toISOString(),
      to: filter.to?.toISOString(),
    },
  );

  // Get active sessions (sessions with status 'running')
  const activeSessions = tracingOverview.recentSessions.filter(
    (s) => s.status === 'running',
  ).length;

  // Build recent activity from tracing sessions
  const recentActivity: RecentActivity[] = tracingOverview.recentSessions
    .slice(0, 10)
    .map((session) => ({
      id: session.sessionId,
      type: 'agent' as const,
      service: session.agentName || 'Agent',
      endpoint: `/api/tracing/sessions/${session.sessionId}`,
      status: session.status === 'error' ? 'error' : 'success',
      timestamp: session.startedAt ? new Date(session.startedAt) : new Date(),
    }));

  // Calculate API calls trend
  const daily = tracingOverview.analytics.daily || [];
  let trend = 0;
  if (daily.length >= 2) {
    const currentWeek = daily.slice(-7).reduce((sum, d) => sum + d.sessionsCount, 0);
    const previousWeek = daily.slice(-14, -7).reduce((sum, d) => sum + d.sessionsCount, 0);
    if (previousWeek > 0) {
      trend = ((currentWeek - previousWeek) / previousWeek) * 100;
    }
  }

  return {
    stats: {
      models: {
        total: filteredModels.length,
        llm: llmModels.length,
        embedding: embeddingModels.length,
      },
      vectors: {
        providers: filteredProviders.length,
        indexes: totalIndexes,
      },
      tracing: {
        totalSessions: tracingOverview.analytics.totals.sessionsCount,
        totalTokens: tracingOverview.analytics.totals.totalTokens,
        activeSessions,
      },
      apiCalls: {
        total: tracingOverview.analytics.totals.sessionsCount,
        trend: Math.round(trend * 10) / 10,
      },
    },
    recentActivity,
    recentSessions: tracingOverview.recentSessions,
    daily: daily.map((d) => ({
      date: d.date,
      sessionsCount: d.sessionsCount,
      totalTokens: d.totalTokens,
    })),
  };
}
