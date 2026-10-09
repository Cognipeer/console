/**
 * RBAC for `GET /api/resource-usage/:type/:id`: the route is gated by the
 * service that owns `:type` (a caller who may read tools may see where a tool is
 * used), not by the admin-only `resources` inventory service. An unknown or
 * unregistered type falls back to `resources` (owner/admin, or an explicit
 * grant), so probing type names never grants more than the inventory does.
 */
import {
  authorizeServiceRequest,
  getEffectiveServicePermissionWithGroups,
  registerPathServiceResolver,
  type GroupTenantGrant,
  type PermissionService,
} from '@/lib/security/rbac';
import { getResourceTypeDefinition } from './registry';
import { ensureCommunityResourceTypesRegistered } from './providers';

export const RESOURCE_USAGE_PATH_PREFIX = '/api/resource-usage/';

export function resolveResourceUsageService(pathname: string): PermissionService {
  const rest = pathname.startsWith(RESOURCE_USAGE_PATH_PREFIX)
    ? pathname.slice(RESOURCE_USAGE_PATH_PREFIX.length)
    : '';
  const raw = rest.split('/')[0] ?? '';
  let type = raw;
  try {
    type = decodeURIComponent(raw);
  } catch {
    return 'resources';
  }
  if (!type) return 'resources';
  // Types are registered lazily (and the enterprise ones by the overlay), so
  // make sure the registry is populated before the very first request is gated.
  try {
    ensureCommunityResourceTypesRegistered();
  } catch {
    return 'resources';
  }
  return getResourceTypeDefinition(type)?.service ?? 'resources';
}

/** Idempotent; called when the resources API plugin is registered (server start). */
export function registerResourceUsageAccess(): void {
  registerPathServiceResolver(RESOURCE_USAGE_PATH_PREFIX, resolveResourceUsageService);
}

type RbacUser = Parameters<typeof authorizeServiceRequest>[0];

/**
 * Authoritative check for the usage route, from the decoded `:type` param (the
 * route gate works on the request path). Same rule as the gate: read on the
 * service that owns the type, `resources` for an unknown one.
 */
export function canReadResourceUsage(user: RbacUser, groupGrants: GroupTenantGrant[], type: string): boolean {
  const path = `${RESOURCE_USAGE_PATH_PREFIX}${encodeURIComponent(type)}/x`;
  return authorizeServiceRequest(user, 'GET', path, groupGrants).allowed;
}

/**
 * Whether the caller may read resources of `type` at all (read on the owning
 * service). Used to decide which referrers of a usage answer are listed.
 */
export function canReadResourceType(user: RbacUser, groupGrants: GroupTenantGrant[], type: string): boolean {
  const service = resolveResourceUsageService(`${RESOURCE_USAGE_PATH_PREFIX}${encodeURIComponent(type)}/x`);
  const level = getEffectiveServicePermissionWithGroups(user, groupGrants, service);
  return level !== 'none';
}
