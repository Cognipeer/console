/**
 * The `piiProtection` field of a model or an agent, as an API body carries it.
 *
 *   absent                 -> unchanged
 *   null / false / ""      -> off
 *   { policyKey: "..." }   -> on, with that PII policy (it must exist in the project)
 */

import { runWithTenantScope, type IPiiProtectionConfig } from '@/lib/database';

export type PiiProtectionField =
  | { value?: undefined; error?: undefined }
  | { value: IPiiProtectionConfig | null; error?: undefined }
  | { value?: undefined; error: string };

export async function readPiiProtectionField(
  raw: unknown,
  scope: { tenantDbName: string; projectId?: string },
): Promise<PiiProtectionField> {
  if (raw === undefined) return {};
  if (raw === null || raw === false || raw === '') return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'piiProtection must be an object like { "policyKey": "..." }, or null to turn it off' };
  }
  const policyKey = (raw as { policyKey?: unknown }).policyKey;
  if (typeof policyKey !== 'string' || policyKey.trim() === '') {
    return { error: 'piiProtection.policyKey is required' };
  }
  return runWithTenantScope(scope.tenantDbName, async (db) => {
    const policy = await db.findPiiPolicyByKey(policyKey.trim(), scope.projectId);
    if (!policy) {
      return { error: `piiProtection.policyKey: PII policy "${policyKey.trim()}" not found in this project` };
    }
    return { value: { policyKey: policy.key } };
  });
}
