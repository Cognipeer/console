import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  createSkill,
  deleteSkill,
  getSkillById,
  listSkills,
  updateSkill,
} from '@/lib/services/agents/skillService';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:skills');

export const skillsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/skills', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; status?: string };
      const skills = await listSkills(session.tenantDbName, projectId, {
        search: query.search,
        status: query.status === 'inactive' ? 'inactive' : query.status === 'active' ? 'active' : undefined,
      });
      return reply.code(200).send({ skills });
    } catch (error) {
      logger.error('List skills error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.post('/skills', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.title !== 'string' || !body.title.trim()) {
        return reply.code(400).send({ error: 'title is required' });
      }
      if (typeof body.header !== 'string' || !body.header.trim()) {
        return reply.code(400).send({ error: 'header is required' });
      }

      const skill = await createSkill(session.tenantDbName, session.tenantId, projectId, session.userId, {
        key: typeof body.key === 'string' ? body.key : undefined,
        title: body.title,
        header: body.header,
        body: typeof body.body === 'string' ? body.body : '',
        minModelTier: body.minModelTier === 'small' || body.minModelTier === 'large' ? body.minModelTier : undefined,
        status: body.status === 'inactive' ? 'inactive' : 'active',
      });
      return reply.code(201).send({ skill });
    } catch (error) {
      logger.error('Create skill error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.get('/skills/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const skill = await getSkillById(session.tenantDbName, projectId, id);
      if (!skill) return reply.code(404).send({ error: 'Skill not found' });
      return reply.code(200).send({ skill });
    } catch (error) {
      logger.error('Get skill error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.patch('/skills/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      const skill = await updateSkill(session.tenantDbName, projectId, id, session.userId, {
        title: typeof body.title === 'string' ? body.title : undefined,
        header: typeof body.header === 'string' ? body.header : undefined,
        body: typeof body.body === 'string' ? body.body : undefined,
        minModelTier: body.minModelTier === 'small' || body.minModelTier === 'large'
          ? body.minModelTier
          : body.minModelTier === null ? null : undefined,
        status: body.status === 'active' || body.status === 'inactive' ? body.status : undefined,
      });
      if (!skill) return reply.code(404).send({ error: 'Skill not found' });
      return reply.code(200).send({ skill });
    } catch (error) {
      logger.error('Update skill error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.delete('/skills/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteSkill(session.tenantDbName, projectId, id);
      if (!deleted) return reply.code(404).send({ error: 'Skill not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete skill error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
