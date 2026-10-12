/**
 * Principal context: what the engine needs to know about a user that is not on
 * the request itself - group memberships (+ their tenant grants) and project
 * access, including the project assignment rows the project narrowing is
 * resolved from - loaded in a handful of batched reads and cached per
 * (tenantDbName, userId) for a short TTL.
 *
 * Staleness model: entries live PRINCIPAL_CACHE_TTL_MS (15 s) and are also
 * dropped explicitly. In-process writes invalidate immediately through the
 * provider-level hooks (database/iam-invalidation.mixin.ts -> events.ts). A
 * write handled by ANOTHER node is picked up when the TTL expires, i.e. within
 * 15 s. That bound covers everything cached here: the group ids and grants of a
 * token owner, the project list, and the project assignments (and so the project
 * narrowing). The gate reads the session user's own row and group grants fresh on
 * every request; those are not cached here.
 *
 * Cost of a cold load (a user in n groups): the membership rows, then in
 * parallel the group documents (one batched read), the direct project rows and
 * the project rows of each group - two round trips, however many groups. A warm
 * entry costs nothing.
 */

import { runWithTenantScope, type DatabaseProvider, type IGroup, type IUser } from '@/lib/database';
import type { GroupTenantGrant, RbacUserLike } from '@/lib/security/rbac';
import { onIamInvalidation } from './events';
import { fetchGroupsByIds, grantsOf, listUserGroupIds } from './groupGrants';
import type { ProjectAssignmentRow } from './projectMembership';

export const PRINCIPAL_CACHE_TTL_MS = 15_000;
const MAX_ENTRIES = 5_000;
/** Expired entries are swept at most this often when the cache is full. */
const SWEEP_INTERVAL_MS = 1_000;

export interface PrincipalContext {
  tenantDbName: string;
  userId: string;
  /** The user row as loaded (only role/servicePermissions/projectIds matter). */
  user: RbacUserLike & { projectIds?: string[] };
  groupIds: string[];
  groupGrants: GroupTenantGrant[];
  /** Present once projects were requested. */
  projects?: string[];
  adminProjects?: string[];
  /** The user's direct project assignments (empty for owners and admins, who are in every project). */
  userProjects?: ProjectAssignmentRow[];
  /** The project assignments of the user's groups (empty for owners and admins). */
  groupProjects?: ProjectAssignmentRow[];
  loadedAt: number;
}

interface Entry {
  value?: PrincipalContext;
  pending?: Promise<PrincipalContext>;
  expiresAt: number;
}

const cache = new Map<string, Map<string, Entry>>();
let entryCount = 0;
let lastSweepAt = 0;
const counters = { hits: 0, misses: 0, loads: 0, invalidations: 0 };

/**
 * Ids of every project of the tenant, shared by all the owners and admins of it
 * (each of them is in every project): one read per TTL per tenant instead of
 * one per admin per TTL. Dropped with the tenant's principals.
 */
const projectIdCache = new Map<string, { ids?: string[]; pending?: Promise<string[]>; expiresAt: number }>();

export function getPrincipalCacheStats() {
  const total = counters.hits + counters.misses;
  return { ...counters, entries: entryCount, hitRate: total === 0 ? 0 : counters.hits / total };
}

export function resetPrincipalCacheForTests(): void {
  cache.clear();
  projectIdCache.clear();
  entryCount = 0;
  lastSweepAt = 0;
  counters.hits = counters.misses = counters.loads = counters.invalidations = 0;
}

function tenantMap(tenantDbName: string): Map<string, Entry> {
  let map = cache.get(tenantDbName);
  if (!map) {
    map = new Map();
    cache.set(tenantDbName, map);
  }
  return map;
}

function dropUser(tenantDbName: string, userId: string): void {
  const map = cache.get(tenantDbName);
  if (map?.delete(userId)) {
    entryCount--;
    counters.invalidations++;
  }
}

function dropTenant(tenantDbName: string): void {
  const map = cache.get(tenantDbName);
  if (map) {
    entryCount -= map.size;
    counters.invalidations += map.size;
    cache.delete(tenantDbName);
  }
  projectIdCache.delete(tenantDbName);
}

/** Explicit hooks (also reachable through events.ts). `tenantDbName` null = every tenant. */
export function invalidatePrincipalCache(tenantDbName: string | null, userId: string): void {
  if (tenantDbName) return dropUser(tenantDbName, userId);
  for (const t of [...cache.keys()]) dropUser(t, userId);
}

export function invalidateTenantPrincipalCache(tenantDbName: string | null): void {
  if (tenantDbName) return dropTenant(tenantDbName);
  for (const t of [...cache.keys()]) dropTenant(t);
  projectIdCache.clear();
}

onIamInvalidation((event) => {
  if (event.kind === 'user') invalidatePrincipalCache(event.tenantDbName, event.userId);
  else if (event.kind === 'tenant-principals') invalidateTenantPrincipalCache(event.tenantDbName);
});

/** Drop what has expired (at most once per SWEEP_INTERVAL_MS); a full cache of fresh entries falls back to evicting the oldest. */
function sweepExpired(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [tenant, map] of cache) {
    for (const [userId, entry] of map) {
      if (!entry.pending && entry.expiresAt <= now) {
        map.delete(userId);
        entryCount--;
      }
    }
    if (map.size === 0) cache.delete(tenant);
  }
}

function evictIfFull(): void {
  if (entryCount < MAX_ENTRIES) return;
  sweepExpired(Date.now());
  while (entryCount >= MAX_ENTRIES) {
    const firstTenant = cache.keys().next().value as string | undefined;
    if (firstTenant === undefined) return;
    const map = cache.get(firstTenant)!;
    const firstUser = map.keys().next().value as string | undefined;
    if (firstUser === undefined) {
      cache.delete(firstTenant);
      continue;
    }
    map.delete(firstUser);
    entryCount--;
  }
}

// ── loading ──────────────────────────────────────────────────────────────

async function tenantProjectIds(db: DatabaseProvider, tenantDbName: string, tenantId: string): Promise<string[]> {
  const hit = projectIdCache.get(tenantDbName);
  const now = Date.now();
  if (hit && hit.expiresAt > now) {
    if (hit.ids) return hit.ids;
    if (hit.pending) return hit.pending;
  }
  const entry: { ids?: string[]; pending?: Promise<string[]>; expiresAt: number } = { expiresAt: now + PRINCIPAL_CACHE_TTL_MS };
  entry.pending = db.listProjects(tenantId).then(
    (projects) => {
      const ids = projects.map((p) => String(p._id)).filter(Boolean);
      entry.ids = ids;
      entry.pending = undefined;
      return ids;
    },
    (error) => {
      if (projectIdCache.get(tenantDbName) === entry) projectIdCache.delete(tenantDbName);
      throw error;
    },
  );
  projectIdCache.set(tenantDbName, entry);
  return entry.pending;
}

const assignmentRow = (r: {
  projectId: string;
  role: ProjectAssignmentRow['role'];
  servicePermissions?: ProjectAssignmentRow['servicePermissions'];
  updatedAt?: Date;
  groupId?: string;
}): ProjectAssignmentRow => ({
  projectId: String(r.projectId),
  role: r.role,
  servicePermissions: r.servicePermissions ?? undefined,
  updatedAt: r.updatedAt ?? null,
  ...(r.groupId ? { groupId: String(r.groupId) } : {}),
});

interface ProjectData {
  projects: string[];
  adminProjects: string[];
  userProjects: ProjectAssignmentRow[];
  groupProjects: ProjectAssignmentRow[];
}

async function loadProjects(
  db: DatabaseProvider,
  input: PrincipalLoadInput,
  user: IUser | (RbacUserLike & { projectIds?: string[] }),
  groupIdsPromise: Promise<string[]>,
): Promise<ProjectData> {
  const role = user.role;
  if (role === 'owner' || role === 'admin') {
    // Implicit access to every project of the tenant; no assignments to resolve.
    const all = await tenantProjectIds(db, input.tenantDbName, input.tenantId);
    return { projects: all, adminProjects: all, userProjects: [], groupProjects: [] };
  }
  const [direct, groupLists] = await Promise.all([
    db.listUserProjectsByUser(input.userId),
    groupIdsPromise.then((groupIds) => Promise.all(groupIds.map((groupId) => db.listGroupProjectsByGroup(groupId)))),
  ]);
  const projects = new Set<string>();
  const admin = new Set<string>();
  const legacy = (user.projectIds ?? []).map(String).filter(Boolean);
  for (const id of legacy) {
    projects.add(id);
    if (role === 'project_admin') admin.add(id); // legacy tenant project_admin == project admin everywhere it is a member
  }
  const userProjects: ProjectAssignmentRow[] = [];
  for (const m of direct) {
    if (!m.projectId) continue;
    userProjects.push(assignmentRow(m));
    projects.add(String(m.projectId));
    if (m.role === 'project_admin') admin.add(String(m.projectId));
  }
  const groupProjects: ProjectAssignmentRow[] = [];
  for (const list of groupLists) {
    for (const gp of list) {
      if (!gp.projectId) continue;
      groupProjects.push(assignmentRow(gp));
      projects.add(String(gp.projectId));
      if (gp.role === 'project_admin') admin.add(String(gp.projectId));
    }
  }
  return { projects: [...projects], adminProjects: [...admin], userProjects, groupProjects };
}

export interface PrincipalLoadInput {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  /** Skip the cache and refresh the entry. */
  fresh?: boolean;
  /** Also load project access (cached with the rest). */
  withProjects?: boolean;
  /** Use this already-loaded user row instead of reading it (the gate has one). */
  user?: IUser | (RbacUserLike & { projectIds?: string[] });
  /** Use these already-loaded groups of the user instead of reading them (the gate / the Authorization center just did). */
  groups?: IGroup[];
  /**
   * Use the cache when it has the entry, but do not add the result to it. For
   * bulk callers (the impact preview walks hundreds of people) that must not
   * push the hot entries of live traffic out.
   */
  noStore?: boolean;
}

async function loadContext(input: PrincipalLoadInput, previous?: PrincipalContext): Promise<PrincipalContext> {
  counters.loads++;
  return runWithTenantScope(input.tenantDbName, async (db) => {
    const user = input.user ?? (await db.findUserById(input.userId));
    if (!user) throw new Error(`User ${input.userId} not found`);

    const groupIdsPromise = input.groups
      ? Promise.resolve(input.groups.map((g) => String(g._id)))
      : listUserGroupIds(db, input.userId);
    const groupsPromise = input.groups
      ? Promise.resolve(input.groups)
      : groupIdsPromise.then((ids) => fetchGroupsByIds(db, input.tenantId, ids));
    const withProjects = !!(input.withProjects || previous?.projects);
    const projectsPromise = withProjects ? loadProjects(db, input, user, groupIdsPromise) : Promise.resolve(undefined);

    const [groups, projectData] = await Promise.all([groupsPromise, projectsPromise]);
    const ctx: PrincipalContext = {
      tenantDbName: input.tenantDbName,
      userId: input.userId,
      user,
      groupIds: groups.map((g) => String(g._id)),
      groupGrants: grantsOf(groups),
      loadedAt: Date.now(),
    };
    if (projectData) {
      ctx.projects = projectData.projects;
      ctx.adminProjects = projectData.adminProjects;
      ctx.userProjects = projectData.userProjects;
      ctx.groupProjects = projectData.groupProjects;
    }
    return ctx;
  });
}

/** Cached principal context. Never returns a value older than the TTL. */
export async function getPrincipalContext(input: PrincipalLoadInput): Promise<PrincipalContext> {
  const now = Date.now();
  const existing = cache.get(input.tenantDbName)?.get(input.userId);
  if (!input.fresh && existing && existing.expiresAt > now) {
    if (existing.pending) {
      counters.hits++;
      return existing.pending;
    }
    if (existing.value && (!input.withProjects || existing.value.projects)) {
      counters.hits++;
      return existing.value;
    }
  }
  counters.misses++;
  if (input.noStore) return loadContext(input, existing?.value);

  if (!existing) {
    evictIfFull();
    entryCount++;
  }
  // Looked up AFTER the eviction above, which may drop empty tenant maps.
  const map = tenantMap(input.tenantDbName);
  const entry: Entry = { expiresAt: now + PRINCIPAL_CACHE_TTL_MS };
  entry.pending = loadContext(input, existing?.value).then(
    (value) => {
      entry.value = value;
      entry.pending = undefined;
      return value;
    },
    (error) => {
      // never cache a failure
      if (map.get(input.userId) === entry) {
        map.delete(input.userId);
        entryCount--;
      }
      throw error;
    },
  );
  map.set(input.userId, entry);
  return entry.pending;
}
