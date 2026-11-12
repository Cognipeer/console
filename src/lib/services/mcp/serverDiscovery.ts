import { getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import { type McpDiscovery } from './discovery';
import { openAuthConfig } from './secretVault';
import { remoteDiscover } from './remoteMcpClient';
import { type ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';
import { stdioDiscover } from './stdioRunner';
import { requireInternalMcpProvider } from './internal/registry';
import { serverConsoleIdentityAuth, withConsoleIdentityScrubbed } from './identityAuth';
import { parseOpenApiSpec } from './openApiSpec';
import { ensureSandboxInstance, resolveSandboxRunner } from './sandboxHost';
import { resolveSourceType } from './serverView';

// ── Source-specific discovery ────────────────────────────────────────────

/**
 * Discover the tool list (and the instructions, where the source reports
 * them) for a server config. For 'stdio' + 'sandbox' the sandbox must already
 * be provisioned (pass the ensured base URL).
 */
export async function discoverToolsForServer(server: IMcpServer, identity?: ConsoleIdentityCaller): Promise<McpDiscovery> {
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
