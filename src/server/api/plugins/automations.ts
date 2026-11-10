import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';
import { automationHandlers } from './automations-shared';

const logger = createLogger('api:automations');

export const automationsApiPlugin: FastifyPluginAsync = async (app) => {
  const handlers = automationHandlers({
    authenticate: (request) => requireSessionContext(request),
    logger,
    subject: 'automation',
  });

  app.get('/automations', withApiRequestContext(handlers.list));
  app.get('/automations/:key', withApiRequestContext(handlers.get));
  app.post('/automations/:key/run', withApiRequestContext(handlers.run));
  app.post('/automations/:key/pause', withApiRequestContext(handlers.pause));
  app.post('/automations/:key/resume', withApiRequestContext(handlers.resume));
};
