import type { FastifyReply, FastifyRequest } from 'fastify';
import { trustsEveryHop } from '@/lib/security/trustedProxy';
import { canonicalizeRequestPathname } from '@/lib/security/requestPath';

export function getHeaderValue(
  request: FastifyRequest,
  name: string,
): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return null;
}

export function readJsonBody<T>(request: FastifyRequest): T {
  const { body } = request;

  if (body === undefined || body === null || body === '') {
    throw new SyntaxError('Unexpected end of JSON input');
  }

  if (typeof body === 'string') {
    return JSON.parse(body) as T;
  }

  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString('utf8')) as T;
  }

  return body as T;
}

/**
 * readJsonBody for a handler that reads fields off the body: a literal `null`
 * (or a bare string, number or boolean) is valid JSON but no body, so it throws
 * the same SyntaxError an empty body does and the route answers 400.
 */
export function readJsonObjectBody<T extends object = Record<string, unknown>>(request: FastifyRequest): T {
  const parsed: unknown = readJsonBody<unknown>(request);
  if (parsed === null || typeof parsed !== 'object') {
    throw new SyntaxError('Request body must be a JSON object');
  }
  return parsed as T;
}

/**
 * A body the caller may leave out: none at all (or a literal `null`) reads as
 * `{}`, anything else must be a JSON object. Unlike safeReadJsonBody, malformed
 * JSON throws, so a route can answer 400 instead of quietly running on its
 * defaults something the caller asked to change.
 */
export function readOptionalJsonObjectBody<T extends object = Record<string, unknown>>(request: FastifyRequest): T {
  const { body } = request;
  if (body === undefined || body === null) return {} as T;
  if (typeof body === 'string' && body.trim() === '') return {} as T;
  if (Buffer.isBuffer(body) && body.toString('utf8').trim() === '') return {} as T;
  const parsed: unknown = readJsonBody<unknown>(request);
  if (parsed === null) return {} as T;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('Request body must be a JSON object');
  }
  return parsed as T;
}

/**
 * Same as readJsonBody but never throws — returns `{}` on missing or malformed
 * payload. Use when the handler validates field-by-field and prefers to reply
 * with a domain-specific 400 rather than letting JSON parse errors leak out.
 *
 * IMPORTANT: every Fastify plugin route in this app MUST use this (or
 * readJsonBody) instead of accessing `request.body` directly. The global
 * JSON content-type parser keeps the body as the raw string for Next.js
 * compatibility, so a direct `body.fleetToken` access reads from a string
 * and silently returns undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeReadJsonBody<T = Record<string, any>>(request: FastifyRequest): T {
  try {
    return readJsonBody<T>(request);
  } catch {
    return {} as T;
  }
}

/**
 * The caller's IP as resolved through the server's configured proxy trust
 * boundary (`config.network.trustedProxies` → Fastify's `trustProxy`).
 *
 * There is deliberately no X-Forwarded-For / X-Real-IP fallback here any
 * more. Fastify already derives `request.ip` from X-Forwarded-For when — and
 * only when — the immediate peer is trusted; re-reading those headers here
 * did the opposite, taking a caller-settable header at face value no matter
 * what `trustProxy` said, which is exactly the spoof F-09 reported. Since
 * `request.ip` falls back to the raw socket address on its own, the old
 * branches were also unreachable in practice.
 *
 * Deployment note: a proxy that sets ONLY `X-Real-IP` and not
 * `X-Forwarded-For` will now show up as the proxy's own address. Set
 * `X-Forwarded-For` on it (nginx's `proxy_set_header X-Forwarded-For
 * $proxy_add_x_forwarded_for`) and list the proxy in `TRUSTED_PROXIES`.
 */
export function getClientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

export { trustsEveryHop };

/**
 * The caller's address for AUTHORIZATION decisions: a token's IP allowlist and a
 * policy's `ip` condition. Unlike `getClientIp` (audit, rate limiting) this never
 * takes a header at face value:
 *
 *  - With trusted proxies configured it is `request.ip`: Fastify walks the
 *    forwarded-for chain from the right and stops at the first hop that is not
 *    one of them, so what the caller wrote to the left of the proxy is ignored.
 *  - With none configured Fastify trusts every hop, which makes `request.ip`
 *    the leftmost forwarded-for entry - a value the caller chooses, even behind
 *    a proxy that appends to the header. The only address nobody can forge is
 *    then the connection's own peer, so that is the one rules are checked
 *    against. (Behind a reverse proxy every caller then looks like the proxy
 *    until `TRUSTED_PROXIES` names it - the IAM settings and the token form say
 *    so. A rule that cannot be evaluated safely errs on the side of not matching
 *    a spoofed address, never of matching it.)
 */
export function getAuthzClientIp(request: FastifyRequest): string {
  if (trustsEveryHop()) {
    return request.raw?.socket?.remoteAddress || request.socket?.remoteAddress || 'unknown';
  }
  return request.ip || 'unknown';
}

export function getRequestPathname(request: FastifyRequest): string {
  // RBAC must map the path the router actually matched: Fastify decodes
  // percent-escapes, so the raw '/api/to%6Fls' reaches the /api/tools handler
  // while mapping to no service (= no authorization).
  return canonicalizeRequestPathname(request.raw.url);
}

/**
 * Response headers every SSE endpoint needs. `X-Accel-Buffering: no` is the one
 * that is easy to forget and expensive to miss: nginx (and most ingress
 * controllers) default to `proxy_buffering on`, which holds the whole event
 * stream until the response completes — the client sees nothing, then
 * everything, which reads exactly like "streaming does not work".
 */
export function applyStreamHeaders(reply: FastifyReply, requestId?: string): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  if (requestId) {
    reply.raw.setHeader('X-Request-Id', requestId);
  }
}

export function parseBooleanQuery(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

export function parseCsvQuery(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
