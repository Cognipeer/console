import { createLogger } from '@/lib/core/logger';
import type { IMcpServer, McpSourceType } from '@/lib/database';
import { McpServerConfigError } from './errors';
import { CONSOLE_IDENTITY_AUTH_TYPE, consoleIdentityHeaders, ensureConsoleIdentityKey, type ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';
import { sanitizeExecutionError } from './executionError';

const logger = createLogger('mcp-service');

// ── Console identity (lib/iam/consoleIdentity.ts) ─────────────────────────

/** Remote MCP and OpenAPI servers are the sources with an upstream to send a Console identity token to. */
export function assertConsoleIdentitySource(sourceType: McpSourceType): void {
  if (sourceType !== 'remote' && sourceType !== 'openapi') {
    throw new McpServerConfigError('Console identity is available for remote MCP and OpenAPI servers only');
  }
}

/** Create the workspace's signing key when an administrator turns Console identity on, so its key set is published. */
export async function prepareConsoleIdentityKey(tenantDbName: string): Promise<void> {
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
export async function consoleIdentityAuthFor(input: {
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

export function serverConsoleIdentityAuth(
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
export function withConsoleIdentityHeader(
  runtimeHeaders: Record<string, string> | undefined,
  identityHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!identityHeaders) return runtimeHeaders;
  const replaced = new Set(Object.keys(identityHeaders).map((name) => name.toLowerCase()));
  const kept = Object.entries(runtimeHeaders ?? {}).filter(([name]) => !replaced.has(name.toLowerCase()));
  return { ...Object.fromEntries(kept), ...identityHeaders };
}

/** Run an upstream request; the identity token is masked in whatever it throws (an upstream may echo it). */
export async function withConsoleIdentityScrubbed<T>(
  identityAuth: ConsoleIdentityAuth | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw identityAuth ? sanitizeExecutionError(error, [identityAuth.token]) : error;
  }
}
