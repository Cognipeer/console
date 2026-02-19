import { NextRequest, NextResponse } from 'next/server';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantDbName || !tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const filter = parseDashboardDateFilterFromSearchParams(
      request.nextUrl.searchParams,
    );

    const servers = await InferenceMonitoringService.listServers(tenantDbName, tenantId);

    // Fetch latest metrics for each active server
    const serverMetrics = await Promise.all(
      servers.map(async (server) => {
        try {
          const metrics = await InferenceMonitoringService.getMetrics(
            tenantDbName,
            server.key,
            {
              from: filter.from?.toISOString(),
              to: filter.to?.toISOString(),
              limit: 1,
            },
          );
          const latest = metrics[0] ?? null;
          return {
            key: server.key,
            name: server.name,
            type: server.type,
            status: server.status,
            lastPolledAt: server.lastPolledAt,
            lastError: server.lastError,
            latestMetrics: latest
              ? {
                  gpuCacheUsagePercent: latest.gpuCacheUsagePercent,
                  numRequestsRunning: latest.numRequestsRunning,
                  numRequestsWaiting: latest.numRequestsWaiting,
                  promptTokensThroughput: latest.promptTokensThroughput,
                  generationTokensThroughput: latest.generationTokensThroughput,
                  timeToFirstTokenSeconds: latest.timeToFirstTokenSeconds,
                  requestsPerSecond: latest.requestsPerSecond,
                  runningModels: latest.runningModels ?? [],
                  timestamp: latest.timestamp,
                }
              : null,
          };
        } catch {
          return {
            key: server.key,
            name: server.name,
            type: server.type,
            status: server.status,
            lastPolledAt: server.lastPolledAt,
            lastError: server.lastError,
            latestMetrics: null,
          };
        }
      }),
    );

    const hasDateFilter = Boolean(filter.from || filter.to);
    const scopedServers = hasDateFilter
      ? serverMetrics.filter((server) => Boolean(server.latestMetrics))
      : serverMetrics;

    const activeServers = scopedServers.filter((s) => s.status === 'active').length;
    const erroredServers = scopedServers.filter((s) => s.status === 'errored').length;
    const disabledServers = scopedServers.filter((s) => s.status === 'disabled').length;

    // Aggregate averages from latest snapshots for active servers
    const activeWithMetrics = scopedServers.filter(
      (s) => s.status === 'active' && s.latestMetrics,
    );

    const avgGpuCacheUsage =
      activeWithMetrics.length > 0
        ? activeWithMetrics.reduce(
            (sum, s) => sum + (s.latestMetrics?.gpuCacheUsagePercent ?? 0),
            0,
          ) / activeWithMetrics.length
        : null;

    const totalRunningRequests = activeWithMetrics.reduce(
      (sum, s) => sum + (s.latestMetrics?.numRequestsRunning ?? 0),
      0,
    );
    const totalWaitingRequests = activeWithMetrics.reduce(
      (sum, s) => sum + (s.latestMetrics?.numRequestsWaiting ?? 0),
      0,
    );

    const allRunningModels = Array.from(
      new Set(
        activeWithMetrics.flatMap((s) => s.latestMetrics?.runningModels ?? []),
      ),
    );

    // Type breakdown
    const typeMap = new Map<string, number>();
    for (const server of scopedServers) {
      typeMap.set(server.type, (typeMap.get(server.type) ?? 0) + 1);
    }
    const typeBreakdown = Array.from(typeMap.entries()).map(([type, count]) => ({ type, count }));

    return NextResponse.json({
      overview: {
        totalServers: scopedServers.length,
        activeServers,
        erroredServers,
        disabledServers,
        avgGpuCacheUsage,
        totalRunningRequests,
        totalWaitingRequests,
        runningModelsCount: allRunningModels.length,
      },
      typeBreakdown,
      servers: scopedServers,
    });
  } catch (error: unknown) {
    console.error('[inference-monitoring/dashboard] error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
