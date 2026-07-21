import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
  IMcpAuthConfig,
  IMcpExposureConfig,
  IMcpRemoteConfig,
  IMcpServer,
  IMcpStdioConfig,
  McpAuthType,
} from '@/lib/database';
import type { SpecFormatHint } from '@/lib/services/specImport';
import { createLogger } from '@/lib/core/logger';
import {
  createMcpServer,
  deleteMcpServer,
  executeMcpTool,
  getMcpServerByKey,
  listEnabledMcpTools,
  logMcpRequest,
  mcpRequestSecretValues,
  refreshMcpServerTools,
  resolveExposure,
  resolveSourceType,
  serializeMcpServer,
  updateMcpServer,
} from '@/lib/services/mcp';
import type { McpAuditContext } from '@/lib/services/mcp';
import {
  createSseSession,
  encodeSseEndpointEvent,
  getSseSession,
  removeSseSession,
  sendSseResponse,
} from '@/lib/services/mcp/sseSessionManager';
import {
  buildRuntimeContextFromRequest,
  describeRuntimeAuth,
  resolveRuntimeHeaders,
  runtimeHeaderPolicyFromMetadata,
  type AgentRuntimeContext,
} from '@/lib/services/runtimeContext';
import { mcpSandboxRunner } from '@/enterprise/registry';
import { isEnterpriseLicenseType } from '@/lib/license/license-manager';
import {
  getApiTokenContextForRequest,
  getClientIp,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-mcp');

const VALID_AUTH_TYPES: McpAuthType[] = ['none', 'token', 'header', 'basic'];
const VALID_SOURCE_TYPES = ['openapi', 'remote', 'stdio'] as const;

// Local parse helpers replicated from the dashboard `mcp.ts` plugin (they are
// not exported). They coerce the raw request sub-objects into the typed config
// shapes the service expects.
function auditContextFor(request: FastifyRequest, userId: string): McpAuditContext {
  const ua = request.headers['user-agent'];
  return {
    performedBy: userId,
    ipAddress: getClientIp(request),
    userAgent: typeof ua === 'string' ? ua.slice(0, 300) : undefined,
  };
}

function parseExposure(raw: unknown): IMcpExposureConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { protocols?: unknown; accessMode?: unknown };
  const protocols = Array.isArray(value.protocols)
    ? value.protocols.filter((p): p is 'streamable-http' | 'sse' => p === 'streamable-http' || p === 'sse')
    : [];
  return {
    protocols: protocols.length ? protocols : ['streamable-http', 'sse'],
    accessMode: value.accessMode === 'public' ? 'public' : 'token',
  };
}

function parseAegis(raw: unknown): { shieldId?: string; mode: 'off' | 'monitor' | 'enforce' } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { shieldId?: unknown; mode?: unknown };
  const mode = value.mode === 'monitor' || value.mode === 'enforce' ? value.mode : 'off';
  return {
    shieldId: typeof value.shieldId === 'string' && value.shieldId.trim() ? value.shieldId.trim() : undefined,
    mode,
  };
}

function parseRemoteConfig(raw: unknown): IMcpRemoteConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { url?: unknown; transport?: unknown };
  if (typeof value.url !== 'string' || !value.url.trim()) return undefined;
  return {
    url: value.url.trim(),
    transport: value.transport === 'sse' ? 'sse' : 'streamable-http',
  };
}

function parseStdioConfig(raw: unknown): IMcpStdioConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as {
    runtime?: unknown;
    packageName?: unknown;
    args?: unknown;
    env?: unknown;
    executionMode?: unknown;
    sandbox?: unknown;
  };
  if (typeof value.packageName !== 'string' || !value.packageName.trim()) return undefined;
  const runtime = value.runtime === 'uvx' ? 'uvx' : 'npx';
  const args = Array.isArray(value.args)
    ? value.args.map((a) => String(a)).filter((a) => a.length > 0)
    : undefined;
  const env = value.env && typeof value.env === 'object'
    ? Object.fromEntries(
        Object.entries(value.env as Record<string, unknown>)
          .filter(([k, v]) => k.trim() && typeof v === 'string')
          .map(([k, v]) => [k.trim(), v as string]),
      )
    : undefined;
  const sandboxRaw = value.sandbox && typeof value.sandbox === 'object'
    ? value.sandbox as { templateKey?: unknown; resources?: { cpuCores?: unknown; memoryMb?: unknown }; instanceId?: unknown }
    : undefined;
  return {
    runtime,
    packageName: value.packageName.trim(),
    args,
    env: env && Object.keys(env).length ? env : undefined,
    executionMode: value.executionMode === 'sandbox' ? 'sandbox' : 'subprocess',
    sandbox: sandboxRaw
      ? {
          templateKey: typeof sandboxRaw.templateKey === 'string' ? sandboxRaw.templateKey : undefined,
          resources: sandboxRaw.resources
            ? {
                cpuCores: Number(sandboxRaw.resources.cpuCores) || undefined,
                memoryMb: Number(sandboxRaw.resources.memoryMb) || undefined,
              }
            : undefined,
        }
      : undefined,
  };
}

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
    runtimeContext?: AgentRuntimeContext;
  },
): Promise<{ ok: true; result: unknown; latencyMs: number } | { ok: false; error: string }> {
  const runtimeHeaders = resolveMcpRuntimeHeaders(server, log.runtimeContext);
  // Header names only — values never reach the log payload.
  const runtimeAuth = describeRuntimeAuth(log.runtimeContext, runtimeHeaders);
  // Values (runtime headers + static upstream credential) that must be scrubbed
  // from an echoed response before it is persisted.
  const secretValues = mcpRequestSecretValues(server, runtimeHeaders);
  try {
    const { latencyMs, result } = await executeMcpTool(server, toolName, args, runtimeHeaders);
    void logMcpRequest(log.tenantDbName, {
      tenantId: log.tenantId,
      projectId: log.projectId,
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
    }, secretValues);
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
    }, secretValues);
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
        runtimeContext: buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
          userId: ctx.user?._id?.toString(),
          tokenId: ctx.tokenRecord._id?.toString(),
          source: 'mcp',
        }),
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
        tools: listEnabledMcpTools(server),
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
          runtimeContext: buildRuntimeContextFromRequest(meta?.runtime_context, request.headers, {
            userId: ctx.user?._id?.toString(),
            tokenId: ctx.tokenRecord._id?.toString(),
            source: 'mcp',
          }),
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

  // ── Authoring: create an MCP server definition ──
  // Collection-level path — distinct from the deeper `:serverKey/execute`
  // gateway routes above, so there is no Fastify path collision.
  app.post('/client/v1/mcp', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      const sourceType = typeof body.sourceType === 'string' ? body.sourceType : 'openapi';
      if (!VALID_SOURCE_TYPES.includes(sourceType as typeof VALID_SOURCE_TYPES[number])) {
        return reply.code(400).send({ error: 'sourceType must be "openapi", "remote", or "stdio"' });
      }

      if (sourceType === 'openapi' && typeof body.openApiSpec !== 'string') {
        return reply.code(400).send({ error: 'openApiSpec is required' });
      }

      const remoteConfig = parseRemoteConfig(body.remoteConfig);
      if (sourceType === 'remote' && !remoteConfig) {
        return reply.code(400).send({ error: 'remoteConfig.url is required' });
      }

      const stdioConfig = parseStdioConfig(body.stdioConfig);
      if (sourceType === 'stdio' && !stdioConfig) {
        return reply.code(400).send({ error: 'stdioConfig.packageName is required' });
      }

      // Enterprise sub-feature: persistent sandbox execution needs the runtime
      // seam (enterprise build) AND an active ENTERPRISE license. Reject up-front
      // with the same 402 the dashboard uses — it literally cannot run otherwise.
      const licenseEnterprise = isEnterpriseLicenseType(ctx.tenant.licenseType);
      const aegisConfig = parseAegis(body.aegis);
      if (stdioConfig?.executionMode === 'sandbox' && !(licenseEnterprise && mcpSandboxRunner.current)) {
        return reply.code(402).send({
          error: 'Persistent sandbox execution requires an active Enterprise license.',
          module: 'sandbox',
          requiresEnterprise: true,
        });
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
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.tokenRecord.userId,
        ctx.projectId,
        {
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          name: body.name.trim(),
          sourceType: sourceType as 'openapi' | 'remote' | 'stdio',
          openApiSpec: typeof body.openApiSpec === 'string' ? body.openApiSpec : undefined,
          specFormat: typeof body.specFormat === 'string' ? body.specFormat as SpecFormatHint : undefined,
          upstreamAuth: body.upstreamAuth as IMcpAuthConfig,
          upstreamBaseUrl: typeof body.upstreamBaseUrl === 'string' ? body.upstreamBaseUrl.trim() : undefined,
          remoteConfig,
          stdioConfig,
          exposure: parseExposure(body.exposure),
          aegis: aegisConfig,
        },
        auditContextFor(request, ctx.tokenRecord.userId),
      );

      return reply.code(201).send({ server: serializeMcpServer(server) });
    } catch (error) {
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
      const existing = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

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

      if (body.disabledTools !== undefined
        && (!Array.isArray(body.disabledTools) || body.disabledTools.some((n) => typeof n !== 'string'))) {
        return reply.code(400).send({ error: 'disabledTools must be an array of tool names' });
      }

      // Same enterprise-sandbox gate as create (mirrors the dashboard PATCH).
      const licenseEnterprise = isEnterpriseLicenseType(ctx.tenant.licenseType);
      const nextStdioConfig = body.stdioConfig !== undefined ? parseStdioConfig(body.stdioConfig) : undefined;
      const nextAegis = body.aegis !== undefined ? parseAegis(body.aegis) : undefined;
      if (nextStdioConfig?.executionMode === 'sandbox' && !(licenseEnterprise && mcpSandboxRunner.current)) {
        return reply.code(402).send({
          error: 'Persistent sandbox execution requires an active Enterprise license.',
          module: 'sandbox',
          requiresEnterprise: true,
        });
      }

      const updated = await updateMcpServer(ctx.tenantDbName, String(existing._id), ctx.tokenRecord.userId, {
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
        aegis: nextAegis,
        runtimeHeaders: body.runtimeHeaders as { allow?: boolean; allowedNames?: string[] } | null | undefined,
        disabledTools: body.disabledTools as string[] | undefined,
      }, auditContextFor(request, ctx.tokenRecord.userId));

      if (!updated) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({ server: serializeMcpServer(updated) });
    } catch (error) {
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
      const existing = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
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
      const existing = await getMcpServerByKey(ctx.tenantDbName, serverKey, ctx.projectId);
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
