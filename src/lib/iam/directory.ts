/**
 * The people & access directory: users, groups and API tokens listed with
 * server-side search, filters, sort and paging, and the viewer-specific facts a
 * screen needs to offer only what the server will accept (`allowedActions`).
 *
 * `GET /api/iam/principals` keeps its row fields (type, id, label, sublabel, role,
 * status, memberCount, policyCount); everything here is additive. A filter that
 * does not apply to the type asked for is ignored; a malformed value of one that
 * does is refused with the field named, so a typo never silently lists everyone.
 *
 * Tokens obey the same "never upward" rule as everywhere else: the query itself is
 * narrowed to the tokens the viewer may see (the owner role sees all, an admin all
 * but the owner's, anyone else their own), so paging and counts stay consistent.
 *
 * Everything is tenant-scoped through runWithTenantScope, like the rest of the
 * authorization center.
 */

import {
  runWithTenantScope,
  type IApiToken,
  type IGroup,
  type IUser,
  type IamGroupFilter,
  type IamTokenFilter,
  type IamUserFilter,
} from '@/lib/database';
import { canManageToken, tokenVisibilityFor } from '@/lib/services/apiTokens/tokenGovernance';
import { loadTokenPolicyForDisplay, presentApiToken } from '@/lib/services/apiTokens/tokenPolicy';
import {
  canSeeTokensOf,
  computeAllowedActions,
  computeAllowedGroupActions,
  assignableRoles,
  targetOf,
  type AllowedActions,
  type AllowedGroupActions,
  type PolicyActor,
} from '@/lib/services/users/peoplePolicy';
import { collectAccessibleProjectIds } from '@/lib/services/projects/accessibleProjects';
import { roleManagedPredicate } from '@/lib/services/users/roleManagement';
import { normalizeServicePermissions, type UserServicePermissions } from '@/lib/security/rbac';
import {
  AUTH_PROVIDERS,
  DIRECTORY_READ_ONLY_FIELDS,
  TENANT_ROLES,
  isDirectoryManaged,
  isGroupDirectoryManaged,
  isPendingInvite,
  listStatusOf,
  providerOf,
  userKind,
  type AllowedAction,
  type AuthProvider,
  type ListStatus,
  type TenantRole,
  type UserKind,
} from './identity';
import { isSafeId } from './policySpec';
import { countDirectReferences } from './policyRows';
import { buildEnforcePrincipalWithNarrowing } from './enforce';
import {
  computeEffectivePermissions,
  loadEvaluationPrincipal,
  tokenStatus,
  type EffectiveService,
  type IamTenant,
  type PrincipalDetail,
  type PrincipalListItem,
  type PrincipalType,
} from './principals';
import { listPolicies } from './store';

// ── what the viewer is ───────────────────────────────────────────────────

/** The signed-in person asking. `role` is the role the database holds now. */
export type DirectoryViewer = PolicyActor;

// ── the query ────────────────────────────────────────────────────────────

export const USER_SORTS = ['name', 'email', 'createdAt'] as const;
export type UserSort = (typeof USER_SORTS)[number];
const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** Most ids a request may hydrate at once. */
export const MAX_DIRECTORY_IDS = 100;

export interface DirectoryFilters {
  // users
  roles?: TenantRole[];
  status?: ListStatus;
  kind?: UserKind;
  providers?: AuthProvider[];
  groupId?: string;
  projectId?: string;
  sort?: UserSort;
  dir?: SortDirection;
  // groups
  groupSources?: Array<'local' | 'ldap' | 'oidc'>;
  // tokens
  tokenStatus?: 'active' | 'expired';
  ownerId?: string;
  scoped?: boolean;
}

export interface DirectoryRequest extends DirectoryFilters {
  type: PrincipalType;
  q?: string;
  limit: number;
  offset: number;
  /** Also answer the number of matches (one more scan; ask once per filter change, not per page). */
  count?: boolean;
  ids?: string[];
}

export interface FilterIssue {
  field: string;
  message: string;
}

export type ParsedFilters =
  | { ok: true; filters: DirectoryFilters; ids?: string[] }
  | { ok: false; details: FilterIssue[] };

/** The value of a query key: a string, nothing, or `null` when it was repeated or is not text. */
function single(raw: Record<string, unknown>, ...names: string[]): string | undefined | null {
  for (const name of names) {
    const value = raw[name];
    if (value === undefined || value === '') continue;
    return typeof value === 'string' ? value.trim() : null;
  }
  return undefined;
}

/** A comma separated value, trimmed, empty parts dropped. */
function list(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

const USER_SOURCES: Record<string, AuthProvider[]> = {
  local: ['local'],
  ldap: ['ldap'],
  oidc: ['oidc'],
  saml: ['saml'],
  sso: ['oidc', 'saml'],
  directory: ['ldap', 'oidc', 'saml'],
};
const GROUP_SOURCES: Record<string, Array<'local' | 'ldap' | 'oidc'>> = {
  local: ['local'],
  ldap: ['ldap'],
  oidc: ['oidc'],
  sso: ['oidc'],
  directory: ['ldap', 'oidc'],
};

/**
 * Validate the filters of one request (the query string as Fastify parsed it).
 * Parameter names: `role` (csv), `status`, `kind`, `source` (csv), `group` / `groupId`,
 * `project` / `projectId`, `sort`, `dir` for people; `source`, `project` for groups;
 * `status`, `ownerId`, `project`, `scoped` for tokens; `ids` (csv) for all.
 */
export function parseDirectoryFilters(type: PrincipalType, raw: Record<string, unknown>): ParsedFilters {
  const issues: FilterIssue[] = [];
  const filters: DirectoryFilters = {};
  const bad = (field: string, message: string) => issues.push({ field, message });

  const id = (field: string, ...names: string[]): string | undefined => {
    const value = single(raw, ...names);
    if (value === undefined) return undefined;
    if (value === null || !isSafeId(value)) {
      bad(field, 'Not a valid id');
      return undefined;
    }
    return value;
  };
  const choice = <T extends string>(field: string, allowed: readonly T[]): T | undefined => {
    const value = single(raw, field);
    if (value === undefined) return undefined;
    if (value === null || !(allowed as readonly string[]).includes(value)) {
      bad(field, `Must be one of: ${allowed.join(', ')}`);
      return undefined;
    }
    return value as T;
  };

  if (type === 'user') {
    const role = single(raw, 'role');
    if (role === null) bad('role', 'Must be a comma separated list of roles');
    else if (role !== undefined) {
      const roles = [...new Set(list(role))];
      if (roles.length === 0 || roles.some((r) => !(TENANT_ROLES as readonly string[]).includes(r))) bad('role', `Must be roles from: ${TENANT_ROLES.join(', ')}`);
      else filters.roles = roles as TenantRole[];
    }
    filters.status = choice('status', ['active', 'disabled', 'invited'] as const);
    filters.kind = choice('kind', ['person', 'service'] as const);
    const source = single(raw, 'source');
    if (source === null) bad('source', 'Must be a comma separated list of sources');
    else if (source !== undefined) {
      const parts = list(source);
      if (parts.length === 0 || parts.some((part) => !USER_SOURCES[part])) bad('source', `Must be sources from: ${Object.keys(USER_SOURCES).join(', ')}`);
      else filters.providers = [...new Set(parts.flatMap((part) => USER_SOURCES[part]))].filter((p) => (AUTH_PROVIDERS as readonly string[]).includes(p));
    }
    filters.groupId = id('group', 'group', 'groupId');
    filters.projectId = id('project', 'project', 'projectId');
    filters.sort = choice('sort', USER_SORTS);
    filters.dir = choice('dir', SORT_DIRECTIONS);
  } else if (type === 'group') {
    const source = single(raw, 'source');
    if (source === null) bad('source', 'Must be a comma separated list of sources');
    else if (source !== undefined) {
      const parts = list(source);
      if (parts.length === 0 || parts.some((part) => !GROUP_SOURCES[part])) bad('source', `Must be sources from: ${Object.keys(GROUP_SOURCES).join(', ')}`);
      else filters.groupSources = [...new Set(parts.flatMap((part) => GROUP_SOURCES[part]))];
    }
    filters.projectId = id('project', 'project', 'projectId');
  } else {
    filters.tokenStatus = choice('status', ['active', 'expired'] as const);
    filters.ownerId = id('ownerId', 'ownerId', 'owner');
    filters.projectId = id('project', 'project', 'projectId');
    const scoped = choice('scoped', ['true', 'false'] as const);
    if (scoped !== undefined) filters.scoped = scoped === 'true';
  }

  let ids: string[] | undefined;
  const rawIds = single(raw, 'ids');
  if (rawIds === null) bad('ids', 'Must be a comma separated list of ids');
  else if (rawIds !== undefined) {
    const parts = [...new Set(list(rawIds))];
    if (parts.length === 0) bad('ids', 'Must be a comma separated list of ids');
    else if (parts.length > MAX_DIRECTORY_IDS) bad('ids', `At most ${MAX_DIRECTORY_IDS} ids`);
    else if (parts.some((part) => !isSafeId(part))) bad('ids', 'Not a valid id');
    else ids = parts;
  }

  if (issues.length > 0) return { ok: false, details: issues };
  // keep the object free of undefined keys
  for (const key of Object.keys(filters) as Array<keyof DirectoryFilters>) if (filters[key] === undefined) delete filters[key];
  return { ok: true, filters, ...(ids ? { ids } : {}) };
}

// ── rows ─────────────────────────────────────────────────────────────────

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const userLabel = (user: Pick<IUser, 'name' | 'email'>): string => user.name || user.email || '';

export interface DirectoryUserItem extends PrincipalListItem {
  type: 'user';
  email: string;
  kind: UserKind;
  authProvider: AuthProvider;
  managed: boolean;
  /** The directory also decides the role (its connection syncs roles): the role is shown as managed, not editable. */
  roleManaged: boolean;
  createdAt: string | null;
  invitedAt: string | null;
  allowedActions: AllowedActions;
}

export interface DirectoryGroupItem extends PrincipalListItem {
  type: 'group';
  source: string;
  tenantRole: string | null;
  managed: boolean;
  allowedActions: AllowedGroupActions;
}

export interface DirectoryTokenItem extends PrincipalListItem {
  type: 'token';
  prefix: string | null;
  ownerId: string;
  ownerLabel: string | null;
  ownerKind: UserKind | null;
  ownerDisabled: boolean;
  ownerMissing: boolean;
  projectId: string | null;
  projectName: string | null;
  scoped: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
  allowedActions: { edit: AllowedAction; revoke: AllowedAction };
}

export type DirectoryItem = DirectoryUserItem | DirectoryGroupItem | DirectoryTokenItem;

export interface DirectoryPage {
  items: DirectoryItem[];
  hasMore: boolean;
  total?: number;
}

/** The provider filter a person-list request stands for. */
export function userFilterOf(tenantId: string, request: Pick<DirectoryRequest, 'q' | 'ids'> & DirectoryFilters): IamUserFilter {
  const filter: IamUserFilter = { tenantId };
  if (request.q) filter.q = request.q;
  if (request.ids) filter.ids = request.ids;
  if (request.roles) filter.roles = request.roles;
  // active = not disabled and not waiting for an answer; the three statuses partition the people
  if (request.status === 'active') {
    filter.status = 'active';
    filter.invited = false;
  } else if (request.status === 'disabled') {
    filter.status = 'disabled';
  } else if (request.status === 'invited') {
    filter.invited = true;
  }
  if (request.kind) filter.canLogin = request.kind === 'person';
  if (request.providers) filter.authProviders = request.providers;
  if (request.groupId) filter.groupId = request.groupId;
  if (request.projectId) filter.projectId = request.projectId;
  return filter;
}

export async function listDirectory(
  tenant: IamTenant,
  viewer: DirectoryViewer,
  request: DirectoryRequest,
): Promise<DirectoryPage> {
  const policies = await listPolicies(tenant.tenantDbName);
  const direct = countDirectReferences(policies);
  const count = (type: PrincipalType, id: string) => direct.get(`${type}:${id}`) ?? 0;
  const page = { limit: request.limit, offset: request.offset };

  return runWithTenantScope(tenant.tenantDbName, async (db) => {
    if (request.type === 'user') {
      const filter = userFilterOf(tenant.tenantId, request);
      const [res, total] = await Promise.all([
        db.iamListUsers({ ...filter, ...page, sort: request.sort, dir: request.dir }),
        request.count ? db.iamCountUsers(filter) : Promise.resolve(undefined),
      ]);
      const roleManaged = await roleManagedPredicate(tenant, res.items);
      return {
        hasMore: res.hasMore,
        ...(total !== undefined ? { total } : {}),
        items: res.items.map((user): DirectoryUserItem => ({
          type: 'user',
          id: String(user._id),
          label: userLabel(user),
          sublabel: user.email || '',
          role: typeof user.role === 'string' ? user.role : undefined,
          status: listStatusOf(user),
          policyCount: count('user', String(user._id)),
          email: user.email || '',
          kind: userKind(user),
          authProvider: providerOf(user),
          managed: isDirectoryManaged(user),
          roleManaged: roleManaged(user),
          createdAt: iso(user.createdAt),
          invitedAt: iso(user.invitedAt),
          allowedActions: computeAllowedActions(viewer, targetOf(user, { roleManaged: roleManaged(user) })),
        })),
      };
    }

    if (request.type === 'group') {
      const filter: IamGroupFilter = {
        tenantId: tenant.tenantId,
        ...(request.q ? { q: request.q } : {}),
        ...(request.ids ? { ids: request.ids } : {}),
        ...(request.groupSources ? { sources: request.groupSources } : {}),
        ...(request.projectId ? { projectId: request.projectId } : {}),
      };
      const [res, total] = await Promise.all([
        db.iamListGroups({ ...filter, ...page }),
        request.count ? db.iamCountGroups(filter) : Promise.resolve(undefined),
      ]);
      const counts = await db.iamCountGroupMembers(res.items.map((group) => String(group._id)));
      return {
        hasMore: res.hasMore,
        ...(total !== undefined ? { total } : {}),
        items: res.items.map((group): DirectoryGroupItem => ({
          type: 'group',
          id: String(group._id),
          label: group.name,
          // Language-neutral on purpose (the server does not know the reader's language): a group that comes
          // from a directory says where from - "LDAP", "SSO" - when it has no description of its own.
          sublabel: group.description || (group.source && group.source !== 'local' ? String(group.source).toUpperCase() : ''),
          memberCount: counts[String(group._id)] ?? 0,
          policyCount: count('group', String(group._id)),
          source: group.source ?? 'local',
          tenantRole: group.tenantRole ?? null,
          managed: isGroupDirectoryManaged(group),
          allowedActions: computeAllowedGroupActions(viewer, group),
        })),
      };
    }

    // tokens: the query is narrowed to what the viewer may see, so paging and the count agree with the list
    const visibility = await tokenVisibilityFor(db, viewer, tenant.tenantId);
    const filter: IamTokenFilter = {
      tenantId: tenant.tenantId,
      ...(request.q ? { q: request.q } : {}),
      ...(request.ids ? { ids: request.ids } : {}),
      ...(request.tokenStatus ? { status: request.tokenStatus } : {}),
      ...(request.ownerId ? { userId: request.ownerId } : {}),
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.scoped !== undefined ? { scoped: request.scoped } : {}),
      ...(visibility.mode === 'exclude' && visibility.excludeUserIds.length > 0 ? { excludeUserIds: visibility.excludeUserIds } : {}),
      ...(visibility.mode === 'own' ? { userIds: visibility.userIds } : {}),
    };
    const [res, total] = await Promise.all([
      db.iamListTokens({ ...filter, ...page }),
      request.count ? db.iamCountTokens(filter) : Promise.resolve(undefined),
    ]);
    const ownerIds = [...new Set(res.items.map((token) => String(token.userId)))];
    const [owners, projects] = await Promise.all([
      ownerIds.length > 0 ? db.iamListUsers({ tenantId: tenant.tenantId, ids: ownerIds, limit: 200 }) : Promise.resolve({ items: [] as IUser[], hasMore: false }),
      res.items.some((token) => token.projectId) ? db.listProjects(tenant.tenantId) : Promise.resolve([]),
    ]);
    const ownerById = new Map(owners.items.map((owner) => [String(owner._id), owner]));
    const projectName = new Map(projects.map((project) => [String(project._id), project.name]));
    return {
      hasMore: res.hasMore,
      ...(total !== undefined ? { total } : {}),
      items: res.items.map((token): DirectoryTokenItem => {
        const owner = ownerById.get(String(token.userId)) ?? null;
        const manageable = canManageToken({ userId: viewer.id, userRole: viewer.role }, token, owner ? targetOf(owner) : null);
        const verdict: AllowedAction = manageable ? { allowed: true } : { allowed: false, reason: 'higher_privileges' };
        return {
          type: 'token',
          id: String(token._id),
          label: token.label,
          sublabel: [token.tokenPrefix ? `${token.tokenPrefix}…` : '', owner ? userLabel(owner) : ''].filter(Boolean).join(' · '),
          status: tokenStatus(token),
          policyCount: count('token', String(token._id)),
          prefix: token.tokenPrefix ?? null,
          ownerId: String(token.userId),
          ownerLabel: owner ? userLabel(owner) : null,
          ownerKind: owner ? userKind(owner) : null,
          ownerDisabled: owner?.status === 'disabled',
          ownerMissing: owner === null,
          projectId: token.projectId ? String(token.projectId) : null,
          projectName: token.projectId ? projectName.get(String(token.projectId)) ?? null : null,
          scoped: token.servicePermissions != null,
          expiresAt: iso(token.expiresAt),
          lastUsedAt: iso(token.lastUsed),
          createdAt: iso(token.createdAt),
          allowedActions: { edit: verdict, revoke: verdict },
        };
      }),
    };
  });
}

// ── the detail of one principal ──────────────────────────────────────────

/** The token behind a detail request when the viewer may not see it: reads as "no such token". */
export async function tokenVisibleToViewer(
  tenant: IamTenant,
  viewer: DirectoryViewer,
  tokenId: string,
): Promise<boolean> {
  return runWithTenantScope(tenant.tenantDbName, async (db) => {
    let token: IApiToken | null = null;
    try {
      token = await db.findApiTokenById(tokenId, tenant.tenantId);
    } catch {
      return false;
    }
    if (!token) return true; // not found: the detail itself answers 404 in its own words
    if (String(token.userId) === String(viewer.id)) return true;
    let owner: IUser | null = null;
    try {
      owner = await db.findUserById(String(token.userId));
    } catch {
      owner = null;
    }
    return canSeeTokensOf(viewer, owner && String(owner.tenantId) === String(tenant.tenantId) ? targetOf(owner) : null);
  });
}

/** Most tokens a person's detail lists; the total says how many there are. */
const DETAIL_TOKEN_LIMIT = 100;

export interface DetailAugmentation {
  /** Added to `principal`. */
  principal: Record<string, unknown>;
  /** Added next to `principal`, `effective`... */
  extra: Record<string, unknown>;
  /** Replacements for the detail's own lists. */
  groups?: Array<Record<string, unknown>>;
  projects?: PrincipalDetail['projects'] | Array<Record<string, unknown>>;
  tokens?: PrincipalDetail['tokens'];
}

/**
 * What a screen needs on top of the effective permissions: the person's profile facts,
 * who manages the account, what THIS viewer may do with the person, the groups and
 * projects with whether a membership can be removed here, and the tokens the viewer
 * may see. Reads only what the detail did not already load.
 */
export async function augmentPrincipalDetail(
  tenant: IamTenant,
  viewer: DirectoryViewer,
  detail: PrincipalDetail,
  ref: { type: PrincipalType; id: string },
): Promise<DetailAugmentation> {
  return runWithTenantScope(tenant.tenantDbName, async (db) => {
    if (ref.type === 'group') {
      let group: IGroup | null = null;
      try {
        group = await db.findGroupById(ref.id);
      } catch {
        group = null;
      }
      if (!group || String(group.tenantId) !== String(tenant.tenantId)) return { principal: {}, extra: {} };
      return {
        principal: {
          source: group.source ?? 'local',
          tenantRole: group.tenantRole ?? null,
          servicePermissions: normalizeServicePermissions(group.servicePermissions),
          managed: isGroupDirectoryManaged(group),
        },
        extra: { allowedActions: computeAllowedGroupActions(viewer, group) },
      };
    }

    if (ref.type === 'token') {
      const token = await db.findApiTokenById(ref.id, tenant.tenantId);
      if (!token) return { principal: {}, extra: {} };
      const owner = await db.findUserById(String(token.userId)).catch(() => null);
      const ownerRow = owner && String(owner.tenantId) === String(tenant.tenantId) ? owner : null;
      const manageable = canManageToken({ userId: viewer.id, userRole: viewer.role }, token, ownerRow ? targetOf(ownerRow) : null);
      const verdict: AllowedAction = manageable ? { allowed: true } : { allowed: false, reason: 'higher_privileges' };
      const project = token.projectId ? await db.findProjectById(String(token.projectId)).catch(() => null) : null;
      const policy = await loadTokenPolicyForDisplay(tenant.tenantDbName);
      return {
        principal: {
          ownerKind: ownerRow ? userKind(ownerRow) : null,
          ownerMissing: ownerRow === null,
          projectName: project && String(project.tenantId) === String(tenant.tenantId) ? project.name : null,
          createdAt: iso(token.createdAt),
          createdBy: token.createdBy ?? null,
        },
        extra: {
          allowedActions: { edit: verdict, revoke: verdict },
          // the shape the token forms consume; the allowlist ranges only for whoever may edit the token
          tokenRow: presentApiToken(token, { policy, canDelete: manageable, canEdit: manageable }),
        },
      };
    }

    // a person
    const user = await db.findUserById(ref.id).catch(() => null);
    if (!user || String(user.tenantId) !== String(tenant.tenantId)) return { principal: {}, extra: {} };
    const roleFromDirectory = await roleManagedPredicate(tenant, [user]).then((managed) => managed(user));
    const target = targetOf(user, { roleManaged: roleFromDirectory });

    const groupIds = detail.groups.map((group) => group.id);
    const groupDocs = groupIds.length > 0
      ? (await db.iamListGroups({ tenantId: tenant.tenantId, ids: groupIds, limit: 200 })).items
      : [];
    const groupById = new Map(groupDocs.map((group) => [String(group._id), group]));
    const groups = detail.groups.map((group) => {
      const doc = groupById.get(group.id);
      return {
        id: group.id,
        name: group.name,
        source: doc?.source ?? 'local',
        tenantRole: doc?.tenantRole ?? null,
        removable: doc ? !isGroupDirectoryManaged(doc) : false,
      };
    });

    const projects = detail.projects.map((project) => ({
      ...project,
      // a direct membership (or an entry of the legacy list) is removed here; a group's or an admin's is not a row of the person
      removable: project.via === 'direct' || project.via === 'legacy',
    }));

    // Tokens: the person's own for themself, everyone's for the owner role, all but the owner's for an admin.
    const visible = canSeeTokensOf(viewer, target);
    let tokens: PrincipalDetail['tokens'] = null;
    const extra: Record<string, unknown> = {
      allowedActions: computeAllowedActions(viewer, target),
      assignableRoles: assignableRoles(viewer, target),
      tokensHidden: !visible,
    };
    if (visible) {
      const total = await db.iamCountTokens({ tenantId: tenant.tenantId, userId: ref.id });
      tokens = detail.tokens ?? [];
      extra.tokensTotal = total;
      extra.tokensTruncated = total > Math.min(tokens.length, DETAIL_TOKEN_LIMIT);
    } else {
      tokens = [];
      extra.tokensTotal = 0;
      extra.tokensTruncated = false;
    }

    return {
      principal: {
        // the same classification as a row of the list (an unanswered invitation reads `invited`)
        status: listStatusOf(user),
        email: user.email || '',
        authProvider: providerOf(user),
        canLogin: user.canLogin !== false,
        kind: userKind(user),
        createdAt: iso(user.createdAt),
        invitedAt: iso(user.invitedAt),
        inviteAcceptedAt: iso(user.inviteAcceptedAt),
        pendingInvite: isPendingInvite(user),
        disabledAt: iso(user.disabledAt),
        disabledBy: user.disabledBy ?? null,
        disabledReason: user.disabledReason ?? null,
        // the DIRECT overrides: what the access editor starts from (the effective table is a separate thing)
        servicePermissions: normalizeServicePermissions(user.servicePermissions),
        managed: {
          directory: isDirectoryManaged(user),
          provider: providerOf(user),
          readOnly: isDirectoryManaged(user) ? [...DIRECTORY_READ_ONLY_FIELDS] : [],
          // the role follows the directory at every sign-in (the connection syncs roles)
          roleFromDirectory,
        },
      },
      extra,
      groups,
      projects,
      tokens,
    };
  });
}

// ── the members of a group ───────────────────────────────────────────────

export interface GroupMemberRow {
  userId: string;
  label: string;
  email: string | null;
  role: string | null;
  status: ListStatus | null;
  kind: UserKind | null;
  /** Where the membership comes from (a directory group's members are the directory's): the group's own source. */
  membershipSource: 'local' | 'ldap' | 'oidc';
  /** The membership points at an account that no longer exists: it can still be removed. */
  missing?: true;
}

export interface GroupMembersPage {
  items: GroupMemberRow[];
  hasMore: boolean;
  total: number;
}

/**
 * One page of a group's members, ordered by user id, with the people behind them read in ONE
 * query. A membership whose account is gone comes back flagged `missing` so it can be removed.
 * Null when the group does not exist in this workspace.
 */
export async function listGroupMembers(
  tenant: IamTenant,
  groupId: string,
  page: { limit: number; offset: number },
): Promise<GroupMembersPage | null> {
  return runWithTenantScope(tenant.tenantDbName, async (db) => {
    let group: IGroup | null = null;
    try {
      group = await db.findGroupById(groupId);
    } catch {
      group = null; // an id the database cannot parse names no group
    }
    if (!group || String(group.tenantId) !== String(tenant.tenantId)) return null;

    const [ids, counts] = await Promise.all([
      db.iamListGroupMemberIds(groupId, page),
      db.iamCountGroupMembers([groupId]),
    ]);
    const people = ids.items.length > 0
      ? await db.iamListUsers({ tenantId: tenant.tenantId, ids: ids.items, limit: Math.max(1, ids.items.length) })
      : { items: [] as IUser[], hasMore: false };
    const byId = new Map(people.items.map((user) => [String(user._id), user]));
    const membershipSource = group.source === 'oidc' ? 'oidc' as const : isGroupDirectoryManaged(group) ? 'ldap' as const : 'local' as const;
    return {
      hasMore: ids.hasMore,
      total: counts[groupId] ?? 0,
      items: ids.items.map((userId): GroupMemberRow => {
        const user = byId.get(userId);
        if (!user) return { userId, label: userId, email: null, role: null, status: null, kind: null, membershipSource, missing: true };
        return {
          userId,
          label: userLabel(user),
          email: user.email || null,
          role: typeof user.role === 'string' ? user.role : null,
          status: listStatusOf(user),
          kind: userKind(user),
          membershipSource,
        };
      }),
    };
  });
}

// ── a draft of someone's access ──────────────────────────────────────────

export interface AccessDraft {
  role?: 'admin' | 'project_admin' | 'user';
  servicePermissions?: UserServicePermissions;
}

export interface AccessPreview {
  effective: EffectiveService[];
  changes: Array<{ service: string; from: string; to: string }>;
  projects: { before: number; after: number };
}

/**
 * What the person's effective access would be WITH the draft (a role and/or the direct permission
 * overrides), through the real engine and with their groups, next to what it is now. Nothing is
 * stored, and the draft is not clamped to the viewer: the clamp is applied when it is saved.
 */
export async function previewAccess(
  tenant: IamTenant,
  userId: string,
  draft: AccessDraft,
): Promise<AccessPreview> {
  const current = await loadEvaluationPrincipal(tenant, { type: 'user', id: userId }, null, { workspaceLevel: true, noStore: true });
  const before = await computeEffectivePermissions(tenant, current);

  const draftUser: IUser = {
    ...current.user,
    ...(draft.role ? { role: draft.role } : {}),
    ...(draft.servicePermissions ? { servicePermissions: draft.servicePermissions } : {}),
  };
  const { principal } = await buildEnforcePrincipalWithNarrowing({
    subject: 'session',
    tenantDbName: tenant.tenantDbName,
    tenantId: tenant.tenantId,
    requestId: 'iam-center',
    method: 'GET',
    route: '/api/iam',
    userId,
    user: draftUser,
    groupGrants: current.groupGrants,
    skipProjectNarrowing: true,
    service: 'iam',
    noStore: true,
  });
  const after = await computeEffectivePermissions(tenant, {
    ...current,
    user: draftUser,
    principal,
    role: typeof draftUser.role === 'string' ? draftUser.role : '',
  });

  const beforeByService = new Map(before.map((row) => [row.service, row.level]));
  const changes = after
    .filter((row) => (beforeByService.get(row.service) ?? 'none') !== row.level)
    .map((row) => ({ service: row.service, from: beforeByService.get(row.service) ?? 'none', to: row.level }));

  const counts = await runWithTenantScope(tenant.tenantDbName, async (db) => {
    const count = async (user: Pick<IUser, '_id' | 'role' | 'projectIds'>): Promise<number> => {
      if (user.role === 'owner' || user.role === 'admin') return (await db.listProjects(tenant.tenantId)).length;
      return (await collectAccessibleProjectIds(db, String(user._id), user.projectIds)).length;
    };
    return { before: await count(current.user), after: await count(draftUser) };
  });

  return { effective: after, changes, projects: counts };
}
