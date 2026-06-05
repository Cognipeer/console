import Fastify, { type FastifyPluginAsync } from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyRequest } from 'fastify';

const CONTEXT_HEADER_KEYS = [
  'x-features',
  'x-license-type',
  'x-request-id',
  'x-tenant-db-name',
  'x-tenant-id',
  'x-tenant-slug',
  'x-user-email',
  'x-user-id',
  'x-user-role',
] as const;

function buildContextHeaders(request: FastifyRequest) {
  const headers: Record<string, string> = {
    'x-request-id': 'test-request',
  };

  for (const key of CONTEXT_HEADER_KEYS) {
    const value = request.headers[key];
    if (typeof value === 'string' && value.length > 0) {
      headers[key] = value;
    }
  }

  return headers;
}

export async function createFastifyApiTestApp(
  plugin: FastifyPluginAsync,
) {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  app.addHook('onRequest', async (request) => {
    request.apiRequestId = 'test-request';
    request.apiContextHeaders = buildContextHeaders(request);
  });

  await app.register(plugin, { prefix: '/api' });
  return app;
}

export function parseJsonBody<T>(body: string): T {
  return JSON.parse(body) as T;
}

export function getSetCookieHeaders(
  header: string | string[] | undefined,
): string[] {
  if (!header) {
    return [];
  }

  return Array.isArray(header) ? header : [header];
}

export function hasSetCookie(
  header: string | string[] | undefined,
  cookieName: string,
): boolean {
  return getSetCookieHeaders(header).some((value) =>
    value.startsWith(`${cookieName}=`),
  );
}
