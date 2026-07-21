/**
 * Runtime invocation context — caller-supplied auth/data that travels with a
 * single external invocation (Responses API, realtime session, A2A message,
 * direct MCP call) into downstream tool / MCP / connected-agent HTTP calls.
 *
 * Security model:
 * - Header passthrough is OPT-IN per target record (`metadata.runtimeHeaders`
 *   on tools and MCP servers, `connection.runtimeHeaders` on connected
 *   agents). Default is deny: with no policy configured, caller headers are
 *   silently dropped for that target.
 * - Hop-by-hop and host-controlling headers are always stripped, regardless
 *   of policy.
 * - Header VALUES must never be logged or persisted. Log surfaces receive
 *   header names only (see `describeRuntimeAuth`).
 * - `userId` / `tokenId` / `source` are stamped by the server from the
 *   authenticated context; values sent by callers are ignored by
 *   `parseRuntimeContext`.
 */

export interface RuntimeConnectionOverride {
  headers?: Record<string, string>;
}

export interface AgentRuntimeContext {
  /** Headers offered to every outbound target (still subject to per-target policy). */
  headers?: Record<string, string>;
  /**
   * Per-target overrides. Keys are either a bare record key or a
   * kind-prefixed key: `tool:<key>`, `mcp:<key>`, `agent:<key>`.
   * Target-scoped headers win over the global `headers` map.
   */
  connections?: Record<string, RuntimeConnectionOverride>;
  /** Free-form caller metadata (surfaced to logs/traces, never to prompts yet). */
  metadata?: Record<string, unknown>;
  /** Stamped by the server from the authenticated caller — not client-writable. */
  userId?: string;
  tokenId?: string;
  source?: 'api' | 'realtime' | 'a2a' | 'mcp' | 'playground';
}

/** Per-record passthrough policy (stored on the target record). */
export interface RuntimeHeaderPolicy {
  allow?: boolean;
  /** When set (non-empty), only these header names pass (case-insensitive). */
  allowedNames?: string[];
}

export type RuntimeTargetKind = 'tool' | 'mcp' | 'agent';

/** Headers that never pass through, regardless of policy. */
const HEADER_BLOCKLIST = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'expect',
  'accept-encoding',
]);

const MAX_HEADERS = 24;
const MAX_NAME_LENGTH = 128;
const MAX_VALUE_LENGTH = 4096;
const MAX_CONNECTIONS = 32;
const MAX_METADATA_JSON = 8192;

/** Prefix for offering runtime headers via plain HTTP request headers. */
export const RUNTIME_HEADER_HTTP_PREFIX = 'x-cpr-hdr-';

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/;

function sanitizeHeaderMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const trimmed = name.trim();
    if (
      !trimmed
      || trimmed.length > MAX_NAME_LENGTH
      || value.length > MAX_VALUE_LENGTH
      || !HEADER_NAME_RE.test(trimmed)
      || HEADER_BLOCKLIST.has(trimmed.toLowerCase())
      // CR/LF in values enables header injection on naive upstreams.
      || /[\r\n]/.test(value)
    ) {
      continue;
    }
    out[trimmed] = value;
    count += 1;
    if (count >= MAX_HEADERS) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate and sanitize a caller-supplied runtime context (from a request
 * body field or a `session.update` patch). Returns undefined when nothing
 * usable was supplied. Server-stamped fields are intentionally NOT read here.
 */
export function parseRuntimeContext(raw: unknown): AgentRuntimeContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const ctx: AgentRuntimeContext = {};

  const headers = sanitizeHeaderMap(input.headers);
  if (headers) ctx.headers = headers;

  if (input.connections && typeof input.connections === 'object' && !Array.isArray(input.connections)) {
    const connections: Record<string, RuntimeConnectionOverride> = {};
    let count = 0;
    for (const [key, value] of Object.entries(input.connections as Record<string, unknown>)) {
      if (!key || key.length > 200 || !value || typeof value !== 'object') continue;
      const connHeaders = sanitizeHeaderMap((value as Record<string, unknown>).headers);
      if (!connHeaders) continue;
      connections[key] = { headers: connHeaders };
      count += 1;
      if (count >= MAX_CONNECTIONS) break;
    }
    if (Object.keys(connections).length > 0) ctx.connections = connections;
  }

  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    try {
      const json = JSON.stringify(input.metadata);
      if (json.length <= MAX_METADATA_JSON) {
        ctx.metadata = input.metadata as Record<string, unknown>;
      }
    } catch {
      // Non-serializable metadata is dropped.
    }
  }

  return ctx.headers || ctx.connections || ctx.metadata ? ctx : undefined;
}

/**
 * Collect runtime headers offered as plain HTTP request headers using the
 * `X-Cpr-Hdr-<Name>: <value>` convention (for callers that can only set
 * extra headers, e.g. off-the-shelf OpenAI clients and WS upgrade requests).
 */
export function collectRuntimeHeadersFromHttpHeaders(
  httpHeaders: Record<string, string | string[] | undefined>,
): Record<string, string> | undefined {
  const offered: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(httpHeaders)) {
    const lower = name.toLowerCase();
    if (!lower.startsWith(RUNTIME_HEADER_HTTP_PREFIX)) continue;
    const target = lower.slice(RUNTIME_HEADER_HTTP_PREFIX.length);
    if (!target) continue;
    offered[target] = Array.isArray(value) ? value[0] : value;
  }
  return sanitizeHeaderMap(offered);
}

/** Merge an HTTP-header offering and a body/context offering into one context. */
export function mergeRuntimeContext(
  base: AgentRuntimeContext | undefined,
  headerOffering: Record<string, string> | undefined,
): AgentRuntimeContext | undefined {
  if (!headerOffering) return base;
  return {
    ...(base ?? {}),
    // Body-supplied headers win over the HTTP-header convention.
    headers: { ...headerOffering, ...(base?.headers ?? {}) },
  };
}

/**
 * Build the runtime context for one ingress request: a caller-supplied
 * context value (body `runtime_context`, `_meta`, or session patch) merged
 * with the `X-Cpr-Hdr-*` HTTP-header convention, stamped with the
 * authenticated caller's identity.
 */
export function buildRuntimeContextFromRequest(
  rawContext: unknown,
  httpHeaders: Record<string, string | string[] | undefined>,
  caller: { userId?: string; tokenId?: string; source: NonNullable<AgentRuntimeContext['source']> },
): AgentRuntimeContext | undefined {
  const fromBody = parseRuntimeContext(rawContext);
  const merged = mergeRuntimeContext(fromBody, collectRuntimeHeadersFromHttpHeaders(httpHeaders));
  if (!merged) return undefined;
  return {
    ...merged,
    ...(caller.userId ? { userId: caller.userId } : {}),
    ...(caller.tokenId ? { tokenId: caller.tokenId } : {}),
    source: caller.source,
  };
}

/** Read the passthrough policy stored on a record's metadata blob. */
export function runtimeHeaderPolicyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): RuntimeHeaderPolicy | undefined {
  const raw = metadata?.runtimeHeaders;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const policy = raw as Record<string, unknown>;
  return {
    allow: policy.allow === true,
    ...(Array.isArray(policy.allowedNames)
      ? { allowedNames: policy.allowedNames.filter((n): n is string => typeof n === 'string') }
      : {}),
  };
}

/**
 * Resolve the headers that actually apply to one outbound target: global +
 * target-scoped offering, filtered by the target's opt-in policy. Returns
 * undefined when nothing passes (the common case).
 */
export function resolveRuntimeHeaders(
  ctx: AgentRuntimeContext | undefined,
  targetKind: RuntimeTargetKind,
  targetKey: string,
  policy: RuntimeHeaderPolicy | undefined,
): Record<string, string> | undefined {
  if (!ctx) return undefined;
  if (!policy?.allow) return undefined;

  const scoped = ctx.connections?.[`${targetKind}:${targetKey}`]?.headers
    ?? ctx.connections?.[targetKey]?.headers;
  const offered: Record<string, string> = { ...(ctx.headers ?? {}), ...(scoped ?? {}) };

  const allowedNames = policy.allowedNames?.length
    ? new Set(policy.allowedNames.map((n) => n.toLowerCase()))
    : null;

  const applied: Record<string, string> = {};
  for (const [name, value] of Object.entries(offered)) {
    if (allowedNames && !allowedNames.has(name.toLowerCase())) continue;
    applied[name] = value;
  }
  return Object.keys(applied).length > 0 ? applied : undefined;
}

/** Log-safe description of applied runtime auth: header NAMES only, never values. */
export interface RuntimeAuthLogInfo {
  headerKeys: string[];
  source?: string;
  userId?: string;
}

export function describeRuntimeAuth(
  ctx: AgentRuntimeContext | undefined,
  applied: Record<string, string> | undefined,
): RuntimeAuthLogInfo | undefined {
  if (!applied) return undefined;
  return {
    headerKeys: Object.keys(applied).sort(),
    ...(ctx?.source ? { source: ctx.source } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
  };
}
