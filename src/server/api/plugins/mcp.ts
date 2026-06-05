import type { IMcpAuthConfig, McpAuthType } from '@/lib/database';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  aggregateMcpRequestLogs,
  countMcpRequestLogs,
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpRequestLogs,
  listMcpServers,
  serializeMcpServer,
  serializeMcpServerFull,
  updateMcpServer,
} from '@/lib/services/mcp';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:mcp');
const VALID_AUTH_TYPES: McpAuthType[] = ['none', 'token', 'header', 'basic'];

export const mcpApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/mcp', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        search?: string;
        status?: 'active' | 'disabled';
      };

      const servers = await listMcpServers(session.tenantDbName, {
        projectId,
        search: query.search,
        status: query.status,
      });

      return reply.code(200).send({
        servers: servers.map(serializeMcpServer),
      });
    } catch (error) {
      logger.error('List MCP servers error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/mcp', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      if (typeof body.openApiSpec !== 'string') {
        return reply.code(400).send({ error: 'openApiSpec is required' });
      }

      if (
        !body.upstreamAuth
        || typeof body.upstreamAuth !== 'object'
        || !('type' in body.upstreamAuth)
      ) {
        return reply.code(400).send({ error: 'upstreamAuth with type is required' });
      }

      const authType = (body.upstreamAuth as { type?: unknown }).type;
      if (!VALID_AUTH_TYPES.includes(authType as McpAuthType)) {
        return reply.code(400).send({
          error: 'upstreamAuth.type must be "none", "token", "header", or "basic"',
        });
      }

      const server = await createMcpServer(
        session.tenantDbName,
        session.tenantId,
        session.userId,
        projectId,
        {
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          name: body.name.trim(),
          openApiSpec: body.openApiSpec,
          upstreamAuth: body.upstreamAuth as IMcpAuthConfig,
          upstreamBaseUrl: typeof body.upstreamBaseUrl === 'string'
            ? body.upstreamBaseUrl.trim()
            : undefined,
        },
      );

      return reply.code(201).send({
        server: serializeMcpServer(server),
      });
    } catch (error) {
      logger.error('Create MCP server error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/mcp/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as {
        includeAggregate?: string;
        includeLogs?: string;
      };

      const server = await getMcpServer(session.tenantDbName, id);
      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      const payload: Record<string, unknown> = {
        server: serializeMcpServerFull(server),
      };

      if (query.includeLogs === 'true') {
        payload.logs = await listMcpRequestLogs(session.tenantDbName, server.key, { limit: 50 });
      }

      if (query.includeAggregate === 'true') {
        payload.aggregate = await aggregateMcpRequestLogs(session.tenantDbName, server.key, {
          groupBy: 'day',
        });
      }

      return reply.code(200).send(payload);
    } catch (error) {
      logger.error('Get MCP server error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/mcp/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      const authType = body.upstreamAuth && typeof body.upstreamAuth === 'object'
        ? (body.upstreamAuth as { type?: unknown }).type
        : undefined;
      if (authType !== undefined && !VALID_AUTH_TYPES.includes(authType as McpAuthType)) {
        return reply.code(400).send({
          error: 'upstreamAuth.type must be "none", "token", "header", or "basic"',
        });
      }

      if (body.status !== undefined && body.status !== 'active' && body.status !== 'disabled') {
        return reply.code(400).send({ error: 'status must be "active" or "disabled"' });
      }

      const updated = await updateMcpServer(session.tenantDbName, id, session.userId, {
        description: body.description as string | undefined,
        name: body.name as string | undefined,
        openApiSpec: body.openApiSpec as string | undefined,
        status: body.status as 'active' | 'disabled' | undefined,
        upstreamAuth: body.upstreamAuth as IMcpAuthConfig | undefined,
        upstreamBaseUrl: body.upstreamBaseUrl as string | undefined,
      });

      if (!updated) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({ server: serializeMcpServerFull(updated) });
    } catch (error) {
      logger.error('Update MCP server error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/mcp/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteMcpServer(session.tenantDbName, id);

      if (!deleted) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete MCP server error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/mcp/:id/logs', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const server = await getMcpServer(session.tenantDbName, id);

      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      const query = (request.query ?? {}) as {
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

      const filter = {
        from,
        keyword: query.keyword?.trim() || undefined,
        limit,
        skip: resolvedSkip,
        status: query.status,
        to,
      };

      const [logs, total] = await Promise.all([
        listMcpRequestLogs(session.tenantDbName, server.key, filter),
        countMcpRequestLogs(session.tenantDbName, server.key, {
          from,
          keyword: filter.keyword,
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
      logger.error('List MCP server logs error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));
};
