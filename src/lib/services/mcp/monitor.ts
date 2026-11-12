import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { IMcpAuditLog, IMcpRequestLog, IMcpServer } from '@/lib/database';
import type { McpServerView } from './types';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';
import { resolveTenantDbName } from '@/lib/services/guardrail/hooks/recordCache';
import { isStdioRunnerEnabled } from './stdioRunner';
import { mcpSandboxRunner } from '@/enterprise/registry';
import { getCompositeConfig } from './composite';
import { mcpLogScope } from './requestLog';
import { serializeMcpServer } from './serialize';
import { resolveSourceType } from './serverView';

const logger = createLogger('mcp-service');

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
  return runWithTenantScope(tenantDbName, async (db) => {

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
  });
}

/**
 * Records one health observation for an MCP server call. The tenant database
 * name is not in the request context and a routed call may start on a node
 * without one, so it is resolved from the server's tenant (cached). Never
 * throws and is never awaited by the caller.
 */
export function recordMcpServerMetric(
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
