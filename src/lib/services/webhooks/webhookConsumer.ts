/**
 * Consumer of the `webhooks` queue: one `deliver` job per delivery row. The
 * handler leases the row and sends, so a duplicate job (the reconciler and the
 * publisher both enqueued it) delivers once.
 */

import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import {
  WEBHOOK_DELIVER_JOB,
  WEBHOOK_QUEUE,
  deliverWebhookJob,
  type WebhookDeliveryJob,
} from './webhookService';

const log = createLogger('webhooks.consumer');
let started = false;

export async function startWebhookQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(WEBHOOK_QUEUE, async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === WEBHOOK_DELIVER_JOB) return deliverWebhookJob(ctx.data as WebhookDeliveryJob);
    throw new Error(`Unknown webhook job: ${ctx.name}`);
  }, { concurrency: getConfig().webhooks.concurrency });
  started = true;
  log.info('Webhook queue consumer registered', { concurrency: getConfig().webhooks.concurrency });
}
