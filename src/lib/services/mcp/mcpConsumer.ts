/**
 * MCP queue consumer — invokes the local handler on whichever node owns
 * the assignment.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import type { IMcpServer } from '@/lib/database';
import { executeMcpToolLocal } from './mcpService';

const log = createLogger('mcp.consumer');
let started = false;

interface InvokePayload {
  server: IMcpServer;
  toolName: string;
  args: Record<string, unknown>;
  runtimeHeaders?: Record<string, string>;
}

export async function startMcpQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(queueNameFor('mcp'), async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'invoke') {
      const payload = ctx.data as unknown as InvokePayload;
      return executeMcpToolLocal(payload.server, payload.toolName, payload.args, payload.runtimeHeaders);
    }
    throw new Error(`Unknown mcp job: ${ctx.name}`);
  });
  started = true;
  log.info('MCP queue consumer registered');
}
