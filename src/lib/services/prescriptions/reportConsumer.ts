/**
 * Prescription report queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the snapshot consumer: on single-node (memory queue) deployments
 * it drains locally; on multi-node BullMQ deployments it executes jobs
 * routed to this node. Concurrency defaults to 1 — a report generation can
 * scan a full session window, and two heavy scans in parallel is how shared
 * database capacity gets drained.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import {
  PRESCRIPTION_JOB,
  PRESCRIPTION_QUEUE,
  runPrescriptionJob,
  type PrescriptionJobPayload,
} from './reportJob';

const log = createLogger('prescriptions:consumer');
let started = false;

const CONCURRENCY = Math.max(1, Number(process.env.PRESCRIPTION_JOB_CONCURRENCY ?? 1) || 1);

export async function startPrescriptionQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    PRESCRIPTION_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === PRESCRIPTION_JOB) {
        await runPrescriptionJob(ctx.data as unknown as PrescriptionJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown prescription job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Prescription queue consumer registered', { concurrency: CONCURRENCY });
}
