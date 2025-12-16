/**
 * Dashboard Service
 * Aggregates data from various services for the main dashboard
 */

import { getDatabase } from '@/lib/database';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { listModels } from '@/lib/services/models/modelService';
import { listVectorProviders, listVectorIndexes } from '@/lib/services/vector/vectorService';

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
  recentSessions: any[];
  daily: Array<{
    date: string;
    sessionsCount: number;
    totalTokens: number;
  }>;
}

export async function getDashboardData(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
): Promise<DashboardData> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  // Fetch models
  const models = await listModels(tenantDbName, projectId, {});
  const llmModels = models.filter((m) => m.category === 'llm');
  const embeddingModels = models.filter((m) => m.category === 'embedding');

  // Fetch vector providers and indexes
  const vectorProviders = await listVectorProviders(tenantDbName, tenantId, projectId, {});
  let totalIndexes = 0;
  for (const provider of vectorProviders) {
    try {
      const indexes = await listVectorIndexes(tenantDbName, tenantId, provider.key, projectId);
      totalIndexes += indexes.length;
    } catch (e) {
      // Provider may not be accessible
    }
  }

  // Fetch tracing analytics
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const tracingOverview = await AgentTracingService.getDashboardOverview(
    tenantDbName,
    projectId,
    {
      from: thirtyDaysAgo.toISOString(),
      to: now.toISOString(),
    },
  );

  // Get active sessions (sessions with status 'running')
  const activeSessions = tracingOverview.recentSessions.filter(
    (s: any) => s.status === 'running',
  ).length;

  // Build recent activity from tracing sessions
  const recentActivity: RecentActivity[] = tracingOverview.recentSessions
    .slice(0, 10)
    .map((session: any) => ({
      id: session._id?.toString() || session.sessionId,
      type: 'agent' as const,
      service: session.agentName || 'Agent',
      endpoint: `/api/tracing/sessions/${session.sessionId}`,
      status: session.status === 'error' ? 'error' : 'success',
      timestamp: new Date(session.startedAt),
      details: session.modelsUsed?.join(', '),
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
        total: models.length,
        llm: llmModels.length,
        embedding: embeddingModels.length,
      },
      vectors: {
        providers: vectorProviders.length,
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
