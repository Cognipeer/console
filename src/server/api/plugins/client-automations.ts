import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  getApiTokenContextForRequest,
  withClientApiRequestContext,
} from '../fastify-utils';
import { automationHandlers } from './automations-shared';

const logger = createLogger('api:client-automations');

export const clientAutomationsApiPlugin: FastifyPluginAsync = async (app) => {
  const handlers = automationHandlers({
    authenticate: (request) => getApiTokenContextForRequest(request),
    logger,
    subject: 'client automation',
  });

  app.get('/client/v1/automations', withClientApiRequestContext(handlers.list));
  app.get('/client/v1/automations/:key', withClientApiRequestContext(handlers.get));
  app.post('/client/v1/automations/:key/run', withClientApiRequestContext(handlers.run));
  app.post('/client/v1/automations/:key/pause', withClientApiRequestContext(handlers.pause));
  app.post('/client/v1/automations/:key/resume', withClientApiRequestContext(handlers.resume));
};
