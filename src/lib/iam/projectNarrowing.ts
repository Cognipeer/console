/**
 * Project-level narrowing (decision 2 of the IAM design).
 *
 *   effective(service) = min(tenant level, project level)
 *
 * applied when the request has a project context AND the principal has an
 * explicit project-level setting for that service in that project (the
 * `servicePermissions` of the UserProject / GroupProject membership). A
 * membership that says nothing about a service leaves the tenant-level answer
 * alone, so the role defaults of a project (member = write, ...) never silently
 * lower a tenant-level grant. Tenant owners and admins (also through a group's
 * tenantRole) are never narrowed, as in resolveEffectivePermission.
 *
 * The project context is the one the handlers will actually run in, resolved by
 * the same function as `resolveProjectContext` (pickActiveProjectId): the
 * requested project (cookie / token project) when the principal can access it,
 * else the default project when accessible, else the first accessible project.
 * Resolving it any other way would let a forged cookie pick which project's
 * narrowing applies while the handler runs in a different one.
 *
 * Shared by enforce mode (iam/enforce.ts) and the shadow evaluation
 * (shadow/evaluate.ts) so the numbers an admin reviews before switching are the
 * numbers enforcement will produce.
 */

import { runWithTenantScope } from '@/lib/database';
import {
  getEffectiveServicePermissionWithGroups,
  minPermission,
  normalizeServicePermissions,
  type GroupTenantGrant,
  type PermissionService,
  type RbacProjectLike,
  type RbacUserLike,
  type ServicePermissionLevel,
} from '@/lib/security/rbac';
import { levelSets, type LevelSets } from './entities';
import { getPrincipalContext } from './principalCache';
import { resolveProjectMembershipCached } from './shadow/projectMembership';

const DEFAULT_PROJECT_KEY = 'default';
const DEFAULT_PROJECT_TTL_MS = 60_000;
const MAX_TENANTS = 5_000;

const ownerOrAdmin = (role: string | undefined) => role === 'owner' || role === 'admin';

/** The level after narrowing one service by an (optional) project membership. */
export function narrowLevel(
  tenantLevel: ServicePermissionLevel,
  membership: RbacProjectLike | null | undefined,
  service: PermissionService,
): ServicePermissionLevel {
  if (!membership) return tenantLevel;
  const explicit = normalizeServicePermissions(membership.servicePermissions)[service];
  return explicit ? minPermission(tenantLevel, explicit) : tenantLevel;
}

/** The principal's level sets with the project narrowing applied. */
export function narrowedLevelSets(
  user: RbacUserLike,
  groupGrants: GroupTenantGrant[],
  membership: RbacProjectLike | null | undefined,
): LevelSets {
  return levelSets((service) =>
    narrowLevel(getEffectiveServicePermissionWithGroups(user, groupGrants, service), membership, service),
  );
}

/**
 * The project a non-privileged principal operates in. Mirrors
 * `resolveProjectContext`: requested (or default) project when accessible, else
 * the first accessible one. Undefined when the principal has no project.
 */
export function pickActiveProjectId(input: {
  requestedProjectId?: string | null;
  defaultProjectId?: string | null;
  memberProjectIds: string[];
}): string | undefined {
  const projectId = input.requestedProjectId || input.defaultProjectId || undefined;
  if (!projectId || !input.memberProjectIds.includes(projectId)) return input.memberProjectIds[0];
  return projectId;
}

// ── default project id (read-only, cached) ───────────────────────────────

const defaultProjectCache = new Map<string, { id: string | null; expiresAt: number }>();

async function lookupDefaultProjectId(tenantDbName: string, tenantId: string): Promise<string | null> {
  const hit = defaultProjectCache.get(tenantDbName);
  if (hit && hit.expiresAt > Date.now()) return hit.id;
  const id = await runWithTenantScope(tenantDbName, async (db) => {
    const project = await db.findProjectByKey(tenantId, DEFAULT_PROJECT_KEY);
    return project?._id ? String(project._id) : null;
  });
  if (!defaultProjectCache.has(tenantDbName) && defaultProjectCache.size >= MAX_TENANTS) {
    const oldest = defaultProjectCache.keys().next().value as string | undefined;
    if (oldest !== undefined) defaultProjectCache.delete(oldest);
  }
  defaultProjectCache.set(tenantDbName, { id, expiresAt: Date.now() + DEFAULT_PROJECT_TTL_MS });
  return id;
}

export function resetProjectNarrowingCachesForTests(): void {
  defaultProjectCache.clear();
}

export interface NarrowingInput {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  /** Tenant role string of the user (the token owner for tokens). */
  role: string;
  /** The user row as the gate loaded it. */
  user: RbacUserLike & { projectIds?: string[] };
  /** The group grants that apply to the principal in the world being evaluated. */
  groupGrants: GroupTenantGrant[];
  /** Cookie `active_project_id` (sessions) or the token's resolved project. */
  requestedProjectId?: string | null;
  /**
   * Token requests: the handler runs in exactly `requestedProjectId` (the token's
   * own project, no membership fallback), so narrowing must use that project or
   * none. Without this flag a project the principal cannot access would borrow
   * the settings of the first project they do belong to (the session rule of
   * resolveProjectContext), narrowing - or not - by the wrong project.
   */
  exactProject?: boolean;
}

export interface NarrowingResult {
  projectId: string;
  membership: RbacProjectLike;
}

/**
 * The project membership that narrows this request, or null when nothing does
 * (privileged principal, no project, no membership record in that project).
 */
export async function resolveNarrowingMembership(input: NarrowingInput): Promise<NarrowingResult | null> {
  if (ownerOrAdmin(input.role)) return null;
  if (input.groupGrants.some((g) => g.tenantRole && ownerOrAdmin(g.tenantRole))) return null;

  const ctx = await getPrincipalContext({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    userId: input.userId,
    user: input.user,
    withProjects: true,
  });
  const memberProjectIds = ctx.projects ?? [];
  if (memberProjectIds.length === 0) return null;

  const requested = input.requestedProjectId ? String(input.requestedProjectId) : undefined;
  if (input.exactProject && (!requested || !memberProjectIds.includes(requested))) return null;
  const defaultProjectId = requested ? null : await lookupDefaultProjectId(input.tenantDbName, input.tenantId);
  const projectId = pickActiveProjectId({ requestedProjectId: requested, defaultProjectId, memberProjectIds });
  if (!projectId) return null;

  const membership = await resolveProjectMembershipCached({
    tenantDbName: input.tenantDbName,
    userId: input.userId,
    userRole: input.role,
    projectId,
    legacyProjectIds: input.user.projectIds,
    groupIds: ctx.groupIds,
  });
  return membership ? { projectId, membership } : null;
}
