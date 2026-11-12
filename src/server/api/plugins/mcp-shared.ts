/**
 * Request parsing shared by the dashboard (`mcp.ts`), client (`client-mcp.ts`)
 * and public (`public-mcp.ts`) MCP plugins.
 *
 * Everything here is pure: body parsers, the create-body validation steps and
 * the JSON-RPC constants. Who may create what (stdio subprocess permission,
 * sandbox and license gates, tenant scope) stays in each plugin, which runs its
 * own checks between the steps below and passes the surface's identity in
 * explicitly.
 */
import type { FastifyRequest } from 'fastify';
import {
  CONSOLE_IDENTITY_AUTH_TYPE,
} from '@/lib/iam/consoleIdentity';
import type {
  IMcpAuthConfig,
  IMcpExposureConfig,
  IMcpGuardrailConfig,
  IMcpRemoteConfig,
  IMcpStdioConfig,
  McpAuthType,
} from '@/lib/database';
import type { McpAuditContext } from '@/lib/services/mcp';
import { mcpInstructionsInputError } from '@/lib/services/mcp';
import type { SpecFormatHint } from '@/lib/services/specImport';
import { getClientIp } from '../fastify-utils';

export const VALID_AUTH_TYPES: McpAuthType[] = ['none', 'token', 'header', 'basic', CONSOLE_IDENTITY_AUTH_TYPE];

export const JSONRPC_VERSION = '2.0';
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const SERVER_VERSION = '1.0.0';

export function jsonRpcOk(id: string | number | null, result: unknown) {
  return { id, jsonrpc: JSONRPC_VERSION, result };
}

export function jsonRpcError(id: string | number | null, code: number, message: string) {
  return {
    error: { code, message },
    id,
    jsonrpc: JSONRPC_VERSION,
  };
}

export function auditContextFor(request: FastifyRequest, userId: string): McpAuditContext {
  const ua = request.headers['user-agent'];
  return {
    performedBy: userId,
    ipAddress: getClientIp(request),
    userAgent: typeof ua === 'string' ? ua.slice(0, 300) : undefined,
  };
}

export function parseExposure(raw: unknown): IMcpExposureConfig | undefined {
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

/**
 * The guardrail binding of an MCP server. `guardrailKey` is a guardrail KEY
 * (the tenant-scoped slug), not an id, and omitting it is meaningful — it
 * selects the tenant's default tool guardrail rather than leaving the server
 * unguarded.
 */
export function parseGuardrail(raw: unknown): IMcpGuardrailConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { guardrailKey?: unknown; mode?: unknown };
  const mode = value.mode === 'monitor' || value.mode === 'enforce' ? value.mode : 'off';
  return {
    guardrailKey: typeof value.guardrailKey === 'string' && value.guardrailKey.trim()
      ? value.guardrailKey.trim()
      : undefined,
    mode,
  };
}

export function parseRemoteConfig(raw: unknown): IMcpRemoteConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { url?: unknown; transport?: unknown };
  if (typeof value.url !== 'string' || !value.url.trim()) return undefined;
  return {
    url: value.url.trim(),
    transport: value.transport === 'sse' ? 'sse' : 'streamable-http',
  };
}

export function parseStdioConfig(raw: unknown): IMcpStdioConfig | undefined {
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

// ── Create body ───────────────────────────────────────────────────────────

export type McpSourceType = 'openapi' | 'remote' | 'stdio' | 'internal' | 'composite';

export interface McpBodyFailure {
  ok: false;
  status: 400;
  error: string;
}

function failure(error: string): McpBodyFailure {
  return { ok: false, status: 400, error };
}

/** `"a", "b", or "c"` */
function quotedList(values: readonly string[]): string {
  const quoted = values.map((v) => `"${v}"`);
  if (quoted.length <= 1) return quoted.join('');
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`;
}

export interface McpCreateHead {
  name: string;
  sourceType: McpSourceType;
  remoteConfig?: IMcpRemoteConfig;
  stdioConfig?: IMcpStdioConfig;
}

export type McpCreateHeadResult = { ok: true; value: McpCreateHead } | McpBodyFailure;

/**
 * First half of the create validation: name, source type and the source
 * configs every surface accepts. `allowedSourceTypes` is the surface's own
 * list. Internal and composite configs are parsed by the surface that allows
 * them.
 */
export function readMcpCreateHead(
  body: Record<string, unknown>,
  options: { allowedSourceTypes: readonly McpSourceType[] },
): McpCreateHeadResult {
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return failure('name is required');
  }

  const sourceType = typeof body.sourceType === 'string' ? body.sourceType : 'openapi';
  if (!options.allowedSourceTypes.includes(sourceType as McpSourceType)) {
    return failure(`sourceType must be ${quotedList(options.allowedSourceTypes)}`);
  }

  if (sourceType === 'openapi' && typeof body.openApiSpec !== 'string') {
    return failure('openApiSpec is required');
  }

  const remoteConfig = parseRemoteConfig(body.remoteConfig);
  if (sourceType === 'remote' && !remoteConfig) {
    return failure('remoteConfig.url is required');
  }

  const stdioConfig = parseStdioConfig(body.stdioConfig);
  if (sourceType === 'stdio' && !stdioConfig) {
    return failure('stdioConfig.packageName is required');
  }

  return {
    ok: true,
    value: {
      name: body.name.trim(),
      sourceType: sourceType as McpSourceType,
      remoteConfig,
      stdioConfig,
    },
  };
}

/**
 * Second half of the create validation: the upstream credential shape and the
 * instructions text. Fills in `upstreamAuth: { type: 'none' }` on the body for
 * a remote server that sends none.
 */
export function readMcpUpstreamBody(
  body: Record<string, unknown>,
  sourceType: McpSourceType,
): { ok: true; upstreamAuth: IMcpAuthConfig } | McpBodyFailure {
  // A remote server that needs no credential does not have to spell that out.
  if ((body.upstreamAuth === undefined || body.upstreamAuth === null) && sourceType === 'remote') {
    body.upstreamAuth = { type: 'none' };
  }

  if (
    !body.upstreamAuth
    || typeof body.upstreamAuth !== 'object'
    || !('type' in body.upstreamAuth)
  ) {
    return failure('upstreamAuth with type is required');
  }

  const authType = (body.upstreamAuth as { type?: unknown }).type;
  if (!VALID_AUTH_TYPES.includes(authType as McpAuthType)) {
    return failure('upstreamAuth.type must be "none", "token", "header", "basic", or "console_identity"');
  }
  if (authType === CONSOLE_IDENTITY_AUTH_TYPE && sourceType !== 'remote' && sourceType !== 'openapi') {
    return failure('Console identity is available for remote MCP and OpenAPI servers only');
  }

  const instructionsError = mcpInstructionsInputError(body.instructions);
  if (instructionsError) return failure(instructionsError);

  return { ok: true, upstreamAuth: body.upstreamAuth as IMcpAuthConfig };
}

/** The create-input fields every surface fills the same way. */
export function readMcpCommonCreateFields(
  body: Record<string, unknown>,
  head: McpCreateHead,
  upstreamAuth: IMcpAuthConfig,
) {
  return {
    description: typeof body.description === 'string' ? body.description.trim() : undefined,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    name: head.name,
    key: typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined,
    openApiSpec: typeof body.openApiSpec === 'string' ? body.openApiSpec : undefined,
    specFormat: typeof body.specFormat === 'string' ? body.specFormat as SpecFormatHint : undefined,
    upstreamAuth,
    upstreamBaseUrl: typeof body.upstreamBaseUrl === 'string'
      ? body.upstreamBaseUrl.trim()
      : undefined,
    remoteConfig: head.remoteConfig,
    stdioConfig: head.stdioConfig,
    exposure: parseExposure(body.exposure),
    guardrail: parseGuardrail(body.guardrail),
  };
}
