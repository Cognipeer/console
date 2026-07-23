/**
 * Public (unauthenticated) MCP endpoints.
 *
 * Servers whose exposure.accessMode is 'public' are reachable without a
 * Cognipeer API token at:
 *
 *   POST /api/public/mcp/:tenantId/:endpointSlug/message   (JSON-RPC / streamable HTTP)
 *   GET  /api/public/mcp/:tenantId/:endpointSlug/sse       (legacy SSE transport)
 *
 * The URL carries the tenant id (opaque) plus the server's random 16-char
 * endpoint slug — the pair is unguessable, but treat it like a webhook URL:
 * anyone who has it can call the tools. Access mode 'token' servers return
 * 404 here regardless of slug knowledge.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseProvider, IMcpServer, ITenant } from '@/lib/database';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  executeMcpTool,
  listEnabledMcpTools,
  logMcpRequest,
  mcpRequestSecretValues,
  resolveExposure,
  resolveSourceType,
} from '@/lib/services/mcp';
import {
  createSseSession,
  encodeSseEndpointEvent,
  getSseSession,
  removeSseSession,
  sendSseResponse,
} from '@/lib/services/mcp/sseSessionManager';
import { readJsonBody } from '../fastify-utils';

const logger = createLogger('api:public-mcp');

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
  return { error: { code, message }, id, jsonrpc: JSONRPC_VERSION };
}

async function withTenantDb<T>(
  db: DatabaseProvider,
  tenantDbName: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (db.runWithTenant) return db.runWithTenant(tenantDbName, fn);
  await db.switchToTenant(tenantDbName);
  return fn();
}

/**
 * Resolve tenant + public server for a request. Returns null (→ 404) when the
 * tenant or slug is unknown, the server is disabled, or it is not public.
 */
async function resolvePublicServer(
  tenantId: string,
  endpointSlug: string,
): Promise<{ tenant: ITenant; server: IMcpServer } | null> {
  if (!tenantId || !endpointSlug || endpointSlug.length < 8) return null;
  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId).catch(() => null);
  if (!tenant?.dbName) return null;

  const server = await withTenantDb(db, tenant.dbName, async () =>
    db.findMcpServerByEndpointSlug(endpointSlug));

  if (!server || server.status !== 'active') return null;
  if (resolveExposure(server).accessMode !== 'public') return null;
  return { tenant, server };
}

async function runPublicToolCall(
  tenant: ITenant,
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  transport: 'jsonrpc' | 'sse',
  sessionId?: string,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const db = await getDatabase();
  // Public surface forwards no runtime headers, but the server's own static
  // upstream credential can still be echoed back — scrub it from the response.
  const secretValues = mcpRequestSecretValues(server);
  try {
    const { result, latencyMs } = await withTenantDb(db, tenant.dbName, () =>
      executeMcpTool(server, toolName, args));
    void logMcpRequest(tenant.dbName, {
      tenantId: server.tenantId,
      projectId: server.projectId,
      serverKey: server.key,
      toolName,
      status: 'success',
      latencyMs,
      requestPayload: { tool: toolName, arguments: args },
      responsePayload: typeof result === 'object' && result !== null
        ? result as Record<string, unknown>
        : { value: result },
      callerType: 'public',
      transport,
      sourceType: resolveSourceType(server),
      sessionId,
    }, secretValues);
    return { ok: true, result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
    void logMcpRequest(tenant.dbName, {
      tenantId: server.tenantId,
      projectId: server.projectId,
      serverKey: server.key,
      toolName,
      status: 'error',
      latencyMs: 0,
      requestPayload: { tool: toolName, arguments: args },
      errorMessage,
      callerType: 'public',
      transport,
      sourceType: resolveSourceType(server),
      sessionId,
    }, secretValues);
    return { ok: false, error: errorMessage };
  }
}

async function handlePublicMessage(request: FastifyRequest, reply: FastifyReply) {
  const { tenantId, endpointSlug } = request.params as { tenantId: string; endpointSlug: string };
  const query = (request.query ?? {}) as { sessionId?: string };
  const sessionId = query.sessionId;
  const session = sessionId ? getSseSession(sessionId) : null;

  const resolved = await resolvePublicServer(tenantId, endpointSlug);
  if (!resolved) {
    return reply.code(404).send({ error: 'Not found' });
  }
  const { tenant, server } = resolved;
  const exposure = resolveExposure(server);
  const requiredProtocol = session && sessionId ? 'sse' : 'streamable-http';
  if (!exposure.protocols.includes(requiredProtocol)) {
    return reply.code(403).send({ error: `${requiredProtocol} access is disabled for this MCP server` });
  }

  let body: {
    id?: string | number | null;
    jsonrpc?: string;
    method?: string;
    params?: Record<string, unknown>;
  };
  try {
    body = readJsonBody(request);
  } catch {
    return reply.code(400).send(jsonRpcError(null, -32700, 'Parse error'));
  }

  const { id = null, method } = body;
  if (!method) {
    return reply.code(400).send(jsonRpcError(id, -32600, 'Invalid Request: method is required'));
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
      tools: listEnabledMcpTools(server).map((tool) => ({
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

    const outcome = await runPublicToolCall(
      tenant,
      server,
      toolName,
      args,
      session && sessionId ? 'sse' : 'jsonrpc',
      sessionId ?? undefined,
    );

    return respond(jsonRpcOk(id, {
      content: [
        {
          text: outcome.ok
            ? (typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result))
            : outcome.error,
          type: 'text',
        },
      ],
      isError: !outcome.ok,
    }));
  }

  return respond(jsonRpcError(id, -32601, `Method not found: ${method}`));
}

export const publicMcpApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/public/mcp/:tenantId/:endpointSlug/message', async (request, reply) => {
    try {
      return await handlePublicMessage(request, reply);
    } catch (error) {
      logger.error('Public MCP message error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  });

  // Streamable HTTP transport: accept JSON-RPC POSTs on the advertised `/sse`
  // URL so streamable-HTTP-first MCP clients connect without a failed attempt +
  // SSE fallback (mirrors the client gateway).
  app.post('/public/mcp/:tenantId/:endpointSlug/sse', async (request, reply) => {
    try {
      return await handlePublicMessage(request, reply);
    } catch (error) {
      logger.error('Public MCP streamable-http error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  });

  app.get('/public/mcp/:tenantId/:endpointSlug/sse', async (request, reply) => {
    try {
      const { tenantId, endpointSlug } = request.params as { tenantId: string; endpointSlug: string };
      const resolved = await resolvePublicServer(tenantId, endpointSlug);
      if (!resolved) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const { tenant, server } = resolved;
      if (!resolveExposure(server).protocols.includes('sse')) {
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
      const messageEndpoint = `${protocol}://${host}/api/public/mcp/${tenantId}/${endpointSlug}/message?sessionId=${sessionId}`;

      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          logger.info('Public MCP SSE session closed', { serverKey: server.key, sessionId });
          removeSseSession(sessionId);
        },
        start(controller) {
          createSseSession(sessionId, {
            controller,
            projectId: server.projectId,
            serverKey: server.key,
            tenantDbName: tenant.dbName,
            tenantId: server.tenantId,
            tokenId: undefined,
          });
          controller.enqueue(encodeSseEndpointEvent(messageEndpoint));
        },
      });

      logger.info('Public MCP SSE session opened', { serverKey: server.key, sessionId });

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Mcp-Session-Id', sessionId);

      return reply.send(
        Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>),
      );
    } catch (error) {
      logger.error('Public MCP SSE error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  });
};
