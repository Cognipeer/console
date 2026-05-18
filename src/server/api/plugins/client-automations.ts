import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  getAutomation,
  isAutomationKey,
  listAutomations,
  pauseAutomation,
  resumeAutomation,
  runAutomation,
} from '@/lib/services/automations';
import {
  getApiTokenContextForRequest,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-automations');

export const clientAutomationsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/automations', withClientApiRequestContext(async (request, reply) => {
    try {
      await getApiTokenContextForRequest(request);
      return reply.code(200).send({ automations: listAutomations() });
    } catch (error) {
      logger.error('List client automations failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/automations/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      if (!isAutomationKey(key)) {
        return reply.code(400).send({ error: 'Invalid automation key' });
      }

      const automation = getAutomation(key);
      if (!automation) {
        return reply.code(404).send({ error: 'Automation not found' });
      }

      return reply.code(200).send({ automation });
    } catch (error) {
      logger.error('Get client automation failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/automations/:key/run', withClientApiRequestContext(async (request, reply) => {
    try {
      await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      if (!isAutomationKey(key)) {
        return reply.code(400).send({ error: 'Invalid automation key' });
      }

      const automation = await runAutomation(key);
      return reply.code(200).send({ automation });
    } catch (error) {
      logger.error('Run client automation failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/automations/:key/pause', withClientApiRequestContext(async (request, reply) => {
    try {
      await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      if (!isAutomationKey(key)) {
        return reply.code(400).send({ error: 'Invalid automation key' });
      }

      const automation = pauseAutomation(key);
      return reply.code(200).send({ automation });
    } catch (error) {
      logger.error('Pause client automation failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/automations/:key/resume', withClientApiRequestContext(async (request, reply) => {
    try {
      await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      if (!isAutomationKey(key)) {
        return reply.code(400).send({ error: 'Invalid automation key' });
      }

      const automation = resumeAutomation(key);
      return reply.code(200).send({ automation });
    } catch (error) {
      logger.error('Resume client automation failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));
};
