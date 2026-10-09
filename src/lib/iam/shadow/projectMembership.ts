/**
 * The caller's membership in ONE project, resolved exactly like the live
 * project endpoints do (plugins/projects.ts `resolveProjectMembership`):
 * direct UserProject, else the legacy `projectIds` entry, plus every
 * group -> project assignment of the user's groups; strongest role wins and the
 * service overrides are merged (highest level per service).
 *
 * Used only by shadow mode to evaluate the "project narrowing" candidate rule.
 * Cached per (tenant, user, project) for a short TTL and dropped by the same
 * invalidation events as the principal cache.
 */

import { runWithTenantScope } from '@/lib/database';
import {
  mergeServicePermissions,
  type ProjectRole,
  type RbacProjectLike,
} from '@/lib/security/rbac';
import { onIamInvalidation } from '../events';

const TTL_MS = 15_000;
/** Entries kept per tenant (the cookie that selects the project is client-controlled). */
const MAX_ENTRIES_PER_TENANT = 500;
const MAX_ENTRIES = 5_000;

interface Entry {
  value: RbacProjectLike | null;
  expiresAt: number;
}

const cache = new Map<string, Map<string, Entry>>();
let size = 0;

const keyOf = (userId: string, projectId: string) => `${userId}::${projectId}`;

onIamInvalidation((event) => {
  if (event.kind === 'tenant-policies') return;
  const tenants = event.tenantDbName ? [event.tenantDbName] : [...cache.keys()];
  for (const tenant of tenants) {
    const map = cache.get(tenant);
    if (!map) continue;
    if (event.kind === 'tenant-principals') {
      size -= map.size;
      cache.delete(tenant);
    } else {
      const prefix = `${event.userId}::`;
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) {
          map.delete(key);
          size--;
        }
      }
    }
  }
});

export interface ProjectMembershipInput {
  tenantDbName: string;
  userId: string;
  userRole: string;
  projectId: string;
  legacyProjectIds?: string[];
  /** Group ids of the user (from the principal context). */
  groupIds: string[];
}

export async function resolveProjectMembershipCached(input: ProjectMembershipInput): Promise<RbacProjectLike | null> {
  const now = Date.now();
  const key = keyOf(input.userId, input.projectId);
  let map = cache.get(input.tenantDbName);
  const hit = map?.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  if (hit && map) {
    // Expired: drop it now instead of letting it sit until overwritten.
    map.delete(key);
    size--;
  }

  const value = await runWithTenantScope(input.tenantDbName, async (db) => {
    const sources: Array<{ role: ProjectRole; servicePermissions?: RbacProjectLike['servicePermissions'] }> = [];
    const direct = await db.findUserProject(input.userId, input.projectId);
    if (direct) {
      sources.push({ role: direct.role, servicePermissions: direct.servicePermissions });
    } else if ((input.legacyProjectIds ?? []).map(String).includes(String(input.projectId))) {
      sources.push({ role: input.userRole === 'project_admin' ? 'project_admin' : 'member' });
    }
    if (input.groupIds.length > 0) {
      const ids = new Set(input.groupIds.map(String));
      const groupProjects = await db.listGroupProjectsByProject(input.projectId);
      for (const gp of groupProjects) {
        if (ids.has(String(gp.groupId))) sources.push({ role: gp.role, servicePermissions: gp.servicePermissions });
      }
    }
    if (sources.length === 0) return null;
    const role: ProjectRole = sources.some((s) => s.role === 'project_admin') ? 'project_admin' : 'member';
    return { role, servicePermissions: mergeServicePermissions(sources.map((s) => s.servicePermissions)) };
  });

  if (!map) {
    map = new Map();
    cache.set(input.tenantDbName, map);
  }
  if (!map.has(key)) {
    // Evict within the SAME tenant only (oldest insertion first), so one
    // tenant's traffic can never flush another tenant's cache.
    while (map.size >= MAX_ENTRIES_PER_TENANT) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
      size--;
    }
    if (size >= MAX_ENTRIES) {
      // Global safety net: drop this tenant's own entries only.
      size -= map.size;
      map.clear();
    }
    size++;
  }
  map.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

export function resetProjectMembershipCacheForTests(): void {
  cache.clear();
  size = 0;
}
