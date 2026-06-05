import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  executeMcpTool,
  getMcpServerByKey,
  logMcpRequest,
  serializeMcpServer,
} from '@/lib/services/mcp';
import {
  createSseSession,
  encodeSseEndpointEvent,
  getSseSession,
  removeSseSession,
  sendSseResponse,
} from '@/lib/services/mcp/sseSessionManager';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-mcp');

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'cognipeer-mcp-gateway',
  version: '1.0.0',
};

function jsonRpcOk(id: string | number | null, result: unknown) {
  return { id, jsonrpc: JSONRPC_VERSION, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return {
    error: { code, message },
    id,
    jsonrpc: JSONRPC_VERSION,
  };
}

export const clientMcpApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/mcp/:serverKey/execute', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const server = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);

      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      if (server.status !== 'active') {
        return reply.code(403).send({ error: 'MCP server is disabled' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.tool !== 'string' || body.tool.trim() === '') {
        return reply.code(400).send({ error: '"tool" is required' });
      }

      const args = body.arguments && typeof body.arguments === 'object'
        ? body.arguments as Record<string, unknown>
        : {};

      try {
        const { latencyMs, result } = await executeMcpTool(server, body.tool, args);

        void logMcpRequest(
          ctx.tenantDbName,
          ctx.tenantId,
          ctx.projectId,
          server.key,
          body.tool,
          'success',
          latencyMs,
          { arguments: args, tool: body.tool },
          typeof result === 'object' ? result as Record<string, unknown> : { value: result },
          undefined,
          ctx.tokenRecord._id?.toString(),
        );

        return reply.code(200).send({
          metadata: {
            latencyMs,
            server: server.key,
            tool: body.tool,
          },
          result,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';

        void logMcpRequest(
          ctx.tenantDbName,
          ctx.tenantId,
          ctx.projectId,
          server.key,
          body.tool,
          'error',
          0,
          { arguments: args, tool: body.tool },
          undefined,
          errorMessage,
          ctx.tokenRecord._id?.toString(),
        );

        return reply.code(502).send({ error: errorMessage });
      }
    } catch (error) {
      logger.error('Client MCP execute error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.get('/client/v1/mcp/:serverKey/execute', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const server = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);

      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({
        server: serializeMcpServer(server),
        tools: server.tools,
      });
    } catch (error) {
      logger.error('Client MCP list tools error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.post('/client/v1/mcp/:serverKey/message', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const query = (request.query ?? {}) as { sessionId?: string };
      const sessionId = query.sessionId;
      const session = sessionId ? getSseSession(sessionId) : null;

      let body: {
        id?: string | number | null;
        jsonrpc?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        body = readJsonBody(request);
      } catch {
        const errorPayload = jsonRpcError(null, -32700, 'Parse error');
        if (session && sessionId) {
          sendSseResponse(sessionId, errorPayload);
          return reply.code(202).send();
        }
        return reply.code(400).send(errorPayload);
      }

      const { id = null, method } = body;
      if (!method) {
        const errorPayload = jsonRpcError(id, -32600, 'Invalid Request: method is required');
        if (session && sessionId) {
          sendSseResponse(sessionId, errorPayload);
          return reply.code(202).send();
        }
        return reply.code(400).send(errorPayload);
      }

      const respond = (payload: Record<string, unknown>) => {
        if (session && sessionId) {
          sendSseResponse(sessionId, payload);
          return reply.code(202).send();
        }
        return reply.code(200).send(payload);
      };

      if (method === 'initialize') {
        return respond(jsonRpcOk(id, {
          capabilities: {
            tools: { listChanged: false },
          },
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
        }));
      }

      if (method === 'notifications/initialized') {
        return reply.code(202).send();
      }

      if (method === 'ping') {
        return respond(jsonRpcOk(id, {}));
      }

      if (method === 'tools/list') {
        const server = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
        if (!server) {
          return respond(jsonRpcError(id, -32001, 'MCP server not found'));
        }

        return respond(jsonRpcOk(id, {
          tools: (server.tools ?? []).map((tool) => ({
            description: tool.description,
            inputSchema: tool.inputSchema,
            name: tool.name,
          })),
        }));
      }

      if (method === 'tools/call') {
        const toolName = typeof body.params?.name === 'string' ? body.params.name : '';
        const args = body.params?.arguments && typeof body.params.arguments === 'object'
          ? body.params.arguments as Record<string, unknown>
          : {};

        if (!toolName) {
          return respond(jsonRpcError(id, -32602, 'Invalid params: "name" is required'));
        }

        const server = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
        if (!server) {
          return respond(jsonRpcError(id, -32001, 'MCP server not found'));
        }
        if (server.status !== 'active') {
          return respond(jsonRpcError(id, -32002, 'MCP server is disabled'));
        }

        try {
          const { latencyMs, result } = await executeMcpTool(server, toolName, args);

          void logMcpRequest(
            ctx.tenantDbName,
            ctx.tenantId,
            ctx.projectId,
            server.key,
            toolName,
            'success',
            latencyMs,
            { arguments: args, tool: toolName },
            typeof result === 'object' ? result as Record<string, unknown> : { value: result },
            undefined,
            ctx.tokenRecord._id?.toString(),
          );

          return respond(jsonRpcOk(id, {
            content: [
              {
                text: typeof result === 'string' ? result : JSON.stringify(result),
                type: 'text',
              },
            ],
            isError: false,
          }));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';

          void logMcpRequest(
            ctx.tenantDbName,
            ctx.tenantId,
            ctx.projectId,
            server.key,
            toolName,
            'error',
            0,
            { arguments: args, tool: toolName },
            undefined,
            errorMessage,
            ctx.tokenRecord._id?.toString(),
          );

          return respond(jsonRpcOk(id, {
            content: [
              {
                text: errorMessage,
                type: 'text',
              },
            ],
            isError: true,
          }));
        }
      }

      return respond(jsonRpcError(id, -32601, `Method not found: ${method}`));
    } catch (error) {
      logger.error('Client MCP message handler error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));

  app.get('/client/v1/mcp/:serverKey/sse', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const server = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);

      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      if (server.status !== 'active') {
        return reply.code(403).send({ error: 'MCP server is disabled' });
      }

      const sessionId = randomUUID();
      const forwardedProto = request.headers['x-forwarded-proto'];
      const protocol = typeof forwardedProto === 'string' && forwardedProto.length > 0
        ? forwardedProto
        : 'http';
      const host = typeof request.headers.host === 'string' && request.headers.host.length > 0
        ? request.headers.host
        : 'localhost';
      const messageEndpoint = `${protocol}://${host}/api/client/v1/mcp/${serverKey}/message?sessionId=${sessionId}`;

      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          logger.info('Client MCP SSE session closed', { serverKey, sessionId });
          removeSseSession(sessionId);
        },
        start(controller) {
          createSseSession(sessionId, {
            controller,
            projectId: ctx.projectId,
            serverKey,
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            tokenId: ctx.tokenRecord._id?.toString(),
          });

          controller.enqueue(encodeSseEndpointEvent(messageEndpoint));
        },
      });

      logger.info('Client MCP SSE session opened', {
        serverKey,
        sessionId,
        tenantId: ctx.tenantId,
      });

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Mcp-Session-Id', sessionId);

      return reply.send(
        Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>),
      );
    } catch (error) {
      logger.error('Client MCP SSE error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
