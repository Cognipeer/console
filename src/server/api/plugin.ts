import { randomUUID } from 'node:crypto';
import type {
  FastifyPluginAsync,
  FastifyReply,
} from 'fastify';
import { LicenseManager } from '@/lib/license/license-manager';
import { TokenManager, type JWTPayload } from '@/lib/license/token-manager';
import { applyCorsHeaders } from './cors';
import { authApiPlugin } from './plugins/auth';
import { clientAgentsApiPlugin } from './plugins/client-agents';
import { clientConfigApiPlugin } from './plugins/client-config';
import { clientFilesApiPlugin } from './plugins/client-files';
import { clientGuardrailsApiPlugin } from './plugins/client-guardrails';
import { clientInferenceApiPlugin } from './plugins/client-inference';
import { clientMemoryApiPlugin } from './plugins/client-memory';
import { clientMcpApiPlugin } from './plugins/client-mcp';
import { clientPromptsApiPlugin } from './plugins/client-prompts';
import { clientRagApiPlugin } from './plugins/client-rag';
import { clientToolsApiPlugin } from './plugins/client-tools';
import { clientTracingApiPlugin } from './plugins/client-tracing';
import { clientVectorApiPlugin } from './plugins/client-vector';
import { agentsApiPlugin } from './plugins/agents';
import { alertsApiPlugin } from './plugins/alerts';
import { configApiPlugin } from './plugins/config';
import { dashboardApiPlugin } from './plugins/dashboard';
import { filesApiPlugin } from './plugins/files';
import { guardrailsApiPlugin } from './plugins/guardrails';
import { healthApiPlugin } from './plugins/health';
import { inferenceMonitoringApiPlugin } from './plugins/inference-monitoring';
import { mcpApiPlugin } from './plugins/mcp';
import { memoryApiPlugin } from './plugins/memory';
import { metricsApiPlugin } from './plugins/metrics';
import { modelsApiPlugin } from './plugins/models';
import { promptsApiPlugin } from './plugins/prompts';
import { providersApiPlugin } from './plugins/providers';
import { projectsApiPlugin } from './plugins/projects';
import { quotaApiPlugin } from './plugins/quota';
import { ragApiPlugin } from './plugins/rag';
import { tokensApiPlugin } from './plugins/tokens';
import { toolsApiPlugin } from './plugins/tools';
import { tracingApiPlugin } from './plugins/tracing';
import { usersApiPlugin } from './plugins/users';
import { vectorApiPlugin } from './plugins/vector';

const PUBLIC_API_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/health/live',
  '/api/health/ready',
];

const CLIENT_API_PREFIXES = ['/api/client/', '/api/models/v1/', '/api/metrics'];

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

function unauthorized(
  reply: FastifyReply,
  body: Record<string, unknown>,
  status = 401,
) {
  return reply.code(status).send(body);
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

  await app.register(agentsApiPlugin);
  await app.register(alertsApiPlugin);
  await app.register(authApiPlugin);
  await app.register(clientAgentsApiPlugin);
  await app.register(clientConfigApiPlugin);
  await app.register(clientFilesApiPlugin);
  await app.register(clientGuardrailsApiPlugin);
  await app.register(clientInferenceApiPlugin);
  await app.register(clientMemoryApiPlugin);
  await app.register(clientMcpApiPlugin);
  await app.register(clientPromptsApiPlugin);
  await app.register(clientRagApiPlugin);
  await app.register(clientToolsApiPlugin);
  await app.register(clientTracingApiPlugin);
  await app.register(clientVectorApiPlugin);
  await app.register(configApiPlugin);
  await app.register(dashboardApiPlugin);
  await app.register(filesApiPlugin);
  await app.register(guardrailsApiPlugin);
  await app.register(healthApiPlugin);
  await app.register(inferenceMonitoringApiPlugin);
  await app.register(mcpApiPlugin);
  await app.register(memoryApiPlugin);
  await app.register(metricsApiPlugin);
  await app.register(modelsApiPlugin);
  await app.register(promptsApiPlugin);
  await app.register(providersApiPlugin);
  await app.register(projectsApiPlugin);
  await app.register(quotaApiPlugin);
  await app.register(ragApiPlugin);
  await app.register(tokensApiPlugin);
  await app.register(toolsApiPlugin);
  await app.register(tracingApiPlugin);
  await app.register(usersApiPlugin);
  await app.register(vectorApiPlugin);
};
