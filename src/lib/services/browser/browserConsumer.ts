/**
 * Browser queue consumer.
 *
 * Currently handles the runAction job. Session creation is not yet
 * routed because Playwright contexts are sticky to the node where the
 * session was opened; assigning a browser to a different node will
 * affect future sessions only.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { runBrowserActionLocal } from './browserSessionService';
import type { BrowserAction } from './types';

const log = createLogger('browser.consumer');
let started = false;

interface SessionCtx {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

interface RunActionPayload {
  ctx: SessionCtx;
  sessionKey: string;
  action: BrowserAction;
}

export async function startBrowserQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(queueNameFor('browser'), async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'runAction') {
      const payload = ctx.data as unknown as RunActionPayload;
      return runBrowserActionLocal(payload.ctx, payload.sessionKey, payload.action);
    }
    throw new Error(`Unknown browser job: ${ctx.name}`);
  });
  started = true;
  log.info('Browser queue consumer registered');
}
