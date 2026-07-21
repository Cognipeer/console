/**
 * Client Monitoring API plugin.
 *
 * Read-only inference-server metrics summary for token callers. Inference
 * servers are tenant-scoped (NOT project-scoped). RBAC (see ROUTE_PREFIXES →
 * service 'inference-monitoring', an admin service) restricts this to
 * owner/admin tokens or tokens with an explicit `inference-monitoring:read`
 * grant. `sanitizeServer` strips the stored `apiKey` from every echoed server.
 *
 * The summary reduction is REPLICATED from the dashboard plugin
 * (`inference-monitoring.ts` GET /inference-monitoring/dashboard) — that math
 * lives in the handler, not the service, so it is copied here rather than
 * shared, and re-emitted as snake_case for the token API.
 *
 *   GET /client/v1/monitoring/inference  – per-server latest metrics + overview
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';
import { sanitizeServer } from '@/lib/services/inferenceMonitoring/utils';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import { sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-monitoring');

export const clientMonitoringApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/monitoring/inference', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);

      const servers = await InferenceMonitoringService.listServers(
        auth.tenantDbName,
        auth.tenantId,
      );

      const serverMetrics = await Promise.all(
        servers.map(async (server) => {
          const safe = sanitizeServer(server);
          const base = {
            key: safe.key,
            lastError: safe.lastError,
            lastPolledAt: safe.lastPolledAt,
            name: safe.name,
            status: safe.status,
            type: safe.type,
          };
          try {
            const metrics = await InferenceMonitoringService.getMetrics(
              auth.tenantDbName,
              server.key,
              {
                from: filter.from?.toISOString(),
                limit: 1,
                to: filter.to?.toISOString(),
              },
            );
            return { ...base, latestMetrics: metrics[0] ?? null };
          } catch {
            return { ...base, latestMetrics: null };
          }
        }),
      );

      // ── Reduction copied from inference-monitoring.ts dashboard handler ──
      const hasDateFilter = Boolean(filter.from || filter.to);
      const scopedServers = hasDateFilter
        ? serverMetrics.filter((server) => Boolean(server.latestMetrics))
        : serverMetrics;

      const activeWithMetrics = scopedServers.filter(
        (server) => server.status === 'active' && server.latestMetrics,
      );
      const avgGpuCacheUsage = activeWithMetrics.length > 0
        ? activeWithMetrics.reduce(
          (sum, server) => sum + (server.latestMetrics?.gpuCacheUsagePercent ?? 0),
          0,
        ) / activeWithMetrics.length
        : null;

      const typeMap = new Map<string, number>();
      for (const server of scopedServers) {
        typeMap.set(server.type, (typeMap.get(server.type) ?? 0) + 1);
      }

      return reply.code(200).send({
        object: 'monitoring.inference',
        overview: {
          active_servers: scopedServers.filter((server) => server.status === 'active').length,
          avg_gpu_cache_usage: avgGpuCacheUsage,
          disabled_servers: scopedServers.filter((server) => server.status === 'disabled').length,
          errored_servers: scopedServers.filter((server) => server.status === 'errored').length,
          running_models_count: Array.from(
            new Set(activeWithMetrics.flatMap((server) => server.latestMetrics?.runningModels ?? [])),
          ).length,
          total_running_requests: activeWithMetrics.reduce(
            (sum, server) => sum + (server.latestMetrics?.numRequestsRunning ?? 0),
            0,
          ),
          total_servers: scopedServers.length,
          total_waiting_requests: activeWithMetrics.reduce(
            (sum, server) => sum + (server.latestMetrics?.numRequestsWaiting ?? 0),
            0,
          ),
        },
        servers: scopedServers.map((server) => ({
          key: server.key,
          name: server.name,
          type: server.type,
          status: server.status,
          last_error: server.lastError ?? null,
          last_polled_at: server.lastPolledAt ?? null,
          latest_metrics: server.latestMetrics
            ? {
              generation_tokens_throughput: server.latestMetrics.generationTokensThroughput,
              gpu_cache_usage_percent: server.latestMetrics.gpuCacheUsagePercent,
              num_requests_running: server.latestMetrics.numRequestsRunning,
              num_requests_waiting: server.latestMetrics.numRequestsWaiting,
              prompt_tokens_throughput: server.latestMetrics.promptTokensThroughput,
              requests_per_second: server.latestMetrics.requestsPerSecond,
              running_models: server.latestMetrics.runningModels ?? [],
              time_to_first_token_seconds: server.latestMetrics.timeToFirstTokenSeconds,
              timestamp: server.latestMetrics.timestamp,
            }
            : null,
        })),
        type_breakdown: Array.from(typeMap.entries()).map(([type, count]) => ({ count, type })),
      });
    } catch (error) {
      logger.error('Client inference monitoring error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
