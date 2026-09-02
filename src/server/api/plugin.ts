import { randomUUID } from 'node:crypto';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { isApplicationReady } from '@/server/bootstrap';
import { getDatabase } from '@/lib/database';
import { LicenseManager } from '@/lib/license/license-manager';
import { checkEnterpriseApiAccess, getEnterpriseModuleForPath } from '@/lib/license/enterprise-access';
import {
  getCachedEnterpriseLicense,
  setCachedEnterpriseLicense,
} from '@/lib/license/enterprise-license-cache';
import { TokenManager, type JWTPayload } from '@/lib/license/token-manager';
import { fireAndForget } from '@/lib/core/asyncTask';
import { getPermissionServiceForPath, getRequiredPermissionLevel } from '@/lib/security/rbac';
import { recordAuditLog } from '@/lib/services/audit';
import { anthropicErrorBody } from '@/lib/services/models/anthropicWire';
import { applyCorsHeaders } from './cors';
import { authApiPlugin } from './plugins/auth';
import { clientA2aApiPlugin } from './plugins/client-a2a';
import { clientAgentsApiPlugin } from './plugins/client-agents';
import { clientAnalyticsApiPlugin } from './plugins/client-analytics';
import { clientAuditApiPlugin } from './plugins/client-audit';
import { clientMonitoringApiPlugin } from './plugins/client-monitoring';
import { clientProvidersApiPlugin } from './plugins/client-providers';
import { clientModelsApiPlugin } from './plugins/client-models';
import { clientLicenseApiPlugin } from './plugins/client-license';
import { clientProjectsApiPlugin } from './plugins/client-projects';
import { clientMembersApiPlugin } from './plugins/client-members';
import { clientUsersApiPlugin } from './plugins/client-users';
import { clientBatchesApiPlugin } from './plugins/client-batches';
import { clientModerationsApiPlugin } from './plugins/client-moderations';
import { clientSpendApiPlugin } from './plugins/client-spend';
import { clientConfigApiPlugin } from './plugins/client-config';
import { clientFilesApiPlugin } from './plugins/client-files';
import { clientGuardrailsApiPlugin } from './plugins/client-guardrails';
import { clientAudioOcrApiPlugin } from './plugins/client-audio-ocr';
import { clientInferenceApiPlugin } from './plugins/client-inference';
import { clientMemoryApiPlugin } from './plugins/client-memory';
import { clientAutomationsApiPlugin } from './plugins/client-automations';
import { clientMcpApiPlugin } from './plugins/client-mcp';
import { clientMcpConsoleApiPlugin } from './plugins/client-mcp-console';
import { publicA2aApiPlugin } from './plugins/public-a2a';
import { publicMcpApiPlugin } from './plugins/public-mcp';
import { clientPiiApiPlugin } from './plugins/client-pii';
import { clientEvaluationsApiPlugin } from './plugins/client-evaluations';
import { clientPromptsApiPlugin } from './plugins/client-prompts';
import { clientRagApiPlugin } from './plugins/client-rag';
import { clientRerankerApiPlugin } from './plugins/client-reranker';
import { clientTracingApiPlugin } from './plugins/client-tracing';
import { clientVectorApiPlugin } from './plugins/client-vector';
import { clientWebSearchApiPlugin } from './plugins/client-websearch';
import { clientBrowserApiPlugin } from './plugins/client-browser';
import { clientBrowserMcpApiPlugin } from './plugins/client-browser-mcp';
import { auditApiPlugin } from './plugins/audit';
import { automationsApiPlugin } from './plugins/automations';
import { browserApiPlugin } from './plugins/browser';
import { crawlerApiPlugin } from './plugins/crawler';
import { clientCrawlerApiPlugin } from './plugins/client-crawler';
import { clientOcrJobsApiPlugin } from './plugins/client-ocr-jobs';
import { ocrJobsApiPlugin } from './plugins/ocr-jobs';
import { agentsApiPlugin } from './plugins/agents';
import { alertsApiPlugin } from './plugins/alerts';
import { configApiPlugin } from './plugins/config';
import { modelPriceCatalogApiPlugin } from './plugins/model-price-catalog';
import { snapshotsApiPlugin } from './plugins/snapshots';
import { datasetImportApiPlugin } from './plugins/dataset-import';
import { dashboardApiPlugin } from './plugins/dashboard';
import { filesApiPlugin } from './plugins/files';
import { guardrailsApiPlugin } from './plugins/guardrails';
import { evaluationsApiPlugin } from './plugins/evaluations';
import { redTeamApiPlugin } from './plugins/redteam';
import { clientRedTeamApiPlugin } from './plugins/client-redteam';
import { analysisApiPlugin } from './plugins/analysis';
import { piiApiPlugin } from './plugins/pii';
import { healthApiPlugin } from './plugins/health';
import { inferenceMonitoringApiPlugin } from './plugins/inference-monitoring';
import { licenseApiPlugin } from './plugins/license';
import { mcpApiPlugin } from './plugins/mcp';
import { memoryApiPlugin } from './plugins/memory';
import { metricsApiPlugin } from './plugins/metrics';
import { modelsApiPlugin } from './plugins/models';
import { groupsApiPlugin } from './plugins/groups';
import { promptsApiPlugin } from './plugins/prompts';
import { providersApiPlugin } from './plugins/providers';
import { projectsApiPlugin } from './plugins/projects';
import { quotaApiPlugin } from './plugins/quota';
import { ragApiPlugin } from './plugins/rag';
import { rerankerApiPlugin } from './plugins/reranker';
import { specsApiPlugin } from './plugins/specs';
import { supportApiPlugin } from './plugins/support';
import { tokensApiPlugin } from './plugins/tokens';
import { toolsApiPlugin } from './plugins/tools';
import { tracingApiPlugin } from './plugins/tracing';
import { usersApiPlugin } from './plugins/users';
import { vectorApiPlugin } from './plugins/vector';
import { websearchApiPlugin } from './plugins/websearch';
import {
  registerEnterpriseApiPlugins,
  enterprisePublicApiPaths,
  enterprisePublicApiPrefixes,
} from '@/enterprise/registry';

const PUBLIC_API_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/health/live',
  '/api/health/ready',
  // Enterprise overlay contributes its own public paths (e.g. the gpu-fleet
  // installer.sh). Empty in the community edition.
  ...enterprisePublicApiPaths,
];

/**
 * Anything under here is downloadable without session auth. The enterprise
 * overlay contributes its prefixes (e.g. the GPU agent bundle tarball, which
 * contains no tenant secrets — pairing requires a fleet token). Empty in the
 * community edition.
 */
const PUBLIC_API_PREFIXES = [
  // MCP servers exposed with accessMode 'public' (unguessable slug URLs; the
  // handler re-checks the access mode on every request).
  '/api/public/mcp/',
  // Agents exposed over A2A with accessMode 'public' (same slug-URL model).
  '/api/public/a2a/',
  ...enterprisePublicApiPrefixes,
];

const CLIENT_API_PREFIXES = ['/api/client/', '/api/models/v1/', '/api/metrics', '/api/internal/gpu-pool/'];

/**
 * Endpoints under these prefixes manage their own auth (Bearer agent tokens)
 * and must bypass the cookie-session check below. Each handler MUST call into
 * `authenticateAgent` itself; the global hook only short-circuits.
 */
const SELF_AUTH_API_PREFIXES = ['/api/gpu/agent/', '/api/sandbox/agent/'];

function isSelfAuthApiPath(pathname: string): boolean {
  return SELF_AUTH_API_PREFIXES.some((path) => pathname.startsWith(path));
}

function getPathname(url: string | undefined): string {
  return new URL(url || '/', 'http://localhost').pathname;
}

function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return true;
  }
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isClientApiPath(pathname: string): boolean {
  return CLIENT_API_PREFIXES.some((path) => pathname.startsWith(path));
}

function applySecurityHeaders(reply: { header: (name: string, value: string) => void }) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-XSS-Protection', '1; mode=block');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function buildSessionHeaders(payload: JWTPayload, requestId: string) {
  const tenantDbName =
    payload.tenantDbName
    || (payload.tenantSlug ? `tenant_${payload.tenantSlug}` : undefined);

  if (!tenantDbName) {
    return null;
  }

  const licenseExpired = payload.licenseExpiresAt
    ? Date.parse(payload.licenseExpiresAt) <= Date.now()
    : false;
  const effectiveLicenseType = licenseExpired ? 'FREE' : payload.licenseType;

  return {
    'x-features': JSON.stringify(LicenseManager.getFeaturesForLicense(effectiveLicenseType)),
    'x-license-type': effectiveLicenseType,
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

/**
 * Resolve a tenant's CURRENT effective license for the enterprise API guard,
 * instead of trusting the licenseType/licenseExpiresAt embedded in the
 * caller's session JWT. A JWT can be up to JWT_EXPIRES_IN old (default 7
 * days), so trusting it here would let every other already-logged-in user
 * of a tenant keep enterprise access for the life of their cookie after an
 * owner/admin downgrades or removes the tenant's license.
 *
 * Backed by a short TTL cache (`enterprise-license-cache.ts`) so this
 * doesn't add a DB round-trip to every gated request; the license admin
 * endpoints invalidate that cache entry immediately on change, so both
 * upgrades and downgrades are visible on the very next request.
 */
async function resolveLiveLicenseForTenant(
  tenantId: string,
): Promise<{ licenseType: string; licenseExpiresAt?: string }> {
  const cached = await getCachedEnterpriseLicense(tenantId);
  if (cached) {
    return cached;
  }

  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId);
  const effective = LicenseManager.getEffectiveLicenseForTenant(tenant);
  const resolved = {
    licenseExpiresAt: effective.expiresAt?.toISOString(),
    licenseType: effective.licenseType,
  };
  await setCachedEnterpriseLicense(tenantId, resolved);
  return resolved;
}

function getAuditOutcome(
  statusCode: number,
  upstreamForwarded = false,
): 'success' | 'failure' | 'denied' {
  // `denied` means *we* refused the caller. A 401 forwarded from a model
  // provider says our credentials for that provider are wrong, which is an
  // operational failure, not an authorization event.
  if (!upstreamForwarded && (statusCode === 401 || statusCode === 403)) return 'denied';
  if (statusCode >= 400) return 'failure';
  return 'success';
}

function shouldAuditRequest(request: FastifyRequest, statusCode: number): boolean {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    return true;
  }
  return statusCode === 401 || statusCode === 403;
}

function getHeaderString(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function getClientIp(request: FastifyRequest): string {
  const forwarded = getHeaderString(request, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return getHeaderString(request, 'x-real-ip') ?? request.ip ?? 'unknown';
}

function enqueueAuditLog(request: FastifyRequest, reply: FastifyReply): void {
  const pathname = getPathname(request.raw.url);
  const service = getPermissionServiceForPath(pathname);
  if (!service || pathname.startsWith('/api/audit')) {
    return;
  }

  const statusCode = reply.statusCode;
  if (!shouldAuditRequest(request, statusCode)) {
    return;
  }

  const sessionHeaders = request.apiContextHeaders;
  const apiToken = request.apiTokenContext;
  const tenantDbName = apiToken?.tenantDbName ?? sessionHeaders?.['x-tenant-db-name'];
  const tenantId = apiToken?.tenantId ?? sessionHeaders?.['x-tenant-id'];
  if (!tenantDbName || !tenantId) {
    return;
  }

  const actorUser = request.rbacUser ?? apiToken?.user ?? null;
  const method = request.method.toUpperCase();
  const action = getRequiredPermissionLevel(method, service);
  const apiTokenId = apiToken?.tokenRecord?._id
    ? String(apiToken.tokenRecord._id)
    : undefined;

  fireAndForget('api-audit-log', () => recordAuditLog(
    { tenantDbName, tenantId },
    {
      action,
      actorEmail: actorUser?.email ?? sessionHeaders?.['x-user-email'],
      actorRole: actorUser?.role ?? sessionHeaders?.['x-user-role'],
      actorType: apiToken ? 'api_token' : 'user',
      actorUserId: actorUser?._id
        ? String(actorUser._id)
        : (apiToken?.tokenRecord.userId ?? sessionHeaders?.['x-user-id']),
      apiTokenId,
      event: `${method} ${pathname}`,
      ipAddress: getClientIp(request),
      method,
      outcome: getAuditOutcome(statusCode, request.upstreamStatusForwarded),
      path: pathname,
      projectId: apiToken?.projectId,
      requestId: request.apiRequestId,
      service,
      statusCode,
      userAgent: getHeaderString(request, 'user-agent'),
    },
  ));
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

    // The server now starts listening before `bootstrapApplication()`
    // finishes (see app.ts) so every other route here would otherwise run
    // against a cache/queue/cluster provider — or tenant reconciliation —
    // that hasn't initialized yet. `/health/*` is exempt: `/health/live` is
    // a pure liveness check and `/health/ready` reports this same flag
    // itself, so both need to keep responding during the boot window.
    if (!pathname.startsWith('/api/health/') && !isApplicationReady()) {
      return reply.code(503).send({
        error: 'ServiceUnavailable',
        message: 'Server is still starting up. Retry shortly.',
      });
    }

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

    if (isSelfAuthApiPath(pathname)) {
      // gpu-agent (and similar machine-to-machine endpoints) verify their own
      // bearer tokens. Skip the cookie-session check; the handler is on the hook.
      return;
    }

    if (clientApiRequest) {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        const message = 'Missing or invalid Authorization header. Use: Bearer <token>';
        // The Messages route speaks Anthropic's envelope; an SDK handed the
        // generic body reports "401 (no body)" instead of this message.
        if (pathname === '/api/client/v1/messages') {
          return unauthorized(reply, anthropicErrorBody(message, 'authentication_error'));
        }
        return unauthorized(reply, { error: 'Unauthorized', message });
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

    const sessionHeaders = buildSessionHeaders(payload, requestId);
    if (!sessionHeaders) {
      return unauthorized(reply, {
        error: 'Unauthorized',
        message: 'Tenant context is missing',
      });
    }

    request.apiSession = payload;
    request.apiContextHeaders = sessionHeaders;

    // ── Enterprise license guard (runtime gate, layer 2) ───────────────────
    // No-op in the community edition (enterprise routes don't exist). In the
    // enterprise edition this turns a FREE tenant hitting an enterprise route
    // into a clean 402.
    //
    // The license type/expiry used here is re-resolved from the tenant's
    // CURRENT record (via a short-lived cache), never taken from the
    // session JWT: the JWT can be days old, and a license downgrade must
    // apply to every already-logged-in user of the tenant, not just the
    // acting admin whose cookie gets re-issued.
    if (getEnterpriseModuleForPath(pathname)) {
      const liveLicense = await resolveLiveLicenseForTenant(payload.tenantId);
      const enterpriseDenial = checkEnterpriseApiAccess(
        pathname,
        liveLicense.licenseType,
        liveLicense.licenseExpiresAt,
      );
      if (enterpriseDenial) {
        return reply.code(enterpriseDenial.status).send(enterpriseDenial.body);
      }
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    enqueueAuditLog(request, reply);
  });

  await app.register(agentsApiPlugin);
  await app.register(alertsApiPlugin);
  await app.register(auditApiPlugin);
  await app.register(authApiPlugin);
  await app.register(clientA2aApiPlugin);
  await app.register(clientAgentsApiPlugin);
  await app.register(clientAnalyticsApiPlugin);
  await app.register(clientAuditApiPlugin);
  await app.register(clientMonitoringApiPlugin);
  await app.register(clientProvidersApiPlugin);
  await app.register(clientModelsApiPlugin);
  await app.register(clientLicenseApiPlugin);
  await app.register(clientProjectsApiPlugin);
  await app.register(clientMembersApiPlugin);
  await app.register(clientUsersApiPlugin);
  await app.register(clientBatchesApiPlugin);
  await app.register(clientModerationsApiPlugin);
  await app.register(clientSpendApiPlugin);
  await app.register(clientAutomationsApiPlugin);
  await app.register(clientConfigApiPlugin);
  await app.register(clientFilesApiPlugin);
  await app.register(clientGuardrailsApiPlugin);
  await app.register(clientInferenceApiPlugin);
  await app.register(clientAudioOcrApiPlugin);
  await app.register(clientMemoryApiPlugin);
  // Built-in console MCP server must register before the dynamic user MCP
  // plugin so its static `/console/*` routes win over the parametric
  // `/:serverKey/*` routes.
  await app.register(clientMcpConsoleApiPlugin);
  await app.register(clientMcpApiPlugin);
  // Unauthenticated MCP endpoints for servers with accessMode 'public'
  // (slug-addressed; see PUBLIC_API_PREFIXES).
  await app.register(publicMcpApiPlugin);
  // Unauthenticated A2A endpoints for agents with accessMode 'public'.
  await app.register(publicA2aApiPlugin);
  await app.register(clientPiiApiPlugin);
  await app.register(clientEvaluationsApiPlugin);
  await app.register(clientPromptsApiPlugin);
  await app.register(clientRagApiPlugin);
  await app.register(clientRerankerApiPlugin);
  // NOTE: the public client Tools API (`/api/client/v1/tools`) is retired —
  // Tools are an agent-module capability now, executed server-side through
  // agent tool bindings. The dashboard management API (`/api/tools`) stays.
  await app.register(clientTracingApiPlugin);
  await app.register(clientVectorApiPlugin);
  await app.register(clientWebSearchApiPlugin);
  await app.register(clientBrowserApiPlugin);
  await app.register(clientBrowserMcpApiPlugin);
  await app.register(automationsApiPlugin);
  await app.register(browserApiPlugin);
  await app.register(crawlerApiPlugin);
  await app.register(clientCrawlerApiPlugin);
  await app.register(ocrJobsApiPlugin);
  await app.register(clientOcrJobsApiPlugin);
  await app.register(configApiPlugin);
  await app.register(modelPriceCatalogApiPlugin);
  await app.register(snapshotsApiPlugin);
  await app.register(datasetImportApiPlugin);
  await app.register(dashboardApiPlugin);
  await app.register(filesApiPlugin);
  await app.register(guardrailsApiPlugin);
  await app.register(evaluationsApiPlugin);
  await app.register(redTeamApiPlugin);
  await app.register(clientRedTeamApiPlugin);
  await app.register(analysisApiPlugin);
  await app.register(piiApiPlugin);
  await app.register(healthApiPlugin);
  await app.register(inferenceMonitoringApiPlugin);
  await app.register(licenseApiPlugin);
  await app.register(mcpApiPlugin);
  await app.register(memoryApiPlugin);
  await app.register(metricsApiPlugin);
  await app.register(modelsApiPlugin);
  await app.register(promptsApiPlugin);
  await app.register(providersApiPlugin);
  await app.register(projectsApiPlugin);
  await app.register(groupsApiPlugin);
  await app.register(quotaApiPlugin);
  await app.register(ragApiPlugin);
  await app.register(rerankerApiPlugin);
  await app.register(specsApiPlugin);
  await app.register(supportApiPlugin);
  await app.register(tokensApiPlugin);
  await app.register(toolsApiPlugin);
  await app.register(tracingApiPlugin);
  await app.register(usersApiPlugin);
  await app.register(vectorApiPlugin);
  await app.register(websearchApiPlugin);

  // ── Enterprise overlay seam ──────────────────────────────────────────────
  // Registers the enterprise Fastify plugins (gpu-fleet, sandbox runtime,
  // cluster admin, ...). No-op in the community edition (registry is empty).
  await registerEnterpriseApiPlugins(app);
};
