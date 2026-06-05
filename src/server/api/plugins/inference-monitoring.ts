import type { FastifyPluginAsync } from 'fastify';
import type { IInferenceServer } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';
import { normalizeBaseUrl, sanitizeServer } from '@/lib/services/inferenceMonitoring/utils';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import {
  readJsonBody,
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:inference-monitoring');
const SUPPORTED_TYPES: Array<IInferenceServer['type']> = ['vllm', 'llamacpp'];

export const inferenceMonitoringApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/inference-monitoring/servers', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const servers = await InferenceMonitoringService.listServers(
        session.tenantDbName,
        session.tenantId,
      );

      return reply.code(200).send({ servers: servers.map(sanitizeServer) });
    } catch (error) {
      logger.error('List inference servers error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to list servers',
      });
    }
  }));

  app.post('/inference-monitoring/servers', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (
        typeof body.name !== 'string'
        || typeof body.type !== 'string'
        || typeof body.baseUrl !== 'string'
      ) {
        return reply.code(400).send({ error: 'name, type, and baseUrl are required' });
      }

      if (!SUPPORTED_TYPES.includes(body.type as IInferenceServer['type'])) {
        return reply.code(400).send({
          error: `Unsupported server type. Supported types: ${SUPPORTED_TYPES.join(', ')}`,
        });
      }

      const normalizedBaseUrl = normalizeBaseUrl(body.baseUrl);
      if (!normalizedBaseUrl) {
        return reply.code(400).send({
          error: 'Invalid base URL. Must be a valid HTTP/HTTPS URL.',
        });
      }

      const server = await InferenceMonitoringService.createServer(
        session.tenantDbName,
        session.tenantId,
        {
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
          baseUrl: normalizedBaseUrl,
          name: body.name.slice(0, 200),
          pollIntervalSeconds: Math.max(
            10,
            Math.min(3600, Number(body.pollIntervalSeconds) || 60),
          ),
          type: body.type as IInferenceServer['type'],
        },
        session.userId,
      );

      return reply.code(201).send({ server: sanitizeServer(server) });
    } catch (error) {
      logger.error('Create inference server error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to create server',
      });
    }
  }));

  app.get('/inference-monitoring/servers/:serverKey', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { serverKey } = request.params as { serverKey: string };
      const server = await InferenceMonitoringService.getServerByKey(
        session.tenantDbName,
        session.tenantId,
        serverKey,
      );

      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      return reply.code(200).send({ server: sanitizeServer(server) });
    } catch (error) {
      logger.error('Get inference server error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to get server',
      });
    }
  }));

  app.put('/inference-monitoring/servers/:serverKey', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { serverKey } = request.params as { serverKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      const normalizedBaseUrl = typeof body.baseUrl === 'string'
        ? normalizeBaseUrl(body.baseUrl)
        : undefined;

      if (body.baseUrl !== undefined && typeof body.baseUrl === 'string' && !normalizedBaseUrl) {
        return reply.code(400).send({
          error: 'Invalid base URL. Must be a valid HTTP/HTTPS URL.',
        });
      }

      if (body.status !== undefined && body.status !== 'active' && body.status !== 'disabled') {
        return reply.code(400).send({
          error: 'Invalid status. Must be "active" or "disabled".',
        });
      }

      const update: Partial<Pick<IInferenceServer, 'apiKey' | 'baseUrl' | 'name' | 'pollIntervalSeconds' | 'status'>> = {};
      if (typeof body.name === 'string') {
        update.name = body.name.slice(0, 200);
      }
      if (typeof body.baseUrl === 'string') {
        update.baseUrl = normalizedBaseUrl!;
      }
      if (body.apiKey !== undefined) {
        update.apiKey = body.apiKey ? String(body.apiKey) : undefined;
      }
      if (body.pollIntervalSeconds !== undefined) {
        update.pollIntervalSeconds = Math.max(10, Math.min(3600, Number(body.pollIntervalSeconds) || 60));
      }
      if (body.status !== undefined) {
        update.status = body.status as IInferenceServer['status'];
      }

      const server = await InferenceMonitoringService.updateServer(
        session.tenantDbName,
        session.tenantId,
        serverKey,
        update,
        session.userId,
      );

      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      return reply.code(200).send({ server: sanitizeServer(server) });
    } catch (error) {
      logger.error('Update inference server error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to update server',
      });
    }
  }));

  app.delete('/inference-monitoring/servers/:serverKey', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { serverKey } = request.params as { serverKey: string };
      const deleted = await InferenceMonitoringService.deleteServer(
        session.tenantDbName,
        session.tenantId,
        serverKey,
      );

      if (!deleted) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete inference server error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to delete server',
      });
    }
  }));

  app.post('/inference-monitoring/servers/:serverKey/poll', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { serverKey } = request.params as { serverKey: string };
      const metrics = await InferenceMonitoringService.pollServer(
        session.tenantDbName,
        session.tenantId,
        serverKey,
      );

      return reply.code(200).send({ metrics });
    } catch (error) {
      logger.error('Poll inference server error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to poll server',
      });
    }
  }));

  app.get('/inference-monitoring/servers/:serverKey/metrics', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { serverKey } = request.params as { serverKey: string };
      const server = await InferenceMonitoringService.getServerByKey(
        session.tenantDbName,
        session.tenantId,
        serverKey,
      );

      if (!server) {
        return reply.code(404).send({ error: 'Server not found' });
      }

      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);
      const metrics = await InferenceMonitoringService.getMetrics(
        session.tenantDbName,
        serverKey,
        {
          from: searchParams.get('from') || filter.from?.toISOString(),
          limit: searchParams.get('limit') ? Number.parseInt(searchParams.get('limit')!, 10) : 500,
          to: searchParams.get('to') || filter.to?.toISOString(),
        },
      );

      return reply.code(200).send({ metrics });
    } catch (error) {
      logger.error('Get inference server metrics error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to get metrics',
      });
    }
  }));

  app.get('/inference-monitoring/dashboard', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);
      const servers = await InferenceMonitoringService.listServers(
        session.tenantDbName,
        session.tenantId,
      );

      const serverMetrics = await Promise.all(
        servers.map(async (server) => {
          try {
            const metrics = await InferenceMonitoringService.getMetrics(
              session.tenantDbName,
              server.key,
              {
                from: filter.from?.toISOString(),
                limit: 1,
                to: filter.to?.toISOString(),
              },
            );
            const latestMetrics = metrics[0] ?? null;

            return {
              key: server.key,
              lastError: server.lastError,
              lastPolledAt: server.lastPolledAt,
              latestMetrics: latestMetrics
                ? {
                  generationTokensThroughput: latestMetrics.generationTokensThroughput,
                  gpuCacheUsagePercent: latestMetrics.gpuCacheUsagePercent,
                  numRequestsRunning: latestMetrics.numRequestsRunning,
                  numRequestsWaiting: latestMetrics.numRequestsWaiting,
                  promptTokensThroughput: latestMetrics.promptTokensThroughput,
                  requestsPerSecond: latestMetrics.requestsPerSecond,
                  runningModels: latestMetrics.runningModels ?? [],
                  timeToFirstTokenSeconds: latestMetrics.timeToFirstTokenSeconds,
                  timestamp: latestMetrics.timestamp,
                }
                : null,
              name: server.name,
              status: server.status,
              type: server.type,
            };
          } catch {
            return {
              key: server.key,
              lastError: server.lastError,
              lastPolledAt: server.lastPolledAt,
              latestMetrics: null,
              name: server.name,
              status: server.status,
              type: server.type,
            };
          }
        }),
      );

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
        overview: {
          activeServers: scopedServers.filter((server) => server.status === 'active').length,
          avgGpuCacheUsage,
          disabledServers: scopedServers.filter((server) => server.status === 'disabled').length,
          erroredServers: scopedServers.filter((server) => server.status === 'errored').length,
          runningModelsCount: Array.from(
            new Set(activeWithMetrics.flatMap((server) => server.latestMetrics?.runningModels ?? [])),
          ).length,
          totalRunningRequests: activeWithMetrics.reduce(
            (sum, server) => sum + (server.latestMetrics?.numRequestsRunning ?? 0),
            0,
          ),
          totalServers: scopedServers.length,
          totalWaitingRequests: activeWithMetrics.reduce(
            (sum, server) => sum + (server.latestMetrics?.numRequestsWaiting ?? 0),
            0,
          ),
        },
        servers: scopedServers,
        typeBreakdown: Array.from(typeMap.entries()).map(([type, count]) => ({ count, type })),
      });
    } catch (error) {
      logger.error('Inference monitoring dashboard error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
