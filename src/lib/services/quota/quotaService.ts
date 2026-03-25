import { getDatabase, type IQuotaPolicy } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { getPlanQuotaLimits } from '@/lib/quota/planLimits';
import type { QuotaDomain, QuotaPolicy, QuotaPolicyInput, QuotaScope } from '@/lib/quota/types';

function normalizePolicy(policy: IQuotaPolicy): QuotaPolicy {
  return {
    ...policy,
    _id: policy._id ? policy._id.toString() : undefined,
  };
}

export async function getPlanDefaults(licenseType: LicenseType) {
  return getPlanQuotaLimits(licenseType);
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
  return db.deleteQuotaPolicy(id, tenantId, projectId);
}
