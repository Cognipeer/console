import type { FastifyReply } from 'fastify';

/**
 * An AbortSignal that fires when the caller hangs up before the reply is complete (a Stop
 * button, a closed tab, a dropped connection). Pass it to the model call so the upstream
 * request - and its billing - stops with the client. A reply that finished normally never aborts it.
 */
export function abortSignalOnDisconnect(reply: Pick<FastifyReply, 'raw'>): AbortSignal {
  const controller = new AbortController();
  const raw = reply.raw;
  raw.once('close', () => {
    if (!raw.writableFinished) controller.abort(new Error('Client disconnected'));
  });
  return controller.signal;
}
