import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { parseAccessListInput } from '@/lib/iam/accessList';
import { isToolOutput, toMcpCallResult } from '@/lib/services/tools/toolOutput';
import type {
  IMcpAuthConfig,
  IMcpServer,
  McpAuthType,
} from '@/lib/database';
import type { SpecFormatHint } from '@/lib/services/specImport';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import {
  consoleIdentityCallerOf,
  isConsoleIdentityRefusal,
} from '@/lib/iam/consoleIdentity';
import { maskSecretValues } from '@/lib/services/logRedaction';
import {
  createMcpServer,
  deleteMcpServer,
  executeMcpTool,
  getMcpServerByKey,
  isMcpServerConfigError,
  isMcpToolInputError,
  isMcpUnknownToolError,
  listEnabledMcpTools,
  mcpInstructionsInputError,
  resolveMcpInstructions,
  listMcpToolDescriptors,
  logMcpRequest,
  mcpRequestSecretValues,
  refreshMcpServerTools,
  resolveExposure,
  resolveSourceType,
  serializeMcpServer,
  updateMcpServer,
} from '@/lib/services/mcp';
import type { UpdateMcpServerInput } from '@/lib/services/mcp';
import { sendSseResponse, tokenSsePrincipal } from '@/lib/services/mcp/sseSessionManager';
import {
  buildRuntimeContextFromRequest,
  describeRuntimeAuth,
  resolveRuntimeHeaders,
  runtimeHeaderPolicyFromMetadata,
  type AgentRuntimeContext,
} from '@/lib/services/runtimeContext';
import { mcpSandboxRunner } from '@/enterprise/registry';
import { isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import { isEnterpriseLicenseType } from '@/lib/license/license-manager';
import {
  authorizeServiceForRequest,
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';
import {
  lookupMessageSession,
  mcpOriginGuard,
  readJsonObjectBody,
  readJsonRpcRequest,
  sendSessionNotFound,
  startMcpSseResponse,
} from '../mcpTransport';
import {
  MCP_PROTOCOL_VERSION,
  SERVER_VERSION,
  VALID_AUTH_TYPES,
  auditContextFor,
  jsonRpcError,
  jsonRpcOk,
  parseExposure,
  parseGuardrail,
  parseRemoteConfig,
  parseStdioConfig,
  readMcpCommonCreateFields,
  readMcpCreateHead,
  readMcpUpstreamBody,
} from './mcp-shared';

const logger = createLogger('api:client-mcp');

/**
 * A server of the project by key, as the client API serves it: an agent's own server (`owner`) is part of that agent
 * and is never served, changed or deleted here, so it answers like an unknown key.
 */
async function sharedServerByKey(tenantDbName: string, serverKey: string, projectId: string | undefined) {
  const server = await getMcpServerByKey(tenantDbName, serverKey, projectId);
  return server && !server.owner ? server : null;
}

const VALID_SOURCE_TYPES = ['openapi', 'remote', 'stdio'] as const;

/**
 * Mirrors `requireStdioSubprocessPermission` in the dashboard `mcp.ts` plugin:
 * a stdio 'subprocess' server makes the shared backend spawn npx/uvx with a
 * caller-supplied package name/args, so — unlike every other MCP source type
 * default-'write'-permitted here — it additionally requires 'admin'-level
 * 'mcp' permission on the token owner, capped by the token's own scope (an
 * unscoped token inherits the owner's permission unchanged; a token explicitly
 * scoped down to 'mcp: write' stays capped at 'write' even for an admin owner).
 *
 * Decided by `authorizeServiceForRequest`, so the policy engine decides exactly
 * like the dashboard path (custom forbid policies, the owner's group grants,
 * the token's project narrowing, and the token scope as a cap). It reads the token
 * from `request.apiTokenContext`, which `withClientApiRequestContext` has set by
 * the time any authoring handler runs.
 */
async function hasStdioSubprocessPermission(request: FastifyRequest): Promise<boolean> {
  return (await authorizeServiceForRequest(request, 'mcp', { level: 'admin' })).allowed;
}

const STDIO_SUBPROCESS_FORBIDDEN_ERROR =
  'Creating or editing a stdio MCP server with subprocess execution requires elevated "mcp" '
  + 'admin permission. Ask a tenant owner/admin, or have one grant your account (or token) '
  + 'admin-level MCP permission.';

/** Resolve caller-supplied headers against the server's opt-in policy. */
function resolveMcpRuntimeHeaders(
  server: IMcpServer,
  runtimeContext: AgentRuntimeContext | undefined,
): Record<string, string> | undefined {
  return resolveRuntimeHeaders(
    runtimeContext,
    'mcp',
    server.key,
    runtimeHeaderPolicyFromMetadata(server.metadata),
  );
}

/** The MCP transport routes: browser pages may call them only from an allowed origin. */
const TRANSPORT_ROUTE = { onRequest: mcpOriginGuard };

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
    runtimeContext?: AgentRuntimeContext;
    /** The JSON-RPC `params._meta` of a `tools/call`, raw; the log write bounds and scrubs it. */
    clientMeta?: unknown;
  },
): Promise<
  | { ok: true; result: unknown; latencyMs: number }
  /**
   * `inputError`: the call itself was wrong (unknown tool, bad argument), as opposed to failing.
   * `unknownTool`: the input error is a tool name the server does not advertise.
   * `refused`: the server takes Console identity and there was no person to mint a token for.
   */
  | { ok: false; error: string; inputError: boolean; unknownTool: boolean; refused: boolean; quotaExceeded?: boolean }
> {
  const runtimeHeaders = resolveMcpRuntimeHeaders(server, log.runtimeContext);
  // Header names only — values never reach the log payload.
  const runtimeAuth = describeRuntimeAuth(log.runtimeContext, runtimeHeaders);
  // Values (runtime headers + static upstream credential) that must be scrubbed
  // from an echoed response before it is persisted.
  const secretValues = mcpRequestSecretValues(server, runtimeHeaders);
  // Only the host's `_meta` is recorded here, not who called: the address and
  // user agent stay out of token-caller rows.
  const logOptions = log.clientMeta === undefined ? undefined : { client: { meta: log.clientMeta } };
  try {
    const { latencyMs, result } = await executeMcpTool(
      server,
      toolName,
      args,
      runtimeHeaders,
      consoleIdentityCallerOf(log.runtimeContext, { projectId: log.projectId ?? server.projectId }),
    );
    void logMcpRequest(log.tenantDbName, {
      tenantId: log.tenantId,
      projectId: log.projectId,
      serverId: String(server._id),
      serverKey: server.key,
      toolName,
      status: 'success',
      latencyMs,
      requestPayload: {
        tool: toolName,
        arguments: args,
        ...(runtimeAuth ? { _runtimeAuth: runtimeAuth } : {}),
      },
      responsePayload: typeof result === 'object' && result !== null
        ? result as Record<string, unknown>
        : { value: result },
      callerTokenId: log.caller.tokenId,
      callerUserId: log.caller.userId,
      callerType: 'api',
      transport: log.transport,
      sourceType: resolveSourceType(server),
      sessionId: log.sessionId,
    }, secretValues, logOptions);
    return { ok: true, result, latencyMs };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Tool execution failed';
    void logMcpRequest(log.tenantDbName, {
      tenantId: log.tenantId,
      projectId: log.projectId,
      serverId: String(server._id),
      serverKey: server.key,
      toolName,
      status: 'error',
      latencyMs: 0,
      requestPayload: {
        tool: toolName,
        arguments: args,
        ...(runtimeAuth ? { _runtimeAuth: runtimeAuth } : {}),
      },
      errorMessage,
      callerTokenId: log.caller.tokenId,
      callerUserId: log.caller.userId,
      callerType: 'api',
      transport: log.transport,
      sourceType: resolveSourceType(server),
      sessionId: log.sessionId,
    }, secretValues, logOptions);
    return {
      ok: false,
      // The executors mask what they throw; this is the same scrub once more on
      // the way out, for errors that did not come through them.
      error: maskSecretValues(errorMessage, secretValues, { maxChars: getConfig().mcp.errorMessageMaxChars }),
      inputError: isMcpToolInputError(error),
      unknownTool: isMcpUnknownToolError(error),
      refused: isConsoleIdentityRefusal(error),
      ...(isQuotaExceededError(error) ? { quotaExceeded: true } : {}),
    };
  }
}

/**
 * What of a call's `_meta` goes to the request log. `runtime_context` is this
 * gateway's own channel for runtime headers; it is recorded as header names
 * only (`_runtimeAuth`), so its values must not come back in through here.
 */
function loggableClientMeta(meta: unknown): unknown {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return meta;
  const rest = { ...(meta as Record<string, unknown>) };
  delete rest.runtime_context;
  return rest;
}

/**
 * Handle a single JSON-RPC message for the client MCP gateway.
 *
 * Shared by the `/message` endpoint (SSE transport when a `sessionId` is
 * present, streamable-HTTP when it is not) and the POST handler on `/sse`
 * (streamable HTTP). Modern MCP clients speak streamable HTTP first and POST
 * their JSON-RPC to the very URL they would open an SSE stream on — so the
 * advertised `/sse` URL must accept POST too, or those clients fail their
 * streamable-HTTP attempt (404) before falling back to SSE.
 */
async function handleClientMcpMessage(request: FastifyRequest, reply: FastifyReply) {
  const ctx = await getApiTokenContextForRequest(request);
  const { serverKey } = request.params as { serverKey: string };
  // A message that names an SSE session is delivered into that stream — only
  // when this token opened it, on this server.
  const lookup = lookupMessageSession(request, {
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    serverKey,
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
    const server = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
    if (!server) {
      return respond(jsonRpcError(id, -32001, 'MCP server not found'));
    }
    if (!protocolEnabled(server, requiredProtocol)) {
      return respond(jsonRpcError(id, -32003, `${requiredProtocol} access is disabled for this MCP server`));
    }
    const instructions = resolveMcpInstructions(server);
    return respond(jsonRpcOk(id, {
      capabilities: {
        tools: { listChanged: false },
      },
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: getConfig().mcp.serverInfoName, version: SERVER_VERSION },
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
    const server = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
    if (!server) {
      return respond(jsonRpcError(id, -32001, 'MCP server not found'));
    }
    if (!protocolEnabled(server, requiredProtocol)) {
      return respond(jsonRpcError(id, -32003, `${requiredProtocol} access is disabled for this MCP server`));
    }

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

    const server = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
    if (!server) {
      return respond(jsonRpcError(id, -32001, 'MCP server not found'));
    }
    if (server.status !== 'active') {
      return respond(jsonRpcError(id, -32002, 'MCP server is disabled'));
    }
    if (!protocolEnabled(server, requiredProtocol)) {
      return respond(jsonRpcError(id, -32003, `${requiredProtocol} access is disabled for this MCP server`));
    }

    // MCP convention: request-scoped extras ride in params._meta.
    const meta = body.params?._meta as Record<string, unknown> | undefined;
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
      clientMeta: loggableClientMeta(meta),
      runtimeContext: buildRuntimeContextFromRequest(meta?.runtime_context, request.headers, {
        userId: ctx.user?._id?.toString(),
        tokenId: ctx.tokenRecord._id?.toString(),
        source: 'mcp',
      }),
    });

    if (outcome.ok) {
      if (isToolOutput(outcome.result)) {
        return respond(jsonRpcOk(id, toMcpCallResult(outcome.result, MCP_PROTOCOL_VERSION)));
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
    if (outcome.quotaExceeded && !(session && sessionId)) {
      return reply.code(429).send(jsonRpcError(id, -32000, outcome.error));
    }
    // An unknown tool is a malformed call. Anything else — a bad argument
    // included — is a failed call whose message the model reads and can act on.
    if (outcome.unknownTool) {
      return respond(jsonRpcError(id, -32602, outcome.error));
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

  return respond(jsonRpcError(id, -32601, `Method not found: ${method.slice(0, 100)}`));
}

export const clientMcpApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/mcp/:serverKey/execute', TRANSPORT_ROUTE, withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const server = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);

      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      if (server.status !== 'active') {
        return reply.code(403).send({ error: 'MCP server is disabled' });
      }

      if (!protocolEnabled(server, 'streamable-http')) {
        return reply.code(403).send({ error: 'HTTP access is disabled for this MCP server' });
      }

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

      const outcome = await runToolCall(server, body.tool, args, {
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        transport: 'rest',
        caller: {
          tokenId: ctx.tokenRecord._id?.toString(),
          userId: ctx.user?._id?.toString(),
        },
        runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
          userId: ctx.user?._id?.toString(),
          tokenId: ctx.tokenRecord._id?.toString(),
          source: 'mcp',
        }),
      });

      if (!outcome.ok) {
        if (outcome.quotaExceeded) return reply.code(429).send(quotaExceededBody({ message: outcome.error }));
        return reply.code(outcome.refused ? 403 : outcome.inputError ? 400 : 502).send({ error: outcome.error });
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

  app.get('/client/v1/mcp/:serverKey/execute', TRANSPORT_ROUTE, withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const server = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);

      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({
        server: serializeMcpServer(server),
        tools: listEnabledMcpTools(server),
      });
    } catch (error) {
      logger.error('Client MCP list tools error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.post('/client/v1/mcp/:serverKey/message', TRANSPORT_ROUTE, withClientApiRequestContext(async (request, reply) => {
    try {
      return await handleClientMcpMessage(request, reply);
    } catch (error) {
      logger.error('Client MCP message handler error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));

  // Streamable HTTP transport: modern MCP clients POST JSON-RPC to the same URL
  // they open the SSE stream on (the advertised `/sse` URL). Without this POST
  // handler such a client's streamable-HTTP attempt 404s (falling through to
  // the Next.js app) before it can fall back to the GET SSE transport below.
  app.post('/client/v1/mcp/:serverKey/sse', TRANSPORT_ROUTE, withClientApiRequestContext(async (request, reply) => {
    try {
      return await handleClientMcpMessage(request, reply);
    } catch (error) {
      logger.error('Client MCP streamable-http handler error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));

  // `exposeHeadRoute: false`: a HEAD request must not open a stream (and so a
  // session) it would never read.
  app.get('/client/v1/mcp/:serverKey/sse', { ...TRANSPORT_ROUTE, exposeHeadRoute: false }, withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const server = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);

      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      if (server.status !== 'active') {
        return reply.code(403).send({ error: 'MCP server is disabled' });
      }
      if (!protocolEnabled(server, 'sse')) {
        return reply.code(403).send({ error: 'SSE access is disabled for this MCP server' });
      }

      const tokenId = ctx.tokenRecord._id?.toString();
      return startMcpSseResponse(request, reply, {
        messagePath: `/api/client/v1/mcp/${encodeURIComponent(serverKey)}/message`,
        session: {
          principal: tokenSsePrincipal(tokenId),
          projectId: ctx.projectId,
          serverKey,
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          tokenId,
        },
        logFields: { serverKey, tenantId: ctx.tenantId },
      });
    } catch (error) {
      logger.error('Client MCP SSE error', { error });
      return reply.code(500).send({ error: 'Internal error' });
    }
  }));

  // ── Authoring: create an MCP server definition ──
  // Collection-level path — distinct from the deeper `:serverKey/execute`
  // gateway routes above, so there is no Fastify path collision.
  app.post('/client/v1/mcp', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      const head = readMcpCreateHead(body, { allowedSourceTypes: VALID_SOURCE_TYPES });
      if (!head.ok) {
        return reply.code(head.status).send({ error: head.error });
      }
      const { sourceType, stdioConfig } = head.value;

      // Enterprise sub-feature: persistent sandbox execution needs the runtime
      // seam (enterprise build) AND an active ENTERPRISE license. Reject up-front
      // with the same 402 the dashboard uses — it literally cannot run otherwise.
      const licenseEnterprise = isEnterpriseLicenseType(ctx.tenant.licenseType);
      if (stdioConfig?.executionMode === 'sandbox' && !(licenseEnterprise && mcpSandboxRunner.current)) {
        return reply.code(402).send({
          error: 'Persistent sandbox execution requires an active Enterprise license.',
          module: 'sandbox',
          requiresEnterprise: true,
        });
      }

      if (stdioConfig?.executionMode === 'subprocess' && !(await hasStdioSubprocessPermission(request))) {
        return reply.code(403).send({ error: STDIO_SUBPROCESS_FORBIDDEN_ERROR });
      }

      const upstream = readMcpUpstreamBody(body, sourceType);
      if (!upstream.ok) {
        return reply.code(upstream.status).send({ error: upstream.error });
      }

      const access = body.access !== undefined ? parseAccessListInput(body.access) : undefined;
      if (access && !access.ok) return reply.code(400).send({ error: access.error });

      const server = await createMcpServer(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.tokenRecord.userId,
        ctx.projectId,
        {
          ...readMcpCommonCreateFields(body, head.value, upstream.upstreamAuth),
          sourceType: sourceType as 'openapi' | 'remote' | 'stdio',
          ...(access?.ok ? { access: access.access } : {}),
        },
        auditContextFor(request, ctx.tokenRecord.userId),
      );

      return reply.code(201).send({ server: serializeMcpServer(server) });
    } catch (error) {
      if (isMcpServerConfigError(error)) return reply.code(400).send({ error: error.message });
      logger.error('Create client MCP server error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  // ── Authoring: update an MCP server definition (project-scoped resolve by key) ──
  app.patch('/client/v1/mcp/:serverKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const existing = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);

      const authType = body.upstreamAuth && typeof body.upstreamAuth === 'object'
        ? (body.upstreamAuth as { type?: unknown }).type
        : undefined;
      if (authType !== undefined && !VALID_AUTH_TYPES.includes(authType as McpAuthType)) {
        return reply.code(400).send({
          error: 'upstreamAuth.type must be "none", "token", "header", "basic", or "console_identity"',
        });
      }

      if (body.status !== undefined && body.status !== 'active' && body.status !== 'disabled') {
        return reply.code(400).send({ error: 'status must be "active" or "disabled"' });
      }

      if (body.disabledTools !== undefined
        && (!Array.isArray(body.disabledTools) || body.disabledTools.some((n) => typeof n !== 'string'))) {
        return reply.code(400).send({ error: 'disabledTools must be an array of tool names' });
      }

      if (body.toolAnnotations !== undefined
        && (typeof body.toolAnnotations !== 'object' || body.toolAnnotations === null
          || Array.isArray(body.toolAnnotations))) {
        return reply.code(400).send({ error: 'toolAnnotations must be an object keyed by tool name' });
      }

      if (body.toolDescriptions !== undefined
        && (typeof body.toolDescriptions !== 'object' || body.toolDescriptions === null
          || Array.isArray(body.toolDescriptions))) {
        return reply.code(400).send({ error: 'toolDescriptions must be an object keyed by tool name' });
      }

      // Same enterprise-sandbox gate as create (mirrors the dashboard PATCH).
      const licenseEnterprise = isEnterpriseLicenseType(ctx.tenant.licenseType);
      const nextStdioConfig = body.stdioConfig !== undefined ? parseStdioConfig(body.stdioConfig) : undefined;
      const nextGuardrail = body.guardrail !== undefined ? parseGuardrail(body.guardrail) : undefined;
      if (nextStdioConfig?.executionMode === 'sandbox' && !(licenseEnterprise && mcpSandboxRunner.current)) {
        return reply.code(402).send({
          error: 'Persistent sandbox execution requires an active Enterprise license.',
          module: 'sandbox',
          requiresEnterprise: true,
        });
      }

      if (nextStdioConfig?.executionMode === 'subprocess' && !(await hasStdioSubprocessPermission(request))) {
        return reply.code(403).send({ error: STDIO_SUBPROCESS_FORBIDDEN_ERROR });
      }

      const instructionsError = mcpInstructionsInputError(body.instructions);
      if (instructionsError) return reply.code(400).send({ error: instructionsError });

      const nextAccess = body.access !== undefined ? parseAccessListInput(body.access) : undefined;
      if (nextAccess && !nextAccess.ok) return reply.code(400).send({ error: nextAccess.error });

      const updated = await updateMcpServer(ctx.tenantDbName, String(existing._id), ctx.tokenRecord.userId, {
        key: typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined,
        description: body.description as string | undefined,
        name: body.name as string | undefined,
        openApiSpec: body.openApiSpec as string | undefined,
        specFormat: typeof body.specFormat === 'string' ? body.specFormat as SpecFormatHint : undefined,
        status: body.status as 'active' | 'disabled' | undefined,
        upstreamAuth: body.upstreamAuth as IMcpAuthConfig | undefined,
        upstreamBaseUrl: body.upstreamBaseUrl as string | undefined,
        remoteConfig: body.remoteConfig !== undefined ? parseRemoteConfig(body.remoteConfig) : undefined,
        stdioConfig: nextStdioConfig,
        exposure: body.exposure !== undefined ? parseExposure(body.exposure) : undefined,
        guardrail: nextGuardrail,
        ...(nextAccess?.ok ? { access: nextAccess.access } : {}),
        runtimeHeaders: body.runtimeHeaders as { allow?: boolean; allowedNames?: string[] } | null | undefined,
        disabledTools: body.disabledTools as string[] | undefined,
        toolAnnotations: body.toolAnnotations as UpdateMcpServerInput['toolAnnotations'],
        toolDescriptions: body.toolDescriptions as UpdateMcpServerInput['toolDescriptions'],
        instructions: body.instructions as string | null | undefined,
      }, auditContextFor(request, ctx.tokenRecord.userId));

      if (!updated) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({ server: serializeMcpServer(updated) });
    } catch (error) {
      if (isMcpServerConfigError(error)) return reply.code(400).send({ error: error.message });
      logger.error('Update client MCP server error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  // ── Authoring: delete an MCP server definition (project-scoped resolve by key) ──
  app.delete('/client/v1/mcp/:serverKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const existing = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      const deleted = await deleteMcpServer(
        ctx.tenantDbName,
        String(existing._id),
        auditContextFor(request, ctx.tokenRecord.userId),
      );
      if (!deleted) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client MCP server error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  // ── Authoring: re-run tool discovery against the source ──
  app.post('/client/v1/mcp/:serverKey/refresh-tools', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { serverKey } = request.params as { serverKey: string };
      const existing = await sharedServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      const updated = await refreshMcpServerTools(
        ctx.tenantDbName,
        String(existing._id),
        ctx.tokenRecord.userId,
        auditContextFor(request, ctx.tokenRecord.userId),
      );
      if (!updated) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({ server: serializeMcpServer(updated) });
    } catch (error) {
      logger.error('Refresh client MCP tools error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Tool discovery failed',
      });
    }
  }));
};
