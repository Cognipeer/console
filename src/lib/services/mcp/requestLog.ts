import { createLogger } from '@/lib/core/logger';
import { createHash } from 'crypto';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import type { IMcpAuditLog, IMcpRequestLog, IMcpServer, McpLogServerScope } from '@/lib/database';
import { getConfig } from '@/lib/core/config';
import { authConfigSecretValues, DEFAULT_MAX_STRING_CHARS, maskSecretValues, redactLogPayload, redactLogString } from '@/lib/services/logRedaction';
import { recordUsageEvent, resolveUsageAttribution } from '@/lib/services/usage/usageEvents';
import { boundClientMeta } from './clientMeta';
import { responseLogSummaryOf } from './responseLog';
import { openAuthConfig, openStdioEnv } from './secretVault';

const logger = createLogger('mcp-service');

// ── Request logging ───────────────────────────────────────────────────────

/**
 * Scope a request-log query to `server`. `serverId` is the durable match;
 * the rest only extend it to rows written before `serverId` existed, capped
 * at this server's own `createdAt` so a deleted-and-recreated server (which
 * regenerates the same name-derived `key`) can't pull in its predecessor's
 * history.
 */
export function mcpLogScope(server: IMcpServer): McpLogServerScope {
  return {
    serverId: String(server._id),
    serverKey: server.key,
    projectId: server.projectId,
    createdAt: server.createdAt,
  };
}

/** Values of the server's static upstream credential, opened from the vault. */
export function upstreamCredentialValues(server: IMcpServer): string[] {
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
export function lastErrorRecord(
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
export function forgetLastErrorWrite(server: Pick<IMcpServer, 'tenantId' | '_id'>): void {
  lastErrorWrites.delete(lastErrorKey(server));
}

/** True (and remembers it) unless this exact message was written within the throttle window. */
export function claimLastErrorWrite(server: IMcpServer, message: string): boolean {
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
