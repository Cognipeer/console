/**
 * Built-in "console" MCP server.
 *
 * Exposes a project-scoped MCP endpoint backed by simple agent observability
 * tools. Authentication and project context come from the API token sent in
 * the `Authorization: Bearer <token>` header (same as other /client/v1
 * endpoints), so no per-server configuration is needed.
 *
 * The `mcp` permission opens this endpoint; each tool additionally needs the
 * permission on the console service whose data it returns (see
 * `ConsoleToolDefinition.service`). A token that lacks it does not see the tool
 * in the tool list and cannot call it.
 *
 * Endpoints:
 *   GET  /api/client/v1/mcp/console/execute        — list available tools
 *   POST /api/client/v1/mcp/console/execute        — execute a tool (REST)
 *   GET  /api/client/v1/mcp/console/sse            — open SSE transport
 *   POST /api/client/v1/mcp/console/message        — JSON-RPC message endpoint
 */

import { isToolOutput, toMcpCallResult } from '@/lib/services/tools/toolOutput';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getRequiredPermissionLevel, type PermissionService } from '@/lib/security/rbac';
import {
  consoleToolServices,
  getConsoleTool,
  listConsoleToolDescriptors,
  type ConsoleToolContext,
} from '@/lib/services/mcp/builtin/consoleTools';
import { sendSseResponse, tokenSsePrincipal } from '@/lib/services/mcp/sseSessionManager';
import {
  RbacAuthorizationError,
  getApiTokenContextForRequest,
  serviceActionAllowedForRequest,
  withClientApiRequestContext,
} from '../fastify-utils';
import {
  lookupMessageSession,
  readJsonObjectBody,
  readJsonRpcRequest,
  sendSessionNotFound,
  startMcpSseResponse,
} from '../mcpTransport';

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

class ConsoleToolForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleToolForbiddenError';
  }
}

/**
 * Which console services the caller may use: what the policy engine answers for
 * a read of the matching /api/client/v1/<service> routes — the token owner's
 * grants, capped by the token's own scope (an unscoped token inherits the
 * owner's), narrowed by its project, and subject to custom policies. Asked once
 * per request; when the engine cannot decide it throws the 503 the route gate
 * would have sent, which the request wrapper answers.
 */
async function consoleServiceAccess(request: FastifyRequest): Promise<(service: PermissionService) => boolean> {
  const allowed = new Set<PermissionService>();
  for (const service of consoleToolServices()) {
    const level = getRequiredPermissionLevel('GET', service);
    if (level === 'none' || await serviceActionAllowedForRequest(request, service, level)) {
      allowed.add(service);
    }
  }
  return (service) => allowed.has(service);
}

async function runTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ConsoleToolContext,
  isServiceAllowed: (service: PermissionService) => boolean,
) {
  const tool = getConsoleTool(toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  if (!isServiceAllowed(tool.service)) {
    throw new ConsoleToolForbiddenError(
      `Forbidden: ${tool.service} requires ${getRequiredPermissionLevel('GET', tool.service)} permission`,
    );
  }
  return tool.handler(args, ctx);
}

export const clientMcpConsoleApiPlugin: FastifyPluginAsync = async (app) => {
  // ── REST: list tools ───────────────────────────────────────────────
  app.get('/client/v1/mcp/console/execute', withClientApiRequestContext(async (request, reply) => {
    try {
      // Auth happens in the wrapper; the token decides which tools are listed.
      await getApiTokenContextForRequest(request);
      const isServiceAllowed = await consoleServiceAccess(request);
      return reply.code(200).send({
        server: {
          key: SERVER_KEY,
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
          builtin: true,
        },
        tools: listConsoleToolDescriptors(isServiceAllowed),
      });
    } catch (error) {
      if (error instanceof RbacAuthorizationError) throw error;
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
      const body = readJsonObjectBody<Record<string, unknown>>(request);
      if (!body) {
        return reply.code(400).send({ error: 'A JSON object body is required' });
      }

      if (typeof body.tool !== 'string' || body.tool.trim() === '') {
        return reply.code(400).send({ error: '"tool" is required' });
      }

      const args = body.arguments && typeof body.arguments === 'object'
        ? body.arguments as Record<string, unknown>
        : {};

      const isServiceAllowed = await consoleServiceAccess(request);
      const startedAt = Date.now();
      try {
        const result = await runTool(body.tool, args, {
          tenantDbName: ctx.tenantDbName,
          projectId: ctx.projectId,
        }, isServiceAllowed);
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
        if (error instanceof ConsoleToolForbiddenError) {
          return reply.code(403).send({ error: message });
        }
        return reply.code(400).send({ error: message });
      }
    } catch (error) {
      if (error instanceof RbacAuthorizationError) throw error;
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
      // A message that names an SSE session is delivered into that stream —
      // only when this token opened it.
      const lookup = lookupMessageSession(request, {
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        serverKey: SERVER_KEY,
        principal: tokenSsePrincipal(ctx.tokenRecord._id?.toString()),
      });
      if (lookup.kind === 'unknown') return sendSessionNotFound(reply);
      const session = lookup.kind === 'session' ? lookup.session : null;
      const sessionId = lookup.kind === 'session' ? lookup.sessionId : undefined;

      const parsed = readJsonRpcRequest(request);
      if (!parsed.ok) {
        const errorPayload = jsonRpcError(null, parsed.code, parsed.message);
        if (session && sessionId) {
          sendSseResponse(sessionId, errorPayload);
          return reply.code(202).send();
        }
        return reply.code(400).send(errorPayload);
      }
      const body = parsed.body;

      const { id = null, method } = body;
      if (typeof method !== 'string' || method === '') {
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
          tools: listConsoleToolDescriptors(await consoleServiceAccess(request)),
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

        const isServiceAllowed = await consoleServiceAccess(request);
        try {
          const result = await runTool(toolName, args, {
            tenantDbName: ctx.tenantDbName,
            projectId: ctx.projectId,
          }, isServiceAllowed);
          if (isToolOutput(result)) {
            return respond(jsonRpcOk(id, toMcpCallResult(result, MCP_PROTOCOL_VERSION)));
          }
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

      return respond(jsonRpcError(id, -32601, `Method not found: ${method.slice(0, 100)}`));
    } catch (error) {
      if (error instanceof RbacAuthorizationError) throw error;
      logger.error('Console MCP message handler error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));

  // ── SSE transport ──────────────────────────────────────────────────
  // `exposeHeadRoute: false`: a HEAD request must not open a stream (and so a
  // session) it would never read.
  app.get('/client/v1/mcp/console/sse', { exposeHeadRoute: false }, withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const tokenId = ctx.tokenRecord._id?.toString();
      return startMcpSseResponse(request, reply, {
        messagePath: '/api/client/v1/mcp/console/message',
        session: {
          principal: tokenSsePrincipal(tokenId),
          projectId: ctx.projectId,
          serverKey: SERVER_KEY,
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          tokenId,
        },
        logFields: { tenantId: ctx.tenantId },
      });
    } catch (error) {
      logger.error('Console MCP SSE error', { error });
      return reply.code(500).send({ error: 'Internal error' });
    }
  }));
};
