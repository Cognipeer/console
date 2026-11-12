import type { DatabaseProvider, IMcpExposureConfig, IMcpServer, McpSourceType } from '@/lib/database';
import { getInternalMcpProvider } from './internal/registry';
import type { InternalMcpProvider } from './internal/types';
import { getCompositeConfig } from './composite';

export const DEFAULT_MCP_EXPOSURE: IMcpExposureConfig = {
  protocols: ['streamable-http', 'sse'],
  accessMode: 'token',
};

export function resolveSourceType(server: Pick<IMcpServer, 'sourceType'>): McpSourceType {
  return server.sourceType ?? 'openapi';
}

/**
 * Some internal providers reach past the console — a browser reaches whatever
 * address the console can, a sandbox runs code — so a server on one is called
 * with a token only: neither the server itself nor a composite that includes it
 * can be public (`InternalMcpProvider.tokenOnly`).
 */
export function tokenOnlyMessage(provider: Pick<InternalMcpProvider, 'label'>): string {
  return `A ${provider.label.toLowerCase()} server is available with an API token only: it cannot be public, and neither can a composite server that includes it.`;
}

/** The token-only provider an internal-source server is built on, or null. */
export function tokenOnlyProviderOf(server: Pick<IMcpServer, 'sourceType' | 'metadata'>): InternalMcpProvider | null {
  if (resolveSourceType(server) !== 'internal') return null;
  const internal = (server.metadata as Record<string, unknown> | undefined)?.internal as { provider?: unknown } | undefined;
  const provider = typeof internal?.provider === 'string' ? getInternalMcpProvider(internal.provider) : undefined;
  return provider?.tokenOnly ? provider : null;
}

/** An internal-source server on a token-only provider (a browser, a sandbox). */
export function isTokenOnlyServer(server: Pick<IMcpServer, 'sourceType' | 'metadata'>): boolean {
  return tokenOnlyProviderOf(server) !== null;
}

/**
 * The token-only provider a server reaches — its own, or a composite member's — else null (members are read
 * from the current tenant database).
 */
export async function reachedTokenOnlyProvider(
  db: DatabaseProvider,
  server: Pick<IMcpServer, 'sourceType' | 'metadata'>,
): Promise<InternalMcpProvider | null> {
  const own = tokenOnlyProviderOf(server);
  if (own) return own;
  if (resolveSourceType(server) !== 'composite') return null;
  for (const member of getCompositeConfig(server).members) {
    const record = await db.findMcpServerById(member.serverId);
    const reached = record ? tokenOnlyProviderOf(record) : null;
    if (reached) return reached;
  }
  return null;
}

/** A token-only server, or a composite with a token-only member. */
export async function reachesTokenOnlyServer(
  db: DatabaseProvider,
  server: Pick<IMcpServer, 'sourceType' | 'metadata'>,
): Promise<boolean> {
  return (await reachedTokenOnlyProvider(db, server)) !== null;
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
