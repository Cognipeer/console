import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  executeToolAction,
  getToolByKey,
  listTools,
  logToolRequest,
} from '@/lib/services/tools';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-tools');

export const clientToolsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/tools', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: 'active' | 'disabled'; type?: 'mcp' | 'openapi' };
      const tools = await listTools(ctx.tenantDbName, {
        projectId: ctx.projectId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
      });

      return reply.code(200).send({
        tools: tools.map((tool) => ({
          actions: tool.actions.map((action) => ({
            description: action.description,
            inputSchema: action.inputSchema,
            key: action.key,
            name: action.name,
          })),
          createdAt: tool.createdAt,
          description: tool.description,
          key: tool.key,
          name: tool.name,
          status: tool.status,
          type: tool.type,
        })),
      });
    } catch (error) {
      logger.error('List client tools error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/tools/:toolKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { toolKey } = request.params as { toolKey: string };
      const tool = await getToolByKey(ctx.tenantDbName, toolKey, ctx.projectId);

      if (!tool) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      return reply.code(200).send({
        tool: {
          actions: tool.actions.map((action) => ({
            description: action.description,
            inputSchema: action.inputSchema,
            key: action.key,
            name: action.name,
          })),
          createdAt: tool.createdAt,
          description: tool.description,
          key: tool.key,
          name: tool.name,
          status: tool.status,
          type: tool.type,
        },
      });
    } catch (error) {
      logger.error('Get client tool error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/tools/:toolKey/actions/:actionKey/execute', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { actionKey, toolKey } = request.params as { actionKey: string; toolKey: string };
      const tool = await getToolByKey(ctx.tenantDbName, toolKey, ctx.projectId);

      if (!tool) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      if (tool.status !== 'active') {
        return reply.code(403).send({ error: 'Tool is disabled' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const args = (body.arguments ?? body.args ?? {}) as Record<string, unknown>;
      const action = tool.actions.find((item) => item.key === actionKey);
      const actionName = action?.name ?? actionKey;
      const callerTokenId = String(ctx.tokenRecord._id ?? '');

      try {
        const { latencyMs, result } = await executeToolAction(tool, actionKey, args);
        void logToolRequest(
          ctx.tenantDbName,
          ctx.tenantId,
          tool.projectId,
          tool.key,
          actionKey,
          actionName,
          'success',
          latencyMs,
          args,
          typeof result === 'object' ? result as Record<string, unknown> : { value: result },
          undefined,
          'api',
          callerTokenId,
        );

        return reply.code(200).send({
          actionKey,
          latencyMs,
          result,
          toolKey: tool.key,
        });
      } catch (execError) {
        const errorMessage = execError instanceof Error
          ? execError.message
          : 'Failed to execute tool action';

        void logToolRequest(
          ctx.tenantDbName,
          ctx.tenantId,
          tool.projectId,
          tool.key,
          actionKey,
          actionName,
          'error',
          0,
          args,
          undefined,
          errorMessage,
          'api',
          callerTokenId,
        );

        return reply.code(400).send({ error: errorMessage });
      }
    } catch (error) {
      logger.error('Execute client tool action error', { error });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Failed to execute tool action',
      });
    }
  }));
};
