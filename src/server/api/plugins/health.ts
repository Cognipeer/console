import type { FastifyPluginAsync } from 'fastify';
import { checkHealth, checkLiveness } from '@/lib/core/health';
import { isApplicationReady } from '@/server/bootstrap';
import { withApiRequestContext } from '../fastify-utils';

export const healthApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/health/live', withApiRequestContext(async (_request, reply) => {
    return reply.code(200).send(checkLiveness());
  }));

  app.get('/health/ready', withApiRequestContext(async (_request, reply) => {
    // Bootstrap registers most health checks (cache/cluster/queue/...) as it
    // runs, so before it finishes `checkHealth()` would only see whichever
    // subset happened to be registered so far and could read as "ok" —
    // check the boot flag explicitly instead of relying on that.
    if (!isApplicationReady()) {
      return reply.code(503).send({
        status: 'down',
        message: 'Server is still starting up',
      });
    }

    const report = await checkHealth();
    return reply.code(report.status === 'down' ? 503 : 200).send(report);
  }));
};
