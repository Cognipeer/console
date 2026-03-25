import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { requireApiTokenFromHeader, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { collectPrometheusMetrics } from '@/lib/services/metrics/prometheusExporter';
import {
  getHeaderValue,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('metrics');

export const metricsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/metrics', withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await requireApiTokenFromHeader(
        getHeaderValue(request, 'authorization'),
      );
      const body = await collectPrometheusMetrics(ctx.tenantDbName, ctx.tenantId);

      return reply
        .code(200)
        .header('Cache-Control', 'no-store')
        .type('text/plain; version=0.0.4; charset=utf-8')
        .send(body);
    } catch (error) {
      if (error instanceof ApiTokenAuthError) {
        return reply.code(error.status).send({ error: error.message });
      }

      logger.error('Collection error', { error });
      return reply.code(500).send({ error: 'Failed to collect metrics' });
    }
  }));
};
