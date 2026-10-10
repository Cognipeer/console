/**
 * RBAC for `GET /api/resource-usage/:type/:id`: the route is gated by the
 * service that owns `:type` (a caller who may read tools may see where a tool is
 * used), not by the admin-only `resources` inventory service. An unknown or
 * unregistered type falls back to `resources` (owner/admin, or an explicit
 * grant), so probing type names never grants more than the inventory does.
 */
import { registerPathServiceResolver, type PermissionService } from '@/lib/security/rbac';
import { getResourceTypeDefinition, listResourceTypeDefinitions } from './registry';
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

/** The permission service that owns resources of `type` (`resources` for an unknown one). */
export function resourceTypeService(type: string): PermissionService {
  return resolveResourceUsageService(`${RESOURCE_USAGE_PATH_PREFIX}${encodeURIComponent(type)}/x`);
}

/**
 * A synchronous "may the caller read resources of this type" predicate built
 * from an asynchronous per-service decision (the policy engine is async). Every
 * registered type is resolved up front; an unknown type is judged by the
 * `resources` service, like the route gate.
 */
export async function buildReferrerTypeAccess(
  mayRead: (service: PermissionService) => Promise<boolean>,
): Promise<(type: string) => boolean> {
  try {
    ensureCommunityResourceTypesRegistered();
  } catch {
    // the lazily registered types are best effort here; unknown ones fall back to `resources`
  }
  const services = new Set<PermissionService>(['resources']);
  for (const def of listResourceTypeDefinitions()) services.add(resourceTypeService(def.type));
  const allowed = new Map<PermissionService, boolean>();
  await Promise.all([...services].map(async (service) => {
    allowed.set(service, await mayRead(service));
  }));
  return (type) => allowed.get(resourceTypeService(type)) ?? allowed.get('resources') ?? false;
}
