import type { FastifyPluginAsync } from 'fastify';
import type { AgentStatus } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createConversation,
  executeAgentChat,
  getAgentByKey,
  getConversationById,
  listAgents,
} from '@/lib/services/agents/agentService';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-agents');

function extractUserMessage(input: unknown): string | null {
  if (typeof input === 'string') {
    return input;
  }

  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (!item || typeof item !== 'object') {
        continue;
      }

      const candidate = item as {
        content?: string | Array<Record<string, unknown>>;
        role?: string;
      };

      if (candidate.role === 'user' && typeof candidate.content === 'string') {
        return candidate.content;
      }

      if (candidate.role === 'user' && Array.isArray(candidate.content)) {
        const textPart = candidate.content.find(
          (part) => part.type === 'input_text' && typeof part.text === 'string',
        );
        if (textPart && typeof textPart.text === 'string') {
          return textPart.text;
        }
      }
    }
  }

  return null;
}

function conversationIdFromResponseId(responseId: string): string | null {
  return responseId.startsWith('resp_') ? responseId.slice(5) : null;
}

function createResponsesHandler(usePublished: boolean) {
  return withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const model = body.model;

      if (typeof model !== 'string') {
        return reply.code(400).send({
          error: 'model field is required and must contain the agent key',
        });
      }

      const requestedVersion = body.version !== undefined && body.version !== null
        ? Number(body.version)
        : undefined;
      if (requestedVersion !== undefined && (!Number.isFinite(requestedVersion) || requestedVersion < 1)) {
        return reply.code(400).send({ error: 'version must be a positive integer' });
      }

      const agent = await getAgentByKey(ctx.tenantDbName, model, ctx.projectId);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      if (agent.status !== 'active') {
        return reply.code(400).send({ error: 'Agent is not active' });
      }

      const userMessage = extractUserMessage(body.input);
      if (!userMessage) {
        return reply.code(400).send({
          error: 'input field is required (string or array of message items)',
        });
      }

      let conversationId: string | undefined;
      if (typeof body.previous_response_id === 'string') {
        const resolvedConversationId = conversationIdFromResponseId(body.previous_response_id);
        if (resolvedConversationId) {
          const conversation = await getConversationById(ctx.tenantDbName, resolvedConversationId);
          if (!conversation || conversation.agentKey !== agent.key) {
            return reply.code(404).send({
              error: 'previous_response_id does not match a valid conversation',
            });
          }
          conversationId = resolvedConversationId;
        }
      }

      if (!conversationId) {
        const conversation = await createConversation(
          ctx.tenantDbName,
          ctx.tenantId,
          ctx.projectId,
          ctx.tokenRecord.userId,
          agent.key,
        );
        conversationId = String(conversation._id);
      }

      const result = await executeAgentChat({
        agentKey: agent.key,
        conversationId,
        projectId: ctx.projectId,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        usePublished,
        userId: ctx.tokenRecord.userId,
        userMessage,
        version: requestedVersion,
      });

      const { _conversation_messages, ...responseBody } = result;
      void _conversation_messages;
      return reply.code(200).send(responseBody);
    } catch (error) {
      logger.error('Client agent responses error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

export const clientAgentsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/agents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: AgentStatus };
      const agents = await listAgents(ctx.tenantDbName, {
        ...(query.status ? { status: query.status } : {}),
        projectId: ctx.projectId,
      });

      return reply.code(200).send({
        agents: agents.map((agent) => ({
          config: {
            maxTokens: agent.config.maxTokens,
            modelKey: agent.config.modelKey,
            temperature: agent.config.temperature,
            topP: agent.config.topP,
          },
          createdAt: agent.createdAt,
          description: agent.description,
          key: agent.key,
          name: agent.name,
          status: agent.status,
        })),
      });
    } catch (error) {
      logger.error('List client agents error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/agents/:agentKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentKey } = request.params as { agentKey: string };
      const agent = await getAgentByKey(ctx.tenantDbName, agentKey, ctx.projectId);

      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      return reply.code(200).send({
        agent: {
          config: {
            maxTokens: agent.config.maxTokens,
            modelKey: agent.config.modelKey,
            temperature: agent.config.temperature,
            topP: agent.config.topP,
          },
          createdAt: agent.createdAt,
          description: agent.description,
          key: agent.key,
          name: agent.name,
          status: agent.status,
        },
      });
    } catch (error) {
      logger.error('Get client agent error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/agents/responses', createResponsesHandler(true));
  app.post('/client/v1/responses', createResponsesHandler(false));
};
