/**
 * Principal context: what the engine needs to know about a user that is not on
 * the request itself — group memberships (+ their tenant grants) and project
 * access — loaded in a handful of batched reads and cached per
 * (tenantDbName, userId) for a short TTL.
 *
 * Staleness model: entries live PRIORITY_TTL_MS (15 s by default) and are also
 * dropped explicitly. In-process writes invalidate immediately through the
 * provider-level hooks (database/iam-invalidation.mixin.ts -> events.ts). A
 * write handled by ANOTHER node is picked up when the TTL expires, i.e. within
 * 15 s — the bound the C4 enforcement design accepts for this cache. The legacy
 * gate does not use this cache at all (it keeps reading per request), so
 * nothing about today's authorization latency of changes is altered.
 */

import { runWithTenantScope, type DatabaseProvider, type IGroup, type IUser } from '@/lib/database';
import type { GroupTenantGrant, RbacUserLike } from '@/lib/security/rbac';
import { onIamInvalidation } from './events';
import { groupToGrant, loadUserGroups } from './groupGrants';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from './entities';
import type { UserServicePermissions } from '@/lib/security/rbac';

export const PRINCIPAL_CACHE_TTL_MS = 15_000;
const MAX_ENTRIES = 5_000;

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
  loadedAt: number;
}

interface Entry {
  value?: PrincipalContext;
  pending?: Promise<PrincipalContext>;
  expiresAt: number;
}

const cache = new Map<string, Map<string, Entry>>();
let entryCount = 0;
const counters = { hits: 0, misses: 0, loads: 0, invalidations: 0 };

export function getPrincipalCacheStats() {
  const total = counters.hits + counters.misses;
  return { ...counters, entries: entryCount, hitRate: total === 0 ? 0 : counters.hits / total };
}

export function resetPrincipalCacheForTests(): void {
  cache.clear();
  entryCount = 0;
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
}

/** Explicit hooks (also reachable through events.ts). `tenantDbName` null = every tenant. */
export function invalidatePrincipalCache(tenantDbName: string | null, userId: string): void {
  if (tenantDbName) return dropUser(tenantDbName, userId);
  for (const t of [...cache.keys()]) dropUser(t, userId);
}

export function invalidateTenantPrincipalCache(tenantDbName: string | null): void {
  if (tenantDbName) return dropTenant(tenantDbName);
  for (const t of [...cache.keys()]) dropTenant(t);
}

onIamInvalidation((event) => {
  if (event.kind === 'user') invalidatePrincipalCache(event.tenantDbName, event.userId);
  else if (event.kind === 'tenant-principals') invalidateTenantPrincipalCache(event.tenantDbName);
});

function evictIfFull(): void {
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

async function loadProjects(
  db: DatabaseProvider,
  tenantId: string,
  user: IUser | (RbacUserLike & { projectIds?: string[] }),
  userId: string,
  groupIds: string[],
): Promise<{ projects: string[]; adminProjects: string[] }> {
  const role = user.role;
  if (role === 'owner' || role === 'admin') {
    // Implicit access to every project of the tenant.
    const all = (await db.listProjects(tenantId)).map((p) => String(p._id)).filter(Boolean);
    return { projects: all, adminProjects: all };
  }
  const projects = new Set<string>();
  const admin = new Set<string>();
  const legacy = (user.projectIds ?? []).map(String).filter(Boolean);
  for (const id of legacy) {
    projects.add(id);
    if (role === 'project_admin') admin.add(id); // legacy tenant project_admin == project admin everywhere it is a member
  }
  const [memberships, groupProjects] = await Promise.all([
    db.listUserProjectsByUser(userId),
    Promise.all(groupIds.map((groupId) => db.listGroupProjectsByGroup(groupId))),
  ]);
  for (const m of memberships) {
    if (!m.projectId) continue;
    projects.add(String(m.projectId));
    if (m.role === 'project_admin') admin.add(String(m.projectId));
  }
  for (const list of groupProjects) {
    for (const gp of list) {
      if (!gp.projectId) continue;
      projects.add(String(gp.projectId));
      if (gp.role === 'project_admin') admin.add(String(gp.projectId));
    }
  }
  return { projects: [...projects], adminProjects: [...admin] };
}

export interface PrincipalLoadInput {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  /** Skip the cache and refresh the entry. */
  fresh?: boolean;
  /** Also load project access (an extra 1 + #groups reads; cached with the rest). */
  withProjects?: boolean;
  /** Use this already-loaded user row instead of reading it (the legacy gate has one). */
  user?: IUser | (RbacUserLike & { projectIds?: string[] });
}

async function loadContext(input: PrincipalLoadInput, previous?: PrincipalContext): Promise<PrincipalContext> {
  counters.loads++;
  return runWithTenantScope(input.tenantDbName, async (db) => {
    const user = input.user ?? (await db.findUserById(input.userId));
    if (!user) throw new Error(`User ${input.userId} not found`);
    const groups: IGroup[] = await loadUserGroups(db, input.userId);
    const groupIds = groups.map((g) => String(g._id));
    const groupGrants = groups.map(groupToGrant).filter((g): g is GroupTenantGrant => !!g);
    const ctx: PrincipalContext = {
      tenantDbName: input.tenantDbName,
      userId: input.userId,
      user,
      groupIds,
      groupGrants,
      loadedAt: Date.now(),
    };
    if (input.withProjects || previous?.projects) {
      const p = await loadProjects(db, input.tenantId, user, input.userId, groupIds);
      ctx.projects = p.projects;
      ctx.adminProjects = p.adminProjects;
    }
    return ctx;
  });
}

/** Cached principal context. Never returns a value older than the TTL. */
export async function getPrincipalContext(input: PrincipalLoadInput): Promise<PrincipalContext> {
  const map = tenantMap(input.tenantDbName);
  const now = Date.now();
  const existing = map.get(input.userId);
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
  if (!existing) {
    evictIfFull();
    entryCount++;
  }
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

// ── principal construction ───────────────────────────────────────────────

export interface UserPrincipalRequest extends Omit<PrincipalLoadInput, 'user'> {
  /**
   * Inputs the legacy gate already computed. When given they decide the LEVELS
   * (so the engine sees exactly what rbac.ts saw); group ids and projects still
   * come from the cached context.
   */
  user?: IUser | (RbacUserLike & { projectIds?: string[] });
  groupGrants?: GroupTenantGrant[];
}

export async function resolveUserPrincipal(input: UserPrincipalRequest): Promise<IamPrincipal> {
  const ctx = await getPrincipalContext(input);
  return userPrincipal({
    userId: input.userId,
    user: input.user ?? ctx.user,
    groupGrants: input.groupGrants ?? ctx.groupGrants,
    groupIds: ctx.groupIds,
    projects: ctx.projects,
    adminProjects: ctx.adminProjects,
  });
}

export interface TokenPrincipalRequest extends Omit<PrincipalLoadInput, 'user' | 'userId'> {
  tokenId: string;
  ownerUserId: string;
  owner?: IUser | (RbacUserLike & { projectIds?: string[] });
  scope: UserServicePermissions | null | undefined;
  projectId?: string | null;
  /**
   * false (default) = LEGACY: the token path never loads groups, so the owner's
   * levels use no group grants and the owner has no group parents.
   * true = TARGET (C2 'token-groups'): the owner's group grants apply.
   */
  includeOwnerGroups?: boolean;
}

export async function resolveTokenPrincipal(input: TokenPrincipalRequest): Promise<IamPrincipal> {
  const includeGroups = input.includeOwnerGroups === true;
  const ctx = await getPrincipalContext({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    userId: input.ownerUserId,
    fresh: input.fresh,
    withProjects: input.withProjects,
    user: input.owner,
  });
  const owner = userPrincipal({
    userId: input.ownerUserId,
    user: input.owner ?? ctx.user,
    groupGrants: includeGroups ? ctx.groupGrants : [],
    groupIds: includeGroups ? ctx.groupIds : [],
    projects: ctx.projects,
    adminProjects: ctx.adminProjects,
  });
  return tokenPrincipal({ tokenId: input.tokenId, owner, scope: input.scope, projectId: input.projectId });
}
