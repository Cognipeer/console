/**
 * Red-team scan queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the dataset-generation / OCR consumers: on single-node (memory queue)
 * deployments it drains locally; on multi-node BullMQ deployments it executes
 * scan jobs routed to this node.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { RED_TEAM_JOB, RED_TEAM_QUEUE, runCampaignJob, type RedTeamJobPayload } from './campaignJob';

const log = createLogger('redteam:consumer');
let started = false;

/** How many scans may run concurrently on this node. */
const CONCURRENCY = Math.max(1, Number(process.env.REDTEAM_SCAN_CONCURRENCY ?? 2) || 2);

export async function startRedTeamQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    RED_TEAM_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === RED_TEAM_JOB) {
        await runCampaignJob(ctx.data as unknown as RedTeamJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown red-team job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Red-team scan queue consumer registered', { concurrency: CONCURRENCY });
}
