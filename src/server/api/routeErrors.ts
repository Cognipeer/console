import type { FastifyReply } from 'fastify';
import type { Logger } from 'winston';
import { sendProjectContextError } from './fastify-utils';

/** The body of every unexpected-failure response: a constant, never the text of the underlying error. */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export interface RouteErrorOptions {
  /** The module logger the failure is recorded on, with the error attached. */
  logger: Pick<Logger, 'error'>;
  /** The log line for this failure, e.g. `'List RAG modules error'`. */
  log: string;
  /** The body of the 500 answer; defaults to {@link INTERNAL_ERROR_MESSAGE}. */
  message?: string;
  /**
   * A module's own mapping of the errors it can tell apart (typed service errors): answers and returns the reply
   * for an error it recognises, or returns null to leave the error to the generic 500.
   */
  typed?: (error: unknown) => FastifyReply | null | undefined;
}

/**
 * Logs a failed route and answers it, in one order everywhere: the project-context / authorization status when
 * that is what failed, then the module's typed mapping, else a 500 whose body is the constant `message`. The
 * error itself is only ever written to the log.
 */
export function sendRouteError(reply: FastifyReply, error: unknown, options: RouteErrorOptions): FastifyReply {
  options.logger.error(options.log, { error });
  return (
    sendProjectContextError(reply, error)
    ?? options.typed?.(error)
    ?? reply.code(500).send({ error: options.message ?? INTERNAL_ERROR_MESSAGE })
  );
}
