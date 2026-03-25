import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@/lib/core/config';

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type, X-Request-Id, X-Api-Key';

function isOriginAllowed(origin: string): boolean {
  const cfg = getConfig();
  if (!cfg.cors.enabled || cfg.cors.allowedOrigins.length === 0) {
    return false;
  }

  return cfg.cors.allowedOrigins.some((allowed) => {
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      const host = new URL(origin).hostname;
      return host === domain || host.endsWith(`.${domain}`);
    }
    return allowed === origin;
  });
}

export function applyCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const cfg = getConfig();
  if (!cfg.cors.enabled) {
    return false;
  }

  const origin = request.headers.origin;
  if (!origin || !isOriginAllowed(origin)) {
    return false;
  }

  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Methods', CORS_METHODS);
  reply.header('Access-Control-Allow-Headers', CORS_HEADERS);
  reply.header('Access-Control-Max-Age', String(cfg.cors.maxAge));
  reply.header('Access-Control-Allow-Credentials', 'true');
  return true;
}
