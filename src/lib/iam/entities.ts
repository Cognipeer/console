/**
 * Entity builder: turns "who is asking, about what" into Cedar entities.
 *
 * The principal's effective service levels are computed here with the REAL
 * rbac.ts functions (getEffectiveServicePermissionWithGroups, the token
 * minPermission rule), never re-implemented, and exposed to policy as three
 * upward-closed string sets. That is the whole trick that keeps the managed
 * policies tiny and the parity with the legacy gate provable (see the parity
 * fuzz test): Cedar cannot iterate a principal's parents' attributes, and an
 * explicit per-user override can LOWER a role default while groups only RAISE
 * (rbac.ts:496-530), so that logic has to live in TypeScript.
 *
 * Pure and synchronous. Loading data from the database (and caching it) is
 * principalCache.ts; this file only maps already-loaded data to entities.
 */

import {
  RBAC_SERVICE_DEFINITIONS,
  getEffectiveServicePermissionWithGroups,
  getServiceDefinition,
  isPermissionService,
  normalizeServicePermissions,
  type GroupTenantGrant,
  type PermissionService,
  type RbacUserLike,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { resourceEntityTypeName, LEVEL_TO_GROUP } from './actions';
import type { CedarEntity, CedarEntityUid } from './cedar';

type Attrs = CedarEntity['attrs'];

const RANK: Record<ServicePermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

export const SERVICE_IDS: readonly PermissionService[] = RBAC_SERVICE_DEFINITIONS.map((d) => d.id);

// ── level sets ───────────────────────────────────────────────────────────

/** Services where the effective level is >= read / >= write / == admin. */
export interface LevelSets {
  readSvcs: string[];
  writeSvcs: string[];
  adminSvcs: string[];
}

export function levelSets(levelOf: (service: PermissionService) => ServicePermissionLevel): LevelSets {
  const sets: LevelSets = { readSvcs: [], writeSvcs: [], adminSvcs: [] };
  for (const service of SERVICE_IDS) {
    const rank = RANK[levelOf(service)];
    if (rank >= 1) sets.readSvcs.push(service);
    if (rank >= 2) sets.writeSvcs.push(service);
    if (rank >= 3) sets.adminSvcs.push(service);
  }
  return sets;
}

/** The owner/user side of the decision: role default, override, group union. */
export function userLevelSets(user: RbacUserLike, groupGrants: GroupTenantGrant[]): LevelSets {
  return levelSets((service) => getEffectiveServicePermissionWithGroups(user, groupGrants, service));
}

export interface TokenCaps {
  scoped: boolean;
  capRead: string[];
  capWrite: string[];
  capAdmin: string[];
}

/**
 * Token scope -> caps. `null`/`undefined` = unscoped (inherits the owner,
 * `scoped: false`); anything else — including `{}` — is a scope: services
 * absent from the (normalised) map resolve to `none`, i.e. are in no cap set.
 */
export function tokenCaps(scope: UserServicePermissions | null | undefined): TokenCaps {
  if (scope == null) return { scoped: false, capRead: [], capWrite: [], capAdmin: [] };
  const normalized = normalizeServicePermissions(scope);
  const sets = levelSets((service) => normalized[service] ?? 'none');
  return { scoped: true, capRead: sets.readSvcs, capWrite: sets.writeSvcs, capAdmin: sets.adminSvcs };
}

// ── principals ───────────────────────────────────────────────────────────

/** Everything the entity builder needs about a caller. Plain data, cacheable, JSON-safe. */
export interface IamPrincipal {
  kind: 'user' | 'token';
  /** User id; for a token principal the OWNER's id. */
  userId: string;
  /** Tenant role string as stored ('' when unknown). */
  role: string;
  /** Group ids the user is a member of (Cedar parents). Empty for legacy-parity token principals. */
  groupIds: string[];
  /** Effective levels of the user (for tokens: of the owner). */
  sets: LevelSets;
  /** Project ids the user can access (owner/admin: every project). May be empty when not loaded. */
  projects: string[];
  /** Project ids where the user is a project admin (owner/admin: every project). */
  adminProjects: string[];
  token?: TokenCaps & { id: string; projectId?: string | null };
}

export interface UserPrincipalInput {
  userId: string;
  user: RbacUserLike;
  groupGrants?: GroupTenantGrant[];
  groupIds?: string[];
  projects?: string[];
  adminProjects?: string[];
}

export function userPrincipal(input: UserPrincipalInput): IamPrincipal {
  return {
    kind: 'user',
    userId: input.userId,
    role: typeof input.user.role === 'string' ? input.user.role : '',
    groupIds: input.groupIds ?? [],
    sets: userLevelSets(input.user, input.groupGrants ?? []),
    projects: input.projects ?? [],
    adminProjects: input.adminProjects ?? [],
  };
}

export interface TokenPrincipalInput {
  tokenId: string;
  /** The token owner as a user principal (built with or without group grants, see principalCache). */
  owner: IamPrincipal;
  scope: UserServicePermissions | null | undefined;
  projectId?: string | null;
}

export function tokenPrincipal(input: TokenPrincipalInput): IamPrincipal {
  return {
    ...input.owner,
    kind: 'token',
    token: { id: input.tokenId, projectId: input.projectId ?? null, ...tokenCaps(input.scope) },
  };
}

// ── entity JSON ──────────────────────────────────────────────────────────

const uid = (type: string, id: string): CedarEntityUid => ({ type, id });
const projectUid = (id: string) => ({ __entity: uid('Project', id) });

function userEntity(p: IamPrincipal): CedarEntity {
  return {
    uid: uid('User', p.userId),
    parents: p.groupIds.map((g) => uid('Group', g)),
    attrs: {
      role: p.role,
      readSvcs: p.sets.readSvcs,
      writeSvcs: p.sets.writeSvcs,
      adminSvcs: p.sets.adminSvcs,
      projects: p.projects.map(projectUid),
      adminProjects: p.adminProjects.map(projectUid),
    },
  };
}

/** principal uid + the entities that describe it (user, groups, and the token for token principals). */
export function principalEntities(p: IamPrincipal): { uid: CedarEntityUid; entities: CedarEntity[] } {
  const entities: CedarEntity[] = [userEntity(p)];
  for (const groupId of p.groupIds) {
    entities.push({ uid: uid('Group', groupId), parents: [], attrs: {} });
  }
  if (p.kind === 'token' && p.token) {
    const attrs: Attrs = {
      owner: { __entity: uid('User', p.userId) },
      scoped: p.token.scoped,
      capRead: p.token.capRead,
      capWrite: p.token.capWrite,
      capAdmin: p.token.capAdmin,
    };
    if (p.token.projectId) attrs.project = projectUid(p.token.projectId);
    entities.push({ uid: uid('ApiToken', p.token.id), parents: [], attrs });
    return { uid: uid('ApiToken', p.token.id), entities };
  }
  return { uid: uid('User', p.userId), entities };
}

// ── resources ────────────────────────────────────────────────────────────

export type IamResource =
  /** A whole permission service (what the HTTP gate checks). */
  | { kind: 'service'; service: PermissionService | string }
  /** One registry resource. `service` defaults to the registry's owner of the type. */
  | {
      kind: 'resource';
      /** Registry type id, e.g. `agent`, `rag-module`. */
      type: string;
      id: string;
      service: PermissionService | string;
      projectId?: string | null;
      key?: string;
      tags?: string[];
    };

export function isAdminService(service: string): boolean {
  return isPermissionService(service) ? !!getServiceDefinition(service).adminService : false;
}

export function resourceEntities(
  resource: IamResource,
  tenantDbName?: string,
): { uid: CedarEntityUid; entities: CedarEntity[] } {
  if (resource.kind === 'service') {
    const entity = {
      uid: uid('Service', resource.service),
      parents: [],
      attrs: { service: resource.service, adminService: isAdminService(resource.service) },
    } satisfies CedarEntity;
    return { uid: entity.uid, entities: [entity] };
  }
  const typeName = resourceEntityTypeName(resource.type);
  const attrs: Attrs = {
    service: resource.service,
    adminService: isAdminService(resource.service),
  };
  if (resource.key) attrs.key = resource.key;
  if (resource.tags) attrs.tags = resource.tags;
  const entity = {
    uid: uid(typeName, resource.id),
    parents: resource.projectId ? [uid('Project', resource.projectId)] : [],
    attrs,
  } satisfies CedarEntity;
  const entities: CedarEntity[] = [entity];
  if (resource.projectId) {
    entities.push({
      uid: uid('Project', resource.projectId),
      parents: tenantDbName ? [uid('Tenant', tenantDbName)] : [],
      attrs: {},
    });
    if (tenantDbName) entities.push({ uid: uid('Tenant', tenantDbName), parents: [], attrs: {} });
  }
  return { uid: entity.uid, entities };
}

// ── actions ──────────────────────────────────────────────────────────────

const actionEntityCache = new Map<string, CedarEntity[]>();

/**
 * Action entities (the action plus its level group). Without a schema the
 * hierarchy is NOT implicit, so `action in Action::"Write"` only matches when
 * these are sent with the request. `level` null = an action outside the
 * catalog: it belongs to no group, so only custom policies can match it. Only
 * catalog actions are memoised — action ids can come from callers, and an
 * unbounded cache keyed on them would be a memory leak.
 */
export function actionEntities(actionId: string, level: 'read' | 'write' | 'admin' | null): CedarEntity[] {
  const build = (): CedarEntity[] => {
    const group = level ? LEVEL_TO_GROUP[level] : null;
    const entities: CedarEntity[] = [{ uid: uid('Action', actionId), parents: group ? [uid('Action', group)] : [], attrs: {} }];
    if (group) entities.push({ uid: uid('Action', group), parents: [], attrs: {} });
    return entities;
  };
  if (level === null) return build();
  const key = `${actionId}|${level}`;
  let cached = actionEntityCache.get(key);
  if (!cached) {
    cached = build();
    actionEntityCache.set(key, cached);
  }
  return cached;
}
