import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import slugify from 'slugify';
import { createHash, randomUUID } from 'crypto';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import type {
  DatabaseProvider,
  IMcpAegisConfig,
  IMcpAuditLog,
  IMcpAuthConfig,
  IMcpExposureConfig,
  IMcpGuardrailConfig,
  IMcpRequestLog,
  IMcpServer,
  IMcpStdioConfig,
  IMcpTool,
  IMcpToolAnnotations,
  McpLogServerScope,
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
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import {
  authConfigSecretValues,
  DEFAULT_MAX_STRING_CHARS,
  maskSecretValues,
  redactLogPayload,
  redactLogString,
} from '@/lib/services/logRedaction';
import { recordUsageEvent, resolveUsageAttribution } from '@/lib/services/usage/usageEvents';
import { readResponseText, safeFetch } from '@/lib/security/outboundFetch';
import { normalizeApiSpec, type SpecFormatHint } from '@/lib/services/specImport';
import { deleteInstanceAssignment, routeInstanceCall } from '@/lib/core/cluster';
import type { QueuePayload } from '@/lib/core/queue';
import { mcpEntityId } from './mcpEntityId';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';
import { resolveTenantDbName } from '@/lib/services/guardrail/hooks/recordCache';
import { boundClientMeta } from './clientMeta';
import { normalizeMcpInstructions, type McpDiscovery } from './discovery';
import { isMcpToolInputError, McpServerConfigError, McpUnknownToolError, McpUpstreamError } from './errors';
import { responseLogSummaryOf, setResponseLogSummary } from './responseLog';
import { buildOpenApiRequest } from './openApiRequest';
import { specDeclaredParameters } from './openApiSpecParameters';
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
import { remoteCallTool, remoteDiscover, withUpstreamLimits } from './remoteMcpClient';
import {
  CONSOLE_IDENTITY_AUTH_TYPE,
  consoleIdentityHeaders,
  ensureConsoleIdentityKey,
  isConsoleIdentityRefusal,
  type ConsoleIdentityCaller,
} from '@/lib/iam/consoleIdentity';
import { isStdioRunnerEnabled, stdioCallTool, stdioDiscover } from './stdioRunner';
import { mcpSandboxRunner } from '@/enterprise/registry';
import { toGuardrailMode } from '@/lib/services/guardrail/hooks/contract';
import {
  ensureMcpGuardrailHook,
  invalidateMcpGuardrailBinding,
} from '@/lib/services/guardrail/hooks/mcpHook';
import { requireInternalMcpProvider } from './internal/registry';
import {
  allocateExposedNames,
  assertMemberUsable,
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

// ── Guardrail seam registration ───────────────────────────────────────────
// The seam is filled by `ensureMcpGuardrailHook()`, called from
// `executeMcpToolLocal` below — NOT here at module scope. This file is pulled
// into `registry.ts`'s own import phase in the enterprise overlay
// (registry -> plugins/realtime -> ... -> agentService -> mcp/index -> here),
// where `mcpGuardrailHook` does not exist yet, so a module-scope read of the
// ref takes the process down at boot. See `ensureMcpGuardrailHook`'s doc for
// the full chain and for why optional-chaining it is the wrong fix.

export const DEFAULT_MCP_EXPOSURE: IMcpExposureConfig = {
  protocols: ['streamable-http', 'sse'],
  accessMode: 'token',
};

export function resolveSourceType(server: Pick<IMcpServer, 'sourceType'>): McpSourceType {
  return server.sourceType ?? 'openapi';
}

/**
 * A browser reaches whatever address the console can, so a server that drives
 * one is called with a token only: neither the browser server itself nor a
 * composite that includes it can be public.
 */
const BROWSER_PROVIDER_ID = 'browser';
const BROWSER_TOKEN_ONLY_MESSAGE =
  'A browser server is available with an API token only: it cannot be public, and neither can a composite server that includes it.';

/** An internal-source server built on the browser provider. */
export function isBrowserServer(server: Pick<IMcpServer, 'sourceType' | 'metadata'>): boolean {
  if (resolveSourceType(server) !== 'internal') return false;
  const internal = (server.metadata as Record<string, unknown> | undefined)?.internal as { provider?: unknown } | undefined;
  return internal?.provider === BROWSER_PROVIDER_ID;
}

/** A browser server, or a composite with a browser member (members are read from the current tenant database). */
export async function reachesBrowser(
  db: DatabaseProvider,
  server: Pick<IMcpServer, 'sourceType' | 'metadata'>,
): Promise<boolean> {
  if (isBrowserServer(server)) return true;
  if (resolveSourceType(server) !== 'composite') return false;
  for (const member of getCompositeConfig(server).members) {
    const record = await db.findMcpServerById(member.serverId);
    if (record && isBrowserServer(record)) return true;
  }
  return false;
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

// ── Guardrail binding ─────────────────────────────────────────────────────
// A server carries at most one live binding, but two columns can hold it: the
// canonical `guardrail` and the legacy `aegis`, which every row written before
// the hook plane still has. This is the ONE read-time normaliser; nothing else
// may look at `server.aegis`.

/** One WARN per (tenant, server) per process — this runs on every tool call. */
const warnedStaleShields = new Set<string>();

export interface McpGuardrailBinding {
  /** Kept in the MCP vocabulary so it feeds `McpGuardrailContext.mode` directly. */
  mode: 'off' | 'monitor' | 'enforce';
  /** Absent = fall back to the tenant's default tool guardrail. */
  guardrailKey?: string;
}

/**
 * Which guardrail (if any) evaluates this server's tool calls.
 *
 * `guardrail` wins outright when present — an operator who has saved the new
 * field has expressed the current intent, and the legacy column is only still
 * written so a mid-deploy rollback keeps enforcing.
 *
 * ── STALE `aegis.shieldId` IS DROPPED, NOT TRANSLATED ──────────────────────
 * Its values are ids from the removed `aegis_shields` table. There is nothing
 * to translate them into: the shield rows are gone, so the mapping from "this
 * server used shield X" to "this server uses guardrail Y" cannot be recovered
 * at read time. Keeping the id would be worse than dropping it — the hook plane
 * would resolve nothing and the server would silently stop being guarded — so
 * the binding degrades to the tenant's DEFAULT tool guardrail instead.
 *
 * That is a real enforcement change for any server whose shield was not the
 * default: a narrow shield widens to the default policy, a broad one narrows.
 * It is loud on purpose. The fix is to save an explicit `guardrail.guardrailKey`
 * on the server; the warning stops as soon as the new field is present.
 */
export function resolveMcpGuardrailBinding(server: IMcpServer): McpGuardrailBinding {
  // `?? undefined` and `!= null` on purpose. On Mongo/Cosmos an absent binding
  // is persisted as BSON `null` (the driver runs without `ignoreUndefined`),
  // while SQLite maps its NULL to `undefined`; both must read as "no binding".
  // A `!== undefined` test here armed every unbound Cosmos-backed server in
  // 'enforce' — `toGuardrailMode(undefined, true)` is 'enforce'.
  const binding = server.guardrail ?? server.aegis ?? undefined;
  // `toGuardrailMode` folds BOTH vocabularies ('off' and 'disabled') onto the
  // canonical three. `enabled` is "a binding exists at all", which is what
  // preserves the pre-hook-plane default: a server with neither column stays
  // unguarded rather than being armed by an upgrade.
  const mode = toGuardrailMode(binding?.mode, binding != null);

  const guardrailKey = server.guardrail?.guardrailKey;
  if (!guardrailKey && server.aegis?.shieldId && mode !== 'disabled') {
    const warnKey = `${server.tenantId}/${server.key}`;
    if (!warnedStaleShields.has(warnKey)) {
      warnedStaleShields.add(warnKey);
      logger.warn(
        'MCP server is bound to a removed Aegis shield; falling back to the default tool guardrail',
        {
          tenantId: server.tenantId,
          projectId: server.projectId,
          serverKey: server.key,
          serverName: server.name,
          staleShieldId: server.aegis.shieldId,
          mode,
          action: 'Set guardrail.guardrailKey on this server to restore the intended policy.',
        },
      );
    }
  }

  return { mode: mode === 'disabled' ? 'off' : mode, guardrailKey };
}

/** The two binding columns as they are WRITTEN — an absent key is omitted. */
export interface McpGuardrailBindingColumns {
  aegis?: IMcpAegisConfig;
  guardrail?: IMcpGuardrailConfig;
}

/**
 * Two-way projection between the canonical `guardrail` column and the legacy
 * `aegis` column, for the one release in which both are written.
 *
 *   · `guardrail` only → `aegis: { mode }` is written too, so a rollback to a
 *     binary that still reads `server.aegis?.mode` keeps enforcing. Models and
 *     guardrails keep their legacy columns current the same way
 *     (`projectBindingsToLegacy`, `projectHooksToLegacy`); MCP was the one
 *     record that broke the "older binary on the same tenant DB keeps
 *     enforcing" promise.
 *   · `aegis` only (a pre-2.0 SDK client) → `guardrail: { mode }`, so the
 *     legacy write is not silently outranked by a stored `guardrail`. On an
 *     update the stored `guardrailKey` is KEPT: the legacy vocabulary cannot
 *     name one, and a mode change is not a request to fall back to the
 *     default policy.
 *   · Both → written as sent; `guardrail` wins at read time.
 *
 * Keys the caller did not send are OMITTED rather than set to `undefined`: the
 * Mongo driver persists an explicit `undefined` as BSON `null`, which is the
 * shape `resolveMcpGuardrailBinding` then has to defend against. `shieldId` is
 * never projected — its values are dead references and the parsers drop it.
 */
export function projectMcpGuardrailBinding(
  input: McpGuardrailBindingColumns,
  existing?: Pick<IMcpServer, 'guardrail'>,
): McpGuardrailBindingColumns {
  const out: McpGuardrailBindingColumns = {};
  if (input.guardrail !== undefined) {
    out.guardrail = input.guardrail;
  } else if (input.aegis !== undefined) {
    const guardrailKey = existing?.guardrail?.guardrailKey;
    out.guardrail = { mode: input.aegis.mode, ...(guardrailKey ? { guardrailKey } : {}) };
  }
  if (input.aegis !== undefined) {
    out.aegis = input.aegis;
  } else if (input.guardrail !== undefined) {
    out.aegis = { mode: input.guardrail.mode };
  }
  return out;
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

// ── Server instructions ───────────────────────────────────────────────────
// The MCP `instructions` an initialize result carries — how the server's tools
// fit together, which a client may add to the model's system prompt. Same
// metadata-backed pattern: the operator's text (metadata.instructions) wins
// over what the source supplied at discovery (metadata.discoveredInstructions:
// an upstream's initialize result, an internal provider's text, a composite's
// members), which every rediscovery replaces.

export function getMcpInstructionsOverride(server: Pick<IMcpServer, 'metadata'>): string | undefined {
  return normalizeMcpInstructions((server.metadata as Record<string, unknown> | undefined)?.instructions);
}

export function getDiscoveredMcpInstructions(server: Pick<IMcpServer, 'metadata'>): string | undefined {
  return normalizeMcpInstructions(
    (server.metadata as Record<string, unknown> | undefined)?.discoveredInstructions,
  );
}

/** The `instructions` this server's `initialize` result carries, if any. */
export function resolveMcpInstructions(server: Pick<IMcpServer, 'metadata'>): string | undefined {
  return getMcpInstructionsOverride(server) ?? getDiscoveredMcpInstructions(server);
}

/** Set one instructions key in a metadata blob; `null` (or blank text) removes it. */
function metadataWithInstructions(
  metadata: Record<string, unknown> | undefined,
  key: 'instructions' | 'discoveredInstructions',
  value: string | null,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  const text = normalizeMcpInstructions(value);
  if (text) next[key] = text;
  else delete next[key];
  return next;
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
      ...(annotations?.title ? { title: annotations.title } : {}),
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
    instructions: getMcpInstructionsOverride(record),
    discoveredInstructions: getDiscoveredMcpInstructions(record),
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
    instructions: getMcpInstructionsOverride(record),
    discoveredInstructions: getDiscoveredMcpInstructions(record),
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

// The public-MCP route (public-mcp.ts) rejects any slug under 8 chars
// outright (same floor `a2aExposure.ts` uses for agent slugs) — keep this in
// sync with that so a custom path never gets saved just to 404 at call time.
const MIN_ENDPOINT_SLUG_LENGTH = 8;
const MAX_ENDPOINT_SLUG_LENGTH = 80;

function normalizeCustomEndpointSlug(desired: string): string {
  const slug = slugify(desired, SLUG_OPTIONS).substring(0, MAX_ENDPOINT_SLUG_LENGTH);
  if (slug.length < MIN_ENDPOINT_SLUG_LENGTH) {
    throw new Error(
      `Custom path must be at least ${MIN_ENDPOINT_SLUG_LENGTH} characters (letters, numbers, hyphens).`,
    );
  }
  return slug;
}

/**
 * Resolve the path segment a server (or MCP Hub) is addressed by under
 * `/api/public/mcp/:tenantId/:endpointSlug`. Omitting `desired` mints a
 * random unguessable slug, same as before custom paths existed. A
 * caller-supplied `desired` becomes this server's public URL path — unlike
 * `key` it is never silently de-duplicated with a numeric suffix (that would
 * surprise whoever the URL was shared with), so it must be unique or the
 * caller picks a different one. `excludeId` lets a rename check uniqueness
 * without colliding with the record being renamed.
 */
async function resolveEndpointSlug(
  tenantDbName: string,
  desired: string | undefined,
  excludeId?: string,
): Promise<string> {
  if (!desired?.trim()) return generateEndpointSlug();
  const slug = normalizeCustomEndpointSlug(desired);
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const existing = await db.findMcpServerByEndpointSlug(slug);
  if (existing && String(existing._id) !== excludeId) {
    throw new Error(`The path "${slug}" is already used by another MCP server. Choose a different one.`);
  }
  return slug;
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
        ...(operation.summary?.trim() ? { title: operation.summary.trim() } : {}),
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
 * Discover the tool list (and the instructions, where the source reports
 * them) for a server config. For 'stdio' + 'sandbox' the sandbox must already
 * be provisioned (pass the ensured base URL).
 */
async function discoverToolsForServer(server: IMcpServer, identity?: ConsoleIdentityCaller): Promise<McpDiscovery> {
  const sourceType = resolveSourceType(server);

  if (sourceType === 'openapi') {
    if (!server.openApiSpec) throw new Error('Server has no OpenAPI spec');
    return { tools: parseOpenApiSpec(server.openApiSpec).tools };
  }

  if (sourceType === 'remote') {
    if (!server.remoteConfig?.url) throw new Error('Server has no remote MCP URL');
    const identityAuth = await serverConsoleIdentityAuth(server, sourceType, identity);
    return withConsoleIdentityScrubbed(identityAuth, () => remoteDiscover({
      url: server.remoteConfig!.url,
      transport: server.remoteConfig!.transport,
      auth: openAuthConfig(server.upstreamAuth),
      ...(identityAuth ? { extraHeaders: identityAuth.headers } : {}),
    }));
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
    return { tools: built.tools, instructions: built.instructions ?? null };
  }

  // stdio
  const config = server.stdioConfig;
  if (!config?.packageName) throw new Error('Server has no stdio package configured');

  if (config.executionMode === 'sandbox') {
    const { runner, ref, runnerConfig } = await resolveSandboxRunner(server);
    await ensureSandboxInstance(server, runner, ref, runnerConfig);
    // The sandbox bridge reports tools only; instructions stay as they are.
    return { tools: await runner.listTools(ref, runnerConfig) };
  }

  return stdioDiscover(config, { tenantId: server.tenantId });
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
  }
  if (input.upstreamAuth?.type === CONSOLE_IDENTITY_AUTH_TYPE) assertConsoleIdentitySource(sourceType);
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
  hasBrowserMember: boolean;
  /** The active members' instructions, one headed section each; `null` when none has any. */
  instructions: string | null;
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
  const memberInstructions: string[] = [];
  let hasInternalMember = false;
  let hasBrowserMember = false;

  for (const cfg of memberConfigs) {
    const member = await db.findMcpServerById(cfg.serverId);
    assertMemberUsable(self, member, cfg.serverId);
    const m = member!;
    const memberSourceType = resolveSourceType(m);
    if (memberSourceType === 'internal') hasInternalMember = true;
    if (isBrowserServer(m)) hasBrowserMember = true;

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

    const instructions = resolveMcpInstructions(m);
    if (instructions) memberInstructions.push(`## ${m.name}\n${instructions}`);

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

  return {
    tools,
    members,
    memberSummaries,
    hasInternalMember,
    hasBrowserMember,
    instructions: normalizeMcpInstructions(memberInstructions.join('\n\n')) ?? null,
  };
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
      metadata: metadataWithInstructions(
        metadataWithComposite(composite.metadata, { members: [], hasInternalMember: false }, []),
        'discoveredInstructions',
        null,
      ),
    });
  }
  const built = await buildCompositeTools(
    db,
    { id: String(composite._id ?? ''), tenantId: composite.tenantId, projectId: composite.projectId },
    config.members,
    composite.tools,
  );
  forgetLastErrorWrite(composite);
  return db.updateMcpServer(String(composite._id), {
    tools: built.tools,
    toolsDiscoveredAt: new Date(),
    lastError: null,
    metadata: metadataWithInstructions(
      metadataWithComposite(
        composite.metadata,
        { members: built.members, hasInternalMember: built.hasInternalMember },
        built.memberSummaries,
      ),
      'discoveredInstructions',
      built.instructions,
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
      await db.updateMcpServer(String(composite._id), { lastError: lastErrorRecord(composite, message) });
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
  if (input.upstreamAuth?.type === CONSOLE_IDENTITY_AUTH_TYPE) await prepareConsoleIdentityKey(tenantDbName);

  const key = await generateUniqueKey(tenantDbName, projectId, input.key?.trim() || input.name);
  const endpointSlug = await resolveEndpointSlug(tenantDbName, input.endpointSlug);

  let tools: IMcpTool[] = [];
  let discoveredInstructions: string | null | undefined;
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
    // Discovery runs as the person saving the server.
    const identityAuth = await consoleIdentityAuthFor({
      authType: openedAuth.type,
      tenantId,
      tenantDbName,
      projectId,
      audience: input.remoteConfig!.url,
      identity: { userId, source: 'console' },
    });
    ({ tools, instructions: discoveredInstructions } = await withConsoleIdentityScrubbed(identityAuth, () => remoteDiscover({
      url: input.remoteConfig!.url,
      transport: input.remoteConfig!.transport,
      auth: openedAuth,
      ...(identityAuth ? { extraHeaders: identityAuth.headers } : {}),
    })));
  } else if (sourceType === 'stdio' && input.stdioConfig!.executionMode === 'subprocess') {
    // Discover eagerly so the create screen fails fast on a broken package.
    ({ tools, instructions: discoveredInstructions } = await stdioDiscover(input.stdioConfig!, { tenantId }));
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
    if (provider.id === BROWSER_PROVIDER_ID && normalizeExposure(input.exposure).accessMode === 'public') {
      throw new McpServerConfigError(BROWSER_TOKEN_ONLY_MESSAGE);
    }
    const instanceKey = input.internalConfig!.instanceKey;
    const config = input.internalConfig!.config ?? {};
    await provider.validateInstance(ctx, instanceKey, config);
    const built = await provider.buildTools(ctx, instanceKey, config);
    tools = built.tools;
    discoveredInstructions = built.instructions;
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
    if (built.hasBrowserMember && normalizeExposure(input.exposure).accessMode === 'public') {
      throw new McpServerConfigError(BROWSER_TOKEN_ONLY_MESSAGE);
    }
    tools = built.tools;
    discoveredInstructions = built.instructions;
    compositeMetadata = metadataWithComposite(
      undefined,
      { members: built.members, hasInternalMember: built.hasInternalMember },
      built.memberSummaries,
    );
  }

  let metadata: Record<string, unknown> | undefined = internalMetadata ? { internal: internalMetadata } : compositeMetadata;
  if (discoveredInstructions) metadata = metadataWithInstructions(metadata, 'discoveredInstructions', discoveredInstructions);
  if (input.instructions) metadata = metadataWithInstructions(metadata, 'instructions', input.instructions);

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
    // Absent bindings are OMITTED, never `undefined` (BSON null on Mongo), and
    // either column sent is projected onto the other for one release.
    ...projectMcpGuardrailBinding(input),
    status: 'active',
    endpointSlug,
    totalRequests: 0,
    metadata,
    createdBy: userId,
  });

  // Sandbox-backed stdio servers provision after the record exists (the
  // runner needs the server identity); discovery failures are surfaced on
  // the record instead of failing the create.
  if (sourceType === 'stdio' && input.stdioConfig!.executionMode === 'sandbox') {
    try {
      const { tools: discovered } = await discoverToolsForServer({ ...server, stdioConfig });
      await db.switchToTenant(tenantDbName);
      forgetLastErrorWrite(server);
      await db.updateMcpServer(String(server._id), {
        tools: discovered,
        toolsDiscoveredAt: new Date(),
        lastError: null,
      });
      server.tools = discovered;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.updateMcpServer(String(server._id), {
        lastError: lastErrorRecord(server, message),
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
  compare('guardrail', before.guardrail, after.guardrail);
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
    // Lengths only — the text itself can run to thousands of characters.
    const fromInstructions = getMcpInstructionsOverride(before) ?? '';
    const toInstructions = getMcpInstructionsOverride({ metadata: after.metadata }) ?? '';
    if (fromInstructions !== toInstructions) {
      changes.instructions = { from: `${fromInstructions.length} chars`, to: `${toInstructions.length} chars` };
    }
  }
  return changes;
}

/**
 * What an update leaves behind must keep a browser off public URLs: the
 * server itself, a composite through its members, and a server that becomes a
 * browser server while a public composite includes it.
 */
async function assertBrowserStaysTokenOnly(
  db: DatabaseProvider,
  existing: IMcpServer,
  sourceType: McpSourceType,
  updateData: Record<string, unknown>,
): Promise<void> {
  const after = {
    sourceType,
    metadata: (updateData.metadata as IMcpServer['metadata'] | undefined) ?? existing.metadata,
  };
  const exposure = (updateData.exposure as IMcpExposureConfig | undefined) ?? resolveExposure(existing);
  if (exposure.accessMode === 'public' && await reachesBrowser(db, after)) {
    throw new McpServerConfigError(BROWSER_TOKEN_ONLY_MESSAGE);
  }
  if (isBrowserServer(after) && !isBrowserServer(existing)) {
    const id = String(existing._id);
    const publicComposite = (await db.listMcpServers({})).find((server) => resolveSourceType(server) === 'composite'
      && resolveExposure(server).accessMode === 'public'
      && getCompositeConfig(server).members.some((member) => member.serverId === id));
    if (publicComposite) {
      throw new McpServerConfigError(
        `${BROWSER_TOKEN_ONLY_MESSAGE} This server is a member of the public composite server "${publicComposite.name}".`,
      );
    }
  }
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
    if (input.upstreamAuth.type === CONSOLE_IDENTITY_AUTH_TYPE) {
      assertConsoleIdentitySource(resolveSourceType(existing));
      await prepareConsoleIdentityKey(tenantDbName);
    }
    updateData.upstreamAuth = mergeAuthConfigUpdate(existing.upstreamAuth, input.upstreamAuth);
  }
  if (input.exposure !== undefined) updateData.exposure = normalizeExposure(input.exposure);
  if (input.endpointSlug !== undefined) {
    updateData.endpointSlug = await resolveEndpointSlug(tenantDbName, input.endpointSlug, serverId);
  }
  // Either binding column sent → both written (two-way projection, one
  // release); a body that names neither leaves both untouched.
  Object.assign(updateData, projectMcpGuardrailBinding(input, existing));
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
  // `undefined` = the source said nothing about instructions this time.
  let discoveredInstructions: string | null | undefined;
  const sourceType = resolveSourceType(existing);
  if (sourceType === 'remote' && input.remoteConfig !== undefined) {
    const auth = updateData.upstreamAuth
      ? openAuthConfig(updateData.upstreamAuth as IMcpAuthConfig)
      : openAuthConfig(existing.upstreamAuth);
    const remoteConfig = input.remoteConfig;
    // Discovery runs as the person saving the server.
    const identityAuth = await consoleIdentityAuthFor({
      authType: auth.type,
      tenantId: existing.tenantId,
      tenantDbName,
      projectId: existing.projectId,
      audience: remoteConfig.url,
      identity: { userId, source: 'console' },
    });
    const discovered = await withConsoleIdentityScrubbed(identityAuth, () => remoteDiscover({
      url: remoteConfig.url,
      transport: remoteConfig.transport,
      auth,
      ...(identityAuth ? { extraHeaders: identityAuth.headers } : {}),
    }));
    updateData.tools = discovered.tools;
    discoveredInstructions = discovered.instructions;
    updateData.toolsDiscoveredAt = new Date();
  }
  if (sourceType === 'stdio' && input.stdioConfig !== undefined
    && (updateData.stdioConfig as IMcpStdioConfig).executionMode === 'subprocess') {
    const discovered = await stdioDiscover(updateData.stdioConfig as IMcpStdioConfig, { tenantId: existing.tenantId });
    updateData.tools = discovered.tools;
    discoveredInstructions = discovered.instructions;
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
    discoveredInstructions = built.instructions ?? null;
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
    discoveredInstructions = built.instructions;
    updateData.toolsDiscoveredAt = new Date();
    updateData.metadata = metadataWithComposite(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      { members: built.members, hasInternalMember: built.hasInternalMember },
      built.memberSummaries,
    );
  }

  // What the source said about its tools at rediscovery, and the operator's own text.
  if (discoveredInstructions !== undefined) {
    updateData.metadata = metadataWithInstructions(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      'discoveredInstructions',
      discoveredInstructions,
    );
  }
  if (input.instructions !== undefined) {
    updateData.metadata = metadataWithInstructions(
      (updateData.metadata as Record<string, unknown> | undefined) ?? existing.metadata,
      'instructions',
      input.instructions,
    );
  }

  await assertBrowserStaysTokenOnly(db, existing, sourceType, updateData);

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

  // The guardrail bridge caches "which guardrail is this server bound to" for a
  // minute, keyed by server KEY — so a rebinding (or a rename that moves the
  // binding to a new key) would otherwise keep evaluating against the previous
  // guardrail for up to that long. Both old and new keys are dropped because a
  // rename leaves an entry nothing will ever look up again.
  if (updated && (input.guardrail !== undefined || updateData.key !== undefined)) {
    invalidateMcpGuardrailBinding(tenantDbName, existing.key);
    if (updated.key !== existing.key) invalidateMcpGuardrailBinding(tenantDbName, updated.key);
  }

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
      const { tools, instructions } = await discoverToolsForServer(server, { userId, source: 'console' });
      forgetLastErrorWrite(server);
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
      if (instructions !== undefined) {
        refreshUpdate.metadata = metadataWithInstructions(
          refreshUpdate.metadata ?? server.metadata,
          'discoveredInstructions',
          instructions,
        );
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
    await db.updateMcpServer(serverId, { lastError: lastErrorRecord(server, message) });
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
    // Drop the node-pinning cache entry, keyed by tenantId+key: without this,
    // a server recreated under the same name would silently inherit the
    // deleted server's cluster placement (including a stale "strictly
    // assigned to an offline node" error).
    void deleteInstanceAssignment('mcp', mcpEntityId(existing.tenantId, existing.key))
      .catch((error) => logger.warn('Failed to clear MCP instance assignment', { serverId, error }));

    // Same reasoning one level down: the guardrail binding cache is keyed by
    // server key, so a recreated server would inherit the deleted one's
    // guardrail until the entry expired.
    invalidateMcpGuardrailBinding(tenantDbName, existing.key);

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
  projectId?: string | null,
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
 * Scope a request-log query to `server`. `serverId` is the durable match;
 * the rest only extend it to rows written before `serverId` existed, capped
 * at this server's own `createdAt` so a deleted-and-recreated server (which
 * regenerates the same name-derived `key`) can't pull in its predecessor's
 * history.
 */
function mcpLogScope(server: IMcpServer): McpLogServerScope {
  return {
    serverId: String(server._id),
    serverKey: server.key,
    projectId: server.projectId,
    createdAt: server.createdAt,
  };
}

/** Values of the server's static upstream credential, opened from the vault. */
function upstreamCredentialValues(server: IMcpServer): string[] {
  try {
    return authConfigSecretValues(openAuthConfig(server.upstreamAuth));
  } catch {
    return [];
  }
}

/** The password and the query-string values of a URL that may carry a credential. */
function urlSecretValues(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const url = new URL(raw);
    const out: string[] = [];
    if (url.password) out.push(url.password, decodeURIComponent(url.password));
    url.searchParams.forEach((value) => out.push(value));
    return out;
  } catch {
    return [];
  }
}

/**
 * Outbound secret values that could be echoed back in a response or an error
 * for this server: the caller's applied runtime-header values, the server's own
 * static upstream credential (opened from the vault), its stdio environment
 * values, and any credential embedded in its upstream URL. Passed to
 * `logMcpRequest` so an echoing upstream can't leak them into the log, and used
 * by the executors to mask them in the errors they throw.
 */
export function mcpRequestSecretValues(
  server: IMcpServer,
  runtimeHeaders?: Record<string, string>,
): string[] {
  const out: string[] = [
    ...Object.values(runtimeHeaders ?? {}),
    ...upstreamCredentialValues(server),
  ];
  if (server.stdioConfig) {
    try {
      out.push(...Object.values(openStdioEnv(server.stdioConfig)));
    } catch {
      // An unreadable env map has no values to mask.
    }
  }
  out.push(...urlSecretValues(server.remoteConfig?.url), ...urlSecretValues(server.upstreamBaseUrl));
  return out.filter((value): value is string => typeof value === 'string');
}

// ── lastError ──────────────────────────────────────────────────────────────
// `server.lastError` is shown to every `mcp:read` user and drives the monitor's
// "degraded" state, so what is written there is masked and bounded, and a
// failure that repeats is not written on every call.

/** `${tenantId}\0${serverId}` → a digest of the message last written, and when. */
const lastErrorWrites = new Map<string, { digest: string; at: number }>();
const MAX_TRACKED_LAST_ERRORS = 5_000;

function lastErrorKey(server: Pick<IMcpServer, 'tenantId' | '_id'>): string {
  return `${server.tenantId}\0${String(server._id ?? '')}`;
}

/**
 * The `lastError` value for a record: secret values masked, length bounded.
 * `secretValues` defaults to everything the server holds; a caller that has
 * already collected them passes them in.
 */
function lastErrorRecord(
  server: IMcpServer,
  message: string,
  secretValues: string[] = mcpRequestSecretValues(server),
): { message: string; at: Date } {
  return {
    message: maskSecretValues(message, secretValues, { maxChars: getConfig().mcp.lastErrorMaxChars }),
    at: new Date(),
  };
}

/** Call wherever `lastError` is cleared, so the same failure is recorded again afterwards. */
function forgetLastErrorWrite(server: Pick<IMcpServer, 'tenantId' | '_id'>): void {
  lastErrorWrites.delete(lastErrorKey(server));
}

/** True (and remembers it) unless this exact message was written within the throttle window. */
function claimLastErrorWrite(server: IMcpServer, message: string): boolean {
  const windowMs = getConfig().mcp.lastErrorThrottleMs;
  const now = Date.now();
  const key = lastErrorKey(server);
  const digest = createHash('sha256').update(message).digest('base64');
  const previous = lastErrorWrites.get(key);
  if (windowMs > 0 && previous && previous.digest === digest && now - previous.at < windowMs) {
    return false;
  }
  lastErrorWrites.set(key, { digest, at: now });
  if (lastErrorWrites.size > MAX_TRACKED_LAST_ERRORS) {
    for (const [trackedKey, entry] of lastErrorWrites) {
      if (now - entry.at >= windowMs) lastErrorWrites.delete(trackedKey);
    }
    // Still over the bound (a burst inside one window): drop the oldest tenth.
    if (lastErrorWrites.size > MAX_TRACKED_LAST_ERRORS) {
      let excess = Math.ceil(lastErrorWrites.size / 10);
      for (const trackedKey of lastErrorWrites.keys()) {
        if (excess-- <= 0) break;
        lastErrorWrites.delete(trackedKey);
      }
    }
  }
  return true;
}

// ── Request-log inputs ────────────────────────────────────────────────────

/**
 * The session ids this gateway issues (`randomUUID()` when an SSE stream is
 * opened). Anything else in a `?sessionId=` query string was not issued here.
 */
const SERVER_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isServerIssuedSessionId(value: unknown): value is string {
  return typeof value === 'string' && SERVER_SESSION_ID_PATTERN.test(value);
}

/** Caller-supplied attribution for a request-log row. */
export interface McpRequestClientInfo {
  ip?: string;
  userAgent?: string;
  /**
   * The JSON-RPC `params._meta` the host sent with the call, exactly as
   * received. Bounded and scrubbed here (see `withClientInfo`), not by the
   * caller, so every endpoint gets the same treatment.
   */
  meta?: unknown;
}

/** An IP address in text form (IPv6 with a zone id included) is well inside this. */
const CLIENT_IP_MAX_CHARS = 64;

function cleanClientField(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxChars);
  return cleaned || undefined;
}

/**
 * The log row has no column for the caller's network identity (adding one
 * would need a schema change on both databases), so it rides next to the tool
 * and arguments in the request payload under `_client` — the same convention
 * as `_runtimeAuth`. The host's `_meta` rides there too, as `_client.meta`:
 * bounded first, then through the same scrub as the rest of the payload so a
 * sensitive key name or an echoed secret is masked here as well.
 */
function withClientInfo(
  payload: Record<string, unknown> | undefined,
  client: McpRequestClientInfo | undefined,
  secretValues?: string[],
): Record<string, unknown> | undefined {
  const config = getConfig().mcp;
  const ip = cleanClientField(client?.ip, CLIENT_IP_MAX_CHARS);
  const userAgent = cleanClientField(client?.userAgent, config.logUserAgentMaxChars);
  // The scrub runs inside the bound so the byte limit is judged on what is stored.
  const meta = config.logClientMeta
    ? boundClientMeta(client?.meta, {
        maxBytes: config.logClientMetaMaxBytes,
        scrub: (bounded) => redactLogPayload(bounded, { secretValues }),
      })
    : undefined;
  if (!ip && !userAgent && !meta) return payload;
  return {
    ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}),
    _client: {
      ...(ip ? { ip } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(meta ? { meta } : {}),
    },
  };
}

function boundedLogToolName(toolName: unknown): string {
  return String(toolName ?? '').slice(0, getConfig().mcp.logToolNameMaxChars);
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
    /**
     * Cap for each persisted request/response payload, in the unit
     * `DEFAULT_MAX_PAYLOAD_BYTES` uses. Absent = that default. A surface that
     * accepts calls from anyone passes a smaller one.
     */
    payloadLimitBytes?: number;
    /** Who made the call; stored with the request payload as `_client`. */
    client?: McpRequestClientInfo;
  },
): Promise<string | undefined> {
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
  const toolName = boundedLogToolName(entry.toolName);
  try {
    const maxBytes = typeof opts?.payloadLimitBytes === 'number' && opts.payloadLimitBytes > 0
      ? opts.payloadLimitBytes
      : undefined;
    const row: Omit<IMcpRequestLog, '_id' | 'createdAt'> = {
      ...entry,
      // The name comes from the caller's request: bound it.
      toolName,
      // Scrub echoed secrets / sensitive keys and cap size before persisting
      // (redactLogPayload passes undefined through).
      requestPayload: withClientInfo(
        redactLogPayload(entry.requestPayload, { secretValues, maxBytes }),
        opts?.client,
        secretValues,
      ),
      // A result its provider marked is logged as the summary it left (see responseLog.ts).
      responsePayload: redactLogPayload(
        responseLogSummaryOf(entry.responsePayload) ?? entry.responsePayload,
        { secretValues, maxBytes },
      ),
      errorMessage: redactLogString(
        entry.errorMessage,
        secretValues,
        maxBytes === undefined ? DEFAULT_MAX_STRING_CHARS : Math.min(DEFAULT_MAX_STRING_CHARS, maxBytes),
      ),
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
    };
    // Also from the caller's request: keep a session id only when this
    // gateway issued it.
    if (!isServerIssuedSessionId(entry.sessionId)) delete row.sessionId;
    // A real tenant scope for the write: callers such as the public endpoints
    // log after their own scope has ended.
    const created = await runWithTenantScope(tenantDbName, (db) => db.createMcpRequestLog(row));
    // The id a caller can quote to the operator to have the call looked up.
    return created?._id ? String(created._id) : undefined;
  } catch (err) {
    logger.error('Failed to log MCP request', {
      serverKey: entry.serverKey,
      toolName,
      error: err,
    });
    return undefined;
  }
}

export async function listMcpRequestLogs(
  tenantDbName: string,
  server: IMcpServer,
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
  return db.listMcpRequestLogs(mcpLogScope(server), options);
}

export async function countMcpRequestLogs(
  tenantDbName: string,
  server: IMcpServer,
  options?: { from?: Date; to?: Date; status?: string; keyword?: string },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.countMcpRequestLogs(mcpLogScope(server), options);
}

export async function aggregateMcpRequestLogs(
  tenantDbName: string,
  server: IMcpServer,
  options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.aggregateMcpRequestLogs(mcpLogScope(server), options);
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
    const aggregate = await db.aggregateMcpRequestLogs(mcpLogScope(server), { from, groupBy: 'hour' });

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

/**
 * Records one health observation for an MCP server call. The tenant database
 * name is not in the request context and a routed call may start on a node
 * without one, so it is resolved from the server's tenant (cached). Never
 * throws and is never awaited by the caller.
 */
function recordMcpServerMetric(
  server: IMcpServer,
  outcome: 'ok' | 'error',
  latencyMs: number,
): void {
  void (async () => {
    try {
      const tenantDbName = await resolveTenantDbName(server.tenantId);
      if (!tenantDbName) return;
      recordEntityMetric({
        tenantDbName,
        tenantId: server.tenantId,
        projectId: server.projectId,
        entityType: 'mcp',
        entityKey: server.key,
        source: 'service',
        outcome,
        latencyMs,
      });
    } catch (error) {
      logger.debug('MCP health metric skipped', { error });
    }
  })();
}

/**
 * A disabled tool, a guardrail enforce-mode block and a Console identity
 * refusal (nobody to mint a token for) are policy outcomes, not server faults. They are told apart by message (the same text a routed call
 * carries back from another node) and kept out of the health rollup so they
 * cannot raise the server's error rate.
 */
function isMcpPolicyOutcome(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return isConsoleIdentityRefusal(error)
    || /^Tool ".*" is disabled on MCP server /.test(message)
    || message.startsWith('Blocked by Aegis shield')
    || message.startsWith('Response blocked by Aegis shield');
}

/** What a tool call returns; plain data, so it also comes back from another node. */
export interface McpToolOutcome {
  result: unknown;
  latencyMs: number;
  /** Set when the request log keeps this summary of `result` instead of the result (see responseLog.ts). */
  logSummary?: Record<string, unknown>;
}

/**
 * What a cross-node `invoke` job carries: which server to run (the worker
 * loads the record itself), and the call. The server record — with its sealed
 * credentials and stdio config — never travels through the queue.
 */
export interface McpInvokeJob {
  tenantId: string;
  serverId: string;
  serverKey: string;
  toolName: string;
  args: Record<string, unknown>;
  runtimeHeaders?: Record<string, string>;
  /** Who the call is for (plain data, no token): the executing node mints the upstream token itself. */
  identity?: ConsoleIdentityCaller;
}

/**
 * The single choke point for MCP tool execution (dashboard playground, client
 * API, public MCP and agents all come through here), so health is recorded
 * here and nowhere else: not in `logMcpRequest` (composite member rows would
 * double count) and not in `executeMcpToolLocal` (a routed call would be
 * counted on both nodes). A composite call is counted once under the
 * composite's key and its member hop once under the member's key, so
 * tenant-wide MCP totals include member hops. Policy outcomes (disabled tool,
 * guardrail block) are not recorded.
 */
export async function executeMcpTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  runtimeHeaders?: Record<string, string>,
  /**
   * Who the call is for: a server set up for Console identity refuses a call without a person,
   * and a knowledge base with access control answers with what that person may read.
   */
  identity?: ConsoleIdentityCaller,
): Promise<McpToolOutcome> {
  // Refuse before queuing a remote call and before a failure row is logged.
  await assertServiceEnabled({ tenantId: server.tenantId }, 'mcp');
  const startedAt = Date.now();
  try {
    let outcome: McpToolOutcome;
    if (server._id === undefined || server._id === null) {
      outcome = await executeMcpToolLocal(server, toolName, args, runtimeHeaders, identity);
    } else {
      const job: McpInvokeJob = {
        tenantId: server.tenantId,
        serverId: String(server._id),
        serverKey: server.key,
        toolName,
        args,
        runtimeHeaders,
        ...(identity ? { identity } : {}),
      };
      outcome = await routeInstanceCall(
        {
          entityType: 'mcp',
          entityId: mcpEntityId(server.tenantId, server.key),
          jobName: 'invoke',
        },
        job as unknown as QueuePayload,
        () => executeMcpToolLocal(server, toolName, args, runtimeHeaders, identity),
      );
    }
    // The object the caller logs: a result that came back from another node is a new one.
    if (outcome.logSummary) setResponseLogSummary(outcome.result, outcome.logSummary);
    recordMcpServerMetric(server, 'ok', Date.now() - startedAt);
    return outcome;
  } catch (error) {
    if (!isMcpPolicyOutcome(error)) {
      recordMcpServerMetric(server, 'error', Date.now() - startedAt);
    }
    throw error;
  }
}

/**
 * Mask secret values in an error an executor is about to throw, in place (the
 * class and any structured fields survive), and bound its length. The text of
 * an upstream failure — a response body, a stderr tail, a remote client error —
 * is not ours to vouch for, and it travels to whoever made the call.
 */
function sanitizeExecutionError(error: unknown, secretValues: string[]): Error {
  const original = error instanceof Error
    ? error
    : new Error(typeof error === 'string' ? error : 'Tool execution failed');
  const originalMessage = original.message;
  const message = maskSecretValues(originalMessage, secretValues, {
    maxChars: getConfig().mcp.errorMessageMaxChars,
  });
  if (message === originalMessage) return original;
  try {
    const stack = original.stack;
    original.message = message;
    if (typeof stack === 'string') {
      // The stack opens with the message text: swap in the safe one, keep the frames.
      const at = stack.indexOf(originalMessage);
      original.stack = maskSecretValues(
        at >= 0 ? `${stack.slice(0, at)}${message}${stack.slice(at + originalMessage.length)}` : stack,
        secretValues,
      );
    }
    return original;
  } catch {
    // A frozen error cannot be edited: hand back a copy that carries the safe text.
    const copy = new Error(message);
    copy.name = original.name;
    return copy;
  }
}

// ── Console identity (lib/iam/consoleIdentity.ts) ─────────────────────────

/** Remote MCP and OpenAPI servers are the sources with an upstream to send a Console identity token to. */
function assertConsoleIdentitySource(sourceType: McpSourceType): void {
  if (sourceType !== 'remote' && sourceType !== 'openapi') {
    throw new McpServerConfigError('Console identity is available for remote MCP and OpenAPI servers only');
  }
}

/** Create the workspace's signing key when an administrator turns Console identity on, so its key set is published. */
async function prepareConsoleIdentityKey(tenantDbName: string): Promise<void> {
  try {
    await ensureConsoleIdentityKey(tenantDbName);
  } catch (error) {
    // The first call creates it otherwise.
    logger.warn('Could not prepare the Console identity signing key', { error });
  }
}

/** The audience of a server's tokens: the remote MCP endpoint, or an OpenAPI server's base URL (one per server, not per operation). */
function consoleIdentityAudienceOf(server: IMcpServer, sourceType: McpSourceType): string | undefined {
  if (sourceType === 'remote') return server.remoteConfig?.url;
  if (sourceType === 'openapi') return server.upstreamBaseUrl;
  return undefined;
}

interface ConsoleIdentityAuth {
  headers: Record<string, string>;
  token: string;
}

/**
 * The Console identity header of a call, when the upstream is set up for it (`authType` is
 * `console_identity`); `undefined` otherwise. Throws `ConsoleIdentityError` when no token can be
 * minted, so such an upstream never receives a call without one.
 */
async function consoleIdentityAuthFor(input: {
  authType: string | undefined;
  tenantId: string;
  tenantDbName?: string;
  projectId?: string;
  audience: string | undefined;
  identity: ConsoleIdentityCaller | undefined;
}): Promise<ConsoleIdentityAuth | undefined> {
  if (input.authType !== CONSOLE_IDENTITY_AUTH_TYPE || input.audience === undefined) return undefined;
  const { headers, token } = await consoleIdentityHeaders({
    tenantId: input.tenantId,
    tenantDbName: input.tenantDbName,
    audience: input.audience,
    caller: input.identity
      ? { ...input.identity, projectId: input.identity.projectId ?? input.projectId }
      : undefined,
  });
  return { headers, token };
}

function serverConsoleIdentityAuth(
  server: IMcpServer,
  sourceType: McpSourceType,
  identity: ConsoleIdentityCaller | undefined,
): Promise<ConsoleIdentityAuth | undefined> {
  return consoleIdentityAuthFor({
    authType: server.upstreamAuth?.type,
    tenantId: server.tenantId,
    projectId: server.projectId,
    audience: consoleIdentityAudienceOf(server, sourceType),
    identity,
  });
}

/** Runtime headers with the identity header laid over them: no case variant of its name survives. */
function withConsoleIdentityHeader(
  runtimeHeaders: Record<string, string> | undefined,
  identityHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!identityHeaders) return runtimeHeaders;
  const replaced = new Set(Object.keys(identityHeaders).map((name) => name.toLowerCase()));
  const kept = Object.entries(runtimeHeaders ?? {}).filter(([name]) => !replaced.has(name.toLowerCase()));
  return { ...Object.fromEntries(kept), ...identityHeaders };
}

/** Run an upstream request; the identity token is masked in whatever it throws (an upstream may echo it). */
async function withConsoleIdentityScrubbed<T>(
  identityAuth: ConsoleIdentityAuth | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw identityAuth ? sanitizeExecutionError(error, [identityAuth.token]) : error;
  }
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
  /**
   * Who the call is for: a remote / OpenAPI server set up for Console identity gets a token for them,
   * and an internal provider (a knowledge base with access control) is told who is asking.
   */
  identity?: ConsoleIdentityCaller,
): Promise<McpToolOutcome> {
  await assertServiceEnabled({ tenantId: server.tenantId }, 'mcp');
  const sourceType = resolveSourceType(server);
  const start = Date.now();
  // A caller may address the tool by its renamed (exposed) name — resolve
  // back to the real, stored name once, up front, so every downstream check
  // and dispatch below operates on the tool's actual identity.
  const realToolName = resolveMcpToolName(server, toolName);

  // A call may only target a tool the server advertises: the stored tool list
  // is exactly what `tools/list` is built from (minus disabled tools, with
  // renames applied), for every source type. A name the upstream happens to
  // serve but the operator never listed is not callable through this server.
  // Checked before anything else runs — guardrail, sandbox, upstream.
  if (!(server.tools ?? []).some((tool) => tool.name === realToolName)) {
    throw new McpUnknownToolError();
  }

  if (!isMcpToolEnabled(server, realToolName)) {
    throw new Error(`Tool "${toolName}" is disabled on MCP server "${server.name}"`);
  }

  // Console identity: a token for the person behind this call, minted for this upstream. Refused
  // (nobody behind the call, an unknown or disabled account) before anything else runs.
  const identityAuth = await serverConsoleIdentityAuth(server, sourceType, identity);
  const upstreamHeaders = withConsoleIdentityHeader(runtimeHeaders, identityAuth?.headers);
  const identitySecrets = identityAuth ? [identityAuth.token] : [];

  // Guardrail `tool.pre` hook. `ensureMcpGuardrailHook()` fills the seam with
  // the community bridge on first call (an overlay that claimed it first
  // wins), so this is live in every build — and resolving it HERE rather than
  // at module load is what keeps this file importable from inside
  // `registry.ts`'s import phase.
  const guardrail = ensureMcpGuardrailHook();
  const { mode: guardrailMode, guardrailKey } = resolveMcpGuardrailBinding(server);
  // ONE context object for both hooks: the bridge keys its per-call trace id on
  // this object's identity, so splitting it would split the two evaluation-log
  // rows of a single tool call.
  const guardCtx = {
    tenantId: server.tenantId,
    projectId: server.projectId,
    serverKey: server.key,
    toolName: realToolName,
    guardrailKey,
    mode: guardrailMode,
  };
  let effectiveArgs = args;
  if (guardrailMode !== 'off') {
    const verdict = await guardrail.beforeToolCall(guardCtx, args);
    if (!verdict.allowed && guardrailMode === 'enforce') {
      // TODO(v1.3.0): rename to `Blocked by guardrail` once the operator
      // runbooks and log greps that match this exact sentence have been
      // updated. Both strings below are load-bearing OUTSIDE this repo — do
      // not "clean them up" with the rest of the Aegis removal.
      throw new Error(`Blocked by Aegis shield${verdict.reason ? `: ${verdict.reason}` : ''}`);
    }
    if (verdict.args) effectiveArgs = verdict.args;
  }

  let result: unknown;
  let logSummary: Record<string, unknown> | undefined;
  try {
    if (sourceType === 'openapi') {
      result = await executeOpenApiTool(server, realToolName, effectiveArgs, upstreamHeaders);
    } else if (sourceType === 'remote') {
      result = await remoteCallTool(
        {
          url: server.remoteConfig!.url,
          transport: server.remoteConfig!.transport,
          auth: openAuthConfig(server.upstreamAuth),
          extraHeaders: upstreamHeaders,
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
        {
          tenantDbName: tenant.dbName,
          tenantId: server.tenantId,
          projectId: server.projectId,
          serverKey: server.key,
          ...(identity ? { identity } : {}),
        },
        internal.instanceKey,
        internal.config ?? {},
        realToolName,
        effectiveArgs,
      );
    } else if (sourceType === 'composite') {
      result = await executeCompositeTool(server, realToolName, effectiveArgs, runtimeHeaders, identity);
    } else if (server.stdioConfig?.executionMode === 'sandbox') {
      const { runner, ref, runnerConfig } = await resolveSandboxRunner(server);
      await ensureSandboxInstance(server, runner, ref, runnerConfig);
      result = await runner.callTool(ref, runnerConfig, realToolName, effectiveArgs);
    } else {
      result = await stdioCallTool(server.stdioConfig!, realToolName, effectiveArgs, { tenantId: server.tenantId });
    }
    // Read before the masking below, which may hand back a copy; a composite's
    // result carries its member's mark.
    logSummary = responseLogSummaryOf(result);
    // The server's own upstream credential (and the identity token minted for
    // it) is never legitimate output: mask it here, before the result reaches
    // the guardrail, the caller or the log.
    result = maskSecretValues(result, [...upstreamCredentialValues(server), ...identitySecrets]);
  } catch (error) {
    const secretValues = [...mcpRequestSecretValues(server, upstreamHeaders), ...identitySecrets];
    const safeError = sanitizeExecutionError(error, secretValues);
    // A call the caller got wrong says nothing about the server's health.
    // Anything else is persisted on the record so the monitor can surface it.
    if (!isMcpToolInputError(safeError)) void markServerError(server, safeError.message, secretValues);
    throw safeError;
  }

  // Guardrail `tool.post` hook.
  if (guardrailMode !== 'off') {
    const verdict = await guardrail.afterToolCall(guardCtx, result);
    if (!verdict.allowed && guardrailMode === 'enforce') {
      // TODO(v1.3.0): see the `tool.pre` throw above — same runbook contract.
      throw new Error(`Response blocked by Aegis shield${verdict.reason ? `: ${verdict.reason}` : ''}`);
    }
    if (verdict.result !== undefined) result = verdict.result;
  }

  return { result, latencyMs: Date.now() - start, ...(logSummary ? { logSummary } : {}) };
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
  identity: ConsoleIdentityCaller | undefined,
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

  // The member's log row is scrubbed with the MEMBER's secrets: its credential
  // and its runtime headers are what its upstream can echo.
  const memberSecrets = mcpRequestSecretValues(m, runtimeHeaders);

  try {
    // A member set up for Console identity mints its own token, for its own URL.
    const { result } = await executeMcpTool(m, tool.origin.realName, args, runtimeHeaders, identity);
    if (tenantDbName) {
      void logMcpRequest(tenantDbName, {
        tenantId: m.tenantId,
        projectId: m.projectId,
        serverId: String(m._id),
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
      }, memberSecrets, { skipUsageEvent: true });
    }
    return result;
  } catch (error) {
    if (tenantDbName) {
      const message = error instanceof Error ? error.message : 'Execution failed';
      void logMcpRequest(tenantDbName, {
        tenantId: m.tenantId,
        projectId: m.projectId,
        serverId: String(m._id),
        serverKey: m.key,
        toolName: tool.origin.realName,
        status: 'error',
        latencyMs: Date.now() - start,
        requestPayload: { tool: tool.origin.realName, arguments: args },
        errorMessage: message,
        viaServerKey: server.key,
        transport: 'internal',
        sourceType: resolveSourceType(m),
      }, memberSecrets, { skipUsageEvent: true });
    }
    throw error;
  }
}

async function markServerError(
  server: IMcpServer,
  message: string,
  secretValues?: string[],
): Promise<void> {
  try {
    if (!server._id) return;
    const record = lastErrorRecord(server, message, secretValues);
    // The same failure on every call is one write, not one per call.
    if (!claimLastErrorWrite(server, record.message)) return;
    const db = await getDatabase();
    // The caller already bound the tenant context for this request.
    await db.updateMcpServer(String(server._id), { lastError: record });
  } catch {
    // Best-effort only.
  }
}

/** Exported for the response-limit tests; callers go through `executeMcpTool`. */
export async function executeOpenApiTool(
  server: IMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  runtimeHeaders?: Record<string, string>,
): Promise<unknown> {
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new McpUnknownToolError();
  }
  if (!tool.httpPath || !tool.httpMethod) {
    throw new Error(`Tool "${toolName}" has no HTTP mapping`);
  }

  // Path parameters are filled in the tool's path template only, from the
  // arguments the tool declares; see `buildOpenApiRequest` for the rules.
  const request = buildOpenApiRequest({
    baseUrl: server.upstreamBaseUrl,
    httpPath: tool.httpPath,
    inputSchema: tool.inputSchema,
    declaredNames: specDeclaredParameters(server, tool),
    args,
  });

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

  if (request.body && ['POST', 'PUT', 'PATCH'].includes(tool.httpMethod)) {
    fetchOptions.body = JSON.stringify(request.body);
  }

  // The configured auth header and the runtime headers hold credentials meant
  // for this upstream; they do not follow a redirect to another origin.
  return withUpstreamLimits(async ({ signal, maxBytes }) => {
    const response = await safeFetch(request.url, { ...fetchOptions, signal }, {
      keepAbortLinked: true,
      sensitiveHeaders: [
        ...(auth?.type === 'header' && auth.headerName ? [auth.headerName] : []),
        ...Object.keys(runtimeHeaders ?? {}),
      ],
    });

    if (!response.ok) {
      const errorText = await readResponseText(response, { maxBytes: Math.min(maxBytes, 64 * 1024), signal })
        .catch(() => 'Unknown error');
      throw new McpUpstreamError(`Upstream API error (${response.status}): ${errorText}`, response.status);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await readResponseText(response, { maxBytes, signal });
    if (contentType.includes('application/json')) {
      return JSON.parse(text);
    }
    return text;
  });
}
