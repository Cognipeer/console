/**
 * Tool Service
 *
 * Business logic for the unified tool system (OpenAPI and MCP sources).
 * Tools are registered centrally and can be bound to agents or called via API.
 */

import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { currentTurnSignal } from '@/lib/core/turnSignal';
import slugify from 'slugify';
import { safeFetch } from '@/lib/security/outboundFetch';
import { normalizeApiSpec, type SpecFormatHint } from '@/lib/services/specImport';
import { buildOpenApiRequest } from '@/lib/services/mcp/openApiRequest';
import { specDeclaredParameters } from '@/lib/services/mcp/openApiSpecParameters';
import { createLogger } from '@/lib/core/logger';
import {
  authConfigSecretValues,
  redactLogPayload,
  redactLogString,
} from '@/lib/services/logRedaction';
import { getDatabase } from '@/lib/database';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';
import type { RuntimeAuthLogInfo } from '@/lib/services/runtimeContext';
import type { IMcpAuthConfig, ITool, IToolAction, IToolAuthConfig } from '@/lib/database';
import { contentHasMedia, mcpResultToToolOutput } from '@/lib/services/tools/toolOutput';
import { remoteListTools, remoteRpc } from '@/lib/services/mcp/remoteMcpClient';
import { getToolCredentialResolver } from '@/enterprise/tool-credentials';
import { getToolActionExecutor } from '@/enterprise/tool-actions';
import { effectiveActionAnnotations, openApiActionAnnotations, sanitizeAnnotations } from './actionAnnotations';
import { mergeAuthConfigUpdate, openAuthConfig, sealAuthConfig } from './secretVault';
import type {
  CreateToolInput,
  UpdateToolInput,
  ToolView,
  ExecuteToolActionResult,
  ExecuteToolActionOptions,
  ManagedToolInput,
  ManagedToolUpdate,
} from './types';

const logger = createLogger('tool-service');
const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;

// ── Key generation ────────────────────────────────────────────────────────

function normalizeKey(input: string): string {
  const fallback = input?.trim().length ? input.trim() : 'tool';
  return slugify(fallback, SLUG_OPTIONS);
}

async function generateUniqueKey(
  tenantDbName: string,
  projectId: string | undefined,
  desiredKey: string,
): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const base = normalizeKey(desiredKey);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findToolByKey(candidate, projectId);
    if (!existing) return candidate;
    attempt++;
    candidate = `${base}-${attempt}`;
  }

  throw new Error(`Could not generate a unique key for tool "${desiredKey}"`);
}

// ── OpenAPI Parsing ───────────────────────────────────────────────────────

interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<string, unknown>;
}

export function parseOpenApiToActions(specString: string, format: SpecFormatHint = 'auto'): {
  actions: IToolAction[];
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

  let baseUrl = '';
  if (spec.servers && spec.servers.length > 0) {
    baseUrl = spec.servers[0].url;
  }

  const actions: IToolAction[] = [];
  const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of httpMethods) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!operation) continue;

      const opName =
        operation.operationId ||
        `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const actionKey = slugify(opName, SLUG_OPTIONS);
      const description =
        operation.summary || operation.description || `${method.toUpperCase()} ${path}`;

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
          properties['body'] = { ...jsonContent.schema, description: 'Request body' };
          if (operation.requestBody.required) required.push('body');
        }
      }

      const inputSchema: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) inputSchema.required = required;

      actions.push({
        key: actionKey,
        name: opName,
        description,
        inputSchema,
        executionType: 'openapi_http',
        httpMethod: method.toUpperCase(),
        httpPath: path,
        annotations: openApiActionAnnotations(method),
      });
    }
  }

  if (actions.length === 0) {
    throw new Error('No operations found in the OpenAPI specification');
  }

  return { actions, baseUrl, normalizedSpec: openApiJson };
}

// ── MCP Tool Discovery ───────────────────────────────────────────────────

/**
 * Discover tools from an MCP server endpoint.
 * For now, fetches tool list via the MCP SSE/streamable-http protocol.
 */
export async function discoverMcpTools(
  endpoint: string,
  transport: 'sse' | 'streamable-http',
  auth?: IToolAuthConfig,
  extraHeaders?: Record<string, string>,
): Promise<IToolAction[]> {
  try {
    const mcpTools = await remoteListTools({
      url: endpoint,
      transport,
      auth: toMcpAuth(auth),
      ...(extraHeaders ? { extraHeaders } : {}),
    });

    return mcpTools.map((t) => {
      // The server's own markings (readOnlyHint, destructiveHint…), kept as sent; the tool's title rides along.
      const annotations = sanitizeAnnotations({ ...(t.annotations ?? {}), ...(t.title ? { title: t.title } : {}) });
      return {
        key: slugify(t.name, SLUG_OPTIONS),
        name: t.name,
        description: t.description || t.name,
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        executionType: 'mcp_call' as const,
        mcpToolName: t.name,
        ...(annotations ? { annotations } : {}),
      };
    });
  } catch (err) {
    logger.error('Failed to discover MCP tools', { endpoint, error: err });
    throw new Error(`Failed to discover MCP tools: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A tool credential in the MCP client's shape. `none` and `connector` add no header. */
function toMcpAuth(auth: IToolAuthConfig | undefined): IMcpAuthConfig | undefined {
  if (auth?.type !== 'token' && auth?.type !== 'header' && auth?.type !== 'basic') return undefined;
  return {
    type: auth.type,
    token: auth.token,
    headerName: auth.headerName,
    headerValue: auth.headerValue,
    username: auth.username,
    password: auth.password,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function createTool(
  tenantDbName: string,
  tenantId: string,
  userId: string,
  projectId: string | undefined,
  input: CreateToolInput,
): Promise<ITool> {
  if ((input.upstreamAuth as IToolAuthConfig | undefined)?.type === 'connector') {
    throw new Error(MANAGED_AUTH_ERROR);
  }
  // A `connector` tool is created by the Connectors module (createManagedTool), never from outside.
  if (input.type !== 'openapi' && input.type !== 'mcp') {
    throw new Error('Tool type must be "openapi" or "mcp"');
  }
  const key = await generateUniqueKey(tenantDbName, projectId, input.key?.trim() || input.name);

  let actions: IToolAction[] = [];
  let upstreamBaseUrl = input.upstreamBaseUrl;
  let normalizedSpec = input.openApiSpec;

  if (input.type === 'openapi') {
    if (!input.openApiSpec) {
      throw new Error('OpenAPI specification is required for "openapi" tool type');
    }
    const parsed = parseOpenApiToActions(input.openApiSpec, input.specFormat);
    actions = parsed.actions;
    normalizedSpec = parsed.normalizedSpec;
    if (!upstreamBaseUrl && parsed.baseUrl) upstreamBaseUrl = parsed.baseUrl;
    if (!upstreamBaseUrl) {
      throw new Error('Upstream base URL is required. Provide it explicitly or include a servers array in the spec.');
    }
  } else if (input.type === 'mcp') {
    if (!input.mcpEndpoint) {
      throw new Error('MCP endpoint URL is required for "mcp" tool type');
    }
    actions = await discoverMcpTools(
      input.mcpEndpoint,
      input.mcpTransport || 'streamable-http',
      input.upstreamAuth as IToolAuthConfig,
    );
  }

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const tool = await db.createTool({
    tenantId,
    projectId: projectId ?? undefined,
    key,
    name: input.name.trim(),
    description: input.description?.trim(),
    type: input.type,
    status: 'active',
    actions,
    openApiSpec: normalizedSpec,
    upstreamBaseUrl,
    upstreamAuth: input.upstreamAuth
      ? sealAuthConfig(input.upstreamAuth as IToolAuthConfig)
      : undefined,
    mcpEndpoint: input.mcpEndpoint,
    mcpTransport: input.mcpTransport,
    createdBy: userId,
  });

  logger.info('Tool created', { key, type: input.type, tenantId, actionCount: actions.length });
  return tool;
}

export async function updateTool(
  tenantDbName: string,
  toolId: string,
  userId: string,
  input: UpdateToolInput,
): Promise<ITool | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const updateData: Record<string, unknown> = { updatedBy: userId };

  // Fetched lazily, at most once, by whichever branch below needs the
  // currently-stored tool (existing metadata for the runtime-header merge,
  // or the existing sealed auth config to preserve/re-seal on update).
  let existingTool: ITool | null | undefined;
  const loadExisting = async () => {
    if (existingTool === undefined) existingTool = await db.findToolById(toolId);
    return existingTool;
  };

  if ((input.upstreamAuth as IToolAuthConfig | undefined)?.type === 'connector') {
    throw new Error(MANAGED_AUTH_ERROR);
  }
  if (isManagedTool(await loadExisting())) throw new Error(MANAGED_TOOL_ERROR);

  if (input.name !== undefined) updateData.name = input.name.trim();
  if (input.description !== undefined) updateData.description = input.description.trim();
  if (input.status !== undefined) updateData.status = input.status;
  if (input.upstreamBaseUrl !== undefined) updateData.upstreamBaseUrl = input.upstreamBaseUrl;
  if (input.upstreamAuth !== undefined) {
    const existing = await loadExisting();
    updateData.upstreamAuth = mergeAuthConfigUpdate(existing?.upstreamAuth, input.upstreamAuth);
  }
  if (input.mcpEndpoint !== undefined) updateData.mcpEndpoint = input.mcpEndpoint;
  if (input.mcpTransport !== undefined) updateData.mcpTransport = input.mcpTransport;

  // Runtime-header passthrough policy lives in the metadata blob (no schema
  // migration needed in either DB tree).
  if (input.runtimeHeaders !== undefined) {
    const existing = await loadExisting();
    updateData.metadata = {
      ...(existing?.metadata ?? {}),
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

  // Re-parse spec or re-discover MCP tools if source config changed
  if (input.openApiSpec !== undefined) {
    const { actions, baseUrl: specBaseUrl, normalizedSpec } = parseOpenApiToActions(
      input.openApiSpec,
      input.specFormat,
    );
    updateData.openApiSpec = normalizedSpec;
    updateData.actions = actions;
    if (!input.upstreamBaseUrl && specBaseUrl) {
      updateData.upstreamBaseUrl = specBaseUrl;
    }
  }

  return db.updateTool(toolId, updateData as Partial<ITool>);
}

// ── Managed tools ─────────────────────────────────────────────────────────

const MANAGED_AUTH_ERROR = 'A connector credential can only be set by the Connectors module';
const MANAGED_TOOL_ERROR = 'This tool is managed by a connector. Change it from the connector.';

/** A tool another module owns. Its credential comes from that module for each call; the Tools API cannot change it. */
export function isManagedTool(tool: Pick<ITool, 'upstreamAuth'> | null | undefined): boolean {
  return tool?.upstreamAuth?.type === 'connector';
}

/**
 * Creates a tool the Connectors module owns. Its actions come from the caller,
 * which discovered them with the connector's credential.
 */
export async function createManagedTool(
  tenantDbName: string,
  tenantId: string,
  userId: string,
  projectId: string | undefined,
  input: ManagedToolInput,
): Promise<ITool> {
  const key = await generateUniqueKey(tenantDbName, projectId, input.key?.trim() || input.name);
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const tool = await db.createTool({
    tenantId,
    projectId: projectId ?? undefined,
    key,
    name: input.name.trim(),
    description: input.description?.trim(),
    type: input.type,
    status: input.status ?? 'active',
    actions: input.actions,
    openApiSpec: input.openApiSpec,
    upstreamBaseUrl: input.upstreamBaseUrl,
    upstreamAuth: { type: 'connector', connectorId: input.connectorId },
    mcpEndpoint: input.mcpEndpoint,
    mcpTransport: input.mcpTransport,
    metadata: input.metadata,
    createdBy: userId,
  });
  logger.info('Managed tool created', { key, type: input.type, tenantId, actionCount: input.actions.length });
  return tool;
}

/** Updates a tool the given connector owns; refuses any other tool. */
export async function updateManagedTool(
  tenantDbName: string,
  toolId: string,
  connectorId: string,
  userId: string,
  patch: ManagedToolUpdate,
): Promise<ITool | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const existing = await db.findToolById(toolId);
  if (!existing) return null;
  if (existing.upstreamAuth?.type !== 'connector' || existing.upstreamAuth.connectorId !== connectorId) {
    throw new Error('The tool is not managed by this connector');
  }
  const update: Partial<ITool> = { updatedBy: userId };
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.description !== undefined) update.description = patch.description.trim();
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.actions !== undefined) update.actions = patch.actions;
  if (patch.mcpEndpoint !== undefined) update.mcpEndpoint = patch.mcpEndpoint;
  if (patch.mcpTransport !== undefined) update.mcpTransport = patch.mcpTransport;
  if (patch.upstreamBaseUrl !== undefined) update.upstreamBaseUrl = patch.upstreamBaseUrl;
  if (patch.openApiSpec !== undefined) update.openApiSpec = patch.openApiSpec;
  if (patch.metadata !== undefined) update.metadata = patch.metadata;
  return db.updateTool(toolId, update);
}

export async function deleteTool(
  tenantDbName: string,
  toolId: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteTool(toolId);
}

export async function getTool(
  tenantDbName: string,
  toolId: string,
): Promise<ITool | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findToolById(toolId);
}

export async function getToolByKey(
  tenantDbName: string,
  key: string,
  projectId?: string | null,
): Promise<ITool | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findToolByKey(key, projectId);
}

export async function listTools(
  tenantDbName: string,
  filters?: {
    projectId?: string;
    type?: ITool['type'];
    status?: ITool['status'];
    search?: string;
  },
): Promise<ITool[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listTools(filters);
}

export async function countTools(
  tenantDbName: string,
  projectId?: string,
): Promise<number> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.countTools(projectId);
}

/**
 * Re-sync actions from source (re-parse OpenAPI or re-discover MCP tools).
 */
export async function syncToolActions(
  tenantDbName: string,
  toolId: string,
  userId: string,
): Promise<ITool | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const tool = await db.findToolById(toolId);
  if (!tool) throw new Error('Tool not found');

  // A connector tool's actions are the connector's own: only its owner changes them.
  if (tool.type === 'connector') return tool;

  let actions: IToolAction[] = [];

  if (tool.type === 'openapi' && tool.openApiSpec) {
    const parsed = parseOpenApiToActions(tool.openApiSpec);
    actions = parsed.actions;
  } else if (tool.type === 'mcp' && tool.mcpEndpoint) {
    const upstream = await resolveUpstreamAuth(tool);
    actions = await discoverMcpTools(
      tool.mcpEndpoint,
      tool.mcpTransport || 'streamable-http',
      upstream.auth,
      upstream.headers,
    );
  }

  return db.updateTool(toolId, { actions, updatedBy: userId });
}

// ── Execution ─────────────────────────────────────────────────────────────

/**
 * Names of the headers that carry a credential for a tool's upstream: the
 * configured auth header and the caller's runtime headers. They are dropped
 * when a redirect leads to another origin (`safeFetch` `sensitiveHeaders`).
 */
function credentialHeaderNames(
  upstream: UpstreamAuth,
  runtimeHeaders?: Record<string, string>,
): string[] {
  const { auth } = upstream;
  return [
    ...(auth.type === 'header' && auth.headerName ? [auth.headerName] : []),
    ...Object.keys(upstream.headers),
    ...Object.keys(runtimeHeaders ?? {}),
  ];
}

interface UpstreamAuth {
  auth: IToolAuthConfig;
  /** Headers the tool's owner adds to every upstream request. */
  headers: Record<string, string>;
}

/**
 * The credential for one upstream call. A connector-managed tool gets it from
 * the Connectors module (and fails closed without it); any other tool opens
 * its own sealed config.
 */
async function resolveUpstreamAuth(tool: ITool): Promise<UpstreamAuth> {
  if (!isManagedTool(tool)) return { auth: openAuthConfig(tool.upstreamAuth), headers: {} };
  const resolver = getToolCredentialResolver();
  if (!resolver) {
    throw new Error('This tool is managed by a connector, and the Connectors module is not available');
  }
  const { auth, headers } = await resolver(tool);
  if (auth.type === 'connector') throw new Error('The connector did not supply a credential');
  return { auth, headers: headers ?? {} };
}

/**
 * Execute a specific action on a tool.
 */
export async function executeToolAction(
  tool: ITool,
  actionKey: string,
  args: Record<string, unknown>,
  runtimeHeaders?: Record<string, string>,
  options?: ExecuteToolActionOptions,
): Promise<ExecuteToolActionResult> {
  await assertServiceEnabled({ tenantId: tool.tenantId }, 'tools');
  const action = tool.actions.find((a) => a.key === actionKey);
  if (!action) {
    throw new Error(`Action "${actionKey}" not found on tool "${tool.name}"`);
  }

  const start = Date.now();

  // A connector's own action: the Connectors module runs it with the
  // connector's credential, so no credential is resolved (or held) here.
  if (action.executionType === 'connector_action') {
    const executor = getToolActionExecutor();
    if (!executor) {
      throw new Error('This tool is managed by a connector, and the Connectors module is not available');
    }
    const { result, isError } = await executor({ tool, action, args });
    return { result, latencyMs: Date.now() - start, ...(isError ? { isError } : {}) };
  }

  const upstream = await resolveUpstreamAuth(tool);
  if (isManagedTool(tool)) options?.onSecrets?.(authConfigSecretValues(upstream.auth));

  if (action.executionType === 'openapi_http') {
    return executeOpenApiAction(tool, action, args, start, upstream, runtimeHeaders);
  } else if (action.executionType === 'mcp_call') {
    return executeMcpAction(tool, action, args, start, upstream, runtimeHeaders);
  }

  throw new Error(`Unsupported execution type: ${action.executionType}`);
}

async function executeOpenApiAction(
  tool: ITool,
  action: IToolAction,
  args: Record<string, unknown>,
  start: number,
  upstream: UpstreamAuth,
  runtimeHeaders?: Record<string, string>,
): Promise<ExecuteToolActionResult> {
  if (!tool.upstreamBaseUrl) {
    throw new Error('Tool has no upstream base URL configured');
  }
  if (!action.httpPath) {
    throw new Error(`Action "${action.key}" has no HTTP path`);
  }

  // Path parameters are filled in the action's path template only, and only the
  // arguments the action declares are sent; see `buildOpenApiRequest` for the
  // rules. A problem with the arguments throws `McpToolInputError`.
  const request = buildOpenApiRequest({
    baseUrl: tool.upstreamBaseUrl,
    httpPath: action.httpPath,
    inputSchema: action.inputSchema,
    declaredNames: specDeclaredParameters(tool, action),
    args,
  });

  // Build headers with auth
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const { auth } = upstream;
  if (auth.type === 'token' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth.type === 'header' && auth.headerName && auth.headerValue) {
    headers[auth.headerName] = auth.headerValue;
  } else if (auth.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  // Caller-supplied runtime headers (already policy-filtered) win over the owner's headers and static auth.
  Object.assign(headers, upstream.headers, runtimeHeaders);

  const fetchOptions: RequestInit = {
    method: action.httpMethod || 'GET',
    headers,
  };

  if (request.body && ['POST', 'PUT', 'PATCH'].includes(action.httpMethod || '')) {
    fetchOptions.body = JSON.stringify(request.body);
  }

  const turnSignal = currentTurnSignal();
  if (turnSignal) fetchOptions.signal = turnSignal;
  const response = await safeFetch(request.url, fetchOptions, {
    sensitiveHeaders: credentialHeaderNames(upstream, runtimeHeaders),
  });
  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Upstream API error (${response.status}): ${errorText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  let result: unknown;
  if (contentType.includes('application/json')) {
    result = await response.json();
  } else {
    result = await response.text();
  }

  return { result, latencyMs };
}

async function executeMcpAction(
  tool: ITool,
  action: IToolAction,
  args: Record<string, unknown>,
  start: number,
  upstream: UpstreamAuth,
  runtimeHeaders?: Record<string, string>,
): Promise<ExecuteToolActionResult> {
  if (!tool.mcpEndpoint) {
    throw new Error('Tool has no MCP endpoint configured');
  }

  const turnSignal = currentTurnSignal();
  // Streamable HTTP: a JSON or SSE answer, and a session when the server requires one.
  const callResult = await remoteRpc({
    url: tool.mcpEndpoint,
    transport: tool.mcpTransport || 'streamable-http',
    auth: toMcpAuth(upstream.auth),
    // Caller-supplied runtime headers (already policy-filtered) win over the owner's headers and static auth.
    extraHeaders: { ...upstream.headers, ...(runtimeHeaders ?? {}) },
    ...(turnSignal ? { signal: turnSignal } : {}),
  }, 'tools/call', {
    name: action.mcpToolName || action.name,
    arguments: args,
  }) as { content?: unknown; isError?: boolean } | undefined;

  const latencyMs = Date.now() - start;

  // MCP tools/call returns the result in result.content
  const content = callResult?.content;
  let result: unknown;
  if (contentHasMedia(content)) {
    // Keep images/audio/resources as a ToolOutput; text-only results keep the legacy unwrap.
    result = mcpResultToToolOutput(callResult);
  } else if (Array.isArray(content)) {
    const textParts = content.filter((c: { type: string }) => c.type === 'text');
    result = textParts.length === 1
      ? textParts[0].text
      : textParts.map((c: { text: string }) => c.text).join('\n');
  } else {
    result = callResult;
  }

  // A tool that failed on the server's side answers 200 with `isError: true`. The text still goes to the
  // caller (the model reads it), but the call is a failure for logs and metrics.
  const isError = callResult?.isError === true;
  return { result, latencyMs, ...(isError ? { isError: true } : {}) };
}

// ── Serialization ─────────────────────────────────────────────────────────

export function serializeTool(tool: ITool): ToolView {
  return {
    id: String(tool._id),
    tenantId: tool.tenantId,
    projectId: tool.projectId,
    key: tool.key,
    name: tool.name,
    description: tool.description,
    type: tool.type,
    status: tool.status,
    // Read through `effectiveActionAnnotations`, so a record saved before the field existed shows its markings too.
    actions: tool.actions.map((action) => {
      const annotations = effectiveActionAnnotations(action);
      return Object.keys(annotations).length > 0 ? { ...action, annotations } : action;
    }),
    upstreamBaseUrl: tool.upstreamBaseUrl,
    mcpEndpoint: tool.mcpEndpoint,
    mcpTransport: tool.mcpTransport,
    metadata: tool.metadata,
    ...(tool.upstreamAuth?.type === 'connector' && tool.upstreamAuth.connectorId
      ? { managedBy: { kind: 'connector' as const, id: tool.upstreamAuth.connectorId } }
      : {}),
    createdBy: tool.createdBy,
    updatedBy: tool.updatedBy,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
}

// ── Request Logging ───────────────────────────────────────────────────────

/**
 * Outbound secret values that could be echoed back into a logged response for
 * this tool: the caller's applied runtime-header values plus the tool's own
 * static upstream credential. Tool auth is sealed at rest (see
 * `@/lib/services/tools/secretVault`), so it is opened here to get the
 * plaintext values to scrub. Passed to `logToolRequest`.
 */
export function toolRequestSecretValues(
  tool: ITool,
  runtimeHeaders?: Record<string, string>,
): string[] {
  return [
    ...Object.values(runtimeHeaders ?? {}),
    ...authConfigSecretValues(openAuthConfig(tool.upstreamAuth)),
  ];
}

/** Adds values a call resolved (see ExecuteToolActionOptions.onSecrets) to a request log's scrub list, once each. */
export function addSecretValues(target: string[], values: string[]): void {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

export async function logToolRequest(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  toolKey: string,
  actionKey: string,
  actionName: string,
  status: 'success' | 'error',
  latencyMs: number,
  requestPayload?: Record<string, unknown>,
  responsePayload?: Record<string, unknown>,
  errorMessage?: string,
  callerType?: 'dashboard' | 'api' | 'agent',
  callerTokenId?: string,
  /** Log-safe runtime-auth info: header NAMES only, never values. */
  runtimeAuth?: RuntimeAuthLogInfo,
  /** Outbound secret values to scrub from echoed request/response payloads. */
  secretValues?: string[],
) {
  // Resolve attribution + rollup before any await so the request ALS is in
  // scope. `callerType`/`callerTokenId` stay for compat; the standard
  // userId/apiTokenId/actorType columns are stamped alongside.
  const attribution = recordUsageEvent({
    tenantDbName,
    tenantId,
    projectId,
    service: 'tools',
    refKey: toolKey,
    status,
    latencyMs,
  });
  // Health rollup. Failed calls are logged with latency 0 by the callers; the
  // rollup only records latency for successful calls, so that 0 never lands in
  // the histogram.
  recordEntityMetric({
    tenantDbName,
    tenantId,
    projectId,
    entityType: 'tool',
    entityKey: toolKey,
    source: 'service',
    outcome: status === 'success' ? 'ok' : 'error',
    latencyMs,
  });
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    await db.createToolRequestLog({
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
      tenantId,
      projectId,
      toolKey,
      actionKey,
      actionName,
      status,
      latencyMs,
      // Runtime-auth usage rides inside the payload blob so both DB schemas
      // persist it without a migration. Header names only — values never land here.
      // Scrub echoed secrets / sensitive keys and cap size before persisting.
      requestPayload: redactLogPayload(
        runtimeAuth
          ? { ...(requestPayload ?? {}), _runtimeAuth: runtimeAuth as unknown as Record<string, unknown> }
          : requestPayload,
        { secretValues },
      ),
      responsePayload: redactLogPayload(responsePayload, { secretValues }),
      errorMessage: redactLogString(errorMessage, secretValues),
      callerType,
      callerTokenId,
    });
  } catch (err) {
    logger.error('Failed to log tool request', { toolKey, actionKey, error: err });
  }
}

export async function listToolRequestLogs(
  tenantDbName: string,
  toolKey: string,
  options?: {
    limit?: number;
    skip?: number;
    from?: Date;
    to?: Date;
    status?: string;
    actionKey?: string;
    keyword?: string;
  },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listToolRequestLogs(toolKey, options);
}

export async function countToolRequestLogs(
  tenantDbName: string,
  toolKey: string,
  options?: { from?: Date; to?: Date; status?: string; actionKey?: string; keyword?: string },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.countToolRequestLogs(toolKey, options);
}

export async function aggregateToolRequestLogs(
  tenantDbName: string,
  toolKey: string,
  options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.aggregateToolRequestLogs(toolKey, options);
}
