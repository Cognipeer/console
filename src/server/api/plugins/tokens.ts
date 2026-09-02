import type { FastifyPluginAsync } from 'fastify';
import { getDatabase } from '@/lib/database';
import type { IUser } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
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
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  readJsonBody,
  withApiRequestContext,
} from '../fastify-utils';

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

export const tokensApiPlugin: FastifyPluginAsync = async (app) => {
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

      return reply.code(200).send({
        tokens: allTokens.map((token) => ({
          _id: token._id,
          canDelete: canDeleteAll || String(token.userId) === String(session.userId),
          createdAt: token.createdAt,
          createdBy: token.createdBy ?? null,
          label: token.label,
          lastUsed: token.lastUsed,
          servicePermissions: token.servicePermissions ?? null,
          tokenPrefix: token.tokenPrefix,
          userId: token.userId,
        })),
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
      const body = readJsonBody<{ label?: string; servicePermissions?: unknown; userId?: string }>(request);

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
      });

      return reply.code(201).send({
        id: apiToken._id,
        label: apiToken.label,
        message: 'API token created successfully',
        servicePermissions: apiToken.servicePermissions ?? null,
        token,
        userId: apiToken.userId,
      });
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

      const deleted = session.userRole === 'user'
        ? await (async () => {
          const ownTokens = await db.listApiTokens(session.userId);
          const token = ownTokens.find((item) => String(item._id) === String(id));
          if (!token) {
            return false;
          }
          if (
            String(token.tenantId) !== String(session.tenantId)
            || String(token.projectId) !== String(projectId)
          ) {
            return false;
          }
          return db.deleteApiToken(id, session.userId);
        })()
        : await db.deleteProjectApiToken(id, session.tenantId, projectId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Token not found' });
      }

      return reply.code(200).send({ message: 'API token deleted successfully' });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
