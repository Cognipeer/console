import type { FastifyReply } from 'fastify';

export class RbacAuthorizationError extends Error {
  status: number;
  /**
   * Structured refusal: `{ error, code, ... }`, where `error` is the same reason
   * sentence the plain-text clients show (`error.message` of this error). Session
   * routes send it as is; the client-API error styles embed `code` in their
   * envelope and keep `error.message` as the reason.
   */
  body?: Record<string, unknown>;
  /** Response headers that belong to the refusal (`Retry-After` on a 503). */
  headers?: Record<string, string>;

  constructor(message: string, status = 403, body?: Record<string, unknown>, headers?: Record<string, string>) {
    super(message);
    this.name = 'RbacAuthorizationError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Seconds a client is told to wait before retrying a request refused because authorization was unavailable. */
export const AUTHORIZATION_RETRY_AFTER_SECONDS = '5';

export function sendRbacError(reply: FastifyReply, error: unknown) {
  if (error instanceof RbacAuthorizationError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
    return reply.code(error.status).send(error.body ?? { error: error.message });
  }
  return null;
}
