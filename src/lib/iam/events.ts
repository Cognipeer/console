/**
 * Invalidation hooks of the policy engine.
 *
 * Deliberately dependency-free (no database, no Cedar import) so the database
 * layer can call into it without creating an import cycle. Listeners are
 * registered by `principalCache.ts` (principal slices) and `engine.ts`
 * (per-tenant policy sets).
 *
 * Every hook is best-effort and synchronous: a failing listener must never
 * break the write that triggered it.
 */

export type IamInvalidation =
  /** One user's principal slice (role/permission/membership/token change). */
  | { kind: 'user'; tenantDbName: string | null; userId: string }
  /** Every principal slice of a tenant (group, group-project or project change). */
  | { kind: 'tenant-principals'; tenantDbName: string | null }
  /** The tenant's custom policy set / version changed. */
  | { kind: 'tenant-policies'; tenantDbName: string };

type Listener = (event: IamInvalidation) => void;

const listeners = new Set<Listener>();

export function onIamInvalidation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitIamInvalidation(event: IamInvalidation): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // never break the write path
    }
  }
}

/** A user's role / servicePermissions / membership / token changed. */
export function invalidatePrincipal(tenantDbName: string | null, userId: string): void {
  emitIamInvalidation({ kind: 'user', tenantDbName, userId });
}

/** A group, its members' grants or a project assignment changed. */
export function invalidateTenantPrincipals(tenantDbName: string | null): void {
  emitIamInvalidation({ kind: 'tenant-principals', tenantDbName });
}

/** The tenant's custom policies changed (store writes call this). */
export function invalidateTenantPolicies(tenantDbName: string): void {
  emitIamInvalidation({ kind: 'tenant-policies', tenantDbName });
}
