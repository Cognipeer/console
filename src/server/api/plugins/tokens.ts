import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IUser } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { invalidateApiTokenAuthCache } from '@/lib/services/apiTokenAuth';
import { isUserDisabled } from '@/lib/services/users/userAuthState';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { MAX_ALLOWED_IP_RANGES } from '@/lib/services/apiTokens/ipAllowlist';
import { recordTokenRestrictionChange, type TokenRestrictionChange } from '@/lib/services/apiTokens/restrictionAudit';
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

const ALLOWED_ROLES = new Set(['owner', 'admin', 'project_admin', 'user']);

/**
 * Whether `actorRole` may act on (mint for, or list the tokens of) `target`.
 *
 * A token minted in someone's name authorises as that someone, so the rule is
 * "never upward": nobody but the owner touches the owner, and a project_admin
 * — whose own `tokens` permission is only `write` — is confined to the one case
 * the mint-for-others feature exists for: a login-disabled `user`-role account
 * (a service account) that can never reach this endpoint with a session of its
 * own. Self-service is always allowed and is decided before this is consulted.
 */
export function canActOnTokensOf(
  actorRole: string,
  target: Pick<IUser, 'role' | 'canLogin'>,
): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return target.role !== 'owner';
  if (actorRole === 'project_admin') {
    return target.role === 'user' && target.canLogin === false;
  }
  return false;
}

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
 * "never upward" rule that governs minting and listing (canActOnTokensOf), so a
 * project_admin cannot loosen the allowlist or extend the expiry of an admin's
 * or the owner's token. An extension of the expiry is checked against the
 * tenant token policy; the new values reach the auth path immediately (the
 * cached token record is evicted).
 */
export async function editApiTokenForSession(args: {
  db: Awaited<ReturnType<typeof getDatabase>>;
  session: { userId: string; userRole: string; tenantId: string; tenantDbName: string };
  projectId: string;
  tokenId: string;
  body: Record<string, unknown>;
}): Promise<TokenEditResult> {
  const { db, session, projectId, tokenId, body } = args;

  const token = await db.findApiTokenById(tokenId, session.tenantId);
  if (!token || String(token.projectId) !== String(projectId)) {
    return { status: 404, body: { error: 'Token not found' } };
  }

  const own = String(token.userId) === String(session.userId);
  if (!own) {
    const owner = await db.findUserById(String(token.userId));
    const allowed = owner
      ? canActOnTokensOf(session.userRole, owner)
      : session.userRole === 'owner' || session.userRole === 'admin';
    if (!allowed) return { status: 403, body: { error: 'Forbidden' } };
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
  const canDelete = own
    || session.userRole === 'owner'
    || session.userRole === 'admin'
    || session.userRole === 'project_admin';
  const view = presentApiToken(updated, { policy, canDelete, canEdit: true });
  const restrictionsTouched = prepared.patch.expiresAt !== undefined || prepared.patch.allowedIpRanges !== undefined;
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

function restrictionSnapshot(token: { expiresAt?: Date | string | null; allowedIpRanges?: string[] | null }) {
  const expires = token.expiresAt ? new Date(token.expiresAt) : null;
  return {
    expiresAt: expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : null,
    allowedIpRanges: presentAllowedIpRanges(token.allowedIpRanges),
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

/**
 * Which tokens of a list the caller may edit, as a hint for the buttons (the
 * exact decision is made again on PUT). Editing is "never upward" (see
 * canActOnTokensOf): the workspace owner edits everything; an admin everything
 * but the owner's tokens; a project_admin only service accounts; everybody their
 * own. Except for the owner, the few other token owners in the list are looked up
 * (bounded) so the button is only offered where the edit would be accepted.
 */
export async function tokenEditHints(
  db: { findUserById(id: string): Promise<IUser | null> },
  session: { userRole: string; userId: string },
  tokens: readonly { userId?: unknown }[],
): Promise<(token: { userId?: unknown }) => boolean> {
  const privileged = session.userRole === 'owner';
  const editableOwners = new Set<string>();
  if (session.userRole === 'project_admin' || session.userRole === 'admin') {
    const otherOwners = [...new Set(
      tokens.map((token) => String(token.userId)).filter((id) => id !== String(session.userId)),
    )].slice(0, 25);
    const owners = await Promise.all(otherOwners.map((id) => db.findUserById(id).catch(() => null)));
    owners.forEach((owner, index) => {
      if (owner && canActOnTokensOf(session.userRole, owner)) editableOwners.add(otherOwners[index]);
    });
  }
  return (token) => privileged || String(token.userId) === String(session.userId) || editableOwners.has(String(token.userId));
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

      // Optional ?userId= scopes the listing to a single user's tokens (used
      // by the per-user member detail page). Self-service is always allowed;
      // viewing another user's tokens follows the same never-upward rule as
      // minting for them (a project_admin must not enumerate the owner's
      // token labels, prefixes and last-used times).
      const query = request.query as { userId?: string };
      const targetUserId = query.userId;
      let allTokens;
      if (targetUserId) {
        if (targetUserId !== session.userId) {
          const targetUser = await db.findUserById(targetUserId);
          if (!targetUser || String(targetUser.tenantId) !== String(session.tenantId)) {
            return reply.code(404).send({ error: 'User not found' });
          }
          if (!canActOnTokensOf(session.userRole, targetUser)) {
            return reply.code(403).send({ error: 'Forbidden' });
          }
        }
        const userTokens = await db.listApiTokens(targetUserId);
        allTokens = userTokens.filter(
          (token) =>
            String(token.tenantId) === String(session.tenantId)
            && String(token.projectId) === String(projectId),
        );
      } else {
        allTokens = await db.listProjectApiTokens(session.tenantId, projectId);
      }

      const canDeleteAll =
        session.userRole === 'owner'
        || session.userRole === 'admin'
        || session.userRole === 'project_admin';
      const canEdit = await tokenEditHints(db, session, allTokens);
      const policy = await loadTokenPolicyForDisplay(session.tenantDbName);
      const now = new Date();
      return reply.code(200).send({
        tokens: allTokens.map((token) => {
          const own = String(token.userId) === String(session.userId);
          return presentApiToken(token, {
            policy,
            now,
            canDelete: canDeleteAll || own,
            canEdit: canEdit(token),
          });
        }),
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

      const { projectId } = await requireProjectContextForRequest(request);
      const body = readJsonBody<{
        label?: string;
        servicePermissions?: unknown;
        userId?: string;
        expiresAt?: unknown;
        expiresInDays?: unknown;
        allowedIpRanges?: unknown;
      }>(request);

      if (!body.label || body.label.length < 3) {
        return reply.code(400).send({ error: 'Label must be at least 3 characters' });
      }

      const db = await getDatabase();

      // Minting for another user (service-account pattern: a user with
      // login disabled can never reach this endpoint with their own
      // session, so an admin mints on their behalf instead).
      let ownerUserId = session.userId;
      let servicePermissions: UserServicePermissions | null;
      if (body.userId && body.userId !== session.userId) {
        const targetUser = await db.findUserById(body.userId);
        if (!targetUser || String(targetUser.tenantId) !== String(session.tenantId)) {
          return reply.code(404).send({ error: 'User not found' });
        }
        if (!canActOnTokensOf(session.userRole, targetUser)) {
          return reply.code(403).send({ error: 'Forbidden' });
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
      });

      return reply.code(201).send({
        id: apiToken._id,
        label: apiToken.label,
        message: 'API token created successfully',
        servicePermissions: apiToken.servicePermissions ?? null,
        token,
        userId: apiToken.userId,
        expiresAt: prepared.expiresAt ? prepared.expiresAt.toISOString() : null,
        allowedIpRanges: presentAllowedIpRanges(apiToken.allowedIpRanges),
        lastUsedAt: null,
        exceedsTenantPolicy: tokenExceedsPolicy(apiToken, prepared.policy),
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // Edit label / expiry / IP allowlist. Only the fields present in the body change.
  app.put('/tokens/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const body = readBodyObject(request);
      if (!body) {
        return reply.code(400).send({ error: 'The request body must be a JSON object', code: 'invalid_body' });
      }

      const db = await getDatabase();
      const result = await editApiTokenForSession({ db, session, projectId, tokenId: id, body });
      auditTokenRestrictionChange(request, session, result.change);
      return reply.code(result.status).send(result.body);
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
        const projectTokens = await db.listProjectApiTokens(session.tenantId, projectId);
        tokenHash = projectTokens.find((item) => String(item._id) === String(id))?.tokenHash;
        deleted = await db.deleteProjectApiToken(id, session.tenantId, projectId);
      }

      if (!deleted) {
        return reply.code(404).send({ error: 'Token not found' });
      }

      await invalidateApiTokenAuthCache(tokenHash);

      return reply.code(200).send({ message: 'API token deleted successfully' });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
