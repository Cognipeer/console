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
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:automations');

export const automationsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/automations', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      return reply.code(200).send({ automations: listAutomations() });
    } catch (error) {
      logger.error('List automations failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/automations/:key', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
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
      logger.error('Get automation failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/automations/:key/run', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      const { key } = request.params as { key: string };
      if (!isAutomationKey(key)) {
        return reply.code(400).send({ error: 'Invalid automation key' });
      }

      const automation = await runAutomation(key);
      return reply.code(200).send({ automation });
    } catch (error) {
      logger.error('Run automation failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/automations/:key/pause', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      const { key } = request.params as { key: string };
      if (!isAutomationKey(key)) {
        return reply.code(400).send({ error: 'Invalid automation key' });
      }

      const automation = pauseAutomation(key);
      return reply.code(200).send({ automation });
    } catch (error) {
      logger.error('Pause automation failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/automations/:key/resume', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      const { key } = request.params as { key: string };
      if (!isAutomationKey(key)) {
        return reply.code(400).send({ error: 'Invalid automation key' });
      }

      const automation = resumeAutomation(key);
      return reply.code(200).send({ automation });
    } catch (error) {
      logger.error('Resume automation failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));
};
