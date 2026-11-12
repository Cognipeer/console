import { isQuotaExceededError } from '@/lib/quota/serviceQuota';
import { ownedListFilterOf, readAgentIdInput, resolveOwningAgent } from '@/lib/services/agents/agentOwnedResources';
import { parseAccessListInput } from '@/lib/iam/accessList';
import type {
  IMcpAuthConfig,
  IMcpServer,
  McpAuthType,
} from '@/lib/database';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SpecFormatHint } from '@/lib/services/specImport';
import { createLogger } from '@/lib/core/logger';
import { consoleIdentityCallerOf, consoleIdentityIssuerInfo } from '@/lib/iam/consoleIdentity';
import {
  aggregateMcpRequestLogs,
  countMcpRequestLogs,
  createMcpServer,
  deleteMcpServer,
  executeMcpTool,
  getMcpMonitorSnapshot,
  getMcpServer,
  isMcpServerConfigError,
  mcpInstructionsInputError,
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
import type {
  InternalMcpConfigInput,
  CompositeConfigInput,
  UpdateMcpServerInput,
} from '@/lib/services/mcp';
import { sanitizeCompositePrefix } from '@/lib/services/mcp';
import { INTERNAL_MCP_PROVIDERS } from '@/lib/services/mcp/internal/registry';
import { sandboxInstanceProvider, sandboxProvider } from '@/lib/services/mcp/internal/sandboxProvider';
import { requestHasSandboxWrite } from './sandbox-permission';
import {
  buildRuntimeContextFromRequest,
  describeRuntimeAuth,
  resolveRuntimeHeaders,
  runtimeHeaderPolicyFromMetadata,
} from '@/lib/services/runtimeContext';
import { mcpSandboxRunner, IS_ENTERPRISE_BUILD } from '@/enterprise/registry';
import { ensureMcpGuardrailHook } from '@/lib/services/guardrail/hooks/mcpHook';
import { isEnterpriseLicenseType } from '@/lib/license/license-manager';
import {
  type ApiSessionContext,
  authorizeServiceForRequest,
  getClientIp,
  readJsonBody,
  requireProjectContextForRequest,
  resolveSessionRbacContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { withoutRestrictedMcpLogContent } from '../restrictedKnowledgeRequest';
import {
  PUBLIC_EXPOSURE_FORBIDDEN_ERROR,
  VALID_AUTH_TYPES,
  auditContextFor,
  parseAegis,
  parseExposure,
  parseGuardrail,
  parseRemoteConfig,
  parseStdioConfig,
  publishesPublicly,
  readMcpCommonCreateFields,
  readMcpCreateHead,
  readMcpSecurityUpdate,
  readMcpUpstreamBody,
} from './mcp-shared';

const logger = createLogger('api:mcp');
const VALID_SOURCE_TYPES = ['openapi', 'remote', 'stdio', 'internal', 'composite'] as const;

/**
 * Resolve a server by id within the caller's project scope.
 *
 * findMcpServerById is scoped only by tenant DB, so without this an ordinary
 * member could address any project's server in the same tenant — reading its
 * config, flipping its exposure to public, or running its tools with the
 * upstream credentials it stores. Returns null for an out-of-scope id so it is
 * indistinguishable from a missing one. Owners/admins too (the active
 * project decides; they switch to reach another), and servers stored without a
 * projectId stay tenant-wide as findMcpServerByKey already treats them.
 */
async function serverInProjectScope(
  tenantDbName: string,
  id: string,
  projectId: string,
): Promise<IMcpServer | null> {
  const server = await getMcpServer(tenantDbName, id);
  if (!server) return null;
  if (!server.projectId) return server;
  return String(server.projectId) === String(projectId) ? server : null;
}

/** Maps `resolveEndpointSlug`'s thrown errors to proper status codes; null if `error` isn't one of them. */
function sendEndpointSlugError(reply: FastifyReply, error: unknown): ReturnType<FastifyReply['send']> | null {
  if (!(error instanceof Error)) return null;
  if (error.message.startsWith('Custom path must be')) {
    return reply.code(400).send({ error: error.message });
  }
  if (error.message.includes('is already used by another MCP server')) {
    return reply.code(409).send({ error: error.message });
  }
  return null;
}

/**
 * A stdio 'subprocess' execution mode makes the shared backend process spawn
 * npx/uvx with a caller-supplied package name/args on this host — unlike
 * every other MCP source type (and unlike 'sandbox', which is already gated
 * behind an Enterprise license). The 'mcp' service otherwise only requires
 * 'write' by default, which the 'user'/'project_admin' roles hold — so this
 * one capability is additionally gated behind 'admin'-level 'mcp' permission
 * (owner/admin role, or an explicit admin-level grant).
 */
async function requireStdioSubprocessPermission(
  request: FastifyRequest,
  session: ApiSessionContext,
): Promise<boolean> {
  const rbac = await resolveSessionRbacContext(session);
  // The policy engine decides, with project narrowing and custom policies.
  return (await authorizeServiceForRequest(request, 'mcp', { level: 'admin', rbac })).allowed;
}

const STDIO_SUBPROCESS_FORBIDDEN_ERROR =
  'Creating or editing a stdio MCP server with subprocess execution requires elevated "mcp" '
  + 'admin permission. Ask a tenant owner/admin, or have one grant your account admin-level MCP permission.';

/**
 * Serving a sandbox over MCP hands its callers the right to run code in it, so a server on a sandbox provider is
 * created, or pointed at another template or sandbox, only by someone who may work in the project's sandboxes
 * (Sandbox write). Re-saving other settings asks nothing.
 */
const SANDBOX_MCP_PROVIDER_IDS = new Set([sandboxProvider.id, sandboxInstanceProvider.id]);

const SANDBOX_MCP_WRITE_REQUIRED_BODY = {
  error: 'Serving a sandbox over MCP needs write access to Sandbox in this project.',
  type: 'sandbox_write_required',
  code: 'sandbox_write_required',
  field: 'internalConfig',
} as const;

async function sandboxMcpRefusal(
  request: FastifyRequest,
  projectId: string,
  internalConfig: InternalMcpConfigInput | undefined,
): Promise<typeof SANDBOX_MCP_WRITE_REQUIRED_BODY | null> {
  if (!internalConfig || !SANDBOX_MCP_PROVIDER_IDS.has(internalConfig.provider)) return null;
  return (await requestHasSandboxWrite(request, projectId)) ? null : SANDBOX_MCP_WRITE_REQUIRED_BODY;
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

/** Shape-only parse — deep validation (member exists, same tenant/project, no
 *  nesting) happens against the DB inside createMcpServer/updateMcpServer. */
function parseCompositeConfig(raw: unknown): CompositeConfigInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { members?: unknown };
  if (!Array.isArray(value.members)) return undefined;
  const members: CompositeConfigInput['members'] = [];
  for (const m of value.members) {
    if (!m || typeof m !== 'object') continue;
    const entry = m as { serverId?: unknown; toolPrefix?: unknown; alwaysPrefix?: unknown };
    if (typeof entry.serverId !== 'string' || !entry.serverId.trim()) continue;
    members.push({
      serverId: entry.serverId.trim(),
      toolPrefix: sanitizeCompositePrefix(entry.toolPrefix),
      alwaysPrefix: entry.alwaysPrefix === true,
    });
  }
  return { members };
}

export const mcpApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/mcp', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        search?: string;
        status?: 'active' | 'disabled';
        agentId?: string;
        owned?: string;
      };
      // The hub by default; `agentId` adds that agent's own servers (`owned=only`: just those).
      const owned = ownedListFilterOf(query);
      if (!owned.ok) return reply.code(400).send({ error: owned.error });

      const servers = await listMcpServers(session.tenantDbName, {
        projectId,
        search: query.search,
        status: query.status,
        ...owned.filter,
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
      // Resolve rather than peek: the seam is filled lazily on first use (a
      // module-scope read of the ref crashes the enterprise build — see
      // `ensureMcpGuardrailHook`), so reading `mcpGuardrailHook.current`
      // directly would report the guardrail as unavailable on any process
      // that had not yet run an MCP tool call.
      const guardrailHookAvailable = Boolean(ensureMcpGuardrailHook());
      // Sandbox execution is an enterprise sub-feature: a tenant may use it
      // only when the runtime seam is wired (enterprise build) AND the tenant
      // holds an active ENTERPRISE license. `available` therefore folds both;
      // `seamAvailable`/`licenseEnterprise` let the UI explain WHY it is
      // unavailable (build vs. plan).
      //
      // Guardrail enforcement is NOT one of those any more — it is community,
      // in every build and on every plan. `licenseEnterprise` is still reported
      // beside it so a not-yet-deployed UI reading that key renders something
      // sane, but nothing gates on it.
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
        // The canonical block. `available` is the single key the UI should read.
        guardrail: {
          available: guardrailHookAvailable,
          seamAvailable: guardrailHookAvailable,
          enterpriseBuild: IS_ENTERPRISE_BUILD,
          licenseEnterprise,
          requiresEnterprise: false,
        },
        // @deprecated Mirror of `guardrail`, kept for the release in which the
        // dashboard bundle may be older than this API. The four keys are the
        // ones the shipped UI reads — dropping any of them mid-deploy makes the
        // MCP create screen render an "unavailable" state for a feature that is
        // now always available, which is why `hookAvailable` no longer folds in
        // `licenseEnterprise`.
        aegis: {
          hookAvailable: guardrailHookAvailable,
          seamAvailable: guardrailHookAvailable,
          enterpriseBuild: IS_ENTERPRISE_BUILD,
          licenseEnterprise,
        },
        // MCP Hubs ship as a whole separate plugin in the enterprise overlay
        // (no seam ref to check, unlike sandbox/guardrail) — the build flag
        // alone says whether the /api/mcp/hubs routes even exist.
        mcpHub: {
          available: IS_ENTERPRISE_BUILD && licenseEnterprise,
          enterpriseBuild: IS_ENTERPRISE_BUILD,
          licenseEnterprise,
        },
        // What a server set up for Console identity verifies its tokens against.
        consoleIdentity: consoleIdentityIssuerInfo(session.tenantId),
        // `available: false` (an enterprise module or license missing) hides the provider on the create screen;
        // `tokenOnly`: a server on it, and a composite that includes one, takes an API token only.
        internalProviders: await Promise.all(INTERNAL_MCP_PROVIDERS.map(async (p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          configFields: p.configFields,
          tokenOnly: p.tokenOnly === true,
          available: p.isAvailable ? await p.isAvailable({ tenantId: session.tenantId }).catch(() => false) : true,
        }))),
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
      return reply.code(200).send({
        ...snapshot,
        recentLogs: await withoutRestrictedMcpLogContent(request, { tenantDbName: session.tenantDbName, viewerUserId: session.userId }, snapshot.recentLogs),
      });
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

      const head = readMcpCreateHead(body, { allowedSourceTypes: VALID_SOURCE_TYPES });
      if (!head.ok) {
        return reply.code(head.status).send({ error: head.error });
      }
      const { sourceType, stdioConfig } = head.value;

      const internalConfig = parseInternalConfig(body.internalConfig);
      if (sourceType === 'internal') {
        if (!internalConfig) {
          return reply.code(400).send({ error: 'internalConfig.provider and internalConfig.instanceKey are required' });
        }
        if (!INTERNAL_MCP_PROVIDERS.some((p) => p.id === internalConfig.provider)) {
          return reply.code(400).send({ error: `Unknown internal provider "${internalConfig.provider}"` });
        }
        const sandboxRefusal = await sandboxMcpRefusal(request, projectId, internalConfig);
        if (sandboxRefusal) return reply.code(403).send(sandboxRefusal);
      }

      const compositeConfig = parseCompositeConfig(body.compositeConfig);
      if (sourceType === 'composite' && !compositeConfig?.members.length) {
        return reply.code(400).send({ error: 'compositeConfig.members must include at least one member server' });
      }

      // Enterprise sub-feature: persistent sandbox execution needs the runtime
      // seam (enterprise build) AND an active ENTERPRISE license. Reject up-front
      // with a clear 402 — it literally cannot run otherwise, so a silent save
      // would strand the tenant. (The guardrail binding needs no gate at all:
      // it is community and enforces on every plan.)
      const licenseEnterprise = isEnterpriseLicenseType(session.licenseType);
      if (stdioConfig?.executionMode === 'sandbox' && !(licenseEnterprise && mcpSandboxRunner.current)) {
        return reply.code(402).send({
          error: 'Persistent sandbox execution requires an active Enterprise license.',
          module: 'sandbox',
          requiresEnterprise: true,
        });
      }

      if (stdioConfig?.executionMode === 'subprocess' && !(await requireStdioSubprocessPermission(request, session))) {
        return reply.code(403).send({ error: STDIO_SUBPROCESS_FORBIDDEN_ERROR });
      }
      // Publishing at the public URL is admin-level, like a stdio subprocess.
      if (publishesPublicly(body) && !(await requireStdioSubprocessPermission(request, session))) {
        return reply.code(403).send({ error: PUBLIC_EXPOSURE_FORBIDDEN_ERROR });
      }

      const upstream = readMcpUpstreamBody(body, sourceType);
      if (!upstream.ok) {
        return reply.code(upstream.status).send({ error: upstream.error });
      }

      const access = body.access !== undefined ? parseAccessListInput(body.access) : undefined;
      if (access && !access.ok) return reply.code(400).send({ error: access.error });
      // Created inside an agent: the server belongs to that agent of this project, and to nothing else.
      const ownerInput = readAgentIdInput(body.ownerAgentId, 'ownerAgentId');
      if (!ownerInput.ok) return reply.code(400).send({ error: ownerInput.error });
      const owner = ownerInput.agentId ? await resolveOwningAgent(session.tenantDbName, projectId, ownerInput.agentId) : undefined;
      if (owner === null) return reply.code(400).send({ error: 'ownerAgentId must be an agent of this project' });

      const server = await createMcpServer(
        session.tenantDbName,
        session.tenantId,
        session.userId,
        projectId,
        {
          ...readMcpCommonCreateFields(body, head.value, upstream.upstreamAuth),
          sourceType,
          internalConfig,
          compositeConfig,
          endpointSlug: typeof body.endpointSlug === 'string' && body.endpointSlug.trim()
            ? body.endpointSlug.trim()
            : undefined,
          ...(access?.ok ? { access: access.access } : {}),
          ...(owner ? { owner } : {}),
        },
        auditContextFor(request, session.userId),
      );

      return reply.code(201).send({
        server: serializeMcpServer(server),
      });
    } catch (error) {
      if (isMcpServerConfigError(error)) return reply.code(400).send({ error: error.message });
      logger.error('Create MCP server error', { error });
      return sendProjectContextError(reply, error)
        ?? sendEndpointSlugError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/mcp/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as {
        includeAggregate?: string;
        includeLogs?: string;
        includeAudit?: string;
      };

      const server = await serverInProjectScope(session.tenantDbName, id, projectId);
      if (!server) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      const payload: Record<string, unknown> = {
        server: serializeMcpServerFull(server),
      };

      if (query.includeLogs === 'true') {
        payload.logs = await withoutRestrictedMcpLogContent(
          request,
          { tenantDbName: session.tenantDbName, viewerUserId: session.userId },
          await listMcpRequestLogs(session.tenantDbName, server, { limit: 50 }),
        );
      }

      if (query.includeAggregate === 'true') {
        payload.aggregate = await aggregateMcpRequestLogs(session.tenantDbName, server, {
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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const existingServer = await serverInProjectScope(session.tenantDbName, id, projectId);
      if (!existingServer) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);

      const security = await readMcpSecurityUpdate(body, { tenantDbName: session.tenantDbName, projectId });
      if ('error' in security) return reply.code(400).send({ error: security.error });

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

      if (body.toolNames !== undefined
        && (typeof body.toolNames !== 'object' || body.toolNames === null
          || Array.isArray(body.toolNames))) {
        return reply.code(400).send({ error: 'toolNames must be an object keyed by tool name' });
      }

      if (body.compositeConfig !== undefined) {
        const parsed = parseCompositeConfig(body.compositeConfig);
        if (!parsed?.members.length) {
          return reply.code(400).send({ error: 'compositeConfig.members must include at least one member server' });
        }
      }

      const instructionsError = mcpInstructionsInputError(body.instructions);
      if (instructionsError) return reply.code(400).send({ error: instructionsError });

      // Enterprise sub-feature gate (mirrors POST): a non-enterprise tenant may
      // not turn on persistent sandbox execution via edit. The guardrail
      // binding is ungated, on every plan, to match create behaviour.
      const licenseEnterprise = isEnterpriseLicenseType(session.licenseType);
      const nextStdioConfig = body.stdioConfig !== undefined ? parseStdioConfig(body.stdioConfig) : undefined;
      const nextAegis = body.aegis !== undefined ? parseAegis(body.aegis) : undefined;
      const nextGuardrail = body.guardrail !== undefined ? parseGuardrail(body.guardrail) : undefined;
      if (nextStdioConfig?.executionMode === 'sandbox' && !(licenseEnterprise && mcpSandboxRunner.current)) {
        return reply.code(402).send({
          error: 'Persistent sandbox execution requires an active Enterprise license.',
          module: 'sandbox',
          requiresEnterprise: true,
        });
      }

      if (nextStdioConfig?.executionMode === 'subprocess' && !(await requireStdioSubprocessPermission(request, session))) {
        return reply.code(403).send({ error: STDIO_SUBPROCESS_FORBIDDEN_ERROR });
      }
      if (publishesPublicly(body, existingServer) && !(await requireStdioSubprocessPermission(request, session))) {
        return reply.code(403).send({ error: PUBLIC_EXPOSURE_FORBIDDEN_ERROR });
      }

      const nextInternalConfig = body.internalConfig !== undefined ? parseInternalConfig(body.internalConfig) : undefined;
      const sandboxRefusal = await sandboxMcpRefusal(request, projectId, nextInternalConfig);
      if (sandboxRefusal) return reply.code(403).send(sandboxRefusal);

      const nextAccess = body.access !== undefined ? parseAccessListInput(body.access) : undefined;
      if (nextAccess && !nextAccess.ok) return reply.code(400).send({ error: nextAccess.error });

      const updated = await updateMcpServer(session.tenantDbName, id, session.userId, {
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
        internalConfig: nextInternalConfig,
        compositeConfig: body.compositeConfig !== undefined ? parseCompositeConfig(body.compositeConfig) : undefined,
        exposure: body.exposure !== undefined ? parseExposure(body.exposure) : undefined,
        endpointSlug: typeof body.endpointSlug === 'string' && body.endpointSlug.trim()
          ? body.endpointSlug.trim()
          : undefined,
        aegis: nextAegis,
        guardrail: nextGuardrail,
        ...(nextAccess?.ok ? { access: nextAccess.access } : {}),
        ...security.fields,
        disabledTools: body.disabledTools as string[] | undefined,
        toolAnnotations: body.toolAnnotations as UpdateMcpServerInput['toolAnnotations'],
        toolDescriptions: body.toolDescriptions as UpdateMcpServerInput['toolDescriptions'],
        toolNames: body.toolNames as UpdateMcpServerInput['toolNames'],
        instructions: body.instructions as string | null | undefined,
      }, auditContextFor(request, session.userId));

      if (!updated) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      return reply.code(200).send({ server: serializeMcpServerFull(updated) });
    } catch (error) {
      if (isMcpServerConfigError(error)) return reply.code(400).send({ error: error.message });
      logger.error('Update MCP server error', { error });
      return sendProjectContextError(reply, error)
        ?? sendEndpointSlugError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/mcp/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await serverInProjectScope(session.tenantDbName, id, projectId))) {
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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await serverInProjectScope(session.tenantDbName, id, projectId))) {
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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const server = await serverInProjectScope(session.tenantDbName, id, projectId);

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
        listMcpRequestLogs(session.tenantDbName, server, filter),
        countMcpRequestLogs(session.tenantDbName, server, {
          from,
          keyword: filter.keyword,
          status: query.status,
          to,
        }),
      ]);

      return reply.code(200).send({
        limit,
        logs: await withoutRestrictedMcpLogContent(request, { tenantDbName: session.tenantDbName, viewerUserId: session.userId }, logs),
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
      const { projectId, session } = await requireProjectContextForRequest(request);
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

      const server = await serverInProjectScope(session.tenantDbName, id, projectId);
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
        const { result, latencyMs } = await executeMcpTool(
          server,
          toolName,
          args,
          runtimeHeaders,
          consoleIdentityCallerOf(runtimeContext, { projectId: server.projectId }),
        );

        void logMcpRequest(session.tenantDbName, {
          tenantId: session.tenantId,
          projectId: server.projectId,
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
          errorMessage: message,
          callerType: 'dashboard',
          callerUserId: session.userId,
          transport: 'rest',
          sourceType: resolveSourceType(server),
        }, secretValues);
        return reply.code(isQuotaExceededError(execError) ? 429 : 500).send({ error: message });
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
