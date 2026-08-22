import { getDatabase, type IQuotaPolicy } from '@/lib/database';
import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';
import { LicenseManager } from '@/lib/license/license-manager';
import { quotaPolicyCacheKey } from '@/lib/quota/quotaGuard';
import type { QuotaDomain, QuotaPolicy, QuotaPolicyInput, QuotaScope } from '@/lib/quota/types';

const logger = createLogger('quota-service');

/**
 * Drop the cached license + policy set so an edit applies to the next request
 * instead of after QUOTA_POLICY_CACHE_TTL_SECONDS.
 *
 * Best-effort, and only for a mutation that names a project. A tenant-wide
 * policy carries no project yet applies to every one of them, and the cache is
 * keyed per project — there is no single key to drop, so those edits land on
 * the TTL instead.
 */
async function invalidatePolicyCache(
  tenantDbName: string,
  tenantId: string,
  projectId?: string,
): Promise<void> {
  if (!projectId) return;

  try {
    const cache = await getCache();
    await cache.del(quotaPolicyCacheKey(tenantDbName, tenantId, projectId));
  } catch (error) {
    logger.warn('Failed to invalidate quota policy cache; entry expires on TTL', {
      tenantId,
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizePolicy(policy: IQuotaPolicy): QuotaPolicy {
  return {
    ...policy,
    _id: policy._id ? policy._id.toString() : undefined,
  };
}

export async function getLicenseDefaults(tenantId: string) {
  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId);
  return LicenseManager.getEffectiveLicenseForTenant(tenant);
}

export interface ListQuotaPoliciesOptions {
  domain?: QuotaDomain;
  scope?: QuotaScope;
  enabled?: boolean;
  projectId?: string;
}

export async function listQuotaPolicies(
  tenantDbName: string,
  tenantId: string,
  options?: ListQuotaPoliciesOptions,
): Promise<QuotaPolicy[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const allPolicies = await db.listQuotaPolicies(tenantId, options?.projectId);
  
  let policies = allPolicies;
  
  // Apply filters
  if (options?.domain) {
    policies = policies.filter(p => p.domain === options.domain || p.domain === 'global');
  }
  if (options?.scope) {
    policies = policies.filter(p => p.scope === options.scope);
  }
  if (options?.enabled !== undefined) {
    policies = policies.filter(p => (p as { enabled?: boolean }).enabled === options.enabled);
  }
  
  return policies.map(normalizePolicy);
}

export async function createQuotaPolicy(
  tenantDbName: string,
  tenantId: string,
  payload: QuotaPolicyInput,
): Promise<QuotaPolicy> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const now = new Date();
  const policy = await db.createQuotaPolicy({
    ...payload,
    tenantId,
    createdAt: now,
    updatedAt: now,
  });

  await invalidatePolicyCache(tenantDbName, tenantId, payload.projectId);

  return normalizePolicy(policy);
}

export async function updateQuotaPolicy(
  tenantDbName: string,
  tenantId: string,
  id: string,
  payload: Partial<QuotaPolicyInput>,
  projectId?: string,
): Promise<QuotaPolicy | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const updated = await db.updateQuotaPolicy(id, tenantId, {
    ...payload,
    updatedAt: new Date(),
  }, projectId);

  await invalidatePolicyCache(tenantDbName, tenantId, projectId);

  return updated ? normalizePolicy(updated) : null;
}

export async function deleteQuotaPolicy(
  tenantDbName: string,
  tenantId: string,
  id: string,
  projectId?: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const deleted = await db.deleteQuotaPolicy(id, tenantId, projectId);

  await invalidatePolicyCache(tenantDbName, tenantId, projectId);

  return deleted;
}
