/**
 * MCP queue consumer — invokes the local handler on whichever node owns
 * the assignment.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { getDatabase, runWithTenantScope, type IMcpServer } from '@/lib/database';
import { executeMcpToolLocal, type McpInvokeJob } from './mcpService';

const log = createLogger('mcp.consumer');
let started = false;

/**
 * The shape producers sent before a job carried only ids: the whole server
 * record. Still accepted so a rolling deploy does not fail jobs queued by a
 * node that has not been upgraded yet; only the ids in it are used.
 */
interface LegacyInvokeJob {
  server: IMcpServer;
  toolName: string;
  args: Record<string, unknown>;
  runtimeHeaders?: Record<string, string>;
}

type InvokePayload = McpInvokeJob | LegacyInvokeJob;

/**
 * Concurrent MCP tool invocations per node. Stdio servers stay bounded by
 * MCP_STDIO_MAX_CONCURRENT underneath this.
 */
const CONCURRENCY = Math.max(1, Number(process.env.MCP_INVOKE_CONCURRENCY ?? 4) || 4);

function resolveJobTarget(payload: InvokePayload): { tenantId: string; serverId: string } {
  const legacy = (payload as Partial<LegacyInvokeJob>).server;
  const tenantId = (payload as Partial<McpInvokeJob>).tenantId ?? legacy?.tenantId;
  const rawId = (payload as Partial<McpInvokeJob>).serverId ?? legacy?._id;
  const serverId = rawId === undefined || rawId === null ? '' : String(rawId);
  if (typeof tenantId !== 'string' || !tenantId || !serverId) {
    throw new Error('MCP invoke job does not identify a server');
  }
  return { tenantId, serverId };
}

/**
 * Run one job: bind the server's tenant database for the whole execution, load
 * the server record from it, and execute against THAT record. Nothing in the
 * message but the ids, the tool name and the arguments is trusted.
 */
async function invokeMcpJob(payload: InvokePayload): Promise<unknown> {
  const { tenantId, serverId } = resolveJobTarget(payload);

  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId);
  if (!tenant?.dbName) {
    throw new Error('MCP invoke job refers to an unknown tenant');
  }

  return runWithTenantScope(tenant.dbName, async (scoped) => {
    const server = await scoped.findMcpServerById(serverId);
    if (!server || server.tenantId !== tenantId) {
      throw new Error('MCP server not found');
    }
    // The producer checked the server was active when it enqueued the call;
    // the job may have waited since.
    if (server.status !== 'active') {
      throw new Error('MCP server is disabled');
    }
    // The person a call is for travels as plain data; this node checks the account and mints the token.
    const identity = (payload as Partial<McpInvokeJob>).identity;
    return executeMcpToolLocal(server, payload.toolName, payload.args, payload.runtimeHeaders, identity);
  });
}

export async function startMcpQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(queueNameFor('mcp'), async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'invoke') {
      return invokeMcpJob(ctx.data as unknown as InvokePayload);
    }
    throw new Error(`Unknown mcp job: ${ctx.name}`);
  }, { concurrency: CONCURRENCY });
  started = true;
  log.info('MCP queue consumer registered', { concurrency: CONCURRENCY });
}
