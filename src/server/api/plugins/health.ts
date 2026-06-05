import type { FastifyPluginAsync } from 'fastify';
import { checkHealth, checkLiveness } from '@/lib/core/health';
import { withApiRequestContext } from '../fastify-utils';

export const healthApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/health/live', withApiRequestContext(async (_request, reply) => {
    return reply.code(200).send(checkLiveness());
  }));

  app.get('/health/ready', withApiRequestContext(async (_request, reply) => {
    const report = await checkHealth();
    return reply.code(report.status === 'down' ? 503 : 200).send(report);
  }));
};
