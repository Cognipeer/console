/**
 * The policy list narrowed to one resource (`GET /api/iam/policies?resourceType=&resourceId=`):
 * the custom policies that name it or apply to every resource of its kind, each with
 * which of the two (`scope`). The portal page shows them next to the portal's access
 * list ("policies that also apply"); the built-in ones are listed as always.
 *
 * Only portals are judged today (policyRows.policyReach); any other type answers an
 * empty list rather than a guess.
 */

import { listManagedPolicyViews, policiesReaching, toPolicyRows, type ManagedPolicyView, type PolicyRow } from './policyRows';
import { isSafeId } from './policySpec';
import type { IamTenant } from './principals';
import { listIamResourceTypes } from './resourceTypes';
import { listPolicies } from './store';

export class PolicyFilterError extends Error {
  readonly code = 'validation';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PolicyFilterError';
  }
}

export interface PoliciesForResource {
  managed: ManagedPolicyView[];
  custom: Array<PolicyRow & { scope: 'this' | 'all' }>;
}

export async function listPoliciesForResource(
  tenant: IamTenant,
  filter: { resourceType?: unknown; resourceId?: unknown },
): Promise<PoliciesForResource> {
  const type = typeof filter.resourceType === 'string' ? filter.resourceType : '';
  const id = typeof filter.resourceId === 'string' ? filter.resourceId : '';
  if (!type || !id) throw new PolicyFilterError('resourceType and resourceId go together');
  if (!listIamResourceTypes().some((t) => t.type === type)) throw new PolicyFilterError(`"${type.slice(0, 60)}" is not a resource type`);
  if (!isSafeId(id)) throw new PolicyFilterError('resourceId is not a valid id');

  const policies = (await listPolicies(tenant.tenantDbName)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const reaching = policiesReaching(policies, { type, id });
  const rows = await toPolicyRows(tenant, reaching.map((r) => r.policy));
  return {
    managed: listManagedPolicyViews(),
    custom: rows.map((row, i) => ({ ...row, scope: reaching[i].scope })),
  };
}
