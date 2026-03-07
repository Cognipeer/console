import { randomUUID } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { LicenseManager } from '@/lib/license/license-manager';
import { TokenManager, type JWTPayload } from '@/lib/license/token-manager';
import { createLogger } from '@/lib/core/logger';
import { isShuttingDown } from '@/lib/core/lifecycle';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { applyCorsHeaders } from './cors';
import { createGatewayRequest, GatewayResponse, sendGatewayResponse } from './http';
import { apiRouteManifest } from './routeManifest';
import type { ApiRouteManifestEntry, RouteHandler, RouteHandlerContext, RouteModule } from './types';

const logger = createLogger('fastify-api');

const PUBLIC_API_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/health/live',
  '/api/health/ready',
];

const CLIENT_API_PREFIXES = ['/api/client/', '/api/models/v1/', '/api/metrics'];
const HTTP_METHODS: Array<keyof RouteModule> = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

function getPathname(url: string | undefined): string {
  return new URL(url || '/', 'http://localhost').pathname;
}

function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function isClientApiPath(pathname: string): boolean {
  return CLIENT_API_PREFIXES.some((path) => pathname.startsWith(path));
}

function applySecurityHeaders(reply: { header: (name: string, value: string) => void }) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-XSS-Protection', '1; mode=block');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function buildSessionHeaders(payload: JWTPayload, requestId: string) {
  const tenantDbName =
    payload.tenantDbName
    || (payload.tenantSlug ? `tenant_${payload.tenantSlug}` : undefined);

  if (!tenantDbName) {
    return null;
  }

  return {
    'x-features': JSON.stringify(payload.features),
    'x-license-type': payload.licenseType,
    'x-request-id': requestId,
    'x-tenant-db-name': tenantDbName,
    'x-tenant-id': payload.tenantId,
    'x-tenant-slug': payload.tenantSlug,
    'x-user-email': payload.email,
    'x-user-id': payload.userId,
    'x-user-role': payload.role,
  };
}

function buildRouteParams(
  entry: ApiRouteManifestEntry,
  params: unknown,
): Record<string, string | string[]> {
  if (!params || typeof params !== 'object') {
    return {};
  }

  const source = params as Record<string, string>;
  const normalized: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === '*') {
      continue;
    }
    normalized[key] = value;
  }

  if (entry.catchAllParam) {
    const wildcard = source['*'];
    normalized[entry.catchAllParam] = wildcard
      ? wildcard.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
      : [];
  }

  return normalized;
}

async function invokeRouteHandler(
  entry: ApiRouteManifestEntry,
  handler: RouteHandler,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (isShuttingDown()) {
    await sendGatewayResponse(
      reply,
      GatewayResponse.json(
        { error: 'Service is shutting down' },
        { status: 503, headers: { 'Retry-After': '5' } },
      ),
    );
    return;
  }

  const apiRequest = createGatewayRequest(request, request.apiContextHeaders);
  const context: RouteHandlerContext = {
    params: Promise.resolve(buildRouteParams(entry, request.params)),
  };

  const tenantId =
    request.apiContextHeaders?.['x-tenant-id']
    || request.apiSession?.tenantId;
  const tenantSlug =
    request.apiContextHeaders?.['x-tenant-slug']
    || request.apiSession?.tenantSlug;
  const userId =
    request.apiContextHeaders?.['x-user-id']
    || request.apiSession?.userId;

  const result = await runWithRequestContext(
    {
      requestId: request.apiRequestId,
      tenantId,
      tenantSlug,
      userId,
    },
    () => handler(apiRequest, context),
  );

  await sendGatewayResponse(reply, result);
}

function registerRouteModule(
  app: FastifyInstance,
  entry: ApiRouteManifestEntry,
): void {
  for (const method of HTTP_METHODS) {
    const handler = entry.module[method];
    if (!handler) {
      continue;
    }

    app.route({
      handler: async (request, reply) => {
        try {
          await invokeRouteHandler(entry, handler, request, reply);
        } catch (error) {
          logger.error('Unhandled Fastify API error', {
            error,
            method,
            routePath: entry.routePath,
          });
          await sendGatewayResponse(
            reply,
            GatewayResponse.json(
              { error: 'Internal server error' },
              { status: 500 },
            ),
          );
        }
      },
      method,
      url: entry.routePath,
    });
  }
}

function unauthorized(
  reply: FastifyReply,
  body: Record<string, unknown>,
  status = 401,
) {
  return sendGatewayResponse(reply, GatewayResponse.json(body, { status }));
}

export const fastifyApiPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (request, reply) => {
    const pathname = getPathname(request.raw.url);
    const requestId =
      (typeof request.headers['x-request-id'] === 'string' && request.headers['x-request-id'])
      || randomUUID();

    request.apiRequestId = requestId;
    request.apiContextHeaders = { 'x-request-id': requestId };

    reply.header('x-request-id', requestId);
    applySecurityHeaders(reply);

    const clientApiRequest = isClientApiPath(pathname);
    if (clientApiRequest) {
      const corsApplied = applyCorsHeaders(request, reply);
      if (request.method === 'OPTIONS' && corsApplied) {
        reply.code(204).send();
        return reply;
      }
    }

    if (isPublicApiPath(pathname)) {
      return;
    }

    if (clientApiRequest) {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return unauthorized(reply, {
          error: 'Unauthorized',
          message: 'Missing or invalid Authorization header. Use: Bearer <token>',
        });
      }
      return;
    }

    const token = request.cookies.token;
    if (!token) {
      return unauthorized(reply, {
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const payload = await TokenManager.verifyToken(token);
    if (!payload) {
      reply.clearCookie('token', { path: '/' });
      return unauthorized(reply, {
        error: 'Unauthorized',
        message: 'Invalid or expired token',
      });
    }

    if (!LicenseManager.hasEndpointAccess(payload.licenseType, pathname)) {
      return unauthorized(
        reply,
        {
          error: 'Forbidden',
          message: 'Your license does not have access to this feature',
          requiredLicense: 'Please upgrade your plan',
        },
        403,
      );
    }

    const sessionHeaders = buildSessionHeaders(payload, requestId);
    if (!sessionHeaders) {
      return unauthorized(reply, {
        error: 'Unauthorized',
        message: 'Tenant context is missing',
      });
    }

    request.apiSession = payload;
    request.apiContextHeaders = sessionHeaders;
  });

  for (const entry of apiRouteManifest) {
    registerRouteModule(app, entry);
  }
};
