/**
 * Agent queue consumer.
 *
 * Registers a handler on the cluster.agent queue that invokes the local
 * (non-routed) entry points. Producer side stays in agentService.ts;
 * this module only matters when an assignment routes work to another
 * node via BullMQ.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import {
  executeAgentChatLocal,
  executePlaygroundChatLocal,
  type AgentChatRequest,
  type AgentPlaygroundChatRequest,
} from './agentService';

const log = createLogger('agent.consumer');
let started = false;

/**
 * Concurrent agent turns per node.
 *
 * These jobs are LLM round-trips — almost entirely I/O wait — so serialising
 * them head-of-line blocked every cross-node turn behind the slowest one, and
 * the queue's 60s invoke timeout then failed the ones still waiting.
 */
const CONCURRENCY = Math.max(1, Number(process.env.AGENT_CHAT_CONCURRENCY ?? 4) || 4);

export async function startAgentQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(queueNameFor('agent'), async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'chat') {
      return executeAgentChatLocal(ctx.data as unknown as AgentChatRequest);
    }
    if (ctx.name === 'playground') {
      return executePlaygroundChatLocal(ctx.data as unknown as AgentPlaygroundChatRequest);
    }
    throw new Error(`Unknown agent job: ${ctx.name}`);
  }, { concurrency: CONCURRENCY });
  started = true;
  log.info('Agent queue consumer registered', { concurrency: CONCURRENCY });
}
