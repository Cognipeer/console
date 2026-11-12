import { getDatabase } from '@/lib/database';
import type { IMcpServer, IMcpStdioConfig } from '@/lib/database';
import { openStdioEnv } from './secretVault';
import { mcpSandboxRunner } from '@/enterprise/registry';

export async function resolveSandboxRunner(server: IMcpServer) {
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
export async function ensureSandboxInstance(
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
