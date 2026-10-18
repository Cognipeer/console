/**
 * What the HTTP server does before it closes (`app.close()` waits for every
 * open connection to end).
 *
 * An agent run's stream — a `/responses` or chat-completions call answered
 * inline, a session's event stream — stays open for as long as the run, or
 * the session, goes on. If the server waited for those first, the agent-run
 * drain (pause the run consumers, give the runs here their drain window, mark
 * the rest interrupted with their notifications) would never start, and the
 * runs would end as `worker_lost` long after the process was gone. So the
 * drain runs in Fastify's `preClose` step — new requests are already refused
 * with 503 there, the open ones are still served: each inline run's caller is
 * answered with its run's outcome (its stream ends with that terminal event),
 * the session event streams are ended (their clients reconnect elsewhere), and
 * only then does the server wait for the connections that are left.
 */

import type { FastifyInstance } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { drainAgentRunConsumers } from '@/lib/services/agents/agentConsumer';
import { closeSessionEventStreams } from './api/plugins/agent-session-events';

const logger = createLogger('http-shutdown');

export function drainAgentRunsBeforeHttpClose(app: FastifyInstance): void {
  app.addHook('preClose', async () => {
    try {
      await drainAgentRunConsumers();
    } catch (error) {
      logger.warn('Agent run drain failed before the HTTP server closed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const ended = closeSessionEventStreams();
    if (ended > 0) logger.info('Ended session event streams for shutdown', { ended });
  });
}
