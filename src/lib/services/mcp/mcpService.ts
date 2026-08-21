import slugify from 'slugify';
import { randomUUID } from 'crypto';
import { getDatabase } from '@/lib/database';
import type {
  DatabaseProvider,
  IMcpAuditLog,
  IMcpAuthConfig,
  IMcpExposureConfig,
  IMcpRequestLog,
  IMcpServer,
  IMcpStdioConfig,
  IMcpTool,
  IMcpToolAnnotations,
  McpSourceType,
} from '@/lib/database';
import type {
  CreateMcpServerInput,
  UpdateMcpServerInput,
  McpAuditContext,
  McpServerView,
  OpenApiSpec,
  OpenApiOperation,
} from './types';
import { createLogger } from '@/lib/core/logger';
import {
  authConfigSecretValues,
  redactLogPayload,
  redactLogString,
} from '@/lib/services/logRedaction';
import { recordUsageEvent, resolveUsageAttribution } from '@/lib/services/usage/usageEvents';
import { safeFetch } from '@/lib/security/outboundFetch';
import { normalizeApiSpec, type SpecFormatHint } from '@/lib/services/specImport';
import { routeInstanceCall } from '@/lib/core/cluster';
import type { QueuePayload } from '@/lib/core/queue';
import { mcpEntityId } from './mcpEntityId';
import {
  defaultAnnotationsForSource,
  describeMcpTools,
  type McpToolDescriptor,
} from './toolAnnotations';
import {
  maskAuthConfig,
  maskStdioConfig,
  mergeAuthConfigUpdate,
  mergeStdioConfigUpdate,
  openAuthConfig,
  openStdioEnv,
  sealAuthConfig,
  sealStdioEnv,
} from './secretVault';
import { remoteCallTool, remoteListTools } from './remoteMcpClient';
import { isStdioRunnerEnabled, stdioCallTool, stdioListTools } from './stdioRunner';
import { mcpGuardrailHook, mcpSandboxRunner } from '@/enterprise/registry';
import { requireInternalMcpProvider } from './internal/registry';
import {
  allocateExposedNames,
  assertMemberUsable,
  assertPublicExposureAllowed,
  defaultMemberPrefix,
  getCompositeConfig,
  getCompositeMemberSummaries,
  MAX_COMPOSITE_MEMBER_TOOLS,
  metadataWithComposite,
  type CompositeToolEntry,
  type IMcpCompositeMemberConfig,
  type IMcpCompositeMemberSummary,
} from './composite';

const logger = createLogger('mcp-service');
const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;

export const DEFAULT_MCP_EXPOSURE: IMcpExposureConfig = {
  protocols: ['streamable-http', 'sse'],
  accessMode: 'token',
};

export function resolveSourceType(server: IMcpServer): McpSourceType {
  return server.sourceType ?? 'openapi';
}

export function resolveExposure(server: IMcpServer): IMcpExposureConfig {
  const exposure = server.exposure;
  if (!exposure || !Array.isArray(exposure.protocols) || exposure.protocols.length === 0) {
    return DEFAULT_MCP_EXPOSURE;
  }
  return {
    protocols: exposure.protocols,
    accessMode: exposure.accessMode === 'public' ? 'public' : 'token',
  };
}

// ── Tool enable/disable ───────────────────────────────────────────────────
// Disabled tool names ride in metadata.disabledTools (same pattern as
// runtimeHeaders — no schema migration in either DB tree). Absent/empty
// list means every discovered tool is enabled.

export function getDisabledToolNames(server: Pick<IMcpServer, 'metadata'>): string[] {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.disabledTools;
  return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : [];
}

export function isMcpToolEnabled(server: IMcpServer, toolName: string): boolean {
  return !getDisabledToolNames(server).includes(toolName);
}

/** Tools visible to callers (tools/list, client APIs, agents), overrides applied. */
export function listEnabledMcpTools(server: IMcpServer): IMcpTool[] {
  const disabled = new Set(getDisabledToolNames(server));
  const enabled = disabled.size === 0
    ? (server.tools ?? [])
    : (server.tools ?? []).filter((tool) => !disabled.has(tool.name));
  return applyToolOverrides(server, enabled);
}

/** Merge a disabled-name list into a metadata blob (empty list removes the key). */
function metadataWithDisabledTools(
  metadata: Record<string, unknown> | undefined,
  disabledTools: string[],
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (disabledTools.length) next.disabledTools = disabledTools;
  else delete next.disabledTools;
  return next;
}

// ── Tool annotation overrides ─────────────────────────────────────────────
// Operator-set hints ride in metadata.toolAnnotations so they survive tool
// rediscovery (which replaces `tools` wholesale).

export function getToolAnnotationOverrides(
  server: Pick<IMcpServer, 'metadata'>,
): Record<string, IMcpToolAnnotations> {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.toolAnnotations;
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, IMcpToolAnnotations>;
}

const ANNOTATION_FLAGS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** Keep only recognised keys; an entry with nothing set is dropped. */
function sanitizeAnnotationOverride(value: unknown): IMcpToolAnnotations | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const next: IMcpToolAnnotations = {};
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title) next.title = title;
  for (const flag of ANNOTATION_FLAGS) {
    if (typeof input[flag] === 'boolean') next[flag] = input[flag] as boolean;
  }
  return Object.keys(next).length ? next : null;
}

function metadataWithToolAnnotations(
  metadata: Record<string, unknown> | undefined,
  overrides: Record<string, IMcpToolAnnotations>,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (Object.keys(overrides).length) next.toolAnnotations = overrides;
  else delete next.toolAnnotations;
  return next;
}

// ── Tool description overrides ────────────────────────────────────────────
// Same metadata-backed pattern: the operator's wording wins over whatever the
// spec/upstream advertises, and survives tool rediscovery.

export function getToolDescriptionOverrides(
  server: Pick<IMcpServer, 'metadata'>,
): Record<string, string> {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.toolDescriptions;
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, string>;
}

function metadataWithToolDescriptions(
  metadata: Record<string, unknown> | undefined,
  overrides: Record<string, string>,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (Object.keys(overrides).length) next.toolDescriptions = overrides;
  else delete next.toolDescriptions;
  return next;
}

// ── Tool name overrides ───────────────────────────────────────────────────
// Same metadata-backed pattern as descriptions/annotations: keyed by the
// *real* (discovered) tool name, so a rename survives tool rediscovery
// without needing an identity of its own. The real name stays the source of
// truth everywhere internally (disabledTools, annotations, descriptions,
// execution) — only the outward-facing `name` in tools/list changes.

export function getToolNameOverrides(
  server: Pick<IMcpServer, 'metadata'>,
): Record<string, string> {
  const raw = (server.metadata as Record<string, unknown> | undefined)?.toolNames;
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, string>;
}

/** MCP/OpenAI-compatible identifier charset, generous length cap. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function sanitizeToolNameOverride(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !TOOL_NAME_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function metadataWithToolNames(
  metadata: Record<string, unknown> | undefined,
  overrides: Record<string, string>,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (Object.keys(overrides).length) next.toolNames = overrides;
  else delete next.toolNames;
  return next;
}

/**
 * Reverse-map whatever name a caller used back to the real, stored tool
 * name. Callers that never saw the override (legacy agent bindings, a
 * client that cached an old tools/list) still pass the real name through
 * unchanged, since it only matches an override's *target*.
 */
export function resolveMcpToolName(server: Pick<IMcpServer, 'metadata'>, calledName: string): string {
  const overrides = getToolNameOverrides(server);
  for (const [realName, exposedName] of Object.entries(overrides)) {
    if (exposedName === calledName) return realName;
  }
  return calledName;
}

/** Overlay the operator's name/description/annotation overrides on discovered tools. */
function applyToolOverrides(server: Pick<IMcpServer, 'metadata'>, tools: IMcpTool[]): IMcpTool[] {
  const annotationOverrides = getToolAnnotationOverrides(server);
  const descriptionOverrides = getToolDescriptionOverrides(server);
  const nameOverrides = getToolNameOverrides(server);
  if (!Object.keys(annotationOverrides).length
    && !Object.keys(descriptionOverrides).length
    && !Object.keys(nameOverrides).length) {
    return tools;
  }
  return tools.map((tool) => {
    const annotations = annotationOverrides[tool.name];
    const description = descriptionOverrides[tool.name];
    const name = nameOverrides[tool.name];
    if (!annotations && !description && !name) return tool;
    return {
      ...tool,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(annotations ? { annotations: { ...(tool.annotations ?? {}), ...annotations } } : {}),
    };
  });
}

/** Enabled tools as spec-complete `tools/list` entries, overrides applied. */
export function listMcpToolDescriptors(server: IMcpServer): McpToolDescriptor[] {
  return describeMcpTools(
    listEnabledMcpTools(server),
    defaultAnnotationsForSource(resolveSourceType(server)),
  );
}

// ── Serialization ─────────────────────────────────────────────────────────

export function serializeMcpServer(record: IMcpServer): McpServerView {
  const serialized = { ...record } as Record<string, unknown>;
  delete serialized._id;
  delete serialized.openApiSpec;
  return {
    ...serialized,
    id: typeof record._id === 'string' ? record._id : (record._id?.toString() ?? ''),
    sourceType: resolveSourceType(record),
    exposure: resolveExposure(record),
    upstreamAuth: maskAuthConfig(record.upstreamAuth),
    stdioConfig: maskStdioConfig(record.stdioConfig),
    disabledTools: getDisabledToolNames(record),
    toolAnnotations: getToolAnnotationOverrides(record),
    toolDescriptions: getToolDescriptionOverrides(record),
    toolNames: getToolNameOverrides(record),
    members: getCompositeMemberSummaries(record),
  } as McpServerView;
}
export function serializeMcpServerFull(record: IMcpServer): McpServerView & { openApiSpec?: string } {
  const { _id, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
    sourceType: resolveSourceType(record),
    exposure: resolveExposure(record),
    upstreamAuth: maskAuthConfig(record.upstreamAuth),
    stdioConfig: maskStdioConfig(record.stdioConfig),
    disabledTools: getDisabledToolNames(record),
    toolAnnotations: getToolAnnotationOverrides(record),
    toolDescriptions: getToolDescriptionOverrides(record),
    toolNames: getToolNameOverrides(record),
    members: getCompositeMemberSummaries(record),
  } as McpServerView & { openApiSpec?: string };
}

// ── Key generation ────────────────────────────────────────────────────────

function normalizeKey(input: string): string {
  const fallback = input?.trim().length ? input.trim() : 'mcp-server';
  return slugify(fallback, SLUG_OPTIONS);
}

/** `excludeId` lets a rename check uniqueness without colliding with itself. */
async function generateUniqueKey(
  tenantDbName: string,
  projectId: string | undefined,
  desiredKey: string,
  excludeId?: string,
): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const base = normalizeKey(desiredKey);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findMcpServerByKey(candidate, projectId);
    if (!existing || String(existing._id) === excludeId) return candidate;
    attempt++;
    candidate = `${base}-${attempt}`;
  }

  throw new Error(`Could not generate a unique key for MCP server "${desiredKey}"`);
}

function generateEndpointSlug(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}

// ── OpenAPI Parsing ───────────────────────────────────────────────────────

export function parseOpenApiSpec(specString: string, format: SpecFormatHint = 'auto'): {
  spec: OpenApiSpec;
  tools: IMcpTool[];
  baseUrl: string;
  /** Canonical OpenAPI JSON string (YAML/Postman inputs are converted). */
  normalizedSpec: string;
} {
  // Accept OpenAPI JSON/YAML or a Postman collection; normalize to OpenAPI JSON.
  const { openApiJson } = normalizeApiSpec(specString, format);

  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(openApiJson);
  } catch {
    throw new Error('Invalid JSON: could not parse OpenAPI specification');
  }

  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new Error('OpenAPI specification must contain a "paths" object');
  }

  // Extract base URL from servers array
  let baseUrl = '';
  if (spec.servers && spec.servers.length > 0) {
    baseUrl = spec.servers[0].url;
  }

  const tools: IMcpTool[] = [];
  const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of httpMethods) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!operation) continue;

      const toolName = operation.operationId
        || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const description = operation.summary || operation.description || `${method.toUpperCase()} ${path}`;

      // Build input schema from parameters + requestBody
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      if (operation.parameters) {
        for (const param of operation.parameters) {
          properties[param.name] = {
            type: (param.schema as Record<string, unknown>)?.type || 'string',
            description: param.description || `Parameter: ${param.name} (in ${param.in})`,
            ...(param.schema || {}),
          };
          if (param.required) required.push(param.name);
        }
      }

      if (operation.requestBody?.content) {
        const jsonContent = operation.requestBody.content['application/json'];
        if (jsonContent?.schema) {
          properties['body'] = {
            ...jsonContent.schema,
            description: 'Request body',
          };
          if (operation.requestBody.required) required.push('body');
        }
      }

      const inputSchema: Record<string, unknown> = {
        type: 'object',
        properties,
      };
      if (required.length > 0) inputSchema.required = required;

      tools.push({
        name: toolName,
        description,
        inputSchema,
        httpMethod: method.toUpperCase(),
        httpPath: path,
      });
    }
  }

  if (tools.length === 0) {
    throw new Error('No operations found in the OpenAPI specification');
  }

  return { spec, tools, baseUrl, normalizedSpec: openApiJson };
}

// ── Source-specific discovery ────────────────────────────────────────────

/**
 * Discover the tool list for a server config. For 'stdio' + 'sandbox' the
 * sandbox must already be provisioned (pass the ensured base URL).
 */
async function discoverToolsForServer(server: IMcpServer): Promise<IMcpTool[]> {
  const sourceType = resolveSourceType(server);

  if (sourceType === 'openapi') {
    if (!server.openApiSpec) throw new Error('Server has no OpenAPI spec');
    return parseOpenApiSpec(server.openApiSpec).tools;
  }

  if (sourceType === 'remote') {
    if (!server.remoteConfig?.url) throw new Error('Server has no remote MCP URL');
    return remoteListTools({
      url: server.remoteConfig.url,
      transport: server.remoteConfig.transport,
      auth: openAuthConfig(server.upstreamAuth),
    });
  }

  if (sourceType === 'internal') {
    const internal = (server.metadata as Record<string, unknown> | undefined)?.internal as
      | { provider?: string; instanceKey?: string; config?: Record<string, unknown> }
      | undefined;
    if (!internal?.provider || !internal.instanceKey) {
      throw new Error(`MCP server "${server.name}" has no internal provider configured`);
    }
    const provider = requireInternalMcpProvider(internal.provider);
    const db = await getDatabase();
    const tenant = await db.findTenantById(server.tenantId);
    if (!tenant?.dbName) {
      throw new Error('Could not resolve tenant database for internal MCP execution');
    }
    const built = await provider.buildTools(
      { tenantDbName: tenant.dbName, tenantId: server.tenantId, projectId: server.projectId },
      internal.instanceKey,
      internal.config ?? {},
    );
    return built.tools;
  }

  // stdio
  const config = server.stdioConfig;
  if (!config?.packageName) throw new Error('Server has no stdio package configured');

  if (config.executionMode === 'sandbox') {
    const { runner, ref, runnerConfig } = await resolveSandboxRunner(server);
    await ensureSandboxInstance(server, runner, ref, runnerConfig);
    return runner.listTools(ref, runnerConfig);
  }

  return stdioListTools(config);
}

async function resolveSandboxRunner(server: IMcpServer) {
  const runner = mcpSandboxRunner.current;
  if (!runner) {
    throw new Error('Sandbox execution requires the enterprise sandbox module');
  }
  const db = await getDatabase();
  const tenant = await db.findTenantById(server.tenantId);
  if (!tenant?.dbName) {
    throw new Error('Could not resolve tenant database for sandbox execution');
  }
  const config = server.stdioConfig!;
  return {
    runner,
    ref: {
      tenantDbName: tenant.dbName,
      tenantId: server.tenantId,
      projectId: server.projectId,
      serverId: String(server._id ?? ''),
      serverKey: server.key,
    },
    runnerConfig: {
      runtime: config.runtime,
      packageName: config.packageName,
      args: config.args,
      env: openStdioEnv(config),
      templateKey: config.sandbox?.templateKey,
      resources: config.sandbox?.resources,
      instanceId: config.sandbox?.instanceId,
    },
  };
}

/**
 * Ensure the backing sandbox instance exists and persist a newly provisioned
 * instance id onto the server record so restarts reuse the same sandbox.
 */
async function ensureSandboxInstance(
  server: IMcpServer,
  runner: NonNullable<typeof mcpSandboxRunner.current>,
  ref: { tenantDbName: string; tenantId: string; projectId?: string; serverId: string; serverKey: string },
  runnerConfig: { instanceId?: string } & Record<string, unknown>,
): Promise<void> {
  const { instanceId } = await runner.ensureRunning(ref, runnerConfig as never);
  if (instanceId && instanceId !== server.stdioConfig?.sandbox?.instanceId && server._id) {
    runnerConfig.instanceId = instanceId;
    const db = await getDatabase();
    const nextConfig: IMcpStdioConfig = {
      ...server.stdioConfig!,
      sandbox: { ...server.stdioConfig!.sandbox, instanceId },
    };
    server.stdioConfig = nextConfig;
    await db.runWithTenant?.(ref.tenantDbName, () =>
      db.updateMcpServer(String(server._id), { stdioConfig: nextConfig }));
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────

function validateCreateInput(input: CreateMcpServerInput): McpSourceType {
  const sourceType: McpSourceType = input.sourceType ?? 'openapi';
  if (sourceType === 'openapi' && !input.openApiSpec) {
    throw new Error('openApiSpec is required for source type "openapi"');
  }
  if (sourceType === 'remote' && !input.remoteConfig?.url) {
    throw new Error('remoteConfig.url is required for source type "remote"');
  }
  if (sourceType === 'stdio') {
    if (!input.stdioConfig?.packageName?.trim()) {
      throw new Error('stdioConfig.packageName is required for source type "stdio"');
    }
    if (!['npx', 'uvx'].includes(input.stdioConfig.runtime)) {
      throw new Error('stdioConfig.runtime must be "npx" or "uvx"');
    }
    if (input.stdioConfig.executionMode === 'sandbox') {
      if (!mcpSandboxRunner.current) {
        throw new Error('Sandbox execution requires the enterprise sandbox module');
      }
    } else if (!isStdioRunnerEnabled()) {
      throw new Error('Stdio subprocess execution is disabled on this deployment');
    }
  }
  if (sourceType === 'internal') {
    if (!input.internalConfig?.provider?.trim()) {
      throw new Error('internalConfig.provider is required for source type "internal"');
    }
    if (!input.internalConfig?.instanceKey?.trim()) {
      throw new Error('internalConfig.instanceKey is required for source type "internal"');
    }
    assertPublicExposureAllowed('internal', true, input.exposure?.accessMode);
  }
  if (sourceType === 'composite') {
    if (!input.compositeConfig?.members?.length) {
      throw new Error('compositeConfig.members is required for source type "composite"');
    }
    for (const m of input.compositeConfig.members) {
      if (!m.serverId?.trim()) {
        throw new Error('Every composite member needs a serverId');
      }
    }
  }
  return sourceType;
}

function normalizeExposure(input?: IMcpExposureConfig): IMcpExposureConfig {
  if (!input) return DEFAULT_MCP_EXPOSURE;
  const protocols = (input.protocols ?? []).filter(
    (p): p is IMcpExposureConfig['protocols'][number] => p === 'streamable-http' || p === 'sse',
  );
  return {
    protocols: protocols.length ? protocols : DEFAULT_MCP_EXPOSURE.protocols,
    accessMode: input.accessMode === 'public' ? 'public' : 'token',
  };
}

// ── Composite servers ──────────────────────────────────────────────────────
// A composite republishes tools from other MCP servers on the same tenant.
// Its `tools[]` is a *materialized snapshot*, not a live join — the five
// protocol surfaces that read `server.tools` (tools/list, client v1, public
// MCP, agent bindings, the EE Hub catalog) all stay synchronous. The
// snapshot is rebuilt here and re-persisted whenever the composite's own
// member list changes (create/update) or a member changes underneath it
// (`reconcileCompositesForMember`, called from updateMcpServer/deleteMcpServer).

interface BuiltCompositeTools {
  tools: IMcpTool[];
  members: IMcpCompositeMemberConfig[];
  memberSummaries: IMcpCompositeMemberSummary[];
  hasInternalMember: boolean;
}

async function buildCompositeTools(
  db: DatabaseProvider,
  self: { id?: string; tenantId: string; projectId?: string },
  memberConfigs: Array<{ serverId: string; toolPrefix?: string; alwaysPrefix?: boolean }>,
  previousTools: IMcpTool[] = [],
): Promise<BuiltCompositeTools> {
  if (memberConfigs.length === 0) {
    throw new Error('A composite server needs at least one member');
  }

  const entries: CompositeToolEntry[] = [];
  const entryTools: IMcpTool[] = [];
  const members: IMcpCompositeMemberConfig[] = [];
  const memberSummaries: IMcpCompositeMemberSummary[] = [];
  let hasInternalMember = false;

  for (const cfg of memberConfigs) {
    const member = await db.findMcpServerById(cfg.serverId);
    assertMemberUsable(self, member, cfg.serverId);
    const m = member!;
    const memberSourceType = resolveSourceType(m);
    if (memberSourceType === 'internal') hasInternalMember = true;

    members.push({
      serverId: cfg.serverId,
      serverKey: m.key,
      toolPrefix: cfg.toolPrefix,
      alwaysPrefix: cfg.alwaysPrefix,
    });
    memberSummaries.push({
      serverId: cfg.serverId,
      serverKey: m.key,
      name: m.name,
      sourceType: memberSourceType,
      status: m.status,
      toolCount: m.tools?.length ?? 0,
    });

    // Inactive members contribute no tools but stay in the member list —
    // re-enabling them on the member's own page brings their tools back on
    // the next reconcile, no need to re-add them here.
    if (m.status !== 'active') continue;

    const prefixBase = cfg.toolPrefix || defaultMemberPrefix(m.key);
    const fallbackAnnotations = defaultAnnotationsForSource(memberSourceType);
    for (const tool of listEnabledMcpTools(m)) {
      entries.push({
        serverId: cfg.serverId,
        serverKey: m.key,
        realName: tool.name,
        prefixBase,
        alwaysPrefix: cfg.alwaysPrefix === true,
      });
      entryTools.push({
        ...tool,
        annotations: tool.annotations ?? fallbackAnnotations,
      });
    }
  }

  if (entries.length > MAX_COMPOSITE_MEMBER_TOOLS) {
    throw new Error(
      `This composite would publish ${entries.length} tools, over the ${MAX_COMPOSITE_MEMBER_TOOLS} limit. `
      + 'Disable unused tools on the member servers first.',
    );
  }

  const exposedNames = allocateExposedNames(entries, previousTools);
  const tools: IMcpTool[] = entryTools.map((tool, i) => ({
    ...tool,
    name: exposedNames[i],
    origin: { serverId: entries[i].serverId, serverKey: entries[i].serverKey, realName: entries[i].realName },
  }));

  return { tools, members, memberSummaries, hasInternalMember };
}

/** Rebuild + persist one composite's snapshot from its stored member config. */
async function reconcileOneComposite(
  db: DatabaseProvider,
  composite: IMcpServer,
): Promise<IMcpServer | null> {
  const config = getCompositeConfig(composite);
  if (config.members.length === 0) {
    // Nothing left to publish — disable rather than leave an always-empty,
    // always-failing endpoint. The operator adds a member or deletes it.
    return db.updateMcpServer(String(composite._id), {
      status: 'disabled',
      tools: [],
      lastError: { message: 'All members were removed from this composite server.', at: new Date() },
      metadata: metadataWithComposite(composite.metadata, { members: [], hasInternalMember: false }, []),
    });
  }
  const built = await buildCompositeTools(
    db,
    { id: String(composite._id ?? ''), tenantId: composite.tenantId, projectId: composite.projectId },
    config.members,
    composite.tools,
  );
  return db.updateMcpServer(String(composite._id), {
    tools: built.tools,
    toolsDiscoveredAt: new Date(),
    lastError: null,
    metadata: metadataWithComposite(
      composite.metadata,
      { members: built.members, hasInternalMember: built.hasInternalMember },
      built.memberSummaries,
    ),
  });
}

/**
 * Called after a server changes (update) or is deleted, so every composite
 * that includes it as a member gets a fresh snapshot. Best-effort per
 * composite — one failing composite (e.g. a member vanished mid-request)
 * doesn't block the others; the failure lands on that composite's
 * `lastError` instead.
 */
export async function reconcileCompositesForMember(
  tenantDbName: string,
  memberId: string,
  opts: { removed?: boolean } = {},
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const all = await db.listMcpServers({});
  const composites = all.filter((s) => resolveSourceType(s) === 'composite'
    && getCompositeConfig(s).members.some((m) => m.serverId === memberId));

  for (const composite of composites) {
    try {
      if (opts.removed) {
        const prunedMembers = getCompositeConfig(composite).members.filter((m) => m.serverId !== memberId);
        await db.updateMcpServer(String(composite._id), {
          metadata: metadataWithComposite(
            composite.metadata,
            { members: prunedMembers, hasInternalMember: getCompositeConfig(composite).hasInternalMember },
            getCompositeMemberSummaries(composite),
          ),
        });
        const refreshed = await db.findMcpServerById(String(composite._id));
        if (refreshed) await reconcileOneComposite(db, refreshed);
      } else {
        await reconcileOneComposite(db, composite);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.updateMcpServer(String(composite._id), { lastError: { message, at: new Date() } });
      logger.warn('Composite reconcile failed', { compositeKey: composite.key, memberId, error: message });
    }
  }
}

export async function createMcpServer(
  tenantDbName: string,
  tenantId: string,
  userId: string,
  projectId: string | undefined,
  input: CreateMcpServerInput,
  audit?: McpAuditContext,
): Promise<IMcpServer> {
  const sourceType = validateCreateInput(input);

  const key = await generateUniqueKey(tenantDbName, projectId, input.key?.trim() || input.name);
  const endpointSlug = generateEndpointSlug();

  let tools: IMcpTool[] = [];
  let normalizedSpec: string | undefined;
  let upstreamBaseUrl = input.upstreamBaseUrl;
  const openedAuth: IMcpAuthConfig = { ...(input.upstreamAuth as IMcpAuthConfig) };

  if (sourceType === 'openapi') {
    const parsed = parseOpenApiSpec(input.openApiSpec!, input.specFormat);
    tools = parsed.tools;
    normalizedSpec = parsed.normalizedSpec;
    upstreamBaseUrl = upstreamBaseUrl || parsed.baseUrl;
    if (!upstreamBaseUrl) {
      throw new Error('Upstream base URL is required. Provide it explicitly or include a servers array in the spec.');
    }
  } else if (sourceType === 'remote') {
    tools = await remoteListTools({
      url: input.remoteConfig!.url,
      transport: input.remoteConfig!.transport,
      auth: openedAuth,
    });
  } else if (sourceType === 'stdio' && input.stdioConfig!.executionMode === 'subprocess') {
    // Discover eagerly so the create screen fails fast on a broken package.
    tools = await stdioListTools(input.stdioConfig!);
  }

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const stdioConfig = input.stdioConfig ? sealStdioEnv(input.stdioConfig) : undefined;

  let internalMetadata: Record<string, unknown> | undefined;
  let compositeMetadata: Record<string, unknown> | undefined;
  let description = input.description?.trim();
  if (sourceType === 'internal') {
    const ctx = { tenantDbName, tenantId, projectId };
    const provider = requireInternalMcpProvider(input.internalConfig!.provider);
    const instanceKey = input.internalConfig!.instanceKey;
    const config = input.internalConfig!.config ?? {};
    await provider.validateInstance(ctx, instanceKey, config);
    const built = await provider.buildTools(ctx, instanceKey, config);
    tools = built.tools;
    description = description || built.suggestedDescription;
    internalMetadata = { provider: provider.id, instanceKey, config };
  }
  if (sourceType === 'composite') {
    const memberConfigs = input.compositeConfig!.members.map((m) => ({
      serverId: m.serverId,
      toolPrefix: m.toolPrefix,
      alwaysPrefix: m.alwaysPrefix,
    }));
    const built = await buildCompositeTools(db, { tenantId, projectId }, memberConfigs);
    assertPublicExposureAllowed('composite', built.hasInternalMember, input.exposure?.accessMode);
    tools = built.tools;
    compositeMetadata = metadataWithComposite(
      undefined,
      { members: built.members, hasInternalMember: built.hasInternalMember },
      built.memberSummaries,
    );
  }

  const server = await db.createMcpServer({
    tenantId,
    projectId: projectId ?? undefined,
    key,
    name: input.name.trim(),
    description,
    sourceType,
    openApiSpec: normalizedSpec,
    remoteConfig: input.remoteConfig,
    stdioConfig,
    tools,
    toolsDiscoveredAt: sourceType === 'openapi' ? undefined : new Date(),
    upstreamBaseUrl,
    upstreamAuth: sealAuthConfig(openedAuth),
    exposure: normalizeExposure(input.exposure),
    aegis: input.aegis,
    status: 'active',
    endpointSlug,
    totalRequests: 0,
    metadata: internalMetadata ? { internal: internalMetadata } : compositeMetadata,
    createdBy: userId,
  });

  // Sandbox-backed stdio servers provision after the record exists (the
  // runner needs the server identity); discovery failures are surfaced on
  // the record instead of failing the create.
  if (sourceType === 'stdio' && input.stdioConfig!.executionMode === 'sandbox') {
    try {
      const discovered = await discoverToolsForServer({ ...server, stdioConfig });
      await db.switchToTenant(tenantDbName);
      await db.updateMcpServer(String(server._id), {
        tools: discovered,
        toolsDiscoveredAt: new Date(),
        lastError: null,
      });
      server.tools = discovered;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.updateMcpServer(String(server._id), {
        lastError: { message, at: new Date() },
      });
      logger.warn('Sandbox MCP provisioning failed at create', { key, error: message });
    }
  }

  logger.info('MCP server created', { key, tenantId, sourceType, toolCount: server.tools.length });

  void logMcpAudit(tenantDbName, {
    tenantId,
    projectId,
    serverId: String(server._id ?? ''),
    serverKey: key,
    action: 'create',
    changes: {
      name: { to: input.name.trim() },
      sourceType: { to: sourceType },
      exposure: { to: normalizeExposure(input.exposure) },
    },
    performedBy: audit?.performedBy ?? userId,
    ipAddress: audit?.ipAddress,
    userAgent: audit?.userAgent,
  });

  return server;
}

/** Fields compared for the audit diff (secrets excluded — masked separately). */
function diffForAudit(before: IMcpServer, after: Partial<IMcpServer>): Record<string, { from?: unknown; to?: unknown }> {
  const changes: Record<string, { from?: unknown; to?: unknown }> = {};
  const compare = (field: string, from: unknown, to: unknown) => {
    if (to === undefined) return;
    const fromJson = JSON.stringify(from ?? null);
    const toJson = JSON.stringify(to ?? null);
    if (fromJson !== toJson) changes[field] = { from, to };
  };

  compare('key', before.key, after.key);
  compare('name', before.name, after.name);
  compare('description', before.description, after.description);
  compare('status', before.status, after.status);
  compare('upstreamBaseUrl', before.upstreamBaseUrl, after.upstreamBaseUrl);
  compare('exposure', resolveExposure(before), after.exposure);
  compare('aegis', before.aegis, after.aegis);
  compare('remoteConfig', before.remoteConfig, after.remoteConfig);
  if (after.stdioConfig !== undefined) {
    const strip = (c?: IMcpStdioConfig) => c && {
      runtime: c.runtime,
      packageName: c.packageName,
      args: c.args,
      executionMode: c.executionMode,
      sandbox: c.sandbox,
      envKeys: Object.keys(c.env ?? {}),
    };
    compare('stdioConfig', strip(before.stdioConfig), strip(after.stdioConfig));
  }
  if (after.upstreamAuth !== undefined) {
    const beforeAuth = before.upstreamAuth ?? { type: 'none' };
    if (beforeAuth.type !== after.upstreamAuth.type
      || beforeAuth.headerName !== after.upstreamAuth.headerName
      || beforeAuth.username !== after.upstreamAuth.username
      || (after.upstreamAuth.sealed && after.upstreamAuth.sealed !== beforeAuth.sealed)) {
      changes.upstreamAuth = { from: beforeAuth.type, to: after.upstreamAuth.type };
    }
  }
  if (after.openApiSpec !== undefined && after.openApiSpec !== before.openApiSpec) {
    changes.openApiSpec = { from: '(previous spec)', to: '(updated spec)' };
  }
  if (after.metadata !== undefined) {
    // Record counts only — the full name list can run to thousands of entries.
    const fromList = getDisabledToolNames(before);
    const toList = getDisabledToolNames({ metadata: after.metadata });
    if (JSON.stringify(fromList) !== JSON.stringify(toList)) {
      changes.disabledTools = { from: `${fromList.length} disabled`, to: `${toList.length} disabled` };
    }
  }
  return changes;
}

export async function updateMcpServer(
  tenantDbName: string,
  serverId: string,
  userId: string,
  input: UpdateMcpServerInput,
  audit?: McpAuditContext,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const existing = await db.findMcpServerById(serverId);
  if (!existing) return null;

  const updateData: Record<string, unknown> = { updatedBy: userId };

  if (input.key !== undefined && input.key.trim()) {
    updateData.key = await generateUniqueKey(tenantDbName, existing.projectId, input.key, serverId);
  }
  if (input.name !== undefined) updateData.name = input.name.trim();
  if (input.description !== undefined) updateData.description = input.description.trim();
  if (input.status !== undefined) updateData.status = input.status;
  if (input.upstreamBaseUrl !== undefined) updateData.upstreamBaseUrl = input.upstreamBaseUrl;
  if (input.upstreamAuth !== undefined) {
    updateData.upstreamAuth = mergeAuthConfigUpdate(existing.upstreamAuth, input.upstreamAuth);
  }
  if (input.exposure !== undefined) updateData.exposure = normalizeExposure(input.exposure);
  if (input.aegis !== undefined) updateData.aegis = input.aegis;
  if (input.remoteConfig !== undefined) updateData.remoteConfig = input.remoteConfig;
  if (input.stdioConfig !== undefined) {
    updateData.stdioConfig = mergeStdioConfigUpdate(existing.stdioConfig, input.stdioConfig);
  }
  // Runtime-header passthrough policy lives in the metadata blob (no schema
  // migration needed in either DB tree).
  if (input.runtimeHeaders !== undefined) {
    updateData.metadata = {
      ...(existing.metadata ?? {}),
      runtimeHeaders: input.runtimeHeaders === null
        ? undefined
        : {
          allow: input.runtimeHeaders.allow === true,
          ...(input.runtimeHeaders.allowedNames?.length
            ? { allowedNames: input.runtimeHeaders.allowedNames.filter((n) => typeof n === 'string' && n.trim()) }
            : {}),
        },
    };
  }

  // Re-parse spec if updated (openapi source only)
  if (input.openApiSpec !== undefined) {
    const { tools, baseUrl: specBaseUrl, normalizedSpec } = parseOpenApiSpec(
      input.openApiSpec,
      input.specFormat,
    );
    updateData.openApiSpec = normalizedSpec;
    updateData.tools = tools;
    if (!input.upstreamBaseUrl && specBaseUrl) {
      updateData.upstreamBaseUrl = specBaseUrl;
    }
  }

  // Re-discover tools when the remote/stdio source configuration changed.
  const sourceType = resolveSourceType(existing);
  if (sourceType === 'remote' && input.remoteConfig !== undefined) {
    const auth = updateData.upstreamAuth
      ? openAuthConfig(updateData.upstreamAuth as IMcpAuthConfig)
      : openAuthConfig(existing.upstreamAuth);
    updateData.tools = await remoteListTools({
      url: input.remoteConfig.url,
      transport: input.remoteConfig.transport,
      auth,
    });
    updateData.toolsDiscoveredAt = new Date();
  }
  if (sourceType === 'stdio' && input.stdioConfig !== undefined
    && (updateData.stdioConfig as IMcpStdioConfig).executionMode === 'subprocess') {
    updateData.tools = await stdioListTools(updateData.stdioConfig as IMcpStdioConfig);
    updateData.toolsDiscoveredAt = new Date();
  }
  if (sourceType === 'internal' && input.internalConfig !== undefined) {
    const existingInternal = (existing.metadata as Record<string, unknown> | undefined)?.internal as
      | { provider?: string; instanceKey?: string; config?: Record<string, unknown> }
      | undefined;
    const providerId = input.internalConfig.provider || existingInternal?.provider;
    const instanceKey = input.internalConfig.instanceKey || existingInternal?.instanceKey;
    if (!providerId || !instanceKey) {
      throw new Error('internalConfig.provider and internalConfig.instanceKey are required');
    }
    const config = { ...(existingInternal?.config ?? {}), ...(input.internalConfig.config ?? {}) };
    const provider = requireInternalMcpProvider(providerId);
    const ctx = { tenantDbName, tenantId: existing.tenantId, projectId: existing.projectId };
    await provider.validateInstance(ctx, instanceKey, config);
    const built = await provider.buildTools(ctx, instanceKey, config);
    updateData.tools = built.tools;
    updateData.toolsDiscoveredAt = new Date();
    updateData.metadata = {
      ...((updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata),
      internal: { provider: provider.id, instanceKey, config },
    };
  }

  // Composite: an explicit compositeConfig patch replaces the member list
  // and rebuilds the tool snapshot (passing the current tools as the
  // "previous" set keeps stable exposed names across the rebuild — see
  // allocateExposedNames). Omitting compositeConfig leaves the member list
  // untouched (e.g. a PATCH that only renames the server or flips status).
  let compositeHasInternalMember = sourceType === 'composite'
    ? getCompositeConfig(existing).hasInternalMember
    : false;
  if (sourceType === 'composite' && input.compositeConfig !== undefined) {
    if (!input.compositeConfig.members.length) {
      throw new Error('compositeConfig.members must include at least one member server');
    }
    const memberConfigs = input.compositeConfig.members.map((m) => ({
      serverId: m.serverId,
      toolPrefix: m.toolPrefix,
      alwaysPrefix: m.alwaysPrefix,
    }));
    const built = await buildCompositeTools(
      db,
      { id: serverId, tenantId: existing.tenantId, projectId: existing.projectId },
      memberConfigs,
      existing.tools,
    );
    updateData.tools = built.tools;
    updateData.toolsDiscoveredAt = new Date();
    compositeHasInternalMember = built.hasInternalMember;
    updateData.metadata = metadataWithComposite(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      { members: built.members, hasInternalMember: built.hasInternalMember },
      built.memberSummaries,
    );
  }

  // Public-exposure gate: an internal-sourced server (direct 'internal', or
  // a composite with an internal member) must never be reachable without a
  // Cognipeer token — runs on every update, not just ones that touch
  // exposure or compositeConfig, since either one alone can flip the
  // effective combination into a disallowed state.
  const effectiveExposure = (updateData.exposure as IMcpExposureConfig | undefined) ?? resolveExposure(existing);
  assertPublicExposureAllowed(
    sourceType,
    sourceType === 'internal' ? true : compositeHasInternalMember,
    effectiveExposure.accessMode,
  );

  // Tool enable/disable list (metadata-backed). Runs after tool rediscovery so
  // the incoming names are validated against the tool list being persisted.
  if (input.disabledTools !== undefined) {
    const knownNames = new Set(
      ((updateData.tools as IMcpTool[] | undefined) ?? existing.tools ?? []).map((t) => t.name),
    );
    const disabled = [...new Set(
      input.disabledTools.filter((n) => typeof n === 'string' && knownNames.has(n)),
    )];
    updateData.metadata = metadataWithDisabledTools(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      disabled,
    );
  } else if (updateData.tools !== undefined) {
    // Tool list changed without an explicit selection — prune disabled names
    // that no longer exist so stale entries don't linger.
    const knownNames = new Set((updateData.tools as IMcpTool[]).map((t) => t.name));
    const before = getDisabledToolNames(existing);
    const pruned = before.filter((n) => knownNames.has(n));
    if (pruned.length !== before.length) {
      updateData.metadata = metadataWithDisabledTools(
        (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
        pruned,
      );
    }
  }

  // Per-tool annotation overrides (metadata-backed, partial patch: a null or
  // empty entry clears that tool's override).
  if (input.toolAnnotations !== undefined) {
    const knownNames = new Set(
      ((updateData.tools as IMcpTool[] | undefined) ?? existing.tools ?? []).map((t) => t.name),
    );
    const overrides = { ...getToolAnnotationOverrides(existing) };
    for (const [name, value] of Object.entries(input.toolAnnotations)) {
      if (!knownNames.has(name)) continue;
      const sanitized = value === null ? null : sanitizeAnnotationOverride(value);
      if (sanitized) overrides[name] = sanitized;
      else delete overrides[name];
    }
    updateData.metadata = metadataWithToolAnnotations(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      overrides,
    );
  }

  // Per-tool description overrides (metadata-backed, partial patch: null or an
  // empty string restores the discovered description).
  if (input.toolDescriptions !== undefined) {
    const knownNames = new Set(
      ((updateData.tools as IMcpTool[] | undefined) ?? existing.tools ?? []).map((t) => t.name),
    );
    const overrides = { ...getToolDescriptionOverrides(existing) };
    for (const [name, value] of Object.entries(input.toolDescriptions)) {
      if (!knownNames.has(name)) continue;
      const text = typeof value === 'string' ? value.trim() : '';
      if (text) overrides[name] = text;
      else delete overrides[name];
    }
    updateData.metadata = metadataWithToolDescriptions(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      overrides,
    );
  }

  // Per-tool name overrides (metadata-backed, partial patch: null or an
  // empty string restores the discovered name). Exposed names must stay
  // unique across the server's effective tool list — callers use them for
  // both tools/list and tools/call, so a collision would strand one tool.
  if (input.toolNames !== undefined) {
    const knownTools = ((updateData.tools as IMcpTool[] | undefined) ?? existing.tools ?? []);
    const knownNames = new Set(knownTools.map((t) => t.name));
    const overrides = { ...getToolNameOverrides(existing) };
    for (const [name, value] of Object.entries(input.toolNames)) {
      if (!knownNames.has(name)) continue;
      const custom = value === null ? null : sanitizeToolNameOverride(value);
      if (custom && custom !== name) overrides[name] = custom;
      else delete overrides[name];
    }

    const claimedBy = new Map<string, string>();
    for (const tool of knownTools) {
      const exposed = overrides[tool.name] ?? tool.name;
      const owner = claimedBy.get(exposed);
      if (owner && owner !== tool.name) {
        throw new Error(`Tool name "${exposed}" collides with another tool on this server`);
      }
      claimedBy.set(exposed, tool.name);
    }

    updateData.metadata = metadataWithToolNames(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      overrides,
    );
  }

  const updated = await db.updateMcpServer(serverId, updateData as Partial<IMcpServer>);

  if (updated) {
    const changes = diffForAudit(existing, updateData as Partial<IMcpServer>);
    const isSecretsChange = 'upstreamAuth' in changes || 'stdioConfig' in changes;
    void logMcpAudit(tenantDbName, {
      tenantId: existing.tenantId,
      projectId: existing.projectId,
      serverId,
      serverKey: existing.key,
      action: input.status !== undefined && Object.keys(changes).length === 1 && changes.status
        ? 'status_change'
        : changes.exposure && Object.keys(changes).length === 1
          ? 'exposure_change'
          : isSecretsChange && Object.keys(changes).length === 1
            ? 'secrets_change'
            : 'update',
      changes,
      performedBy: audit?.performedBy ?? userId,
      ipAddress: audit?.ipAddress,
      userAgent: audit?.userAgent,
    });

    // Composites can't nest (assertMemberUsable rejects it), so this never
    // recurses — it only ever touches composites that include `existing`.
    if (sourceType !== 'composite') {
      await reconcileCompositesForMember(tenantDbName, serverId);
    }
  }

  return updated;
}

/** Re-run tool discovery for remote/stdio servers. */
export async function refreshMcpServerTools(
  tenantDbName: string,
  serverId: string,
  userId: string,
  audit?: McpAuditContext,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const server = await db.findMcpServerById(serverId);
  if (!server) return null;

  try {
    let updated: IMcpServer | null;
    if (resolveSourceType(server) === 'composite') {
      // Composite tools aren't "rediscovered" from an upstream — they're
      // rebuilt from the current state of each member (which also refreshes
      // the cached member display summary, unlike the incremental reconcile
      // triggered by a member's own update).
      updated = await reconcileOneComposite(db, server);
    } else {
      const tools = await discoverToolsForServer(server);
      const refreshUpdate: Partial<IMcpServer> = {
        tools,
        toolsDiscoveredAt: new Date(),
        lastError: null,
        updatedBy: userId,
      };
      // Prune disabled names that vanished from the rediscovered tool list.
      const disabledBefore = getDisabledToolNames(server);
      const disabledKept = disabledBefore.filter((n) => tools.some((t) => t.name === n));
      if (disabledKept.length !== disabledBefore.length) {
        refreshUpdate.metadata = metadataWithDisabledTools(server.metadata, disabledKept);
      }
      updated = await db.updateMcpServer(serverId, refreshUpdate);
    }
    void logMcpAudit(tenantDbName, {
      tenantId: server.tenantId,
      projectId: server.projectId,
      serverId,
      serverKey: server.key,
      action: 'tools_refresh',
      changes: { toolCount: { from: server.tools?.length ?? 0, to: updated?.tools?.length ?? 0 } },
      performedBy: audit?.performedBy ?? userId,
      ipAddress: audit?.ipAddress,
      userAgent: audit?.userAgent,
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.updateMcpServer(serverId, { lastError: { message, at: new Date() } });
    throw error;
  }
}

export async function deleteMcpServer(
  tenantDbName: string,
  serverId: string,
  audit?: McpAuditContext,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const existing = await db.findMcpServerById(serverId);
  const deleted = await db.deleteMcpServer(serverId);

  if (deleted && existing) {
    // Release a sandbox-backed runtime if one exists (best-effort).
    if (existing.stdioConfig?.executionMode === 'sandbox' && mcpSandboxRunner.current) {
      void mcpSandboxRunner.current
        .release(
          {
            tenantDbName,
            tenantId: existing.tenantId,
            projectId: existing.projectId,
            serverId,
            serverKey: existing.key,
          },
          existing.stdioConfig.sandbox?.instanceId,
        )
        .catch((error) => logger.warn('Failed to release MCP sandbox', { serverId, error }));
    }
    void logMcpAudit(tenantDbName, {
      tenantId: existing.tenantId,
      projectId: existing.projectId,
      serverId,
      serverKey: existing.key,
      action: 'delete',
      performedBy: audit?.performedBy ?? existing.updatedBy ?? existing.createdBy,
      ipAddress: audit?.ipAddress,
      userAgent: audit?.userAgent,
    });

    if (resolveSourceType(existing) !== 'composite') {
      await reconcileCompositesForMember(tenantDbName, serverId, { removed: true });
    }
  }
  return deleted;
}

export async function getMcpServer(
  tenantDbName: string,
  serverId: string,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findMcpServerById(serverId);
}

export async function getMcpServerByKey(
  tenantDbName: string,
  key: string,
  projectId?: string,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findMcpServerByKey(key, projectId);
}

export async function listMcpServers(
  tenantDbName: string,
  filters?: { projectId?: string; status?: 'active' | 'disabled'; search?: string },
): Promise<IMcpServer[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listMcpServers(filters);
}

// ── Request logging ───────────────────────────────────────────────────────

/**
 * Outbound secret values that could be echoed back into a logged response for
 * this server: the caller's applied runtime-header values plus the server's
 * own static upstream credential (opened from the vault). Passed to
 * `logMcpRequest` so an echoing upstream can't leak them into the log.
 */
export function mcpRequestSecretValues(
  server: IMcpServer,
  runtimeHeaders?: Record<string, string>,
): string[] {
  return [
    ...Object.values(runtimeHeaders ?? {}),
    ...authConfigSecretValues(openAuthConfig(server.upstreamAuth)),
  ];
}

export async function logMcpRequest(
  tenantDbName: string,
  entry: Omit<IMcpRequestLog, '_id' | 'createdAt'>,
  secretValues?: string[],
  opts?: {
    /**
     * The member-scoped log a composite writes alongside its own
     * external-facing log entry (see `viaServerKey`) — skip the usage/cost
     * rollup here so one call through a composite isn't billed twice under
     * two different refKeys. The row is still written for that member's own
     * Logs tab and per-tool aggregate.
     */
    skipUsageEvent?: boolean;
  },
) {
  // Resolve attribution + rollup before any await so the request ALS is in
  // scope. `callerTokenId`/`callerUserId` stay for compat; the standard
  // userId/apiTokenId/actorType columns are stamped alongside.
  const attribution = opts?.skipUsageEvent
    ? resolveUsageAttribution({ projectId: entry.projectId })
    : recordUsageEvent({
      tenantDbName,
      tenantId: entry.tenantId,
      projectId: entry.projectId,
      service: 'mcp',
      refKey: entry.serverKey,
      status: entry.status,
      latencyMs: entry.latencyMs,
    });
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    await db.createMcpRequestLog({
      ...entry,
      // Scrub echoed secrets / sensitive keys and cap size before persisting
      // (redactLogPayload passes undefined through).
      requestPayload: redactLogPayload(entry.requestPayload, { secretValues }),
      responsePayload: redactLogPayload(entry.responsePayload, { secretValues }),
      errorMessage: redactLogString(entry.errorMessage, secretValues),
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
    });
  } catch (err) {
    logger.error('Failed to log MCP request', {
      serverKey: entry.serverKey,
      toolName: entry.toolName,
      error: err,
    });
  }
}

export async function listMcpRequestLogs(
  tenantDbName: string,
  serverKey: string,
  options?: {
    limit?: number;
    skip?: number;
    from?: Date;
    to?: Date;
    status?: string;
    keyword?: string;
  },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listMcpRequestLogs(serverKey, options);
}

export async function countMcpRequestLogs(
  tenantDbName: string,
  serverKey: string,
  options?: { from?: Date; to?: Date; status?: string; keyword?: string },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.countMcpRequestLogs(serverKey, options);
}

export async function aggregateMcpRequestLogs(
  tenantDbName: string,
  serverKey: string,
  options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.aggregateMcpRequestLogs(serverKey, options);
}

// ── Audit logging ─────────────────────────────────────────────────────────

export async function logMcpAudit(
  tenantDbName: string,
  entry: Omit<IMcpAuditLog, '_id' | 'createdAt'>,
): Promise<void> {
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    await db.createMcpAuditLog(entry);
  } catch (err) {
    logger.error('Failed to write MCP audit log', { serverKey: entry.serverKey, error: err });
  }
}

export async function listMcpAuditLogs(
  tenantDbName: string,
  options?: { projectId?: string; serverKey?: string; action?: string; limit?: number; skip?: number },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listMcpAuditLogs(options);
}

// ── Monitor snapshot ──────────────────────────────────────────────────────

export interface McpServerMonitorEntry {
  server: McpServerView;
  aggregate: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    avgLatencyMs: number | null;
    timeseries?: Array<{ period: string; total: number; success: number; errors: number }>;
  };
  runtime: {
    kind: 'openapi' | 'remote' | 'stdio-subprocess' | 'stdio-sandbox' | 'internal' | 'composite';
    state: 'ready' | 'disabled' | 'degraded' | 'unavailable';
    detail?: string;
  };
}

export async function getMcpMonitorSnapshot(
  tenantDbName: string,
  projectId?: string,
): Promise<{
  servers: McpServerMonitorEntry[];
  recentLogs: IMcpRequestLog[];
  recentAudit: IMcpAuditLog[];
}> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const servers = await db.listMcpServers({ projectId });
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const entries: McpServerMonitorEntry[] = [];
  for (const server of servers) {
    const aggregate = await db.aggregateMcpRequestLogs(server.key, { from, groupBy: 'hour' });

    const sourceType = resolveSourceType(server);
    let kind: McpServerMonitorEntry['runtime']['kind'] = 'openapi';
    let state: McpServerMonitorEntry['runtime']['state'] = 'ready';
    let detail: string | undefined;

    if (server.status !== 'active') {
      state = 'disabled';
    }

    if (sourceType === 'remote') {
      kind = 'remote';
    } else if (sourceType === 'stdio') {
      if (server.stdioConfig?.executionMode === 'sandbox') {
        kind = 'stdio-sandbox';
        const runner = mcpSandboxRunner.current;
        if (!runner) {
          state = 'unavailable';
          detail = 'Sandbox module not available';
        } else {
          try {
            const status = await runner.status(
              {
                tenantDbName,
                tenantId: server.tenantId,
                projectId: server.projectId,
                serverId: String(server._id ?? ''),
                serverKey: server.key,
              },
              server.stdioConfig.sandbox?.instanceId,
            );
            if (status.state !== 'running') {
              state = status.state === 'failed' ? 'degraded' : 'unavailable';
              detail = status.detail ?? `Sandbox ${status.state}`;
            }
          } catch (error) {
            state = 'degraded';
            detail = error instanceof Error ? error.message : 'Sandbox status probe failed';
          }
        }
      } else {
        kind = 'stdio-subprocess';
        if (!isStdioRunnerEnabled()) {
          state = 'unavailable';
          detail = 'Stdio execution disabled (MCP_STDIO_ENABLED=false)';
        }
      }
    } else if (sourceType === 'internal') {
      kind = 'internal';
    } else if (sourceType === 'composite') {
      kind = 'composite';
      const config = getCompositeConfig(server);
      const inactiveMembers = config.members.length
        ? await Promise.all(config.members.map(async (m) => {
          const member = await db.findMcpServerById(m.serverId);
          return !member || member.status !== 'active';
        }))
        : [];
      const inactiveCount = inactiveMembers.filter(Boolean).length;
      if (inactiveCount > 0 && state === 'ready') {
        state = 'degraded';
        detail = `${inactiveCount} of ${config.members.length} member(s) inactive or missing`;
      }
    }

    if (server.lastError && state === 'ready') {
      state = 'degraded';
      detail = server.lastError.message;
    }

    entries.push({
      server: serializeMcpServer(server),
      aggregate: {
        totalRequests: aggregate.totalRequests,
        successCount: aggregate.successCount,
        errorCount: aggregate.errorCount,
        avgLatencyMs: aggregate.avgLatencyMs,
        timeseries: aggregate.timeseries,
      },
      runtime: { kind, state, detail },
    });
  }

  const [recentLogs, recentAudit] = await Promise.all([
    db.listRecentMcpRequestLogs({ projectId, limit: 50 }),
    db.listMcpAuditLogs({ projectId, limit: 50 }),
  ]);

  return { servers: entries, recentLogs, recentAudit };
}

// ── MCP Proxy ─────────────────────────────────────────────────────────────

export async function executeMcpTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  runtimeHeaders?: Record<string, string>,
): Promise<{ result: unknown; latencyMs: number }> {
  return routeInstanceCall(
    {
      entityType: 'mcp',
      entityId: mcpEntityId(server.tenantId, server.key),
      jobName: 'invoke',
    },
    { server, toolName, args, runtimeHeaders } as unknown as QueuePayload,
    () => executeMcpToolLocal(server, toolName, args, runtimeHeaders),
  );
}

export async function executeMcpToolLocal(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  /**
   * Caller-supplied, policy-filtered headers merged into upstream HTTP calls.
   * Applies to remote and openapi sources only; stdio/sandbox runs have no
   * upstream HTTP request to attach them to.
   */
  runtimeHeaders?: Record<string, string>,
): Promise<{ result: unknown; latencyMs: number }> {
  const sourceType = resolveSourceType(server);
  const start = Date.now();
  // A caller may address the tool by its renamed (exposed) name — resolve
  // back to the real, stored name once, up front, so every downstream check
  // and dispatch below operates on the tool's actual identity.
  const realToolName = resolveMcpToolName(server, toolName);

  if (!isMcpToolEnabled(server, realToolName)) {
    throw new Error(`Tool "${toolName}" is disabled on MCP server "${server.name}"`);
  }

  // Aegis pre-hook (enterprise overlay; no-op in community).
  const guardrail = mcpGuardrailHook.current;
  const aegisMode = server.aegis?.mode ?? 'off';
  const guardCtx = {
    tenantId: server.tenantId,
    projectId: server.projectId,
    serverKey: server.key,
    toolName: realToolName,
    shieldId: server.aegis?.shieldId,
    mode: aegisMode,
  };
  let effectiveArgs = args;
  if (guardrail && aegisMode !== 'off') {
    const verdict = await guardrail.beforeToolCall(guardCtx, args);
    if (!verdict.allowed && aegisMode === 'enforce') {
      throw new Error(`Blocked by Aegis shield${verdict.reason ? `: ${verdict.reason}` : ''}`);
    }
    if (verdict.args) effectiveArgs = verdict.args;
  }

  let result: unknown;
  try {
    if (sourceType === 'openapi') {
      result = await executeOpenApiTool(server, realToolName, effectiveArgs, runtimeHeaders);
    } else if (sourceType === 'remote') {
      result = await remoteCallTool(
        {
          url: server.remoteConfig!.url,
          transport: server.remoteConfig!.transport,
          auth: openAuthConfig(server.upstreamAuth),
          extraHeaders: runtimeHeaders,
        },
        realToolName,
        effectiveArgs,
      );
    } else if (sourceType === 'internal') {
      const internal = (server.metadata as Record<string, unknown> | undefined)?.internal as
        | { provider?: string; instanceKey?: string; config?: Record<string, unknown> }
        | undefined;
      if (!internal?.provider || !internal.instanceKey) {
        throw new Error(`MCP server "${server.name}" has no internal provider configured`);
      }
      const provider = requireInternalMcpProvider(internal.provider);
      const db = await getDatabase();
      const tenant = await db.findTenantById(server.tenantId);
      if (!tenant?.dbName) {
        throw new Error('Could not resolve tenant database for internal MCP execution');
      }
      result = await provider.execute(
        { tenantDbName: tenant.dbName, tenantId: server.tenantId, projectId: server.projectId },
        internal.instanceKey,
        internal.config ?? {},
        realToolName,
        effectiveArgs,
      );
    } else if (sourceType === 'composite') {
      result = await executeCompositeTool(server, realToolName, effectiveArgs, runtimeHeaders);
    } else if (server.stdioConfig?.executionMode === 'sandbox') {
      const { runner, ref, runnerConfig } = await resolveSandboxRunner(server);
      await ensureSandboxInstance(server, runner, ref, runnerConfig);
      result = await runner.callTool(ref, runnerConfig, realToolName, effectiveArgs);
    } else {
      result = await stdioCallTool(server.stdioConfig!, realToolName, effectiveArgs);
    }
  } catch (error) {
    // Persist the failure on the record so the monitor can surface it.
    void markServerError(server, error instanceof Error ? error.message : String(error));
    throw error;
  }

  // Aegis post-hook.
  if (guardrail && aegisMode !== 'off') {
    const verdict = await guardrail.afterToolCall(guardCtx, result);
    if (!verdict.allowed && aegisMode === 'enforce') {
      throw new Error(`Response blocked by Aegis shield${verdict.reason ? `: ${verdict.reason}` : ''}`);
    }
    if (verdict.result !== undefined) result = verdict.result;
  }

  return { result, latencyMs: Date.now() - start };
}

/**
 * Route one composite tool call to its member server and record a
 * member-scoped log entry alongside the caller's own external-facing log
 * (written by whichever route handler called `executeMcpTool` on the
 * composite) — so the member's own Logs tab and per-tool aggregate reflect
 * calls that arrived via this composite, without double-billing usage (see
 * `logMcpRequest`'s `skipUsageEvent`).
 *
 * Runtime-header passthrough: the composite's own opt-in policy already
 * gated which headers reached this function at all (default-deny, resolved
 * by the caller before `executeMcpTool` runs) — the member's own
 * `runtimeHeaders` policy is not independently re-checked for calls that
 * arrive via a composite. This mirrors every other multi-hop MCP source
 * today (there is one policy checkpoint per call, not one per hop).
 */
async function executeCompositeTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  runtimeHeaders: Record<string, string> | undefined,
): Promise<unknown> {
  const tool = (server.tools ?? []).find((t) => t.name === toolName);
  if (!tool?.origin) {
    throw new Error(
      `Tool "${toolName}" has no member mapping on composite server "${server.name}" — try refreshing its tools`,
    );
  }

  const db = await getDatabase();
  const member = await db.findMcpServerById(tool.origin.serverId);
  assertMemberUsable(
    { id: String(server._id ?? ''), tenantId: server.tenantId, projectId: server.projectId },
    member,
    tool.origin.serverId,
  );
  const m = member!;
  if (m.status !== 'active') {
    throw new Error(`Member server "${m.name}" is disabled`);
  }

  const tenant = await db.findTenantById(server.tenantId);
  const tenantDbName = tenant?.dbName;
  const start = Date.now();

  try {
    const { result } = await executeMcpTool(m, tool.origin.realName, args, runtimeHeaders);
    if (tenantDbName) {
      void logMcpRequest(tenantDbName, {
        tenantId: m.tenantId,
        projectId: m.projectId,
        serverKey: m.key,
        toolName: tool.origin.realName,
        status: 'success',
        latencyMs: Date.now() - start,
        requestPayload: { tool: tool.origin.realName, arguments: args },
        responsePayload: typeof result === 'object' && result !== null
          ? result as Record<string, unknown>
          : { value: result },
        viaServerKey: server.key,
        transport: 'internal',
        sourceType: resolveSourceType(m),
      }, undefined, { skipUsageEvent: true });
    }
    return result;
  } catch (error) {
    if (tenantDbName) {
      const message = error instanceof Error ? error.message : 'Execution failed';
      void logMcpRequest(tenantDbName, {
        tenantId: m.tenantId,
        projectId: m.projectId,
        serverKey: m.key,
        toolName: tool.origin.realName,
        status: 'error',
        latencyMs: Date.now() - start,
        requestPayload: { tool: tool.origin.realName, arguments: args },
        errorMessage: message,
        viaServerKey: server.key,
        transport: 'internal',
        sourceType: resolveSourceType(m),
      }, undefined, { skipUsageEvent: true });
    }
    throw error;
  }
}

async function markServerError(server: IMcpServer, message: string): Promise<void> {
  try {
    if (!server._id) return;
    const db = await getDatabase();
    // The caller already bound the tenant context for this request.
    await db.updateMcpServer(String(server._id), {
      lastError: { message: message.slice(0, 1_000), at: new Date() },
    });
  } catch {
    // Best-effort only.
  }
}

async function executeOpenApiTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  runtimeHeaders?: Record<string, string>,
): Promise<unknown> {
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Tool "${toolName}" not found on MCP server "${server.name}"`);
  }
  if (!tool.httpPath || !tool.httpMethod) {
    throw new Error(`Tool "${toolName}" has no HTTP mapping`);
  }

  // Build URL with path parameters
  let url = `${server.upstreamBaseUrl}${tool.httpPath}`;
  const queryParams: Record<string, string> = {};
  const bodyContent = args.body;

  // Replace path parameters and separate query params
  for (const [key, value] of Object.entries(args)) {
    if (key === 'body') continue;
    if (url.includes(`{${key}}`)) {
      url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else {
      queryParams[key] = String(value);
    }
  }

  // Append query params
  const qp = new URLSearchParams(queryParams);
  if (qp.toString()) {
    url += `?${qp.toString()}`;
  }

  // Build headers with upstream auth (decrypted from the vault)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const auth = openAuthConfig(server.upstreamAuth);
  if (auth?.type === 'token' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth?.type === 'header' && auth.headerName && auth.headerValue) {
    headers[auth.headerName] = auth.headerValue;
  } else if (auth?.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  // Caller-supplied runtime headers (already policy-filtered) win over static auth.
  Object.assign(headers, runtimeHeaders);

  const fetchOptions: RequestInit = {
    method: tool.httpMethod,
    headers,
  };

  if (bodyContent && ['POST', 'PUT', 'PATCH'].includes(tool.httpMethod)) {
    fetchOptions.body = JSON.stringify(bodyContent);
  }

  const response = await safeFetch(url, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Upstream API error (${response.status}): ${errorText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}
