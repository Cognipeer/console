import { NextRequest } from 'next/server';
import { getDatabase } from '@/lib/database';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import type { ITenant, IUser, IApiToken } from '@/lib/database';

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
  user: IUser | null;
}

export async function requireApiToken(request: NextRequest): Promise<ApiTokenContext> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    throw new ApiTokenAuthError('Missing or invalid authorization header');
  }

  const token = authHeader.slice('bearer '.length).trim();

  if (!token) {
    throw new ApiTokenAuthError('Missing API token');
  }

  const db = await getDatabase();
  const tokenRecord = await db.findApiTokenByToken(token);

  if (!tokenRecord) {
    throw new ApiTokenAuthError('Invalid API token');
  }

  await db.updateTokenLastUsed(token);

  const tenant = await db.findTenantById(tokenRecord.tenantId);

  if (!tenant) {
    throw new ApiTokenAuthError('Tenant not found for token', 404);
  }

  const { tenantDbName } = await resolveTenantDbName(tenant.slug);
  await db.switchToTenant(tenantDbName);

  let user: IUser | null = null;
  try {
    user = await db.findUserById(tokenRecord.userId);
  } catch (error) {
    console.warn('Unable to resolve user for API token', error);
  }

  return {
    token,
    tokenRecord,
    tenant,
    tenantId: tokenRecord.tenantId,
    tenantSlug: tenant.slug,
    tenantDbName,
    user,
  };
}
