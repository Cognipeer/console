/**
 * Shared grant rules for the token-authenticated admin surface
 * (`/client/v1/members`, `/client/v1/projects`, `/client/v1/providers`).
 *
 * What a call may hand out never exceeds what its own credential holds:
 * the account role capped by the token's scope.
 */

import {
  minPermission,
  normalizeServicePermissions,
  resolveCurrentServicePermission,
  type PermissionService,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { isOwnerOrAdmin } from '@/lib/services/users/peoplePolicy';

/** True when the token carries no scope of its own (it holds everything its account role holds). */
export function isUnscopedToken(auth: ApiTokenContext): boolean {
  return auth.tokenRecord.servicePermissions == null;
}

/** Tenant-wide admin grants (admin role, admin-level group roles) need an unscoped owner/admin credential. */
export function canGrantAdminRole(auth: ApiTokenContext): boolean {
  return isUnscopedToken(auth) && isOwnerOrAdmin(auth.user?.role);
}

/** Tenant-wide provider access follows the account role of the caller. */
export function canUseTenantProviderScope(auth: ApiTokenContext): boolean {
  return isOwnerOrAdmin(auth.user?.role);
}

/** Requested per-service levels, each capped at the caller's own effective level. */
export function clampRequestedPermissions(auth: ApiTokenContext, raw: unknown): UserServicePermissions {
  const requested = normalizeServicePermissions(raw);
  const clamped: UserServicePermissions = {};
  for (const [service, level] of Object.entries(requested) as Array<[PermissionService, ServicePermissionLevel]>) {
    const callerLevel = auth.user
      ? resolveCurrentServicePermission(auth.user, service, [], auth.tokenRecord.servicePermissions)
      : 'none';
    clamped[service] = minPermission(level, callerLevel);
  }
  return clamped;
}

/** True when any requested level is higher than the caller's own effective level. */
export function exceedsCallerPermissions(auth: ApiTokenContext, raw: unknown): boolean {
  const requested = normalizeServicePermissions(raw);
  const clamped = clampRequestedPermissions(auth, requested);
  return (Object.keys(requested) as PermissionService[]).some((service) => clamped[service] !== requested[service]);
}
