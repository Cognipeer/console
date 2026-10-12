import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { collectPrometheusMetrics } from '@/lib/services/metrics/prometheusExporter';
import { authz } from '@/lib/iam/routeAuthz';
import { withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('metrics');

export const metricsApiPlugin: FastifyPluginAsync = async (app) => {
  // Token-authenticated route → the canonical client wrapper authenticates the
  // Bearer token, binds the tenant DB via runWithTenant, and hands us `auth`.
  // (Previously used the session wrapper, which never established a tenant
  // scope for a token request.)
  // Authenticated by the canonical client wrapper (valid API token of the tenant).
  // The export is tenant-wide (item counts of every module, users by role), so
  // no single service permission applies. A per-service token scope cannot cap
  // it either: a SCOPED token is refused (use an unscoped token for the
  // Prometheus scraper), so the least-privilege cap is honoured.
  app.get('/metrics', { config: authz.authenticated() }, withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (auth.tokenRecord.servicePermissions != null) {
        // `error` is the reason itself (what clients surface), like every other
        // 403 body of the gate.
        const reason = 'Forbidden: /metrics is tenant-wide and needs an API token without a service scope';
        return reply.code(403).send({ error: reason, code: 'forbidden', message: reason });
      }
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
