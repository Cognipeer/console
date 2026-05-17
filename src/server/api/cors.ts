import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';

const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type, X-Request-Id, X-Api-Key';
const corsLogger = createLogger('cors');

// Valid host label per RFC 1123: letters/digits/hyphens, no leading/trailing hyphen.
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function isValidHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  return host.split('.').every((label) => HOST_LABEL.test(label));
}

function parseOrigin(origin: string): URL | null {
  try {
    const url = new URL(origin);
    // Reject any URL that includes path/query/userinfo — origin should be just scheme://host[:port]
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (url.search || url.hash || url.username || url.password) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!isValidHostname(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function isOriginAllowed(origin: string): boolean {
  const cfg = getConfig();
  if (!cfg.cors.enabled || cfg.cors.allowedOrigins.length === 0) {
    return false;
  }

  // `null` is sent by browsers for opaque origins (sandboxed iframes, file://) — never allow.
  if (origin === 'null') return false;

  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  const requestHost = parsed.hostname.toLowerCase();

  return cfg.cors.allowedOrigins.some((allowed) => {
    const trimmed = allowed.trim();
    if (!trimmed || trimmed === '*') {
      // Refuse the unrestricted wildcard: with credentials enabled it is unsafe
      // and an admin-edit accident could open every origin.
      corsLogger.warn('Ignoring "*" entry in CORS_ALLOWED_ORIGINS (unsafe with credentials)');
      return false;
    }

    if (trimmed.startsWith('*.')) {
      const domain = trimmed.slice(2).toLowerCase();
      if (!isValidHostname(domain)) return false;
      // Require at least one dot in the suffix to disallow `*.com` style entries
      // that would match every site under a TLD.
      if (!domain.includes('.')) return false;
      return requestHost.endsWith(`.${domain}`);
    }

    // Exact origin match (scheme + host + port preserved).
    return trimmed.toLowerCase() === parsed.origin.toLowerCase();
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
