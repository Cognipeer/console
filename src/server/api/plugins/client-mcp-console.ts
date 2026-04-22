/**
 * Built-in "console" MCP server.
 *
 * Exposes a project-scoped MCP endpoint backed by simple agent observability
 * tools. Authentication and project context come from the API token sent in
 * the `Authorization: Bearer <token>` header (same as other /client/v1
 * endpoints), so no per-server configuration is needed.
 *
 * Endpoints:
 *   GET  /api/client/v1/mcp/console/execute        — list available tools
 *   POST /api/client/v1/mcp/console/execute        — execute a tool (REST)
 *   GET  /api/client/v1/mcp/console/sse            — open SSE transport
 *   POST /api/client/v1/mcp/console/message        — JSON-RPC message endpoint
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  getConsoleTool,
  listConsoleToolDescriptors,
  type ConsoleToolContext,
} from '@/lib/services/mcp/builtin/consoleTools';
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

const logger = createLogger('api:client-mcp-console');

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_KEY = 'console';
const SERVER_INFO = {
  name: 'cognipeer-console',
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

async function runTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ConsoleToolContext,
) {
  const tool = getConsoleTool(toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return tool.handler(args, ctx);
}

export const clientMcpConsoleApiPlugin: FastifyPluginAsync = async (app) => {
  // ── REST: list tools ───────────────────────────────────────────────
  app.get('/client/v1/mcp/console/execute', withClientApiRequestContext(async (request, reply) => {
    try {
      // Auth happens in the wrapper; we just confirm token is valid.
      await getApiTokenContextForRequest(request);
      return reply.code(200).send({
        server: {
          key: SERVER_KEY,
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
          builtin: true,
        },
        tools: listConsoleToolDescriptors(),
      });
    } catch (error) {
      logger.error('Console MCP list tools error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  // ── REST: execute a tool ───────────────────────────────────────────
  app.post('/client/v1/mcp/console/execute', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.tool !== 'string' || body.tool.trim() === '') {
        return reply.code(400).send({ error: '"tool" is required' });
      }

      const args = body.arguments && typeof body.arguments === 'object'
        ? body.arguments as Record<string, unknown>
        : {};

      const startedAt = Date.now();
      try {
        const result = await runTool(body.tool, args, {
          tenantDbName: ctx.tenantDbName,
          projectId: ctx.projectId,
        });
        return reply.code(200).send({
          metadata: {
            latencyMs: Date.now() - startedAt,
            server: SERVER_KEY,
            tool: body.tool,
          },
          result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tool execution failed';
        logger.warn('Console MCP tool error', { tool: body.tool, error: message });
        return reply.code(400).send({ error: message });
      }
    } catch (error) {
      logger.error('Console MCP execute error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  // ── JSON-RPC message endpoint ──────────────────────────────────────
  app.post('/client/v1/mcp/console/message', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
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
          capabilities: { tools: { listChanged: false } },
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
        return respond(jsonRpcOk(id, {
          tools: listConsoleToolDescriptors(),
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

        try {
          const result = await runTool(toolName, args, {
            tenantDbName: ctx.tenantDbName,
            projectId: ctx.projectId,
          });
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
          const message = error instanceof Error ? error.message : 'Tool execution failed';
          return respond(jsonRpcOk(id, {
            content: [{ text: message, type: 'text' }],
            isError: true,
          }));
        }
      }

      return respond(jsonRpcError(id, -32601, `Method not found: ${method}`));
    } catch (error) {
      logger.error('Console MCP message handler error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));

  // ── SSE transport ──────────────────────────────────────────────────
  app.get('/client/v1/mcp/console/sse', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const sessionId = randomUUID();
      const forwardedProto = request.headers['x-forwarded-proto'];
      const protocol = typeof forwardedProto === 'string' && forwardedProto.length > 0
        ? forwardedProto
        : 'http';
      const host = typeof request.headers.host === 'string' && request.headers.host.length > 0
        ? request.headers.host
        : 'localhost';
      const messageEndpoint = `${protocol}://${host}/api/client/v1/mcp/console/message?sessionId=${sessionId}`;

      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          logger.info('Console MCP SSE session closed', { sessionId });
          removeSseSession(sessionId);
        },
        start(controller) {
          createSseSession(sessionId, {
            controller,
            projectId: ctx.projectId,
            serverKey: SERVER_KEY,
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            tokenId: ctx.tokenRecord._id?.toString(),
          });

          controller.enqueue(encodeSseEndpointEvent(messageEndpoint));
        },
      });

      logger.info('Console MCP SSE session opened', {
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
      logger.error('Console MCP SSE error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
