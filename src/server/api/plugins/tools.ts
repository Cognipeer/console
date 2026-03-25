import type { IToolAuthConfig } from '@/lib/database';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  aggregateToolRequestLogs,
  countToolRequestLogs,
  createTool,
  deleteTool,
  executeToolAction,
  getTool,
  listToolRequestLogs,
  listTools,
  logToolRequest,
  serializeTool,
  syncToolActions,
  updateTool,
} from '@/lib/services/tools';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:tools');

export const toolsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/tools', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        search?: string;
        status?: 'active' | 'disabled';
        type?: 'mcp' | 'openapi';
      };

      const tools = await listTools(session.tenantDbName, {
        projectId,
        search: query.search,
        status: query.status,
        type: query.type,
      });

      return reply.code(200).send({
        tools: tools.map(serializeTool),
      });
    } catch (error) {
      logger.error('List tools error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to list tools' });
    }
  }));

  app.post('/tools', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string') {
        return reply.code(400).send({ error: 'Tool name is required' });
      }

      if (body.type !== 'openapi' && body.type !== 'mcp') {
        return reply.code(400).send({ error: 'Tool type must be "openapi" or "mcp"' });
      }

      const tool = await createTool(session.tenantDbName, session.tenantId, session.userId, projectId, {
        description: body.description as string | undefined,
        mcpEndpoint: body.mcpEndpoint as string | undefined,
        mcpTransport: body.mcpTransport as 'sse' | 'streamable-http' | undefined,
        name: body.name,
        openApiSpec: body.openApiSpec as string | undefined,
        type: body.type,
        upstreamAuth: body.upstreamAuth as IToolAuthConfig | undefined,
        upstreamBaseUrl: body.upstreamBaseUrl as string | undefined,
      });

      return reply.code(201).send({ tool: serializeTool(tool) });
    } catch (error) {
      logger.error('Create tool error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(400).send({
          error: error instanceof Error ? error.message : 'Failed to create tool',
        });
    }
  }));

  app.get('/tools/:toolId', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { toolId } = request.params as { toolId: string };
      const query = (request.query ?? {}) as { includeAggregate?: string };
      const tool = await getTool(session.tenantDbName, toolId);

      if (!tool) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      const payload: Record<string, unknown> = {
        tool: serializeTool(tool),
      };

      if (query.includeAggregate === 'true') {
        payload.aggregate = await aggregateToolRequestLogs(session.tenantDbName, tool.key, {
          groupBy: 'day',
        });
      }

      return reply.code(200).send(payload);
    } catch (error) {
      logger.error('Get tool error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to get tool' });
    }
  }));

  app.put('/tools/:toolId', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { toolId } = request.params as { toolId: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.sync === true) {
        const synced = await syncToolActions(session.tenantDbName, toolId, session.userId);
        if (!synced) {
          return reply.code(404).send({ error: 'Tool not found' });
        }

        return reply.code(200).send({ tool: serializeTool(synced) });
      }

      const tool = await updateTool(session.tenantDbName, toolId, session.userId, body);
      if (!tool) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      return reply.code(200).send({ tool: serializeTool(tool) });
    } catch (error) {
      logger.error('Update tool error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(400).send({
          error: error instanceof Error ? error.message : 'Failed to update tool',
        });
    }
  }));

  app.delete('/tools/:toolId', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { toolId } = request.params as { toolId: string };
      const deleted = await deleteTool(session.tenantDbName, toolId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete tool error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Failed to delete tool' });
    }
  }));

  app.get('/tools/:toolId/logs', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { toolId } = request.params as { toolId: string };
      const tool = await getTool(session.tenantDbName, toolId);

      if (!tool) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      const query = (request.query ?? {}) as {
        actionKey?: string;
        from?: string;
        keyword?: string;
        limit?: string;
        page?: string;
        skip?: string;
        status?: string;
        to?: string;
      };
      const limit = Math.min(Number.parseInt(query.limit ?? '50', 10), 200);
      const page = Math.max(Number.parseInt(query.page ?? '1', 10), 1);
      const skip = Number.parseInt(query.skip ?? 'NaN', 10);
      const resolvedSkip = Number.isNaN(skip) ? (page - 1) * limit : Math.max(skip, 0);
      const from = query.from ? new Date(query.from) : undefined;
      const to = query.to
        ? (query.to.length === 10
          ? new Date(`${query.to}T23:59:59.999Z`)
          : new Date(query.to))
        : undefined;

      const [logs, total] = await Promise.all([
        listToolRequestLogs(session.tenantDbName, tool.key, {
          actionKey: query.actionKey,
          from,
          keyword: query.keyword?.trim() || undefined,
          limit,
          skip: resolvedSkip,
          status: query.status,
          to,
        }),
        countToolRequestLogs(session.tenantDbName, tool.key, {
          actionKey: query.actionKey,
          from,
          keyword: query.keyword?.trim() || undefined,
          status: query.status,
          to,
        }),
      ]);

      return reply.code(200).send({
        limit,
        logs,
        page,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      });
    } catch (error) {
      logger.error('List tool logs error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/tools/:toolId/actions/:actionKey/execute', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { actionKey, toolId } = request.params as { actionKey: string; toolId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const args = (body.arguments ?? body.args ?? {}) as Record<string, unknown>;
      const tool = await getTool(session.tenantDbName, toolId);

      if (!tool) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      if (tool.status !== 'active') {
        return reply.code(400).send({ error: 'Tool is disabled' });
      }

      const action = tool.actions.find((item) => item.key === actionKey);
      const actionName = action?.name ?? actionKey;

      try {
        const { latencyMs, result } = await executeToolAction(tool, actionKey, args);

        void logToolRequest(
          session.tenantDbName,
          session.tenantId,
          projectId,
          tool.key,
          actionKey,
          actionName,
          'success',
          latencyMs,
          args,
          typeof result === 'object' ? result as Record<string, unknown> : { value: result },
          undefined,
          'dashboard',
        );

        return reply.code(200).send({ latencyMs, result });
      } catch (execError) {
        const errorMessage = execError instanceof Error ? execError.message : 'Execution failed';

        void logToolRequest(
          session.tenantDbName,
          session.tenantId,
          projectId,
          tool.key,
          actionKey,
          actionName,
          'error',
          0,
          args,
          undefined,
          errorMessage,
          'dashboard',
        );

        return reply.code(500).send({ error: errorMessage });
      }
    } catch (error) {
      logger.error('Execute tool action error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Execution failed',
        });
    }
  }));
};
