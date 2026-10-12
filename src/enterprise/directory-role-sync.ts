/**
 * Directory role-sync seam — COMMUNITY (open-source) edition.
 *
 * A directory connection (LDAP, single sign-on) can be set to decide the
 * workspace role of the people it signs in: at every sign-in the role is
 * recomputed from the directory and written to the account. While that is on, the
 * role of such an account is the directory's, so the people screens show it as
 * "Managed by your directory" and the server refuses to change it by hand
 * (409 `directory_managed`).
 *
 * The community core has to know WHICH accounts that applies to without reading
 * the connection settings (they belong to the enterprise overlay). This leaf
 * module is the whole contract, and it is the least invasive way to carry that
 * fact across the seam:
 *
 *   - Nothing is registered in the community edition: no account is role-managed
 *     and every role stays editable, exactly as before.
 *   - The overlay calls `registerDirectoryRoleSyncResolver(...)` once at load, from
 *     its own `registry.ts`. This is a separate community file (NOT replaced by the
 *     overlay), so the `registry.ts` seam shape and SEAM_CONTRACT_VERSION do not
 *     change because of it.
 *   - The resolver answers for ONE workspace (the tenant is passed in) and returns
 *     the sign-in providers, spelled like `IUser.authProvider` (`ldap`, `oidc`),
 *     whose sign-in really syncs roles right now: the connection is usable (on, complete,
 *     and allowed by the workspace's licence, the same preconditions the sign-in itself
 *     checks) AND set to sync roles. It reads the live settings: turning the switch off,
 *     or losing the licence, makes the roles editable again at once, with no per-account
 *     flag left behind to go stale.
 *
 * Leaf module on purpose: no imports besides the logger, so the overlay registry
 * can import it at load time without creating a cycle.
 */
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('iam:directory-role-sync-seam');

export interface DirectoryRoleSyncTenant {
  tenantDbName: string;
  tenantId: string;
}

/** The sign-in providers (`IUser.authProvider` values) whose sign-in sets the workspace role. */
export type DirectoryRoleSyncResolver = (tenant: DirectoryRoleSyncTenant) => Promise<readonly string[]>;

let resolver: DirectoryRoleSyncResolver | null = null;

/** The overlay registers its resolver once at load; `null` clears it (tests). A later registration replaces the earlier one. */
export function registerDirectoryRoleSyncResolver(fn: DirectoryRoleSyncResolver | null): void {
  resolver = fn;
}

/** True when this build has directory connections that can sync roles (the overlay registered its resolver). */
export function hasDirectoryRoleSyncResolver(): boolean {
  return resolver !== null;
}

/**
 * The providers whose sign-in sets the role in this workspace right now. Empty when
 * this build has none or when the resolver failed (the failure is logged: the role
 * then stays editable, the server never locks a role it cannot be sure about).
 */
export async function resolveDirectoryRoleSyncProviders(tenant: DirectoryRoleSyncTenant): Promise<ReadonlySet<string>> {
  if (!resolver) return new Set();
  try {
    return new Set((await resolver(tenant)) ?? []);
  } catch (error) {
    logger.warn('The directory role-sync resolver failed', { error: error instanceof Error ? error.message : String(error) });
    return new Set();
  }
}
