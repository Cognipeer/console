import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync } from 'fastify';
import type { IMcpServer } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  executeMcpTool,
  getMcpServerByKey,
  logMcpRequest,
  resolveExposure,
  resolveSourceType,
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
const MCP_PROTOCOL_VERSION = '2025-03-26';
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

function protocolEnabled(server: IMcpServer, protocol: 'streamable-http' | 'sse'): boolean {
  return resolveExposure(server).protocols.includes(protocol);
}

interface CallerInfo {
  tokenId?: string;
  userId?: string;
}

async function runToolCall(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  log: {
    tenantDbName: string;
    tenantId: string;
    projectId?: string;
    transport: 'rest' | 'jsonrpc' | 'sse';
    caller: CallerInfo;
    sessionId?: string;
  },
): Promise<{ ok: true; result: unknown; latencyMs: number } | { ok: false; error: string }> {
  try {
    const { latencyMs, result } = await executeMcpTool(server, toolName, args);
    void logMcpRequest(log.tenantDbName, {
      tenantId: log.tenantId,
      projectId: log.projectId,
      serverKey: server.key,
      toolName,
      status: 'success',
      latencyMs,
      requestPayload: { tool: toolName, arguments: args },
      responsePayload: typeof result === 'object' && result !== null
        ? result as Record<string, unknown>
        : { value: result },
      callerTokenId: log.caller.tokenId,
      callerUserId: log.caller.userId,
      callerType: 'api',
      transport: log.transport,
      sourceType: resolveSourceType(server),
      sessionId: log.sessionId,
    });
    return { ok: true, result, latencyMs };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
    void logMcpRequest(log.tenantDbName, {
      tenantId: log.tenantId,
      projectId: log.projectId,
      serverKey: server.key,
      toolName,
      status: 'error',
      latencyMs: 0,
      requestPayload: { tool: toolName, arguments: args },
      errorMessage,
      callerTokenId: log.caller.tokenId,
      callerUserId: log.caller.userId,
      callerType: 'api',
      transport: log.transport,
      sourceType: resolveSourceType(server),
      sessionId: log.sessionId,
    });
    return { ok: false, error: errorMessage };
  }
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

      if (!protocolEnabled(server, 'streamable-http')) {
        return reply.code(403).send({ error: 'HTTP access is disabled for this MCP server' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.tool !== 'string' || body.tool.trim() === '') {
        return reply.code(400).send({ error: '"tool" is required' });
      }

      const args = body.arguments && typeof body.arguments === 'object'
        ? body.arguments as Record<string, unknown>
        : {};

      const outcome = await runToolCall(server, body.tool, args, {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        transport: 'rest',
        caller: {
          tokenId: ctx.tokenRecord._id?.toString(),
          userId: ctx.user?._id?.toString(),
        },
      });

      if (!outcome.ok) {
        return reply.code(502).send({ error: outcome.error });
      }

      return reply.code(200).send({
        metadata: {
          latencyMs: outcome.latencyMs,
          server: server.key,
          tool: body.tool,
        },
        result: outcome.result,
      });
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
          return reply.code(400).send(errorPayload);
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

      // Direct (sessionless) JSON-RPC = streamable HTTP; via an SSE session
      // the message endpoint belongs to the SSE transport.
      const requiredProtocol = session && sessionId ? 'sse' : 'streamable-http';

      if (method === 'initialize') {
        const server = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
        if (!server) {
          return respond(jsonRpcError(id, -32001, 'MCP server not found'));
        }
        if (!protocolEnabled(server, requiredProtocol)) {
          return respond(jsonRpcError(id, -32003, `${requiredProtocol} access is disabled for this MCP server`));
        }
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
        if (!protocolEnabled(server, requiredProtocol)) {
          return respond(jsonRpcError(id, -32003, `${requiredProtocol} access is disabled for this MCP server`));
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
        if (!protocolEnabled(server, requiredProtocol)) {
          return respond(jsonRpcError(id, -32003, `${requiredProtocol} access is disabled for this MCP server`));
        }

        const outcome = await runToolCall(server, toolName, args, {
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          transport: session && sessionId ? 'sse' : 'jsonrpc',
          caller: {
            tokenId: ctx.tokenRecord._id?.toString(),
            userId: ctx.user?._id?.toString(),
          },
          sessionId: sessionId ?? undefined,
        });

        if (outcome.ok) {
          return respond(jsonRpcOk(id, {
            content: [
              {
                text: typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result),
                type: 'text',
              },
            ],
            isError: false,
          }));
        }
        return respond(jsonRpcOk(id, {
          content: [
            {
              text: outcome.error,
              type: 'text',
            },
          ],
          isError: true,
        }));
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
      if (!protocolEnabled(server, 'sse')) {
        return reply.code(403).send({ error: 'SSE access is disabled for this MCP server' });
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
