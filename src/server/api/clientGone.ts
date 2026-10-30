import type { FastifyReply } from 'fastify';

/** Aborted when the client goes away before its answer was sent: work done only for that answer can stop. */
export function clientGone(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
