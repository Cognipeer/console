import { getDatabase } from '@/lib/database';

export async function resolveTenantDbName(tenantSlug: string) {
  const db = await getDatabase();
  const tenant = await db.findTenantBySlug(tenantSlug);

  if (!tenant) {
    throw new Error('Tenant not found');
  }

  return { tenantDbName: tenant.dbName, tenantId: tenant._id ?? tenantSlug };
}
