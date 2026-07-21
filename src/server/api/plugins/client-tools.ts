import type { FastifyPluginAsync } from 'fastify';
import type { IToolAuthConfig } from '@/lib/database';
import type { SpecFormatHint } from '@/lib/services/specImport';
import { createLogger } from '@/lib/core/logger';
import {
  createTool,
  deleteTool,
  executeToolAction,
  getToolByKey,
  listTools,
  logToolRequest,
  serializeTool,
  syncToolActions,
  toolRequestSecretValues,
  updateTool,
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
      // No runtime headers on this surface, but the tool's static upstream
      // credential can still be echoed back into the logged response.
      const secretValues = toolRequestSecretValues(tool);

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
          undefined,
          secretValues,
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
          undefined,
          secretValues,
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

  // ── Authoring: create a tool definition ──
  app.post('/client/v1/tools', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'Tool name is required' });
      }

      if (body.type !== 'openapi' && body.type !== 'mcp') {
        return reply.code(400).send({ error: 'Tool type must be "openapi" or "mcp"' });
      }

      const tool = await createTool(ctx.tenantDbName, ctx.tenantId, ctx.tokenRecord.userId, ctx.projectId, {
        description: body.description as string | undefined,
        mcpEndpoint: body.mcpEndpoint as string | undefined,
        mcpTransport: body.mcpTransport as 'sse' | 'streamable-http' | undefined,
        name: body.name,
        openApiSpec: body.openApiSpec as string | undefined,
        specFormat: typeof body.specFormat === 'string' ? body.specFormat as SpecFormatHint : undefined,
        type: body.type,
        upstreamAuth: body.upstreamAuth as IToolAuthConfig | undefined,
        upstreamBaseUrl: body.upstreamBaseUrl as string | undefined,
      });

      return reply.code(201).send({ tool: serializeTool(tool) });
    } catch (error) {
      logger.error('Create client tool error', { error });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Failed to create tool',
      });
    }
  }));

  // ── Authoring: update a tool definition (project-scoped resolve by key) ──
  app.patch('/client/v1/tools/:toolKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { toolKey } = request.params as { toolKey: string };
      const existing = await getToolByKey(ctx.tenantDbName, toolKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const tool = await updateTool(ctx.tenantDbName, String(existing._id), ctx.tokenRecord.userId, body);
      if (!tool) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      return reply.code(200).send({ tool: serializeTool(tool) });
    } catch (error) {
      logger.error('Update client tool error', { error });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Failed to update tool',
      });
    }
  }));

  // ── Authoring: re-discover the tool's actions from its source ──
  app.post('/client/v1/tools/:toolKey/sync', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { toolKey } = request.params as { toolKey: string };
      const existing = await getToolByKey(ctx.tenantDbName, toolKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      const synced = await syncToolActions(ctx.tenantDbName, String(existing._id), ctx.tokenRecord.userId);
      if (!synced) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      return reply.code(200).send({ tool: serializeTool(synced) });
    } catch (error) {
      logger.error('Sync client tool actions error', { error });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Failed to sync tool actions',
      });
    }
  }));

  // ── Authoring: delete a tool definition (project-scoped resolve by key) ──
  app.delete('/client/v1/tools/:toolKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { toolKey } = request.params as { toolKey: string };
      const existing = await getToolByKey(ctx.tenantDbName, toolKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      const deleted = await deleteTool(ctx.tenantDbName, String(existing._id));
      if (!deleted) {
        return reply.code(404).send({ error: 'Tool not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client tool error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));
};
