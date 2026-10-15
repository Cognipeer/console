import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IApiToken } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { invalidateApiTokenAuthCache } from '@/lib/services/apiTokenAuth';
import { checkRateLimit, type RateLimitConfig } from '@/lib/services/auth/rateLimiter';
import { isUserDisabled } from '@/lib/services/users/userAuthState';
import { recordPeopleAudit } from '@/lib/services/users/peopleAudit';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { MAX_ALLOWED_IP_RANGES } from '@/lib/services/apiTokens/ipAllowlist';
import { recordTokenRestrictionChange, type TokenRestrictionChange } from '@/lib/services/apiTokens/restrictionAudit';
import { recordTokenDelegationChange } from '@/lib/services/apiTokens/delegationAudit';
import { authz } from '@/lib/iam/routeAuthz';
import {
  deleteTokenDelegation,
  delegationAuditSnapshot,
  dropTokenDelegation,
  getTokenDelegation,
  parseDelegationInput,
  putTokenDelegation,
  toDelegationView,
} from '@/lib/iam/tokenDelegation';
import {
  canActOnTokensOf,
  EXTERNAL_TOKEN_OWNER_REFUSAL,
  canListProjectTokens,
  canManageToken,
  filterManageableTokens,
  findTokenOwner,
  resolveManageableProjectToken,
  resolveManageableToken,
} from '@/lib/services/apiTokens/tokenGovernance';
import { collectAccessibleProjectIds } from '@/lib/services/projects/accessibleProjects';
import { canonicalizeRequestPathname } from '@/lib/security/requestPath';
import {
  expiryRequired,
  loadTokenPolicyForDisplay,
  prepareTokenCreate,
  prepareTokenUpdate,
  presentApiToken,
  tokenExceedsPolicy,
  presentAllowedIpRanges,
} from '@/lib/services/apiTokens/tokenPolicy';
import {
  getEffectiveServicePermission,
  minPermission,
  normalizeServicePermissions,
  RBAC_SERVICE_DEFINITIONS,
  resolveCurrentServicePermission,
  type PermissionService,
  type RbacUserLike,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import {
  getAuthzClientIp,
  getClientIp,
  trustsEveryHop,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  readJsonBody,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:tokens');

const ALLOWED_ROLES = new Set(['owner', 'admin', 'project_admin', 'user', 'portal_user']);

/** Most tokens one revoke request names (a page of the directory). */
export const MAX_REVOKE_IDS = 100;
/** Revoke requests per person per minute. */
const REVOKE_RATE_LIMIT: RateLimitConfig = { maxAttempts: 20, windowSeconds: 60 };

// The never-upward predicates live with the other token rules; they are exported
// from here as well because the client-API plugins have always imported them from this file.
export { canActOnTokensOf, filterManageableTokens, resolveManageableProjectToken };

/**
 * Normalise a requested per-token scope and CLAMP every service to the minting
 * user's own effective permission — a token can never be minted above its owner
 * (the runtime RBAC cap enforces this too; this is defense-in-depth + honesty in
 * the stored value). Returns `null` when no scope was requested (unscoped token,
 * inherits owner — the legacy default). Returns an object (possibly `{}`) when a
 * scope WAS requested (least-privilege allowlist).
 */
export async function resolveRequestedTokenScope(
  db: Awaited<ReturnType<typeof getDatabase>>,
  minterUserId: string,
  requestedRaw: unknown,
): Promise<UserServicePermissions | null> {
  if (requestedRaw === undefined || requestedRaw === null) {
    return null;
  }
  const requested = normalizeServicePermissions(requestedRaw);
  const minter = await db.findUserById(minterUserId);
  const scope: UserServicePermissions = {};
  for (const [service, level] of Object.entries(requested)) {
    const ownerLevel = minter
      ? getEffectiveServicePermission(minter, service as PermissionService)
      : 'none';
    scope[service as PermissionService] = minPermission(level, ownerLevel);
  }
  return scope;
}

/**
 * The scope stored on a token a NON-OWNER mints for ANOTHER user.
 *
 * Such a token is never left unscoped: an unscoped token resolves to the target
 * user's full permission at runtime, which is exactly how a restricted admin
 * used to launder its own restrictions through a more-privileged colleague's
 * name. Instead every service is pinned to
 * `min(requested-or-target level, minter's effective level)`, where the
 * minter's level already accounts for its own token scope when the minter is
 * itself an API token. The result can only ever be at or below BOTH parties.
 *
 * Pure so it can be tested without a database; callers pass the loaded users.
 */
export function clampScopeToMinter(args: {
  minter: RbacUserLike;
  minterTokenScope?: UserServicePermissions | null;
  target: RbacUserLike;
  requestedRaw: unknown;
}): UserServicePermissions {
  const requested = args.requestedRaw === undefined || args.requestedRaw === null
    ? null
    : normalizeServicePermissions(args.requestedRaw);
  const scope: UserServicePermissions = {};
  for (const { id: service } of RBAC_SERVICE_DEFINITIONS) {
    const targetLevel = getEffectiveServicePermission(args.target, service);
    const wanted = requested ? requested[service] ?? 'none' : targetLevel;
    // Group grants are deliberately not consulted: they can only RAISE the
    // minter's level, so leaving them out makes the clamp stricter, never looser.
    const minterLevel = resolveCurrentServicePermission(args.minter, service, [], args.minterTokenScope);
    scope[service] = minPermission(minPermission(wanted, targetLevel), minterLevel);
  }
  return scope;
}

export interface TokenEditResult {
  status: number;
  body: unknown;
  /** Set when an edit changed the expiry or the IP allowlist (what the audit row records). */
  change?: TokenRestrictionChange;
}

/**
 * Edit the mutable fields of one token (label, expiry, IP allowlist) on behalf
 * of a dashboard session. Shared by `/tokens/:id` and `/projects/:projectId/tokens/:id`.
 *
 * Who may edit: the token's owner always; anyone else only by the same
 * "never upward" rule that governs minting, listing and deleting
 * (canManageToken), so a project_admin cannot loosen the allowlist or extend the
 * expiry of an admin's or the owner's token. An extension of the expiry is checked
 * against the tenant token policy; the new values reach the auth path immediately
 * (the cached token record is evicted).
 */
export async function editApiTokenForSession(args: {
  db: Awaited<ReturnType<typeof getDatabase>>;
  session: { userId: string; userRole: string; tenantId: string; tenantDbName: string };
  projectId: string;
  tokenId: string;
  body: Record<string, unknown>;
  /**
   * Asked before anything but the caller's own token is looked at: may the caller work in
   * `projectId`? Given when the request names a project other than the one it runs in (the
   * active project is checked for membership by the request context itself). A project the
   * caller cannot reach answers 403 whether or not such a token exists there.
   */
  canReachProject?: (projectId: string) => Promise<boolean>;
}): Promise<TokenEditResult> {
  const { db, session, projectId, tokenId, body, canReachProject } = args;

  const token = await db.findApiTokenById(tokenId, session.tenantId);
  const own = !!token && String(token.userId) === String(session.userId);
  if (!own && canReachProject && !(await canReachProject(String(projectId)))) {
    return { status: 403, body: { error: 'Forbidden' } };
  }
  if (!token || String(token.projectId) !== String(projectId)) {
    return { status: 404, body: { error: 'Token not found' } };
  }

  if (!own) {
    const owner = await findTokenOwner(db, String(token.userId), session.tenantId);
    if (!canManageToken(session, token, owner)) return { status: 403, body: { error: 'Forbidden' } };
  }

  const prepared = await prepareTokenUpdate({ body, tenantDbName: session.tenantDbName, token });
  if (!prepared.ok) return { status: prepared.status, body: prepared.body };

  let updated = token;
  if (Object.keys(prepared.patch).length > 0) {
    const result = await db.updateApiToken(tokenId, session.tenantId, prepared.patch);
    if (!result) return { status: 404, body: { error: 'Token not found' } };
    updated = result;
    // The auth path caches a token record for up to a minute; evict it so a
    // tightened allowlist or a shortened expiry applies to the very next call.
    await invalidateApiTokenAuthCache(token.tokenHash);
  }

  const policy = prepared.policy ?? await loadTokenPolicyForDisplay(session.tenantDbName);
  // Being allowed to edit a token is being allowed to manage it, so it can be revoked as well.
  const view = presentApiToken(updated, { policy, canDelete: true, canEdit: true });
  const restrictionsTouched = prepared.patch.expiresAt !== undefined || prepared.patch.allowedIpRanges !== undefined
    || prepared.patch.requireUserToken !== undefined;
  const change: TokenRestrictionChange | undefined = restrictionsTouched
    ? {
      tokenId,
      label: updated.label,
      ownerUserId: String(updated.userId),
      projectId: String(projectId),
      before: { ...restrictionSnapshot(token) },
      after: { ...restrictionSnapshot(updated) },
    }
    : undefined;
  return { status: 200, body: view, change };
}

function restrictionSnapshot(token: { expiresAt?: Date | string | null; allowedIpRanges?: string[] | null; requireUserToken?: boolean }) {
  const expires = token.expiresAt ? new Date(token.expiresAt) : null;
  return {
    expiresAt: expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : null,
    allowedIpRanges: presentAllowedIpRanges(token.allowedIpRanges),
    requireUserToken: token.requireUserToken === true,
  };
}

/**
 * Write the audit row for an edit that touched the expiry or the IP allowlist.
 * Best effort and off the response path: the edit has already succeeded.
 */
export function auditTokenRestrictionChange(
  request: FastifyRequest,
  session: { userId: string; userRole: string; tenantId: string; tenantDbName: string; userEmail?: string },
  change: TokenRestrictionChange | undefined,
): void {
  if (!change) return;
  const userAgent = request.headers['user-agent'];
  try {
    // Imported statically on purpose: the write is scheduled (criticalFireAndForget) in the same
    // tick as the edit, so `drainPendingTasks()` is a real barrier for it - a lazily imported
    // module would schedule it at some later, unpredictable moment.
    recordTokenRestrictionChange({
      tenantId: session.tenantId,
      tenantDbName: session.tenantDbName,
      actorUserId: session.userId,
      actorEmail: session.userEmail,
      actorRole: session.userRole,
      requestId: request.apiRequestId,
      ipAddress: getClientIp(request),
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      method: request.method,
      path: canonicalizeRequestPathname(request.raw.url),
      change,
    });
  } catch (error) {
    logger.warn('Could not audit a token restriction change', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * True when no trusted proxy is configured (`TRUSTED_PROXIES` unset). IP rules
 * (token allowlists, policy conditions) are then checked against the direct
 * connection address (getAuthzClientIp), never a forwarded-for header: safe, but
 * behind a reverse proxy every caller looks like the proxy until the proxy is
 * named in `TRUSTED_PROXIES`. The token screens say so.
 */
function trustsForwardedHeaders(): boolean {
  return trustsEveryHop();
}

/** A JSON object body, or null when it is missing, malformed or not an object. */
export function readBodyObject(request: Parameters<typeof readJsonBody>[0]): Record<string, unknown> | null {
  try {
    const body = readJsonBody<unknown>(request);
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A query value that is absent or a non-empty string; `null` when it is anything else (a repeated key, an object). */
function queryString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  return value === '' ? undefined : value;
}

/** Roles that may work with the tokens of a project they are not a member of: they are in every project. */
function isAllProjectsRole(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * The projects a person who is not in every project can reach: a membership, the legacy
 * project list, or a group. The one answer minting, editing and revoking judge a token's
 * project by.
 */
async function reachableProjectIds(db: Awaited<ReturnType<typeof getDatabase>>, userId: string): Promise<string[]> {
  const person = await db.findUserById(userId);
  return collectAccessibleProjectIds(db, userId, person?.projectIds);
}

export const tokensApiPlugin: FastifyPluginAsync = async (app) => {
  // The tenant's token rules, for the create/edit form. Readable by everyone who
  // can manage tokens (an end user minting their own token needs the limits
  // without holding the Authorization engine permission). `clientIp` is the
  // address this request was resolved to, shown as a hint so nobody locks
  // themselves out of an allowlist they are about to save.
  app.get('/tokens/policy', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const policy = await loadTokenPolicyForDisplay(session.tenantDbName);
      const clientIp = getAuthzClientIp(request);
      return reply.code(200).send({
        maxLifetimeDays: policy.tokens.maxLifetimeDays,
        requireExpiry: policy.tokens.requireExpiry,
        expiryRequired: expiryRequired(policy),
        maxIpRanges: MAX_ALLOWED_IP_RANGES,
        clientIp: clientIp === 'unknown' ? null : clientIp,
        trustsForwardedHeaders: trustsForwardedHeaders(),
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/tokens', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const db = await getDatabase();

      // Every role lists its OWN tokens. A wider view is always explicit and
      // never goes upward:
      //   ?userId=<id>    one other user's tokens (the person's page in the
      //                   Authorization center) - the rule minting for them follows;
      //   ?scope=project  the project's tokens (the quota policy picker) -
      //                   owner/admin only, and it leaves out the tokens of anyone
      //                   the caller could not open with ?userId=.
      const query = (request.query ?? {}) as { scope?: unknown; userId?: unknown };
      const scope = queryString(query.scope);
      const requestedUserId = queryString(query.userId);
      if (scope === null || requestedUserId === null) {
        return reply.code(400).send({ error: 'Invalid query', code: 'invalid_filter' });
      }
      if (scope !== undefined && scope !== 'project') {
        return reply.code(400).send({ error: 'Unsupported scope', code: 'invalid_filter' });
      }

      let listed: IApiToken[];
      if (scope === 'project') {
        if (!canListProjectTokens(session.userRole)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }
        if (requestedUserId) {
          return reply.code(400).send({ error: 'scope and userId cannot be combined', code: 'invalid_filter' });
        }
        listed = await filterManageableTokens(
          db,
          session,
          await db.listProjectApiTokens(session.tenantId, projectId),
        );
      } else {
        const targetUserId = requestedUserId ?? session.userId;
        if (targetUserId !== session.userId) {
          // Resolved like every other account behind a token, so an id the
          // provider cannot parse is a 404 on every backend, not a 500.
          const targetUser = await findTokenOwner(db, targetUserId, session.tenantId);
          if (!targetUser) {
            return reply.code(404).send({ error: 'User not found' });
          }
          if (!canActOnTokensOf(session.userRole, targetUser)) {
            return reply.code(403).send({ error: 'Forbidden' });
          }
        }
        const userTokens = await db.listApiTokens(targetUserId);
        listed = userTokens.filter(
          (token) =>
            String(token.tenantId) === String(session.tenantId)
            && String(token.projectId) === String(projectId),
        );
      }

      const policy = await loadTokenPolicyForDisplay(session.tenantDbName);
      const now = new Date();
      // Whatever is listed here is the caller's to manage: their own tokens, or
      // those of an account they may act on (see above).
      return reply.code(200).send({
        tokens: listed.map((token) => presentApiToken(token, { policy, now, canDelete: true, canEdit: true })),
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/tokens', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId: activeProjectId } = await requireProjectContextForRequest(request);
      const body = readJsonBody<{
        label?: unknown;
        servicePermissions?: unknown;
        userId?: unknown;
        projectId?: unknown;
        expiresAt?: unknown;
        expiresInDays?: unknown;
        allowedIpRanges?: unknown;
        requireUserToken?: unknown;
      }>(request);

      if (typeof body.label !== 'string' || body.label.length < 3) {
        return reply.code(400).send({ error: 'Label must be at least 3 characters' });
      }
      if (body.projectId !== undefined && body.projectId !== null && typeof body.projectId !== 'string') {
        return reply.code(400).send({ error: 'projectId must be a string', code: 'invalid_body' });
      }
      if (body.userId !== undefined && body.userId !== null && typeof body.userId !== 'string') {
        return reply.code(400).send({ error: 'userId must be a string', code: 'invalid_body' });
      }

      const db = await getDatabase();

      // The token lives in the active project unless the request names another
      // one (the Authorization center creates tokens for people whatever project
      // it was opened in). Another project must exist in this workspace, and the
      // minter must be in it: owners and admins are in every project.
      let projectId = activeProjectId;
      const requestedProjectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
      if (requestedProjectId && requestedProjectId !== activeProjectId) {
        let project = null;
        try {
          project = await db.findProjectById(requestedProjectId);
        } catch {
          // an id the provider cannot parse names no project
        }
        if (!project || String(project.tenantId) !== String(session.tenantId)) {
          return reply.code(404).send({ error: 'Project not found' });
        }
        if (!isAllProjectsRole(session.userRole) && !(await reachableProjectIds(db, session.userId)).includes(requestedProjectId)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }
        projectId = requestedProjectId;
      }

      // Minting for another user (service-account pattern: a user with
      // login disabled can never reach this endpoint with their own
      // session, so an admin mints on their behalf instead).
      let ownerUserId = session.userId;
      let servicePermissions: UserServicePermissions | null;
      if (typeof body.userId === 'string' && body.userId && body.userId !== session.userId) {
        const targetUser = await findTokenOwner(db, body.userId, session.tenantId);
        if (!targetUser) {
          return reply.code(404).send({ error: 'User not found' });
        }
        if (!canActOnTokensOf(session.userRole, targetUser)) {
          return reply.code(403).send({ error: 'Forbidden' });
        }
        // External accounts (a host application's people) hold no API tokens at all.
        if (targetUser.kind === 'external') {
          return reply.code(400).send(EXTERNAL_TOKEN_OWNER_REFUSAL);
        }
        // A token minted for a disabled account would be dead on arrival
        // (the auth path rejects its owner) and would silently outlive a
        // later re-enable; make the admin enable the user first.
        if (isUserDisabled(targetUser)) {
          return reply.code(400).send({ error: 'User is disabled' });
        }
        ownerUserId = body.userId;

        if (session.userRole === 'owner') {
          // The owner dominates every permission, so nothing it mints can
          // exceed what it could grant; the legacy shape (unscoped when no
          // scope is requested, target-clamped otherwise) is kept unchanged.
          servicePermissions = await resolveRequestedTokenScope(db, ownerUserId, body.servicePermissions);
        } else {
          const minter = await db.findUserById(session.userId);
          if (!minter) {
            return reply.code(401).send({ error: 'Unauthorized' });
          }
          servicePermissions = clampScopeToMinter({
            minter,
            target: targetUser,
            requestedRaw: body.servicePermissions,
          });
        }
      } else {
        // Self-service: clamped to the minter's own effective permission.
        servicePermissions = await resolveRequestedTokenScope(db, ownerUserId, body.servicePermissions);
      }

      const existingTokens = await db.listProjectApiTokens(session.tenantId, projectId);
      const quotaCheck = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: session.licenseType as LicenseType,
          projectId,
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        'apiTokens',
        existingTokens.length,
      );

      if (!quotaCheck.allowed) {
        return reply.code(429).send({
          error: quotaCheck.reason || 'API token quota exceeded',
        });
      }

      // Expiry + IP allowlist, checked against the tenant token policy. Every
      // mint endpoint goes through the same preparation, so the policy cannot be
      // sidestepped by picking another route.
      const prepared = await prepareTokenCreate({ body, tenantDbName: session.tenantDbName });
      if (!prepared.ok) {
        return reply.code(prepared.status).send(prepared.body);
      }

      const token = createApiTokenSecret();
      const apiToken = await db.createApiToken({
        label: body.label,
        projectId,
        tenantId: session.tenantId,
        tokenHash: hashApiToken(token),
        tokenPrefix: getApiTokenPrefix(token),
        userId: ownerUserId,
        createdBy: session.userId,
        servicePermissions,
        ...(prepared.expiresAt ? { expiresAt: prepared.expiresAt } : {}),
        ...(prepared.allowedIpRanges ? { allowedIpRanges: prepared.allowedIpRanges } : {}),
        ...(prepared.requireUserToken ? { requireUserToken: true } : {}),
      });

      return reply.code(201).send({
        id: apiToken._id,
        label: apiToken.label,
        message: 'API token created successfully',
        projectId,
        servicePermissions: apiToken.servicePermissions ?? null,
        token,
        userId: apiToken.userId,
        expiresAt: prepared.expiresAt ? prepared.expiresAt.toISOString() : null,
        allowedIpRanges: presentAllowedIpRanges(apiToken.allowedIpRanges),
        requireUserToken: apiToken.requireUserToken === true,
        lastUsedAt: null,
        exceedsTenantPolicy: tokenExceedsPolicy(apiToken, prepared.policy),
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // Revoke many tokens by id, whatever project they live in. Each id is judged by the same
  // never-upward rule as DELETE /tokens/:id, one at a time, so one refused id does not stop
  // the rest. Owners and admins are in every project (a token whose project was deleted is
  // theirs to revoke); anyone else revokes a token of their own wherever it lives, and
  // another person's only in a project they are in - the rule of minting there.
  app.post('/tokens/revoke', { config: { skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const body = readBodyObject(request);
      const rawIds = body?.ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((id) => typeof id !== 'string' || id === '')) {
        return reply.code(400).send({ error: 'ids must be a non-empty list of token ids', code: 'invalid_body' });
      }
      const ids = [...new Set(rawIds as string[])];
      if (ids.length > MAX_REVOKE_IDS) {
        return reply.code(400).send({ error: `At most ${MAX_REVOKE_IDS} tokens can be revoked at once`, code: 'too_many_ids' });
      }

      const limit = checkRateLimit(`tokens-revoke:${session.userId}`, REVOKE_RATE_LIMIT);
      if (!limit.allowed) {
        return reply.code(429).header('Retry-After', String(limit.retryAfterSeconds)).send({
          error: 'Too many revoke requests. Please try again shortly.',
          code: 'rate_limited',
        });
      }

      const db = await getDatabase();
      const actor = {
        type: 'user' as const,
        userId: session.userId,
        email: session.userEmail,
        role: session.userRole,
        requestId: session.requestId,
        ipAddress: getClientIp(request),
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
        method: request.method.toUpperCase(),
        path: canonicalizeRequestPathname(request.raw.url),
      };

      // The projects the caller can reach: read once per request, and only when a token that is
      // not theirs gets that far.
      let reachable: Promise<string[]> | null = null;
      const reachesProjectOf = async (token: { projectId?: unknown }): Promise<boolean> => {
        if (isAllProjectsRole(session.userRole)) return true;
        if (typeof token.projectId !== 'string' || token.projectId === '') return false;
        reachable ??= reachableProjectIds(db, session.userId);
        return (await reachable).includes(token.projectId);
      };

      const results: Array<{ id: string; outcome: 'revoked' | 'skipped' | 'failed'; code?: 'token_not_found' | 'higher_privileges' | 'failed' }> = [];
      for (const id of ids) {
        try {
          const target = await resolveManageableToken(db, session, id);
          if (!target.ok) {
            results.push({ id, outcome: 'skipped', code: target.reason === 'forbidden' ? 'higher_privileges' : 'token_not_found' });
            continue;
          }
          const ownerId = String(target.token.userId);
          // A project the caller is not in does not exist for them: the same answer as for an id nobody has.
          if (ownerId !== String(session.userId) && !(await reachesProjectOf(target.token))) {
            results.push({ id, outcome: 'skipped', code: 'token_not_found' });
            continue;
          }
          // Per owner (not per tenant): revoking a page of tokens must not flush every principal of the workspace.
          const deleted = await db.deleteApiToken(id, ownerId);
          if (!deleted) {
            results.push({ id, outcome: 'skipped', code: 'token_not_found' });
            continue;
          }
          await invalidateApiTokenAuthCache(target.token.tokenHash);
          await dropTokenDelegation(session.tenantDbName, id);
          recordPeopleAudit(session, actor, {
            event: 'token.revoke',
            resourceType: 'token',
            resourceId: id,
            metadata: {
              tokenId: id,
              label: target.token.label,
              ownerUserId: ownerId,
              projectId: target.token.projectId ?? null,
              batch: ids.length > 1,
            },
          });
          results.push({ id, outcome: 'revoked' });
        } catch (error) {
          logger.error('Could not revoke an API token', {
            tokenId: id.slice(0, 64),
            error: error instanceof Error ? error.message : String(error),
          });
          results.push({ id, outcome: 'failed', code: 'failed' });
        }
      }

      const count = (outcome: string) => results.filter((result) => result.outcome === outcome).length;
      return reply.code(200).send({
        requested: ids.length,
        revoked: count('revoked'),
        skipped: count('skipped'),
        failed: count('failed'),
        results,
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // Edit label / expiry / IP allowlist. Only the fields present in the body change.
  // The token is looked up in the active project unless `?projectId=` names the one it lives in:
  // owners and admins may name any project, anyone else only one they are in (a token of their own
  // is theirs wherever it lives) - the rule of minting there.
  app.put('/tokens/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId: activeProjectId } = await requireProjectContextForRequest(request);
      const requestedProject = queryString(((request.query ?? {}) as { projectId?: unknown }).projectId);
      if (requestedProject === null) {
        return reply.code(400).send({ error: 'Invalid query', code: 'invalid_filter' });
      }
      const body = readBodyObject(request);
      if (!body) {
        return reply.code(400).send({ error: 'The request body must be a JSON object', code: 'invalid_body' });
      }

      const db = await getDatabase();
      const projectId = requestedProject ?? activeProjectId;
      const result = await editApiTokenForSession({
        db,
        session,
        projectId,
        tokenId: id,
        body,
        // Another project than the one the request runs in: owners and admins are in every project;
        // anyone else has to be in it to edit somebody else's token there (a token of their own is
        // theirs wherever it lives).
        ...(projectId !== activeProjectId && !isAllProjectsRole(session.userRole)
          ? { canReachProject: async (candidate: string) => (await reachableProjectIds(db, session.userId)).includes(candidate) }
          : {}),
      });
      auditTokenRestrictionChange(request, session, result.change);
      return reply.code(result.status).send(result.body);
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── acting for users ────────────────────────────────────────────────────────────────────────────────────────────
  // What an application's token may do on behalf of the people the application vouches for (lib/iam/tokenDelegation.ts).
  // Owners and admins only - by the live account, never the session's claim - and never upward: the same rule as every other
  // edit of someone's token (the owner touches everyone's, an admin everyone's but the owner's). Setting it up lets the
  // token act as OTHER accounts, so it is an access-rule change: it is audited with what it was and what it became (no secrets).

  /** The token the caller may set up delegation for, or the reply that says why not. */
  const delegationTarget = async (
    request: FastifyRequest,
    reply: Parameters<Parameters<typeof withApiRequestContext>[0]>[1],
  ) => {
    const session = requireSessionContext(request);
    const live = request.rbacUser;
    if (!live || (live.role !== 'owner' && live.role !== 'admin')) {
      reply.code(403).send({ error: 'Only owners and admins can set up acting for users', code: 'forbidden' });
      return null;
    }
    const { id } = request.params as { id: string };
    const db = await getDatabase();
    const target = await resolveManageableToken(db, { tenantId: session.tenantId, userId: session.userId, userRole: live.role }, id);
    if (!target.ok) {
      if (target.reason === 'forbidden') reply.code(403).send({ error: 'Forbidden', code: 'higher_privileges' });
      else reply.code(404).send({ error: 'Token not found', code: 'token_not_found' });
      return null;
    }
    return { session, live, db, token: target.token, tokenId: String(id) };
  };

  const auditDelegation = (
    request: FastifyRequest,
    ctx: { session: ReturnType<typeof requireSessionContext>; live: { role: string }; token: IApiToken; tokenId: string },
    change: 'created' | 'updated' | 'removed',
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) => {
    const userAgent = request.headers['user-agent'];
    try {
      recordTokenDelegationChange({
        tenantId: ctx.session.tenantId,
        tenantDbName: ctx.session.tenantDbName,
        actorUserId: ctx.session.userId,
        actorEmail: ctx.session.userEmail,
        actorRole: ctx.live.role,
        requestId: request.apiRequestId,
        ipAddress: getClientIp(request),
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
        method: request.method,
        path: canonicalizeRequestPathname(request.raw.url),
        tokenId: ctx.tokenId,
        label: ctx.token.label,
        ownerUserId: String(ctx.token.userId),
        projectId: ctx.token.projectId ? String(ctx.token.projectId) : undefined,
        change,
        before,
        after,
      });
    } catch (error) {
      logger.warn('Could not audit a token delegation change', { error: error instanceof Error ? error.message : String(error) });
    }
  };

  app.get('/tokens/:id/delegation', { config: authz.service('tokens', 'admin') }, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await delegationTarget(request, reply);
      if (!ctx) return reply;
      const stored = await getTokenDelegation(ctx.session.tenantDbName, ctx.tokenId);
      return reply.code(200).send({
        delegation: stored ? toDelegationView(stored) : null,
        // A token that acts for people is only as narrow as its own scope: the screen says so for an unscoped one.
        tokenScoped: ctx.token.servicePermissions !== null && ctx.token.servicePermissions !== undefined,
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.put('/tokens/:id/delegation', { config: { ...authz.service('tokens', 'admin'), skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await delegationTarget(request, reply);
      if (!ctx) return reply;
      const body = readBodyObject(request);
      if (!body) {
        return reply.code(400).send({ error: 'The request body must be a JSON object', code: 'invalid_body' });
      }
      const before = await getTokenDelegation(ctx.session.tenantDbName, ctx.tokenId);
      const parsed = parseDelegationInput(body, before?.config ?? null);
      if (!parsed.ok) {
        return reply.code(400).send({ error: parsed.problems[0]?.message ?? 'Invalid settings', code: 'invalid_body', problems: parsed.problems });
      }
      const stored = await putTokenDelegation(ctx.session.tenantDbName, ctx.tokenId, parsed.config, ctx.session.userId);
      auditDelegation(request, ctx, before ? 'updated' : 'created', delegationAuditSnapshot(before?.config ?? null), delegationAuditSnapshot(parsed.config));
      return reply.code(200).send({
        delegation: toDelegationView(stored),
        tokenScoped: ctx.token.servicePermissions !== null && ctx.token.servicePermissions !== undefined,
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/tokens/:id/delegation', { config: { ...authz.service('tokens', 'admin'), skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await delegationTarget(request, reply);
      if (!ctx) return reply;
      const before = await getTokenDelegation(ctx.session.tenantDbName, ctx.tokenId);
      const deleted = await deleteTokenDelegation(ctx.session.tenantDbName, ctx.tokenId);
      if (deleted) auditDelegation(request, ctx, 'removed', delegationAuditSnapshot(before?.config ?? null), null);
      return reply.code(200).send({ deleted });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/tokens/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const db = await getDatabase();

      let deleted: boolean;
      let tokenHash: string | undefined;
      if (session.userRole === 'user') {
        const ownTokens = await db.listApiTokens(session.userId);
        const token = ownTokens.find((item) => String(item._id) === String(id));
        if (
          !token
          || String(token.tenantId) !== String(session.tenantId)
          || String(token.projectId) !== String(projectId)
        ) {
          deleted = false;
        } else {
          tokenHash = token.tokenHash;
          deleted = await db.deleteApiToken(id, session.userId);
        }
      } else {
        // Someone else's token goes under the same never-upward rule as
        // minting for them.
        const target = await resolveManageableProjectToken(db, session, projectId, id);
        if (!target.ok) {
          return target.reason === 'forbidden'
            ? reply.code(403).send({ error: 'Forbidden' })
            : reply.code(404).send({ error: 'Token not found' });
        }
        tokenHash = target.token.tokenHash;
        // Per owner, like the revoke endpoint: deleting one token does not flush the principals of the whole workspace.
        deleted = await db.deleteApiToken(id, String(target.token.userId));
      }

      if (!deleted) {
        return reply.code(404).send({ error: 'Token not found' });
      }

      await invalidateApiTokenAuthCache(tokenHash);
      // what the token was set up to act for goes with it (nothing reads it any more; this only tidies)
      await dropTokenDelegation(session.tenantDbName, id);

      return reply.code(200).send({ message: 'API token deleted successfully' });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
