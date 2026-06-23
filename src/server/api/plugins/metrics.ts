import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { collectPrometheusMetrics } from '@/lib/services/metrics/prometheusExporter';
import { withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('metrics');

export const metricsApiPlugin: FastifyPluginAsync = async (app) => {
  // Token-authenticated route → the canonical client wrapper authenticates the
  // Bearer token, binds the tenant DB via runWithTenant, and hands us `auth`.
  // (Previously used the session wrapper, which never established a tenant
  // scope for a token request.)
  app.get('/metrics', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const body = await collectPrometheusMetrics(auth.tenantDbName, auth.tenantId);

      return reply
        .code(200)
        .header('Cache-Control', 'no-store')
        .type('text/plain; version=0.0.4; charset=utf-8')
        .send(body);
    } catch (error) {
      logger.error('Collection error', { error });
      return reply.code(500).send({ error: 'Failed to collect metrics' });
    }
  }));
};
