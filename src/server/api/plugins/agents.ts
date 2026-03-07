import type { FastifyPluginAsync } from 'fastify';
import type { AgentStatus, IAgentConfig } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createAgentRecord,
  createConversation,
  deleteAgentRecord,
  executePlaygroundChat,
  getAgentById,
  getAgentVersion,
  listAgents,
  listAgentVersions,
  listConversations,
  publishAgent,
  updateAgentRecord,
} from '@/lib/services/agents';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:agents');

export const agentsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; status?: string };
      const agents = await listAgents(session.tenantDbName, {
        projectId,
        search: query.search,
        status: query.status as AgentStatus | undefined,
      });

      return reply.code(200).send({ agents });
    } catch (error) {
      logger.error('List agents error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to list agents' });
    }
  }));

  app.post('/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const config = body.config;

      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'Agent name is required' });
      }

      if (
        !config
        || typeof config !== 'object'
        || !('modelKey' in config)
        || typeof (config as { modelKey?: unknown }).modelKey !== 'string'
      ) {
        return reply.code(400).send({ error: 'Model configuration is required' });
      }

      const agent = await createAgentRecord(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        {
          config: config as IAgentConfig,
          description: body.description as string | undefined,
          name: body.name,
        },
      );

      return reply.code(201).send({ agent });
    } catch (error) {
      logger.error('Create agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to create agent' });
    }
  }));

  app.get('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      const { session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const agent = await getAgentById(session.tenantDbName, agentId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent });
    } catch (error) {
      logger.error('Get agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to get agent' });
    }
  }));

  app.patch('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const agent = await updateAgentRecord(session.tenantDbName, agentId, body, session.userId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ agent });
    } catch (error) {
      logger.error('Update agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to update agent' });
    }
  }));

  app.delete('/agents/:agentId', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const deleted = await deleteAgentRecord(session.tenantDbName, agentId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to delete agent' });
    }
  }));

  app.get('/agents/:agentId/versions', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const query = (request.query ?? {}) as { limit?: string; skip?: string; version?: string };
      const agent = await getAgentById(session.tenantDbName, agentId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      if (query.version) {
        const version = await getAgentVersion(
          session.tenantDbName,
          agentId,
          Number.parseInt(query.version, 10),
        );

        if (!version) {
          return reply.code(404).send({ error: 'Version not found' });
        }

        return reply.code(200).send({ version });
      }

      const result = await listAgentVersions(session.tenantDbName, agentId, {
        limit: Number.parseInt(query.limit ?? '50', 10),
        skip: Number.parseInt(query.skip ?? '0', 10),
      });

      return reply.code(200).send({
        publishedVersion: agent.publishedVersion ?? null,
        total: result.total,
        versions: result.versions,
      });
    } catch (error) {
      logger.error('List agent versions error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to list agent versions' });
    }
  }));

  app.post('/agents/:agentId/publish', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const version = await publishAgent(
        session.tenantDbName,
        agentId,
        session.userId,
        typeof body.changelog === 'string' ? body.changelog : undefined,
      );

      return reply.code(201).send({ version });
    } catch (error) {
      logger.error('Publish agent error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to publish agent',
        });
    }
  }));

  app.get('/agents/:agentId/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const agent = await getAgentById(session.tenantDbName, agentId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const conversations = await listConversations(session.tenantDbName, agent.key, {
        limit: 50,
        projectId,
      });

      return reply.code(200).send({ conversations });
    } catch (error) {
      logger.error('List agent conversations error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to list conversations' });
    }
  }));

  app.post('/agents/:agentId/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const agent = await getAgentById(session.tenantDbName, agentId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const conversation = await createConversation(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        agent.key,
        typeof body.title === 'string' ? body.title : undefined,
      );

      return reply.code(201).send({ conversation });
    } catch (error) {
      logger.error('Create agent conversation error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to create conversation' });
    }
  }));

  app.post('/agents/:agentId/chat', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.message !== 'string') {
        return reply.code(400).send({ error: 'Message is required' });
      }

      const agent = await getAgentById(session.tenantDbName, agentId);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const result = await executePlaygroundChat({
        agentKey: agent.key,
        history: Array.isArray(body.history)
          ? body.history
            .filter((item): item is { content: string; role: string } =>
              Boolean(
                item
                && typeof item === 'object'
                && 'content' in item
                && 'role' in item
                && typeof (item as { content?: unknown }).content === 'string'
                && typeof (item as { role?: unknown }).role === 'string',
              ),
            )
            .map((item) => ({ content: item.content, role: item.role }))
          : undefined,
        projectId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userMessage: body.message,
      });

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Agent playground chat error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Agent chat failed',
        });
    }
  }));
};
