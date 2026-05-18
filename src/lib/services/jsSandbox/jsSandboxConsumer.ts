/**
 * JS Sandbox queue consumer.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { executeJsSandboxCodeLocal } from './runtimeService';
import type { ExecuteJsSandboxInput, JsSandboxContext } from './types';

const log = createLogger('js-sandbox.consumer');
let started = false;

interface ExecutePayload {
  ctx: JsSandboxContext;
  input: ExecuteJsSandboxInput;
}

export async function startJsSandboxQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(queueNameFor('js-sandbox'), async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'execute') {
      const payload = ctx.data as unknown as ExecutePayload;
      return executeJsSandboxCodeLocal(payload.ctx, payload.input);
    }
    throw new Error(`Unknown js-sandbox job: ${ctx.name}`);
  });
  started = true;
  log.info('JS sandbox queue consumer registered');
}
