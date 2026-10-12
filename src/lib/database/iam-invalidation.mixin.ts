/**
 * Provider-level invalidation hooks for the policy engine's principal cache.
 *
 * Group membership, user permissions and project assignments are written from
 * many places (dashboard + client APIs, LDAP/SSO provisioning, lifecycle
 * jobs, the enterprise overlay). Rather than wiring a call into every one of
 * them, the composed provider is wrapped once: after any of the mutations below
 * succeeds the affected cache entries are dropped. The wrapper only observes —
 * results and errors pass through untouched, and a throwing listener is
 * swallowed by `emitIamInvalidation`.
 *
 * The tenant label comes from the provider's own tenant scope; when no scope
 * is bound (null) listeners invalidate across all tenants, which is always safe.
 */

import {
  invalidatePrincipal,
  invalidateTenantPrincipals,
} from '@/lib/iam/events';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConstructor = new (...args: any[]) => object;
type Method = (this: unknown, ...args: unknown[]) => unknown;
type TenantAware = { getCurrentTenantDbName?: () => string | null };

type Effect = (tenant: string | null, args: unknown[]) => void;

const idArg = (index: number): Effect => (tenant, args) => {
  const value = args[index];
  if (typeof value === 'string' && value) invalidatePrincipal(tenant, value);
  else if (value && typeof value === 'object') {
    const userId = (value as { userId?: unknown }).userId;
    if (typeof userId === 'string' && userId) invalidatePrincipal(tenant, userId);
    else invalidateTenantPrincipals(tenant);
  } else invalidateTenantPrincipals(tenant);
};
const userFromRecord: Effect = (tenant, args) => idArg(0)(tenant, args);
const wholeTenant: Effect = (tenant) => invalidateTenantPrincipals(tenant);

/** Mutations that can change what a principal is allowed to do. */
export const IAM_INVALIDATING_METHODS: Record<string, Effect> = {
  // user record: role, servicePermissions, projectIds, disabled state
  updateUser: idArg(0),
  deleteUser: idArg(0),
  // direct project membership
  upsertUserProject: userFromRecord,
  deleteUserProject: idArg(0),
  deleteUserProjectsByUser: idArg(0),
  deleteUserProjectsByProject: wholeTenant,
  // a deleted project leaves every principal's `projects` / `adminProjects` stale
  deleteProject: wholeTenant,
  // groups: grants, membership, project assignment
  updateGroup: wholeTenant,
  deleteGroup: wholeTenant,
  addGroupMember: userFromRecord,
  removeGroupMember: (tenant, args) => {
    // removeGroupMember(groupId, userId)
    const userId = args[1];
    if (typeof userId === 'string' && userId) invalidatePrincipal(tenant, userId);
    else invalidateTenantPrincipals(tenant);
  },
  deleteGroupMembersByGroup: wholeTenant,
  deleteGroupProjectsByGroup: wholeTenant,
  upsertGroupProject: wholeTenant,
  removeGroupProject: wholeTenant,
  // tokens act as their owner: a minted/revoked token changes the owner's
  // effective token-side view, so drop the owner's slice too.
  createApiToken: userFromRecord,
  deleteApiToken: (tenant, args) => {
    // deleteApiToken(id, userId)
    const userId = args[1];
    if (typeof userId === 'string' && userId) invalidatePrincipal(tenant, userId);
    else invalidateTenantPrincipals(tenant);
  },
  deleteTenantApiToken: wholeTenant,
  deleteProjectApiToken: wholeTenant,
};

export function IamInvalidationMixin<TBase extends AnyConstructor>(Base: TBase): TBase {
  class IamInvalidationOps extends Base {}
  const proto = IamInvalidationOps.prototype as Record<string, unknown>;
  const baseProto = Base.prototype as Record<string, unknown>;

  for (const [name, effect] of Object.entries(IAM_INVALIDATING_METHODS)) {
    const original = baseProto[name];
    if (typeof original !== 'function') continue; // method absent in this edition
    proto[name] = async function wrapped(this: TenantAware, ...args: unknown[]) {
      const result = await (original as Method).apply(this, args);
      try {
        effect(this.getCurrentTenantDbName?.() ?? null, args);
      } catch {
        // observing only
      }
      return result;
    };
  }
  return IamInvalidationOps;
}
