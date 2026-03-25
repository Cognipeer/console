import slugify from 'slugify';
import { randomUUID } from 'crypto';
import { getDatabase } from '@/lib/database';
import type { IMcpServer, IMcpTool, IMcpAuthConfig } from '@/lib/database';
import type {
  CreateMcpServerInput,
  UpdateMcpServerInput,
  McpServerView,
  OpenApiSpec,
  OpenApiOperation,
} from './types';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('mcp-service');
const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;

// ── Serialization ─────────────────────────────────────────────────────────

export function serializeMcpServer(record: IMcpServer): McpServerView {
  const { _id, openApiSpec: _spec, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
  } as McpServerView;
}

export function serializeMcpServerFull(record: IMcpServer): McpServerView & { openApiSpec: string } {
  const { _id, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
  } as McpServerView & { openApiSpec: string };
}

// ── Key generation ────────────────────────────────────────────────────────

function normalizeKey(input: string): string {
  const fallback = input?.trim().length ? input.trim() : 'mcp-server';
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
    const existing = await db.findMcpServerByKey(candidate, projectId);
    if (!existing) return candidate;
    attempt++;
    candidate = `${base}-${attempt}`;
  }

  throw new Error(`Could not generate a unique key for MCP server "${desiredKey}"`);
}

function generateEndpointSlug(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}

// ── OpenAPI Parsing ───────────────────────────────────────────────────────

export function parseOpenApiSpec(specString: string): {
  spec: OpenApiSpec;
  tools: IMcpTool[];
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

  return { spec, tools, baseUrl };
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function createMcpServer(
  tenantDbName: string,
  tenantId: string,
  userId: string,
  projectId: string | undefined,
  input: CreateMcpServerInput,
): Promise<IMcpServer> {
  const { spec: _parsed, tools, baseUrl: specBaseUrl } = parseOpenApiSpec(input.openApiSpec);

  const key = await generateUniqueKey(tenantDbName, projectId, input.name);
  const endpointSlug = generateEndpointSlug();

  const upstreamBaseUrl = input.upstreamBaseUrl || specBaseUrl;
  if (!upstreamBaseUrl) {
    throw new Error('Upstream base URL is required. Provide it explicitly or include a servers array in the spec.');
  }

  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const server = await db.createMcpServer({
    tenantId,
    projectId: projectId ?? undefined,
    key,
    name: input.name.trim(),
    description: input.description?.trim(),
    openApiSpec: input.openApiSpec,
    tools,
    upstreamBaseUrl,
    upstreamAuth: input.upstreamAuth as IMcpAuthConfig,
    status: 'active',
    endpointSlug,
    totalRequests: 0,
    createdBy: userId,
  });

  logger.info('MCP server created', { key, tenantId, toolCount: tools.length });
  return server;
}

export async function updateMcpServer(
  tenantDbName: string,
  serverId: string,
  userId: string,
  input: UpdateMcpServerInput,
): Promise<IMcpServer | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const updateData: Record<string, unknown> = { updatedBy: userId };

  if (input.name !== undefined) updateData.name = input.name.trim();
  if (input.description !== undefined) updateData.description = input.description.trim();
  if (input.status !== undefined) updateData.status = input.status;
  if (input.upstreamBaseUrl !== undefined) updateData.upstreamBaseUrl = input.upstreamBaseUrl;
  if (input.upstreamAuth !== undefined) updateData.upstreamAuth = input.upstreamAuth;

  // Re-parse spec if updated
  if (input.openApiSpec !== undefined) {
    const { tools, baseUrl: specBaseUrl } = parseOpenApiSpec(input.openApiSpec);
    updateData.openApiSpec = input.openApiSpec;
    updateData.tools = tools;
    if (!input.upstreamBaseUrl && specBaseUrl) {
      updateData.upstreamBaseUrl = specBaseUrl;
    }
  }

  return db.updateMcpServer(serverId, updateData as Partial<IMcpServer>);
}

export async function deleteMcpServer(
  tenantDbName: string,
  serverId: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteMcpServer(serverId);
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

export async function logMcpRequest(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  serverKey: string,
  toolName: string,
  status: 'success' | 'error',
  latencyMs: number,
  requestPayload?: Record<string, unknown>,
  responsePayload?: Record<string, unknown>,
  errorMessage?: string,
  callerTokenId?: string,
) {
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    await db.createMcpRequestLog({
      tenantId,
      projectId,
      serverKey,
      toolName,
      status,
      latencyMs,
      requestPayload,
      responsePayload,
      errorMessage,
      callerTokenId,
    });
  } catch (err) {
    logger.error('Failed to log MCP request', { serverKey, toolName, error: err });
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

// ── MCP Proxy ─────────────────────────────────────────────────────────────

export async function executeMcpTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; latencyMs: number }> {
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Tool "${toolName}" not found on MCP server "${server.name}"`);
  }

  const start = Date.now();

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

  // Build headers with upstream auth
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const auth = server.upstreamAuth;
  if (auth?.type === 'token' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth?.type === 'header' && auth.headerName && auth.headerValue) {
    headers[auth.headerName] = auth.headerValue;
  } else if (auth?.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  const fetchOptions: RequestInit = {
    method: tool.httpMethod,
    headers,
  };

  if (bodyContent && ['POST', 'PUT', 'PATCH'].includes(tool.httpMethod)) {
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
