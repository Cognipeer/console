/**
 * Tool Service
 *
 * Business logic for the unified tool system (OpenAPI and MCP sources).
 * Tools are registered centrally and can be bound to agents or called via API.
 */

import slugify from 'slugify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { ITool, IToolAction, IToolAuthConfig } from '@/lib/database';
import type {
  CreateToolInput,
  UpdateToolInput,
  ToolView,
  ExecuteToolActionResult,
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

export function parseOpenApiToActions(specString: string): {
  actions: IToolAction[];
  baseUrl: string;
} {
  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(specString);
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
      });
    }
  }

  if (actions.length === 0) {
    throw new Error('No operations found in the OpenAPI specification');
  }

  return { actions, baseUrl };
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
): Promise<IToolAction[]> {
  // Build headers
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (auth?.type === 'token' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth?.type === 'header' && auth.headerName && auth.headerValue) {
    headers[auth.headerName] = auth.headerValue;
  } else if (auth?.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  // For streamable-http, use JSON-RPC to list tools
  const listToolsBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: listToolsBody,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`MCP server responded with ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const mcpTools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }> = data?.result?.tools || data?.tools || [];

    return mcpTools.map((t) => ({
      key: slugify(t.name, SLUG_OPTIONS),
      name: t.name,
      description: t.description || t.name,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      executionType: 'mcp_call' as const,
      mcpToolName: t.name,
    }));
  } catch (err) {
    logger.error('Failed to discover MCP tools', { endpoint, error: err });
    throw new Error(`Failed to discover MCP tools: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function createTool(
  tenantDbName: string,
  tenantId: string,
  userId: string,
  projectId: string | undefined,
  input: CreateToolInput,
): Promise<ITool> {
  const key = await generateUniqueKey(tenantDbName, projectId, input.name);

  let actions: IToolAction[] = [];
  let upstreamBaseUrl = input.upstreamBaseUrl;

  if (input.type === 'openapi') {
    if (!input.openApiSpec) {
      throw new Error('OpenAPI specification is required for "openapi" tool type');
    }
    const parsed = parseOpenApiToActions(input.openApiSpec);
    actions = parsed.actions;
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
    openApiSpec: input.openApiSpec,
    upstreamBaseUrl,
    upstreamAuth: input.upstreamAuth as IToolAuthConfig,
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

  if (input.name !== undefined) updateData.name = input.name.trim();
  if (input.description !== undefined) updateData.description = input.description.trim();
  if (input.status !== undefined) updateData.status = input.status;
  if (input.upstreamBaseUrl !== undefined) updateData.upstreamBaseUrl = input.upstreamBaseUrl;
  if (input.upstreamAuth !== undefined) updateData.upstreamAuth = input.upstreamAuth;
  if (input.mcpEndpoint !== undefined) updateData.mcpEndpoint = input.mcpEndpoint;
  if (input.mcpTransport !== undefined) updateData.mcpTransport = input.mcpTransport;

  // Re-parse spec or re-discover MCP tools if source config changed
  if (input.openApiSpec !== undefined) {
    const { actions, baseUrl: specBaseUrl } = parseOpenApiToActions(input.openApiSpec);
    updateData.openApiSpec = input.openApiSpec;
    updateData.actions = actions;
    if (!input.upstreamBaseUrl && specBaseUrl) {
      updateData.upstreamBaseUrl = specBaseUrl;
    }
  }

  return db.updateTool(toolId, updateData as Partial<ITool>);
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
  projectId?: string,
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

  let actions: IToolAction[] = [];

  if (tool.type === 'openapi' && tool.openApiSpec) {
    const parsed = parseOpenApiToActions(tool.openApiSpec);
    actions = parsed.actions;
  } else if (tool.type === 'mcp' && tool.mcpEndpoint) {
    actions = await discoverMcpTools(
      tool.mcpEndpoint,
      tool.mcpTransport || 'streamable-http',
      tool.upstreamAuth,
    );
  }

  return db.updateTool(toolId, { actions, updatedBy: userId });
}

// ── Execution ─────────────────────────────────────────────────────────────

/**
 * Execute a specific action on a tool.
 */
export async function executeToolAction(
  tool: ITool,
  actionKey: string,
  args: Record<string, unknown>,
): Promise<ExecuteToolActionResult> {
  const action = tool.actions.find((a) => a.key === actionKey);
  if (!action) {
    throw new Error(`Action "${actionKey}" not found on tool "${tool.name}"`);
  }

  const start = Date.now();

  if (action.executionType === 'openapi_http') {
    return executeOpenApiAction(tool, action, args, start);
  } else if (action.executionType === 'mcp_call') {
    return executeMcpAction(tool, action, args, start);
  }

  throw new Error(`Unsupported execution type: ${action.executionType}`);
}

async function executeOpenApiAction(
  tool: ITool,
  action: IToolAction,
  args: Record<string, unknown>,
  start: number,
): Promise<ExecuteToolActionResult> {
  if (!tool.upstreamBaseUrl) {
    throw new Error('Tool has no upstream base URL configured');
  }

  // Build URL with path parameters
  let url = `${tool.upstreamBaseUrl}${action.httpPath}`;
  const queryParams: Record<string, string> = {};
  const bodyContent = args.body;

  for (const [key, value] of Object.entries(args)) {
    if (key === 'body') continue;
    if (url.includes(`{${key}}`)) {
      url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else {
      queryParams[key] = String(value);
    }
  }

  const qp = new URLSearchParams(queryParams);
  if (qp.toString()) url += `?${qp.toString()}`;

  // Build headers with auth
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const auth = tool.upstreamAuth;
  if (auth?.type === 'token' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth?.type === 'header' && auth.headerName && auth.headerValue) {
    headers[auth.headerName] = auth.headerValue;
  } else if (auth?.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  const fetchOptions: RequestInit = {
    method: action.httpMethod || 'GET',
    headers,
  };

  if (bodyContent && ['POST', 'PUT', 'PATCH'].includes(action.httpMethod || '')) {
    fetchOptions.body = JSON.stringify(bodyContent);
  }

  const response = await fetch(url, fetchOptions);
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
): Promise<ExecuteToolActionResult> {
  if (!tool.mcpEndpoint) {
    throw new Error('Tool has no MCP endpoint configured');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const auth = tool.upstreamAuth;
  if (auth?.type === 'token' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth?.type === 'header' && auth.headerName && auth.headerValue) {
    headers[auth.headerName] = auth.headerValue;
  } else if (auth?.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  const callBody = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: action.mcpToolName || action.name,
      arguments: args,
    },
  });

  const response = await fetch(tool.mcpEndpoint, {
    method: 'POST',
    headers,
    body: callBody,
  });

  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`MCP server error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`MCP tool error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  // MCP tools/call returns result in data.result.content
  const content = data?.result?.content;
  let result: unknown;
  if (Array.isArray(content)) {
    const textParts = content.filter((c: { type: string }) => c.type === 'text');
    result = textParts.length === 1
      ? textParts[0].text
      : textParts.map((c: { text: string }) => c.text).join('\n');
  } else {
    result = data.result;
  }

  return { result, latencyMs };
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
    actions: tool.actions,
    upstreamBaseUrl: tool.upstreamBaseUrl,
    mcpEndpoint: tool.mcpEndpoint,
    mcpTransport: tool.mcpTransport,
    metadata: tool.metadata,
    createdBy: tool.createdBy,
    updatedBy: tool.updatedBy,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
}

// ── Request Logging ───────────────────────────────────────────────────────

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
) {
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    await db.createToolRequestLog({
      tenantId,
      projectId,
      toolKey,
      actionKey,
      actionName,
      status,
      latencyMs,
      requestPayload,
      responsePayload,
      errorMessage,
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
