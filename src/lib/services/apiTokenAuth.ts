import { getDatabase, runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import { fireAndForget } from '@/lib/core/asyncTask';
import type { ITenant, IUser, IApiToken } from '@/lib/database';
import { LicenseManager } from '@/lib/license/license-manager';
import { hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { hasIpRestriction, isIpAllowed, TOKEN_IP_NOT_ALLOWED } from '@/lib/services/apiTokens/ipAllowlist';
import { isUserDisabled } from '@/lib/services/users/userAuthState';

const logger = createLogger('api-token-auth');
import { ensureDefaultProject } from '@/lib/services/projects/projectService';

/** Who was refused, when a refusal is worth auditing. Never serialized into a response. */
export interface ApiTokenDenialContext {
  tenantId: string;
  tenantDbName: string;
  tokenId?: string;
  userId?: string;
  projectId?: string;
  clientIp?: string;
}

export class ApiTokenAuthError extends Error {
  status: number;
  /** Machine-readable reason for refusals that have one (`ip_not_allowed`); plain 401s carry none. */
  code?: string;
  denial?: ApiTokenDenialContext;

  constructor(message: string, status = 401, code?: string, denial?: ApiTokenDenialContext) {
    super(message);
    this.name = 'ApiTokenAuthError';
    this.status = status;
    this.code = code;
    this.denial = denial;
  }
}

export interface ApiTokenAuthOptions {
  /**
   * The caller's address as the server resolved it (Fastify's `request.ip`,
   * which honours `TRUSTED_PROXIES`). Required for a token that carries an IP
   * allowlist: without it such a token is refused, never waved through.
   */
  clientIp?: string | null;
}

export interface ApiTokenContext {
  token: string;
  tokenRecord: IApiToken;
  tenant: ITenant;
  tenantId: string;
  tenantSlug: string;
  tenantDbName: string;
  projectId: string;
  user: IUser | null;
}

export interface ApiTokenRequestLike {
  headers: {
    get(name: string): string | null;
  };
  /** The caller's address (Fastify's `request.ip`); needed to honour a token's IP allowlist. */
  ip?: string | null;
}

/**
 * The auth-cache key for a given token hash. Exported so the token-delete
 * path can invalidate the exact same entry `requireApiTokenFromHeader`
 * writes — without this, a deleted token stayed valid on every replica for
 * up to the cache's own TTL after the delete succeeded.
 */
export function apiAuthCacheKey(tokenHash: string): string {
  return `api-auth:${tokenHash.substring(0, 16)}`;
}

/**
 * Evict the auth-cache entry of one token (by its stored hash) so a delete or
 * owner disable takes effect immediately on every replica instead of after the
 * cache TTL. Best effort: the token row is the source of truth and the entry
 * expires on its own TTL if the cache is unreachable, so this never throws.
 */
export async function invalidateApiTokenAuthCache(tokenHash: string | undefined): Promise<void> {
  if (!tokenHash) return;
  try {
    const cache = await getCache();
    await cache.del(apiAuthCacheKey(tokenHash));
  } catch (error) {
    logger.warn('Failed to invalidate api-auth cache', { error });
  }
}

export async function requireApiTokenFromHeader(
  authHeader: string | null | undefined,
  options: ApiTokenAuthOptions = {},
): Promise<ApiTokenContext> {
  const normalizedHeader = authHeader ?? null;

  if (!normalizedHeader || !normalizedHeader.toLowerCase().startsWith('bearer ')) {
    throw new ApiTokenAuthError('Missing or invalid authorization header');
  }

  const token = normalizedHeader.slice('bearer '.length).trim();

  if (!token) {
    throw new ApiTokenAuthError('Missing API token');
  }

  const db = await getDatabase();

  // Cache tokenRecord + tenant to avoid 2 DB lookups per request
  const tokenHash = hashApiToken(token);
  const cacheKey = apiAuthCacheKey(tokenHash);

  interface CachedAuth { tokenRecord: IApiToken; tenant: ITenant }
  let cached: CachedAuth | undefined;
  try {
    const cache = await getCache();
    cached = await cache.get<CachedAuth>(cacheKey);
  } catch { /* cache miss — continue to DB */ }

  let tokenRecord: IApiToken | null;
  let tenant: ITenant | null;

  if (cached) {
    tokenRecord = cached.tokenRecord;
    tenant = cached.tenant;
  } else {
    tokenRecord = await db.findApiTokenByHash(tokenHash);
    if (!tokenRecord) {
      throw new ApiTokenAuthError('Invalid API token');
    }

    tenant = await db.findTenantById(tokenRecord.tenantId);
    if (!tenant) {
      throw new ApiTokenAuthError('Tenant not found for token', 404);
    }

    try {
      const cache = await getCache();
      await cache.set(cacheKey, { tokenRecord, tenant }, 60);
    } catch { /* best-effort cache write */ }
  }

  // Reject expired tokens. Checked on every request (not cached on the token
  // record alone) so an expiry that elapses within the auth-cache window still
  // takes effect on the next call.
  if (tokenRecord.expiresAt) {
    const expiresAtMs = new Date(tokenRecord.expiresAt).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      throw new ApiTokenAuthError('API token has expired');
    }
  }

  // Network allowlist. Checked on EVERY request (the record may come from the
  // auth cache, which a token edit invalidates), in every authorization mode,
  // and before anything with side effects (tenant binding, default-project
  // creation, the last-used stamp), so a refused call leaves no trace on the
  // token. A token without a list is unrestricted; one with a list and no
  // usable client address is refused.
  if (hasIpRestriction(tokenRecord.allowedIpRanges) && !isIpAllowed(options.clientIp, tokenRecord.allowedIpRanges)) {
    throw new ApiTokenAuthError(
      'API token is not allowed from this IP address',
      403,
      TOKEN_IP_NOT_ALLOWED,
      {
        tenantId: String(tokenRecord.tenantId),
        tenantDbName: tenant.dbName,
        tokenId: tokenRecord._id ? String(tokenRecord._id) : undefined,
        userId: tokenRecord.userId ? String(tokenRecord.userId) : undefined,
        projectId: tokenRecord.projectId ? String(tokenRecord.projectId) : undefined,
        clientIp: options.clientIp ?? undefined,
      },
    );
  }

  const effectiveLicense = LicenseManager.getEffectiveLicenseForTenant(tenant);
  tenant = {
    ...tenant,
    licenseType: effectiveLicense.licenseType,
  };

  await db.switchToTenant(tenant.dbName);

  // The owner is loaded fresh on every request (never cached) so disabling or
  // deleting the account cuts off its tokens immediately. It is resolved
  // before anything with side effects (default-project creation, last-used
  // stamp) and fails closed: an unreadable, missing, or disabled owner means
  // no access.
  let user: IUser | null;
  try {
    // Scoped lookup: this runs before the request-bound tenant context exists,
    // and the process-global switchToTenant binding above can be overwritten by
    // a concurrent request for another tenant (spurious 401s under load).
    user = await runWithTenantScope(tenant.dbName, (d) => d.findUserById(tokenRecord.userId));
  } catch (error) {
    logger.warn('Unable to resolve user for API token', { error });
    throw new ApiTokenAuthError('Unable to verify API token owner', 503);
  }
  if (!user) {
    throw new ApiTokenAuthError('API token owner no longer exists', 401);
  }
  if (isUserDisabled(user)) {
    throw new ApiTokenAuthError('API token owner is disabled', 401);
  }

  // Non-critical last-used timestamp update — fire and forget
  fireAndForget('token-last-used', async () => {
    const bgDb = await getDatabase();
    await bgDb.updateTokenLastUsedByHash(tokenHash);
  });

  const defaultProject = await ensureDefaultProject(
    tenant.dbName,
    tokenRecord.tenantId,
    tokenRecord.userId,
  );
  const defaultProjectId = defaultProject._id ? String(defaultProject._id) : undefined;
  const projectId = tokenRecord.projectId || defaultProjectId;
  if (!projectId) {
    throw new ApiTokenAuthError('Token project context is missing', 400);
  }

  return {
    token,
    tokenRecord,
    tenant,
    tenantId: tokenRecord.tenantId,
    tenantSlug: tenant.slug,
    tenantDbName: tenant.dbName,
    projectId,
    user,
  };
}

export async function requireApiToken(
  request: ApiTokenRequestLike,
): Promise<ApiTokenContext> {
  return requireApiTokenFromHeader(request.headers.get('authorization'), { clientIp: request.ip });
}
