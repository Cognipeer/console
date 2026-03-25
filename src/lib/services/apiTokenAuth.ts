import { createHash } from 'crypto';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import { fireAndForget } from '@/lib/core/asyncTask';
import type { ITenant, IUser, IApiToken } from '@/lib/database';

const logger = createLogger('api-token-auth');
import { ensureDefaultProject } from '@/lib/services/projects/projectService';

export class ApiTokenAuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'ApiTokenAuthError';
    this.status = status;
  }
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
}

export async function requireApiTokenFromHeader(
  authHeader: string | null | undefined,
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
  const tokenHash = createHash('sha256').update(token).digest('hex').substring(0, 16);
  const cacheKey = `api-auth:${tokenHash}`;

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
    tokenRecord = await db.findApiTokenByToken(token);
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

  // Non-critical last-used timestamp update — fire and forget
  fireAndForget('token-last-used', async () => {
    const bgDb = await getDatabase();
    await bgDb.switchToTenant(tenant.dbName);
    await bgDb.updateTokenLastUsed(token);
  });

  await db.switchToTenant(tenant.dbName);

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

  let user: IUser | null = null;
  try {
    user = await db.findUserById(tokenRecord.userId);
  } catch (error) {
    logger.warn('Unable to resolve user for API token', { error });
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
  return requireApiTokenFromHeader(request.headers.get('authorization'));
}
