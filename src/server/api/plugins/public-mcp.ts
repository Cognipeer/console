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
 *
 * Because anyone holding the URL can reach these routes, they are bounded:
 * a request rate per client address and endpoint, a request rate per endpoint
 * for all callers together, a body size limit, a cap on the tool calls a
 * tenant has running at once, a cap on open SSE streams, JSON-only POSTs, and
 * error messages that say a call failed without saying what the upstream
 * answered (see docs/guide/configuration.md, "MCP Gateway"). A failed call's
 * detail goes to the tenant's request log; the caller gets the log row's id to
 * quote.
 */

import { isToolOutput, toMcpCallResult } from '@/lib/services/tools/toolOutput';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseProvider, IMcpServer, ITenant } from '@/lib/database';
import { getDatabase } from '@/lib/database';
import { isServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import {
  executeMcpTool,
  isMcpToolInputError,
  isMcpUnknownToolError,
  isMcpUpstreamError,
  listMcpToolDescriptors,
  logMcpRequest,
  mcpRequestSecretValues,
  reachesBrowser,
  resolveExposure,
  resolveMcpInstructions,
  resolveSourceType,
  type McpRequestClientInfo,
  mcpProtocolVersionOf,
  negotiateMcpProtocolVersion,
} from '@/lib/services/mcp';
import {
  acquirePublicCallSlot,
  checkPublicAddressRate,
  checkPublicEndpointRate,
  clientAddressBucket,
  type PublicLimitDecision,
} from '@/lib/services/mcp/publicGuard';
import {
  PUBLIC_SSE_PRINCIPAL,
  deliverSseResponse,
  getRemoteSseSessionFor,
} from '@/lib/services/mcp/sseSessionManager';
import { authz } from '@/lib/iam/routeAuthz';
import { getClientIp } from '../fastify-utils';
import {
  hasJsonContentType,
  jsonRpcErrorBody as jsonRpcError,
  lookupMessageSession,
  readJsonRpcRequest,
  sendSessionNotFound,
  startMcpSseResponse,
} from '../mcpTransport';

const logger = createLogger('api:public-mcp');

const PUBLIC_SLUG_AUTHZ = authz.self(
  'unauthenticated by design: addressed by tenant id + random endpoint slug; the handler 404s unless the MCP server is active with accessMode public',
);

const JSONRPC_VERSION = '2.0';
const SERVER_INFO = {
  name: 'cognipeer-mcp-gateway',
  version: '1.0.0',
};

/** Caller-supplied text echoed back in an error is cut to this. */
const ECHOED_TEXT_MAX_CHARS = 100;
const USER_AGENT_MAX_CHARS = 256;
/** A caller turned away for load may retry after this long. */
const BUSY_RETRY_AFTER_SECONDS = 5;

function jsonRpcOk(id: string | number | null, result: unknown) {
  return { id, jsonrpc: JSONRPC_VERSION, result };
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
  // A switched-off MCP service answers like an unknown server.
  if (!(await isServiceEnabled({ tenantId: String(tenant._id) }, 'mcp'))) return null;

  const server = await withTenantDb(db, tenant.dbName, async () =>
    db.findMcpServerByEndpointSlug(endpointSlug));

  if (!server || server.status !== 'active') return null;
  if (resolveExposure(server).accessMode !== 'public') return null;
  // A browser is served with a token only, whatever the stored settings say.
  if (await withTenantDb(db, tenant.dbName, () => reachesBrowser(db, server))) return null;
  return { tenant, server };
}

/** Who is calling, for the request log: the address Fastify resolved and a bounded user agent. */
function clientInfoOf(request: FastifyRequest): McpRequestClientInfo {
  const userAgent = request.headers['user-agent'];
  return {
    ip: getClientIp(request),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, USER_AGENT_MAX_CHARS) : undefined,
  };
}

type PublicToolOutcome =
  | { ok: true; result: unknown }
  /**
   * `inputError`: the call itself was wrong (unknown tool, bad argument); `message` is safe to show.
   * `unknownTool`: the input error is a tool name the server does not advertise.
   */
  | { ok: false; inputError: boolean; unknownTool: boolean; message: string };

/**
 * What an anonymous caller is told about a failed call. The tool-input errors
 * carry messages written for any caller; for everything else — an upstream's
 * response body, a hostname, a subprocess's stderr, a database error — the
 * caller learns only that it failed, and with what status when the upstream
 * answered one.
 */
function describePublicFailure(error: unknown): { inputError: boolean; unknownTool: boolean; message: string } {
  if (isMcpToolInputError(error)) {
    return { inputError: true, unknownTool: isMcpUnknownToolError(error), message: error.message };
  }
  if (isMcpUpstreamError(error)) {
    return { inputError: false, unknownTool: false, message: `Upstream request failed (status ${error.status})` };
  }
  return { inputError: false, unknownTool: false, message: 'Tool execution failed' };
}

async function runPublicToolCall(
  tenant: ITenant,
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  transport: 'jsonrpc' | 'sse',
  sessionId: string | undefined,
  client: McpRequestClientInfo,
): Promise<PublicToolOutcome> {
  const db = await getDatabase();
  // Public surface forwards no runtime headers, but the server's own static
  // upstream credential can still be echoed back — scrub it from the log.
  const secretValues = mcpRequestSecretValues(server);
  // Anyone can call these endpoints, so what a call leaves in the log is
  // smaller than for a token caller, and says where it came from.
  const logOptions = { payloadLimitBytes: getConfig().mcp.public.logPayloadLimitBytes, client };
  try {
    const { result, latencyMs } = await withTenantDb(db, tenant.dbName, () =>
      executeMcpTool(server, toolName, args));
    void logMcpRequest(tenant.dbName, {
      tenantId: server.tenantId,
      projectId: server.projectId,
      serverId: String(server._id),
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
    }, secretValues, logOptions);
    return { ok: true, result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
    const failure = describePublicFailure(error);
    // The log row holds the full detail; its id is what the caller can quote.
    const logId = await logMcpRequest(tenant.dbName, {
      tenantId: server.tenantId,
      projectId: server.projectId,
      serverId: String(server._id),
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
    }, secretValues, logOptions);
    return {
      ok: false,
      inputError: failure.inputError,
      unknownTool: failure.unknownTool,
      message: failure.inputError || !logId ? failure.message : `${failure.message} (ref: ${logId})`,
    };
  }
}

function sendRateLimited(reply: FastifyReply, decision: PublicLimitDecision) {
  return reply
    .code(429)
    .header('Retry-After', String(decision.retryAfterSeconds))
    .send({ error: 'Rate limit exceeded' });
}

async function handlePublicMessage(request: FastifyRequest, reply: FastifyReply) {
  const { tenantId, endpointSlug } = request.params as { tenantId: string; endpointSlug: string };

  const resolved = await resolvePublicServer(tenantId, endpointSlug);
  if (!resolved) {
    return reply.code(404).send({ error: 'Not found' });
  }
  const { tenant, server } = resolved;

  // Counted under the stored record's ids, not under the URL's path parameters.
  const rate = await checkPublicEndpointRate({ server, clientAddress: getClientIp(request) });
  if (!rate.allowed) return sendRateLimited(reply, rate);

  // A message that names an SSE session is delivered into that stream — only
  // when the session was opened on this endpoint, by an anonymous caller.
  const binding = {
    tenantId: server.tenantId,
    projectId: server.projectId,
    serverKey: server.key,
    principal: PUBLIC_SSE_PRINCIPAL,
  };
  const lookup = lookupMessageSession(request, binding);
  let isSse = lookup.kind === 'session';
  let sessionId = lookup.kind === 'session' ? lookup.sessionId : undefined;
  if (lookup.kind === 'unknown') {
    // The stream may be held by another node (Redis relay). It counts only when
    // its registered binding is this very endpoint and an anonymous caller; any
    // other id is answered like an unknown one.
    const claimed = (request.query as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof claimed !== 'string' || !(await getRemoteSseSessionFor(claimed, binding))) {
      return sendSessionNotFound(reply);
    }
    isSse = true;
    sessionId = claimed;
  }

  const exposure = resolveExposure(server);
  const requiredProtocol = isSse ? 'sse' : 'streamable-http';
  if (!exposure.protocols.includes(requiredProtocol)) {
    return reply.code(403).send({ error: `${requiredProtocol} access is disabled for this MCP server` });
  }

  const parsed = readJsonRpcRequest(request);
  if (!parsed.ok) {
    return reply.code(400).send(jsonRpcError(null, parsed.code, parsed.message));
  }
  const body = parsed.body;

  const { id = null, method } = body;
  if (typeof method !== 'string' || method === '') {
    return reply.code(400).send(jsonRpcError(id, -32600, 'Invalid Request: method is required'));
  }

  const respond = async (payload: Record<string, unknown>) => {
    if (isSse && sessionId) {
      try {
        await deliverSseResponse(sessionId, payload);
      } catch (error) {
        logger.error('Public MCP SSE relay publish failed', { sessionId, error });
        return reply.code(502).send(jsonRpcError((payload.id as string | number | null | undefined) ?? null, -32603, 'SSE relay unavailable'));
      }
      return reply.code(202).send();
    }
    return reply.code(200).send(payload);
  };

  if (method === 'initialize') {
    const instructions = resolveMcpInstructions(server);
    return respond(jsonRpcOk(id, {
      capabilities: { tools: { listChanged: false } },
      protocolVersion: negotiateMcpProtocolVersion(body.params?.protocolVersion),
      serverInfo: SERVER_INFO,
      ...(instructions ? { instructions } : {}),
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
      tools: listMcpToolDescriptors(server),
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

    const releaseSlot = acquirePublicCallSlot(server.tenantId);
    if (!releaseSlot) {
      return reply
        .code(503)
        .header('Retry-After', String(BUSY_RETRY_AFTER_SECONDS))
        .send({ error: 'Too many tool calls are running for this endpoint; retry shortly' });
    }

    let outcome: PublicToolOutcome;
    try {
      outcome = await runPublicToolCall(
        tenant,
        server,
        toolName,
        args,
        isSse ? 'sse' : 'jsonrpc',
        sessionId,
        clientInfoOf(request),
      );
    } finally {
      releaseSlot();
    }

    if (outcome.ok) {
      if (isToolOutput(outcome.result)) {
        return respond(jsonRpcOk(id, toMcpCallResult(outcome.result, mcpProtocolVersionOf(request.headers))));
      }
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
    // An unknown tool is a malformed call. Anything else — a bad argument
    // included — is a failed call whose message the model reads and can act on.
    if (outcome.unknownTool) {
      return respond(jsonRpcError(id, -32602, outcome.message));
    }
    return respond(jsonRpcOk(id, {
      content: [{ text: outcome.message, type: 'text' }],
      isError: true,
    }));
  }

  return respond(jsonRpcError(id, -32601, `Method not found: ${method.slice(0, ECHOED_TEXT_MAX_CHARS)}`));
}

export const publicMcpApiPlugin: FastifyPluginAsync = async (app) => {
  const postOptions = { bodyLimit: getConfig().mcp.public.bodyLimitBytes, config: PUBLIC_SLUG_AUTHZ };

  // Before the body is read or the endpoint is looked up: turn away callers
  // that are over their address-wide rate, and POSTs that are not JSON.
  app.addHook('onRequest', async (request, reply) => {
    const rate = checkPublicAddressRate(getClientIp(request));
    if (!rate.allowed) return sendRateLimited(reply, rate);
    if (request.method === 'POST' && !hasJsonContentType(request)) {
      return reply.code(415).send({ error: 'Content-Type must be application/json' });
    }
    return undefined;
  });

  app.post('/public/mcp/:tenantId/:endpointSlug/message', postOptions, async (request, reply) => {
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
  app.post('/public/mcp/:tenantId/:endpointSlug/sse', postOptions, async (request, reply) => {
    try {
      return await handlePublicMessage(request, reply);
    } catch (error) {
      logger.error('Public MCP streamable-http error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  });

  // `exposeHeadRoute: false`: a HEAD request must not open a stream (and so a
  // session) it would never read.
  app.get('/public/mcp/:tenantId/:endpointSlug/sse', { exposeHeadRoute: false, config: PUBLIC_SLUG_AUTHZ }, async (request, reply) => {
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

      const clientAddress = getClientIp(request);
      const rate = await checkPublicEndpointRate({ server, clientAddress });
      if (!rate.allowed) return sendRateLimited(reply, rate);

      return startMcpSseResponse(request, reply, {
        messagePath: `/api/public/mcp/${encodeURIComponent(tenantId)}/${encodeURIComponent(endpointSlug)}/message`,
        session: {
          clientIp: clientAddressBucket(clientAddress),
          principal: PUBLIC_SSE_PRINCIPAL,
          projectId: server.projectId,
          serverKey: server.key,
          tenantDbName: tenant.dbName,
          tenantId: server.tenantId,
          tokenId: undefined,
        },
        logFields: { serverKey: server.key, ip: clientAddress },
      });
    } catch (error) {
      logger.error('Public MCP SSE error', { error });
      return reply.code(500).send({ error: 'Internal error' });
    }
  });
};
