import type {
  IMcpAuthConfig,
  IMcpExposureConfig,
  IMcpRemoteConfig,
  IMcpServer,
  IMcpStdioConfig,
  IUser,
  McpAuthType,
} from '@/lib/database';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { SpecFormatHint } from '@/lib/services/specImport';
import { createLogger } from '@/lib/core/logger';
import {
  aggregateMcpRequestLogs,
  countMcpRequestLogs,
  createMcpServer,
  deleteMcpServer,
  executeMcpTool,
  getMcpMonitorSnapshot,
  getMcpServer,
  listMcpAuditLogs,
  listMcpRequestLogs,
  listMcpServers,
  logMcpAudit,
  logMcpRequest,
  mcpRequestSecretValues,
  refreshMcpServerTools,
  resolveSourceType,
  serializeMcpServer,
  serializeMcpServerFull,
  stdioRuntimeAvailable,
  isStdioRunnerEnabled,
  updateMcpServer,
} from '@/lib/services/mcp';
import type { McpAuditContext, InternalMcpConfigInput, UpdateMcpServerInput } from '@/lib/services/mcp';
import { INTERNAL_MCP_PROVIDERS } from '@/lib/services/mcp/internal/registry';
import {
  buildRuntimeContextFromRequest,
  describeRuntimeAuth,
  resolveRuntimeHeaders,
  runtimeHeaderPolicyFromMetadata,
} from '@/lib/services/runtimeContext';
import { mcpSandboxRunner, mcpGuardrailHook, IS_ENTERPRISE_BUILD } from '@/enterprise/registry';
import { isEnterpriseLicenseType } from '@/lib/license/license-manager';
import {
  getClientIp,
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:mcp');
const VALID_AUTH_TYPES: McpAuthType[] = ['none', 'token', 'header', 'basic'];
const VALID_SOURCE_TYPES = ['openapi', 'remote', 'stdio', 'internal'] as const;

/**
 * Resolve a server by id within the caller's project scope.
 *
 * findMcpServerById is scoped only by tenant DB, so without this an ordinary
 * member could address any project's server in the same tenant — reading its
 * config, flipping its exposure to public, or running its tools with the
 * upstream credentials it stores. Returns null for an out-of-scope id so it is
 * indistinguishable from a missing one. Owners/admins keep tenant-wide reach
 * (resolveProjectContext already grants it), and servers stored without a
 * projectId stay tenant-wide as findMcpServerByKey already treats them.
 */
async function serverInProjectScope(
  tenantDbName: string,
  id: string,
  projectId: string,
  user: Pick<IUser, 'role'>,
): Promise<IMcpServer | null> {
  const server = await getMcpServer(tenantDbName, id);
  if (!server) return null;
  if (user.role === 'owner' || user.role === 'admin') return server;
  if (!server.projectId) return server;
  return String(server.projectId) === String(projectId) ? server : null;
}

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

function parseInternalConfig(raw: unknown): InternalMcpConfigInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { provider?: unknown; instanceKey?: unknown; config?: unknown };
  if (typeof value.provider !== 'string' || !value.provider.trim()) return undefined;
  if (typeof value.instanceKey !== 'string' || !value.instanceKey.trim()) return undefined;
  return {
    provider: value.provider.trim(),
    instanceKey: value.instanceKey.trim(),
    config: value.config && typeof value.config === 'object'
      ? value.config as Record<string, unknown>
      : undefined,
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

  // Runtime capabilities for the create screen: which source types /
  // execution modes are available on this deployment.
  app.get('/mcp/capabilities', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const licenseEnterprise = isEnterpriseLicenseType(session.licenseType);
      const [npxAvailable, uvxAvailable] = await Promise.all([
        stdioRuntimeAvailable('npx'),
        stdioRuntimeAvailable('uvx'),
      ]);
      // Sandbox execution + Aegis enforcement are enterprise sub-features: a
      // tenant may use them only when the runtime seam is wired (enterprise
      // build) AND the tenant holds an active ENTERPRISE license. `available`
      // therefore folds both; `seamAvailable`/`licenseEnterprise` let the UI
      // explain WHY it is unavailable (build vs. plan).
      return reply.code(200).send({
        stdioSubprocess: {
          enabled: isStdioRunnerEnabled(),
          npx: npxAvailable,
          uvx: uvxAvailable,
        },
        stdioSandbox: {
          available: Boolean(mcpSandboxRunner.current) && licenseEnterprise,
          seamAvailable: Boolean(mcpSandboxRunner.current),
          enterpriseBuild: IS_ENTERPRISE_BUILD,
          licenseEnterprise,
        },
        aegis: {
          hookAvailable: Boolean(mcpGuardrailHook.current) && licenseEnterprise,
          seamAvailable: Boolean(mcpGuardrailHook.current),
          enterpriseBuild: IS_ENTERPRISE_BUILD,
          licenseEnterprise,
        },
        // MCP Hubs ship as a whole separate plugin in the enterprise overlay
        // (no seam ref to check, unlike sandbox/Aegis) — the build flag alone
        // says whether the /api/mcp/hubs routes even exist.
        mcpHub: {
          available: IS_ENTERPRISE_BUILD && licenseEnterprise,
          enterpriseBuild: IS_ENTERPRISE_BUILD,
          licenseEnterprise,
        },
        internalProviders: INTERNAL_MCP_PROVIDERS.map((p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          configFields: p.configFields,
        })),
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // Unified monitor snapshot: per-server runtime state + 24h aggregates +
  // recent request/audit activity.
  app.get('/mcp/monitor', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const snapshot = await getMcpMonitorSnapshot(session.tenantDbName, projectId);
      return reply.code(200).send(snapshot);
    } catch (error) {
      logger.error('MCP monitor snapshot error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // Project-wide audit trail (optionally filtered by server/action).
  app.get('/mcp/audit', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        serverKey?: string;
        action?: string;
        limit?: string;
        skip?: string;
      };
      const logs = await listMcpAuditLogs(session.tenantDbName, {
        projectId,
        serverKey: query.serverKey,
        action: query.action,
        limit: Math.min(Number.parseInt(query.limit ?? '50', 10) || 50, 200),
        skip: Math.max(Number.parseInt(query.skip ?? '0', 10) || 0, 0),
      });
      return reply.code(200).send({ logs });
    } catch (error) {
      logger.error('List MCP audit logs error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  app.post('/mcp', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      const sourceType = typeof body.sourceType === 'string' ? body.sourceType : 'openapi';
      if (!VALID_SOURCE_TYPES.includes(sourceType as typeof VALID_SOURCE_TYPES[number])) {
        return reply.code(400).send({ error: 'sourceType must be "openapi", "remote", "stdio", or "internal"' });
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

      const internalConfig = parseInternalConfig(body.internalConfig);
      if (sourceType === 'internal') {
        if (!internalConfig) {
          return reply.code(400).send({ error: 'internalConfig.provider and internalConfig.instanceKey are required' });
        }
        if (!INTERNAL_MCP_PROVIDERS.some((p) => p.id === internalConfig.provider)) {
          return reply.code(400).send({ error: `Unknown internal provider "${internalConfig.provider}"` });
        }
      }

      // Enterprise sub-feature: persistent sandbox execution needs the runtime
      // seam (enterprise build) AND an active ENTERPRISE license. Reject up-front
      // with a clear 402 — it literally cannot run otherwise, so a silent save
      // would strand the tenant. (Aegis is softer: it is saved but stays inert
      // without the license; the UI warns about that — no hard reject here.)
      const licenseEnterprise = isEnterpriseLicenseType(session.licenseType);
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
        session.tenantDbName,
        session.tenantId,
        session.userId,
        projectId,
        {
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          name: body.name.trim(),
          sourceType: sourceType as 'openapi' | 'remote' | 'stdio' | 'internal',
          openApiSpec: typeof body.openApiSpec === 'string' ? body.openApiSpec : undefined,
          specFormat: typeof body.specFormat === 'string' ? body.specFormat as SpecFormatHint : undefined,
          upstreamAuth: body.upstreamAuth as IMcpAuthConfig,
          upstreamBaseUrl: typeof body.upstreamBaseUrl === 'string'
            ? body.upstreamBaseUrl.trim()
            : undefined,
          remoteConfig,
          stdioConfig,
          internalConfig,
          exposure: parseExposure(body.exposure),
          aegis: aegisConfig,
        },
        auditContextFor(request, session.userId),
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
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as {
        includeAggregate?: string;
        includeLogs?: string;
        includeAudit?: string;
      };

      const server = await serverInProjectScope(session.tenantDbName, id, projectId, user);
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

      if (query.includeAudit === 'true') {
        payload.audit = await listMcpAuditLogs(session.tenantDbName, {
          serverKey: server.key,
          limit: 50,
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
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await serverInProjectScope(session.tenantDbName, id, projectId, user))) {
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

      // Enterprise sub-feature gate (mirrors POST): a non-enterprise tenant may
      // not turn on persistent sandbox execution via edit. Aegis is left as
      // save-but-inert (UI warns) to match create behaviour.
      const licenseEnterprise = isEnterpriseLicenseType(session.licenseType);
      const nextStdioConfig = body.stdioConfig !== undefined ? parseStdioConfig(body.stdioConfig) : undefined;
      const nextAegis = body.aegis !== undefined ? parseAegis(body.aegis) : undefined;
      if (nextStdioConfig?.executionMode === 'sandbox' && !(licenseEnterprise && mcpSandboxRunner.current)) {
        return reply.code(402).send({
          error: 'Persistent sandbox execution requires an active Enterprise license.',
          module: 'sandbox',
          requiresEnterprise: true,
        });
      }

      const updated = await updateMcpServer(session.tenantDbName, id, session.userId, {
        description: body.description as string | undefined,
        name: body.name as string | undefined,
        openApiSpec: body.openApiSpec as string | undefined,
        specFormat: typeof body.specFormat === 'string' ? body.specFormat as SpecFormatHint : undefined,
        status: body.status as 'active' | 'disabled' | undefined,
        upstreamAuth: body.upstreamAuth as IMcpAuthConfig | undefined,
        upstreamBaseUrl: body.upstreamBaseUrl as string | undefined,
        remoteConfig: body.remoteConfig !== undefined ? parseRemoteConfig(body.remoteConfig) : undefined,
        stdioConfig: nextStdioConfig,
        internalConfig: body.internalConfig !== undefined ? parseInternalConfig(body.internalConfig) : undefined,
        exposure: body.exposure !== undefined ? parseExposure(body.exposure) : undefined,
        aegis: nextAegis,
        runtimeHeaders: body.runtimeHeaders as { allow?: boolean; allowedNames?: string[] } | null | undefined,
        disabledTools: body.disabledTools as string[] | undefined,
        toolAnnotations: body.toolAnnotations as UpdateMcpServerInput['toolAnnotations'],
        toolDescriptions: body.toolDescriptions as UpdateMcpServerInput['toolDescriptions'],
      }, auditContextFor(request, session.userId));

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
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await serverInProjectScope(session.tenantDbName, id, projectId, user))) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      const deleted = await deleteMcpServer(
        session.tenantDbName,
        id,
        auditContextFor(request, session.userId),
      );

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

  // Re-run tool discovery against the remote/stdio source.
  app.post('/mcp/:id/refresh-tools', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await serverInProjectScope(session.tenantDbName, id, projectId, user))) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      const updated = await refreshMcpServerTools(
        session.tenantDbName,
        id,
        session.userId,
        auditContextFor(request, session.userId),
      );
      if (!updated) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      return reply.code(200).send({ server: serializeMcpServerFull(updated) });
    } catch (error) {
      logger.error('Refresh MCP tools error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Tool discovery failed',
        });
    }
  }));

  app.get('/mcp/:id/logs', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const server = await serverInProjectScope(session.tenantDbName, id, projectId, user);

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

  // Playground: test-execute one of the server's tools from the dashboard.
  app.post('/mcp/:id/execute', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      const toolName = typeof body.tool === 'string'
        ? body.tool
        : typeof body.toolName === 'string'
          ? body.toolName
          : '';
      if (!toolName.trim()) {
        return reply.code(400).send({ error: '"tool" is required' });
      }

      const args = (body.arguments ?? body.args ?? {}) as Record<string, unknown>;

      const server = await serverInProjectScope(session.tenantDbName, id, projectId, user);
      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      if (server.status !== 'active') {
        return reply.code(400).send({ error: 'MCP server is disabled' });
      }

      // Playground JSON editor: caller-supplied runtime context, filtered by
      // the server's opt-in policy exactly like the external surfaces.
      const runtimeContext = buildRuntimeContextFromRequest(body.runtime_context, request.headers, {
        userId: session.userId,
        source: 'playground',
      });
      const runtimeHeaders = resolveRuntimeHeaders(
        runtimeContext,
        'mcp',
        server.key,
        runtimeHeaderPolicyFromMetadata(server.metadata),
      );
      const runtimeAuth = describeRuntimeAuth(runtimeContext, runtimeHeaders);
      const secretValues = mcpRequestSecretValues(server, runtimeHeaders);

      void logMcpAudit(session.tenantDbName, {
        tenantId: session.tenantId,
        projectId: server.projectId,
        serverId: id,
        serverKey: server.key,
        action: 'playground_execute',
        changes: { tool: { to: toolName } },
        performedBy: session.userId,
        ipAddress: getClientIp(request),
        userAgent: typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent'].slice(0, 300)
          : undefined,
      });

      try {
        const { result, latencyMs } = await executeMcpTool(server, toolName, args, runtimeHeaders);

        void logMcpRequest(session.tenantDbName, {
          tenantId: session.tenantId,
          projectId: server.projectId,
          serverKey: server.key,
          toolName,
          status: 'success',
          latencyMs,
          requestPayload: {
            tool: toolName,
            arguments: args,
            ...(runtimeAuth ? { _runtimeAuth: runtimeAuth } : {}),
          },
          responsePayload: typeof result === 'object' ? result as Record<string, unknown> : { value: result },
          callerType: 'dashboard',
          callerUserId: session.userId,
          transport: 'rest',
          sourceType: resolveSourceType(server),
        }, secretValues);

        return reply.code(200).send({ result, latencyMs });
      } catch (execError) {
        const message = execError instanceof Error ? execError.message : 'Execution failed';
        void logMcpRequest(session.tenantDbName, {
          tenantId: session.tenantId,
          projectId: server.projectId,
          serverKey: server.key,
          toolName,
          status: 'error',
          latencyMs: 0,
          requestPayload: {
            tool: toolName,
            arguments: args,
            ...(runtimeAuth ? { _runtimeAuth: runtimeAuth } : {}),
          },
          errorMessage: message,
          callerType: 'dashboard',
          callerUserId: session.userId,
          transport: 'rest',
          sourceType: resolveSourceType(server),
        }, secretValues);
        return reply.code(500).send({ error: message });
      }
    } catch (error) {
      logger.error('Execute MCP tool error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));
};
