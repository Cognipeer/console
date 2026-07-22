import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { getDatabase, type IUser } from '@/lib/database';
import { isShuttingDown } from '@/lib/core/lifecycle';
import type { LicenseType } from '@/lib/license/license-manager';
import { patchRequestContext, runWithRequestContext } from '@/lib/core/requestContext';
import {
  authorizeServiceRequest,
  getPermissionServiceForPath,
  type GroupTenantGrant,
} from '@/lib/security/rbac';
import {
  ApiTokenAuthError,
  requireApiTokenFromHeader,
  type ApiTokenContext,
} from '@/lib/services/apiTokenAuth';
import {
  ProjectContextError,
  resolveProjectContext,
  type ProjectContext,
} from '@/lib/services/projects/projectContext';

export interface ApiSessionContext {
  requestId: string;
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
  userEmail?: string;
  userId: string;
  userRole: string;
  licenseType: LicenseType | string;
}

class RbacAuthorizationError extends Error {
  status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = 'RbacAuthorizationError';
    this.status = status;
  }
}

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

export function getClientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }

  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0].trim();
  }

  const realIp = request.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim().length > 0) {
    return realIp.trim();
  }

  return request.ip || 'unknown';
}

export function getSessionContext(
  request: FastifyRequest,
): ApiSessionContext | null {
  const headers = request.apiContextHeaders;
  if (!headers) {
    return null;
  }

  const tenantDbName = headers['x-tenant-db-name'];
  const tenantId = headers['x-tenant-id'];
  const tenantSlug = headers['x-tenant-slug'];
  const userEmail = headers['x-user-email'];
  const userId = headers['x-user-id'];
  const userRole = headers['x-user-role'];
  const licenseType = headers['x-license-type'];

  if (
    !tenantDbName
    || !tenantId
    || !tenantSlug
    || !userId
    || !userRole
    || !licenseType
  ) {
    return null;
  }

  return {
    requestId: request.apiRequestId ?? headers['x-request-id'] ?? 'unknown',
    tenantDbName,
    tenantId,
    tenantSlug,
    userEmail,
    userId,
    userRole,
    licenseType,
  };
}

export function requireSessionContext(
  request: FastifyRequest,
): ApiSessionContext {
  const session = getSessionContext(request);
  if (!session) {
    throw new Error('Unauthorized');
  }
  return session;
}

function getRequestPathname(request: FastifyRequest): string {
  return new URL(request.raw.url || '/', 'http://localhost').pathname;
}

async function loadRbacUser(session: ApiSessionContext): Promise<IUser> {
  const db = await getDatabase();
  await db.switchToTenant(session.tenantDbName);
  // Defense-in-depth: verify the active tenant context matches the session.
  // Real providers always implement assertTenantContext; test mocks may not.
  if (typeof db.assertTenantContext === 'function') {
    db.assertTenantContext(session.tenantDbName);
  }
  const user = await db.findUserById(session.userId);
  if (!user) {
    throw new RbacAuthorizationError('Unauthorized', 401);
  }
  // Defense-in-depth: ensure the loaded user record actually belongs to the
  // session's tenant. (DB partitioning already enforces this, but a mis-bound
  // mock or future refactor could break the invariant — fail loudly here.)
  if (user.tenantId && String(user.tenantId) !== String(session.tenantId)) {
    throw new RbacAuthorizationError('Tenant mismatch', 403);
  }
  return user;
}

/**
 * Loads the tenant-level grants of every group the user belongs to. These are
 * unioned with the user's own role/permissions at authorization time, so group
 * membership can only ever raise access. Resolved per request (not baked into
 * the session) so group edits take effect immediately without re-login.
 */
async function loadGroupTenantGrants(
  db: Awaited<ReturnType<typeof getDatabase>>,
  userId: string,
): Promise<GroupTenantGrant[]> {
  // Defensive: a provider without group support (or a partial test double) must
  // never break the authorization gate — treat a missing/empty result as "no
  // group grants" rather than throwing.
  const memberships = typeof db.listGroupMembersByUser === 'function'
    ? await db.listGroupMembersByUser(userId)
    : [];
  if (!Array.isArray(memberships) || memberships.length === 0) return [];

  const grants: GroupTenantGrant[] = [];
  for (const membership of memberships) {
    const group = await db.findGroupById(String(membership.groupId));
    if (!group) continue;
    const hasServiceGrant = group.servicePermissions && Object.keys(group.servicePermissions).length > 0;
    if (group.tenantRole || hasServiceGrant) {
      grants.push({ tenantRole: group.tenantRole, servicePermissions: group.servicePermissions });
    }
  }
  return grants;
}

/**
 * Resolves the RBAC user + group grants for routes that are not covered by the
 * route-prefix map (e.g. /api/dashboard) but still need per-item permission
 * filtering inside the handler. Reuses the exact same loaders as the
 * route-level RBAC gate so both paths can never diverge.
 */
export async function resolveSessionRbacContext(
  session: ApiSessionContext,
): Promise<{ user: IUser; groupGrants: GroupTenantGrant[] }> {
  const user = await loadRbacUser(session);
  const db = await getDatabase();
  const groupGrants = await loadGroupTenantGrants(db, String(user._id));
  return { user, groupGrants };
}

async function enforceSessionRbac(request: FastifyRequest, session: ApiSessionContext): Promise<void> {
  const pathname = getRequestPathname(request);
  if (!getPermissionServiceForPath(pathname)) {
    return;
  }

  const user = await loadRbacUser(session);
  request.rbacUser = user;
  // db is already switched to the session tenant by loadRbacUser.
  const db = await getDatabase();
  const groupGrants = await loadGroupTenantGrants(db, String(user._id));
  const decision = authorizeServiceRequest(user, request.method, pathname, groupGrants);
  if (!decision.allowed) {
    throw new RbacAuthorizationError(
      `Forbidden: ${decision.service} requires ${decision.required} permission`,
      403,
    );
  }
}

function enforceApiTokenRbac(
  request: FastifyRequest,
  context: ApiTokenContext,
): void {
  const pathname = getRequestPathname(request);
  if (!getPermissionServiceForPath(pathname)) {
    return;
  }

  if (!context.user) {
    throw new RbacAuthorizationError('API token owner is not available', 403);
  }

  request.rbacUser = context.user;
  const decision = authorizeServiceRequest(
    context.user,
    request.method,
    pathname,
    [],
    // Least-privilege token scope: when the token carries its own
    // servicePermissions allowlist, cap the owner-derived permission at it.
    // Unscoped tokens (null) inherit the owner's permissions unchanged.
    context.tokenRecord.servicePermissions,
  );
  if (!decision.allowed) {
    throw new RbacAuthorizationError(
      `Forbidden: ${decision.service} requires ${decision.required} permission`,
      403,
    );
  }
}

export function sendProjectContextError(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof ProjectContextError) {
    return reply.code(error.status).send({ error: error.message });
  }

  if (error instanceof Error && error.message === 'Unauthorized') {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  return null;
}

function sendRbacError(reply: FastifyReply, error: unknown) {
  if (error instanceof RbacAuthorizationError) {
    return reply.code(error.status).send({ error: error.message });
  }
  return null;
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

export function withApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (request: TRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      return reply
        .code(503)
        .header('Retry-After', '5')
        .send({ error: 'Service is shutting down' });
    }

    const session = getSessionContext(request);

    try {
      if (session) {
        await enforceSessionRbac(request, session);
      }

      return runWithRequestContext(
        {
          requestId: request.apiRequestId,
          tenantId: session?.tenantId,
          tenantSlug: session?.tenantSlug,
          userId: session?.userId,
          actorType: session ? 'user' : undefined,
          source: 'dashboard',
        },
        async () => {
          // Bind the tenant DB for the whole handler execution so every nested
          // query resolves to this session's tenant. Without this, cookie/RBAC
          // (dashboard) requests never establish a tenant scope at request top
          // and fall back to the process-global tenant binding, which a
          // concurrent request for another tenant can overwrite — causing
          // cross-tenant reads/writes (e.g. a provider/model landing in the
          // wrong tenant DB). Mirrors the client-API (token) path above.
          const db = await getDatabase();
          if (session?.tenantDbName && typeof db.runWithTenant === 'function') {
            return db.runWithTenant(session.tenantDbName, () =>
              handler(request as TRequest, reply),
            );
          }
          return handler(request as TRequest, reply);
        },
      );
    } catch (error) {
      return sendRbacError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  };
}

export async function requireApiTokenContext(
  request: FastifyRequest,
): Promise<ApiTokenContext> {
  return requireApiTokenFromHeader(getHeaderValue(request, 'authorization'));
}

export async function getApiTokenContextForRequest(
  request: FastifyRequest,
): Promise<ApiTokenContext> {
  if (request.apiTokenContext) {
    return request.apiTokenContext;
  }

  const context = await requireApiTokenContext(request);
  request.apiTokenContext = context;
  return context;
}

export function sendApiTokenError(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof ApiTokenAuthError) {
    return reply.code(error.status).send({ error: error.message });
  }

  return null;
}

/** Error envelope styles for the client (token) API. */
export type ClientApiErrorStyle = 'json' | 'openai';

export interface ClientApiContextOptions {
  /**
   * Response envelope on error. `'json'` → `{ error: string }` (the default,
   * used by most client routes). `'openai'` → `{ error: { message, type } }`
   * for OpenAI-SDK-compatible routes (chat/completions, embeddings, audio).
   */
  errorStyle?: ClientApiErrorStyle;
  /**
   * Enforce API-token RBAC for paths that map to a permission service. Defaults
   * to `true`. Only set `false` for routes that are intentionally open to any
   * valid token regardless of the token owner's service permissions. (RBAC is a
   * no-op for paths with no permission-service mapping, so leaving it on is
   * safe and is what closes accidental bypasses.)
   */
  rbac?: boolean;
}

function openAiErrorBody(message: string, type: string) {
  return { error: { message, type } };
}

/**
 * Single error responder for the client (token) API. Maps the well-known error
 * types to the right status + envelope so every token route reports failures
 * identically. Returns the reply (never null) so callers can `return` it.
 */
function sendClientApiError(
  reply: FastifyReply,
  error: unknown,
  style: ClientApiErrorStyle,
) {
  if (error instanceof ApiTokenAuthError) {
    if (style === 'openai') {
      // OpenAI SDKs treat auth failures as 401 regardless of the finer status.
      return reply.code(401).send(openAiErrorBody(error.message, 'invalid_request_error'));
    }
    return reply.code(error.status).send({ error: error.message });
  }

  if (error instanceof RbacAuthorizationError) {
    if (style === 'openai') {
      return reply.code(error.status).send(openAiErrorBody(error.message, 'permission_error'));
    }
    return reply.code(error.status).send({ error: error.message });
  }

  if (style === 'openai') {
    return reply.code(500).send(openAiErrorBody('Internal server error', 'server_error'));
  }
  return reply
    .code(500)
    .send({ error: error instanceof Error ? error.message : 'Internal server error' });
}

/**
 * THE canonical wrapper for every API-token ("client") route. It is the single
 * source of truth for the token request lifecycle:
 *   1. shutdown guard (503),
 *   2. authenticate the Bearer token → ApiTokenContext (stored on the request),
 *   3. enforce API-token RBAC (unless `rbac: false`; no-op for unmapped paths),
 *   4. bind the tenant DB for the WHOLE handler via `runWithTenant` (immune to
 *      the cross-tenant process-global race under concurrent load),
 *   5. uniform error responses (`errorStyle`).
 * The resolved `auth` context is passed as the handler's third argument.
 *
 * Do not hand-roll this per plugin — pass options instead. Local clones drift
 * (e.g. silently skipping RBAC on chat/embeddings/ocr-jobs).
 */
export function withClientApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
  options: ClientApiContextOptions = {},
) {
  const errorStyle: ClientApiErrorStyle = options.errorStyle ?? 'json';
  const enforceRbac = options.rbac ?? true;

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      if (errorStyle === 'openai') {
        return reply
          .code(503)
          .header('Retry-After', '5')
          .send(openAiErrorBody('Service is shutting down', 'server_error'));
      }
      return reply
        .code(503)
        .header('Retry-After', '5')
        .send({ error: 'Service is shutting down' });
    }

    let apiToken: ApiTokenContext;
    try {
      apiToken = await requireApiTokenContext(request);
      request.apiTokenContext = apiToken;
      if (enforceRbac) {
        enforceApiTokenRbac(request, apiToken);
      }
    } catch (error) {
      return sendClientApiError(reply, error, errorStyle);
    }

    try {
      return await runWithRequestContext(
        {
          requestId: request.apiRequestId,
          tenantId: apiToken.tenantId,
          tenantSlug: apiToken.tenantSlug,
          userId: apiToken.tokenRecord.userId
            ? String(apiToken.tokenRecord.userId)
            : apiToken.user?._id
              ? String(apiToken.user._id)
              : undefined,
          projectId: apiToken.projectId ?? undefined,
          apiTokenId: apiToken.tokenRecord._id ? String(apiToken.tokenRecord._id) : undefined,
          actorType: 'api_token',
          source: 'api',
        },
        async () => {
          // Bind the tenant DB for the whole handler execution so every nested
          // query resolves to the token's tenant. Without this, client-API
          // (token) requests never establish a tenant scope at request top and
          // fall back to the process-global tenant binding, which a concurrent
          // request for another tenant can overwrite — causing cross-tenant
          // reads/writes. Mirrors the cookie/RBAC path.
          const db = await getDatabase();
          if (typeof db.runWithTenant === 'function') {
            return db.runWithTenant(apiToken.tenantDbName, () =>
              handler(request as TRequest, reply, apiToken),
            );
          }
          await db.switchToTenant(apiToken.tenantDbName);
          return handler(request as TRequest, reply, apiToken);
        },
      );
    } catch (error) {
      return sendClientApiError(reply, error, errorStyle);
    }
  };
}

/**
 * Convenience for OpenAI-SDK-compatible token routes (chat/completions,
 * embeddings, audio/*, ocr). Identical to {@link withClientApiRequestContext}
 * but emits the OpenAI `{ error: { message, type } }` envelope. RBAC stays on
 * by default (no-op for paths without a permission service) — this is what
 * closes the historical bypasses on the routes that DO map to a service.
 */
export function withOpenAiApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
  options: Omit<ClientApiContextOptions, 'errorStyle'> = {},
) {
  return withClientApiRequestContext(handler, { ...options, errorStyle: 'openai' });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie('token', { path: '/' });
  reply.clearCookie('active_project_id', { path: '/' });
}

export function setSessionCookies(
  reply: FastifyReply,
  options: {
    token: string;
    activeProjectId?: string;
  },
): void {
  const isProduction = getConfig().nodeEnv === 'production';

  reply.setCookie('token', options.token, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
    sameSite: 'lax',
    secure: isProduction,
  });

  if (options.activeProjectId) {
    reply.setCookie('active_project_id', options.activeProjectId, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
      sameSite: 'lax',
      secure: isProduction,
    });
    return;
  }

  reply.clearCookie('active_project_id', { path: '/' });
}

export async function requireProjectContextForRequest(
  request: FastifyRequest,
): Promise<ProjectContext & { session: ApiSessionContext }> {
  const session = getSessionContext(request);
  if (!session) {
    throw new Error('Unauthorized');
  }

  const projectContext = await resolveProjectContext({
    activeProjectId: request.cookies.active_project_id,
    tenantDbName: session.tenantDbName,
    tenantId: session.tenantId,
    userId: session.userId,
  });

  if (projectContext.projectId) {
    patchRequestContext({ projectId: String(projectContext.projectId) });
  }

  return {
    ...projectContext,
    session,
  };
}
