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
  IMcpServer,
  IMcpStdioConfig,
  McpAuthType,
} from '@/lib/database';
import type { McpAuditContext, UpdateMcpServerInput } from '@/lib/services/mcp';
import { mcpInstructionsInputError } from '@/lib/services/mcp';
import { readPiiProtectionField } from '@/lib/services/pii/protectionConfig';
import { mcpRuntimeHeaderPolicyError } from '@/lib/services/runtimeContext';
import type { SpecFormatHint } from '@/lib/services/specImport';
import { getClientIp } from '../fastify-utils';

export const VALID_AUTH_TYPES: McpAuthType[] = ['none', 'token', 'header', 'basic', CONSOLE_IDENTITY_AUTH_TYPE];

export const PUBLIC_EXPOSURE_FORBIDDEN_ERROR =
  'Serving an MCP server at its public URL requires elevated "mcp" permission (admin level).';

/**
 * True when a create or update would start serving the server at its public
 * (unauthenticated) URL, or move that URL. Publishing is a separate, admin-level
 * act: write-level access may create and edit servers reached with an API token.
 */
export function publishesPublicly(
  body: Record<string, unknown>,
  existing?: Pick<IMcpServer, 'exposure' | 'endpointSlug'> | null,
): boolean {
  const next = body.exposure !== undefined ? parseExposure(body.exposure) : undefined;
  const wasPublic = existing?.exposure?.accessMode === 'public';
  const willBePublic = next ? next.accessMode === 'public' : wasPublic;
  if (!willBePublic) return false;
  if (!wasPublic) return true;
  const slug = typeof body.endpointSlug === 'string' ? body.endpointSlug.trim() : '';
  return slug !== '' && slug !== existing?.endpointSlug;
}

type McpSecurityUpdateFields = Pick<
  UpdateMcpServerInput,
  'runtimeHeaders' | 'piiProtection' | 'piiPassthroughTools' | 'toolChangePolicy' | 'toolReview'
>;

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1000 && value.every((name) => typeof name === 'string');
}

type ReviewItem = string | { name: string; hash: string };
const DEFINITION_HASH = /^[a-f0-9]{64}$/;

/** Tool names, or `{ name, hash }` entries that bind a decision to one definition; null when malformed. */
function readReviewList(value: unknown): ReviewItem[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const items: ReviewItem[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      items.push(item);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { name, hash } = item as { name?: unknown; hash?: unknown };
    if (typeof name !== 'string' || typeof hash !== 'string' || !DEFINITION_HASH.test(hash)) return null;
    items.push({ name, hash });
  }
  return items;
}

/**
 * The security settings an MCP server update may carry, validated (the
 * dashboard and the client API share this parse). Fields absent from the body
 * stay absent.
 */
export async function readMcpSecurityUpdate(
  body: Record<string, unknown>,
  scope: { tenantDbName: string; projectId?: string },
): Promise<{ error: string } | { fields: McpSecurityUpdateFields }> {
  const headerError = mcpRuntimeHeaderPolicyError(body.runtimeHeaders);
  if (headerError) return { error: headerError };
  const fields: McpSecurityUpdateFields = {};
  if (body.runtimeHeaders !== undefined) {
    const raw = body.runtimeHeaders as { allow?: boolean; allowedNames?: string[] } | null;
    fields.runtimeHeaders = raw === null
      ? null
      : { allow: raw.allow === true, allowedNames: (raw.allowedNames ?? []).map((name) => name.trim()).filter(Boolean) };
  }
  const pii = await readPiiProtectionField(body.piiProtection, scope);
  if (pii.error) return { error: pii.error };
  if (pii.value !== undefined) fields.piiProtection = pii.value ? { policyKey: pii.value.policyKey } : null;
  if (body.piiPassthroughTools !== undefined) {
    if (!isNameList(body.piiPassthroughTools)) return { error: 'piiPassthroughTools must be an array of tool names' };
    fields.piiPassthroughTools = body.piiPassthroughTools;
  }
  if (body.toolChangePolicy !== undefined) {
    if (body.toolChangePolicy !== 'approve' && body.toolChangePolicy !== 'notify') {
      return { error: 'toolChangePolicy must be "approve" or "notify"' };
    }
    fields.toolChangePolicy = body.toolChangePolicy;
  }
  if (body.toolReview !== undefined) {
    const review = body.toolReview as { approve?: unknown; reject?: unknown } | null;
    const shaped = !!review && typeof review === 'object' && !Array.isArray(review);
    const approve = shaped && review.approve !== undefined ? readReviewList(review.approve) : undefined;
    const reject = shaped && review.reject !== undefined ? readReviewList(review.reject) : undefined;
    if (!shaped || approve === null || reject === null) {
      return {
        error: 'toolReview must be { "approve"?: [...], "reject"?: [...] } listing tool names or { "name", "hash" } entries',
      };
    }
    fields.toolReview = {
      ...(approve ? { approve } : {}),
      ...(reject ? { reject } : {}),
    };
  }
  return { fields };
}

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

/** @deprecated Legacy shield binding. Still parsed so an un-deployed UI keeps
 *  saving; `guardrail` wins wherever both are sent.
 *  A legacy-only body is projected onto `guardrail` (mode only) by the service.
 *  `shieldId` is DROPPED here: its values are ids from the removed
 *  `aegis_shields` table, so persisting a fresh one would only re-arm the
 *  "bound to a removed Aegis shield" warning on the server's first tool call. */
export function parseAegis(raw: unknown): { mode: 'off' | 'monitor' | 'enforce' } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { mode?: unknown };
  const mode = value.mode === 'monitor' || value.mode === 'enforce' ? value.mode : 'off';
  return { mode };
}

/**
 * The guardrail binding that replaces `aegis`. Same shape of parse, one real
 * difference: `guardrailKey` is a guardrail KEY (the tenant-scoped slug), not
 * an id, and omitting it is meaningful — it selects the tenant's default tool
 * guardrail rather than leaving the server unguarded.
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
    aegis: parseAegis(body.aegis),
    guardrail: parseGuardrail(body.guardrail),
  };
}
