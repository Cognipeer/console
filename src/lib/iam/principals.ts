/**
 * Principals of the Authorization center: who can be searched, inspected and
 * simulated. Users, groups and API tokens - listed with server-side paging (a
 * 20K-person organisation is never loaded as a whole) and described with their
 * EFFECTIVE permissions: what the engine really allows, and
 * where each level comes from (role, direct grant, group, token scope, project,
 * custom policy).
 *
 * Everything is strictly tenant-scoped: every read goes through
 * runWithTenantScope(tenantDbName) and every row is checked against the
 * caller's tenantId again (defence in depth).
 */

import { runWithTenantScope, type DatabaseProvider, type IApiToken, type IGroup, type IUser } from '@/lib/database';
import {
  RBAC_SERVICE_DEFINITIONS,
  getEffectiveServicePermission,
  getEffectiveServicePermissionWithGroups,
  getRoleDefaultPermission,
  minPermission,
  normalizeServicePermissions,
  type GroupTenantGrant,
  type PermissionService,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { probeServiceLevel } from './effective';
import { buildEnforcePrincipalWithNarrowing } from './enforce';
import { userPrincipal, type IamPrincipal } from './entities';
import { groupToGrant, loadUserGroups } from './groupGrants';
import { listPolicies } from './store';
import { countDirectReferences, policyReferences, toPolicyRows, type PolicyRow } from './policyRows';
import { getDefaultProjectId, narrowLevel, type NarrowingResult } from './projectNarrowing';

export type PrincipalType = 'user' | 'group' | 'token';

export interface IamTenant {
  tenantDbName: string;
  tenantId: string;
}

export class PrincipalError extends Error {
  readonly code: 'principal_not_found' | 'invalid_input';
  constructor(code: 'principal_not_found' | 'invalid_input', message: string) {
    super(message);
    this.name = 'PrincipalError';
    this.code = code;
  }
}

const isForeign = (record: { tenantId?: unknown } | null | undefined, tenantId: string): boolean =>
  !!record?.tenantId && String(record.tenantId) !== String(tenantId);

/** Lookups on MongoDB throw for ids that are not ObjectIds; for us that is simply "no such record". */
async function find<T>(lookup: () => Promise<T | null | undefined>): Promise<T | null> {
  try {
    return (await lookup()) ?? null;
  } catch (error) {
    if (error instanceof Error && /objectid|24 character|hex string|BSONError|Argument passed in must/i.test(error.message)) return null;
    throw error;
  }
}

async function findToken(db: DatabaseProvider, tenantId: string, id: string): Promise<IApiToken | null> {
  const token = await find(async () => {
    if (typeof db.findApiTokenById === 'function') return db.findApiTokenById(id, tenantId);
    return (await db.listTenantApiTokens(tenantId)).find((t) => String(t._id) === id) ?? null;
  });
  return token && !isForeign(token, tenantId) ? token : null;
}

const userLabel = (u: Pick<IUser, 'name' | 'email'>): string => u.name || u.email || '';

export function tokenStatus(token: Pick<IApiToken, 'expiresAt'>, now = Date.now()): 'active' | 'expired' {
  return token.expiresAt && new Date(token.expiresAt).getTime() <= now ? 'expired' : 'active';
}

// ── evaluation principals (simulate / preview / effective permissions) ────

export interface EvaluationPrincipal {
  type: 'user' | 'token';
  /** Set for a GROUP audience (`loadGroupAudience`): a plain member of the group, not a person or a token. `type` is `user` then. */
  audience?: 'group';
  id: string;
  label: string;
  /** The principal the gates build: groups, project narrowing, token cap. */
  principal: IamPrincipal;
  /** The user - for a token, its owner. */
  user: IUser;
  /** The user's group grants (a token owner's apply to the token as well). */
  groupGrants: GroupTenantGrant[];
  /** Name of the group behind each entry of `groupGrants` (same order). */
  grantGroupNames: string[];
  groups: Array<{ id: string; name: string }>;
  /** The project membership that narrowed this principal (null = nothing narrows). */
  narrowing: NarrowingResult | null;
  tokenScope: UserServicePermissions | null | undefined;
  token?: IApiToken;
  role: string;
  accountDisabled: boolean;
}

export interface EvaluationOptions {
  /**
   * Evaluate in the workspace itself when no project is given: no project narrowing
   * and no default-project fallback ("what can this person do before a project limits
   * it?" - the effective-permissions table). Off by default: a request without an
   * active project runs in the person's first / default project, which is what the
   * gate (and so an access check or a preview) must reproduce, because a project's
   * own settings can deny what the workspace allows.
   */
  workspaceLevel?: boolean;
  /** Bulk callers (the impact preview): read the principal cache but do not fill it. */
  noStore?: boolean;
}

/**
 * Build the principal the gate would build for this user / token acting in
 * `projectId` (null = whatever project the gate would pick without a cookie).
 * A token without a project of its own runs in the workspace's default project,
 * exactly as the token gate resolves it (apiTokenAuth.ts).
 */
export async function loadEvaluationPrincipal(
  tenant: IamTenant,
  ref: { type: 'user' | 'token'; id: string },
  projectId?: string | null,
  options: EvaluationOptions = {},
): Promise<EvaluationPrincipal> {
  const loaded = await runWithTenantScope(tenant.tenantDbName, async (db) => {
    let token: IApiToken | null = null;
    let userId = ref.id;
    if (ref.type === 'token') {
      token = await findToken(db, tenant.tenantId, ref.id);
      if (!token) throw new PrincipalError('principal_not_found', 'API token not found');
      userId = String(token.userId);
    }
    const user = await find(() => db.findUserById(userId));
    if (!user || isForeign(user, tenant.tenantId)) {
      throw new PrincipalError('principal_not_found', ref.type === 'token' ? 'The owner of this token no longer exists' : 'User not found');
    }
    const groups: IGroup[] = await loadUserGroups(db, userId, tenant.tenantId);
    return { token, user, groups };
  });

  const grantPairs = loaded.groups
    .map((g) => ({ name: g.name, grant: groupToGrant(g) }))
    .filter((p): p is { name: string; grant: GroupTenantGrant } => !!p.grant);
  const groupGrants = grantPairs.map((p) => p.grant);
  let requestedProjectId = projectId ?? (loaded.token?.projectId ? String(loaded.token.projectId) : null);
  if (!requestedProjectId && loaded.token) {
    // The token gate runs a project-less token in the default project (apiTokenAuth.ts); so must anything that mirrors it.
    requestedProjectId = await getDefaultProjectId(tenant.tenantDbName, tenant.tenantId);
  }
  const { principal, narrowing } = await buildEnforcePrincipalWithNarrowing({
    subject: ref.type === 'token' ? 'token' : 'session',
    tenantDbName: tenant.tenantDbName,
    tenantId: tenant.tenantId,
    requestId: 'iam-center',
    method: 'GET',
    route: '/api/iam',
    userId: String(loaded.user._id),
    user: loaded.user,
    groupGrants,
    groups: loaded.groups,
    tokenId: loaded.token ? String(loaded.token._id) : undefined,
    tokenScope: loaded.token ? loaded.token.servicePermissions ?? null : undefined,
    requestedProjectId,
    // The workspace-level answer (before any project limits it) only when asked for.
    skipProjectNarrowing: options.workspaceLevel === true && !requestedProjectId,
    service: 'iam',
    noStore: options.noStore,
  });

  return {
    type: ref.type,
    id: ref.id,
    label: loaded.token ? loaded.token.label : userLabel(loaded.user),
    principal,
    user: loaded.user,
    groupGrants,
    grantGroupNames: grantPairs.map((p) => p.name),
    narrowing,
    groups: loaded.groups.map((g) => ({ id: String(g._id), name: g.name })),
    tokenScope: loaded.token ? loaded.token.servicePermissions ?? null : undefined,
    token: loaded.token ?? undefined,
    role: typeof loaded.user.role === 'string' ? loaded.user.role : '',
    accountDisabled: loaded.user.status === 'disabled',
  };
}

/**
 * A GROUP as an audience ("view as"): a plain member of the group and nothing else - role `user`, the group
 * as its only group, the group's own grants, no project. It is what a portal check about a group asks:
 * "would somebody whose only trait is being in this group be admitted?". The id is synthetic and names no
 * user, so a custom rule that names one person never matches it.
 */
export async function loadGroupAudience(tenant: IamTenant, groupId: string): Promise<EvaluationPrincipal> {
  const group = await runWithTenantScope(tenant.tenantDbName, (db) => find(() => db.findGroupById(groupId)));
  if (!group || isForeign(group, tenant.tenantId)) throw new PrincipalError('principal_not_found', 'Group not found');
  const grant = groupToGrant(group);
  const principal = userPrincipal({
    userId: `group-audience:${groupId}`,
    user: { role: 'user' },
    groupGrants: grant ? [grant] : [],
    groupIds: [String(group._id)],
  });
  return {
    type: 'user',
    audience: 'group',
    id: groupId,
    label: group.name,
    principal,
    // Nothing reads the user row of an audience; the shape is only here to satisfy the evaluation contract.
    user: { _id: `group-audience:${groupId}`, tenantId: tenant.tenantId, email: '', password: '', name: group.name, role: 'user', licenseId: '' } as IUser,
    groupGrants: grant ? [grant] : [],
    grantGroupNames: grant ? [group.name] : [],
    narrowing: null,
    groups: [{ id: String(group._id), name: group.name }],
    tokenScope: undefined,
    role: 'user',
    accountDisabled: false,
  };
}

// ── list ─────────────────────────────────────────────────────────────────

export interface PrincipalListItem {
  type: PrincipalType;
  id: string;
  label: string;
  sublabel: string;
  role?: string;
  status?: string;
  memberCount?: number;
  policyCount: number;
}

export interface PrincipalListInput {
  type: PrincipalType;
  q?: string;
  limit: number;
  offset: number;
}

/**
 * A page of the workspace's people, groups or tokens with their policy counts.
 *
 * @deprecated No route uses it: `GET /api/iam/principals` answers from `listDirectory`
 * (directory.ts), which narrows the tokens by the viewer ("never upward") and carries the
 * filters, sort and totals of the people screen. This list does NOT narrow tokens - it
 * lists every one of the workspace - so it must not be put behind an endpoint or used for a
 * screen. Kept for the policy-count helpers it exercises in tests.
 */
export async function listPrincipals(
  tenant: IamTenant,
  input: PrincipalListInput,
): Promise<{ items: PrincipalListItem[]; hasMore: boolean }> {
  const policies = await listPolicies(tenant.tenantDbName);
  const direct = countDirectReferences(policies);
  const count = (type: PrincipalType, id: string) => direct.get(`${type}:${id}`) ?? 0;

  return runWithTenantScope(tenant.tenantDbName, async (db) => {
    const page = { limit: input.limit, offset: input.offset };
    if (input.type === 'user') {
      const res = await db.iamListUsers({ tenantId: tenant.tenantId, q: input.q, ...page });
      return {
        hasMore: res.hasMore,
        items: res.items.map((u): PrincipalListItem => ({
          type: 'user',
          id: String(u._id),
          label: userLabel(u),
          sublabel: u.email || '',
          role: typeof u.role === 'string' ? u.role : undefined,
          status: u.status === 'disabled' ? 'disabled' : 'active',
          policyCount: count('user', String(u._id)),
        })),
      };
    }
    if (input.type === 'group') {
      const res = await db.iamListGroups({ tenantId: tenant.tenantId, q: input.q, ...page });
      const counts = await db.iamCountGroupMembers(res.items.map((g) => String(g._id)));
      return {
        hasMore: res.hasMore,
        items: res.items.map((g): PrincipalListItem => ({
          type: 'group',
          id: String(g._id),
          label: g.name,
          // Language-neutral on purpose (the server does not know the reader's language): a group that comes
          // from a directory says where from - "LDAP", "SSO" - when it has no description of its own.
          sublabel: g.description || (g.source && g.source !== 'local' ? String(g.source).toUpperCase() : ''),
          memberCount: counts[String(g._id)] ?? 0,
          policyCount: count('group', String(g._id)),
        })),
      };
    }
    const res = await db.iamListTokens({ tenantId: tenant.tenantId, q: input.q, ...page });
    const owners = await db.iamListUsers({
      tenantId: tenant.tenantId,
      ids: [...new Set(res.items.map((t) => String(t.userId)))],
      limit: 200,
    });
    const ownerLabel = new Map(owners.items.map((u) => [String(u._id), userLabel(u)]));
    return {
      hasMore: res.hasMore,
      items: res.items.map((t): PrincipalListItem => ({
        type: 'token',
        id: String(t._id),
        label: t.label,
        sublabel: [t.tokenPrefix ? `${t.tokenPrefix}…` : '', ownerLabel.get(String(t.userId)) ?? ''].filter(Boolean).join(' · '),
        status: tokenStatus(t),
        policyCount: count('token', String(t._id)),
      })),
    };
  });
}

// ── effective permissions ────────────────────────────────────────────────

export type EffectiveLevel = 'none' | 'read' | 'write' | 'admin';

export interface EffectiveSource {
  kind: 'role' | 'direct' | 'group' | 'token-scope' | 'project' | 'policy';
  label: string;
  level: EffectiveLevel;
}

export interface EffectiveService {
  service: string;
  level: EffectiveLevel;
  sources: EffectiveSource[];
}

/** Services shown in the matrix: everything but the retired ones. */
const MATRIX_SERVICES = RBAC_SERVICE_DEFINITIONS.filter((d) => !d.deprecated);

const asLevel = (l: ServicePermissionLevel | undefined): EffectiveLevel => l ?? 'none';

/**
 * For each service: the level the ENFORCED engine gives this principal (what it
 * can really do, custom policies and boundaries included), plus the sources that
 * explain it. Levels are probed with the real engine (service-level read, write,
 * admin), so the table can never disagree with enforcement.
 */
export async function computeEffectivePermissions(
  tenant: IamTenant,
  evaluation: EvaluationPrincipal,
  projectName?: string,
): Promise<EffectiveService[]> {
  const { user, groupGrants } = evaluation;
  const projectMembership = evaluation.narrowing?.membership ?? null;
  const token = evaluation.type === 'token';
  const scope = evaluation.tokenScope == null ? null : normalizeServicePermissions(evaluation.tokenScope);
  const direct = normalizeServicePermissions(user.servicePermissions);
  const rows: EffectiveService[] = [];

  for (const def of MATRIX_SERVICES) {
    const service = def.id as PermissionService;
    const sources: EffectiveSource[] = [];

    // 1. role default (the owner always is admin)
    const roleLevel = user.role === 'owner' ? 'admin' : getRoleDefaultPermission(user.role, service);
    sources.push({ kind: 'role', label: String(user.role ?? ''), level: asLevel(roleLevel) });

    // 2. direct grant
    if (direct[service] && user.role !== 'owner') {
      sources.push({ kind: 'direct', label: 'Direct permission', level: direct[service]! });
    }

    // 3. groups (only ever raise)
    groupGrants.forEach((grant, i) => {
      const level = getEffectiveServicePermission({ role: grant.tenantRole, servicePermissions: grant.servicePermissions }, service);
      if (level === 'none') return;
      sources.push({ kind: 'group', label: evaluation.grantGroupNames[i] ?? 'Group', level });
    });

    // 4. project narrowing
    const baseLevel = getEffectiveServicePermissionWithGroups(user, groupGrants, service);
    if (projectMembership) {
      const narrowed = narrowLevel(baseLevel, projectMembership, service);
      const explicit = normalizeServicePermissions(projectMembership.servicePermissions)[service];
      if (explicit && narrowed !== baseLevel) sources.push({ kind: 'project', label: projectName ?? 'Project', level: explicit });
    }

    // 5. token scope (a cap)
    if (token && scope) sources.push({ kind: 'token-scope', label: 'Token scope', level: scope[service] ?? 'none' });

    // 6. the engine's answer: the level reached when every level up to it is allowed
    //    (a policy that forbids reading but allows writing leaves nothing usable).
    //    The workspace owner's own session always reaches `iam`, whatever a rule says (owner safety, enforce.ts;
    //    an API token of the owner is an ordinary principal).
    const probed = !token && user.role === 'owner' && service === 'iam'
      ? { level: 'admin' as const, reasons: [] as string[] }
      : await probeServiceLevel(tenant.tenantDbName, evaluation.principal, service, {
        projectId: evaluation.principal.contextProjectId,
        channel: token ? 'api' : 'dashboard',
      });
    const level = probed.level;
    const policyIds = new Set<string>(probed.reasons.filter((r) => r.startsWith('custom:')));
    // What RBAC alone would give (managed rules only), to see whether a policy moved it.
    let rbac = baseLevel;
    if (projectMembership) rbac = narrowLevel(rbac, projectMembership, service);
    if (token && scope) rbac = minPermission(rbac, scope[service] ?? 'none');
    const rbacLevel = def.adminService && rbac === 'write' ? 'read' : asLevel(rbac);
    if (level !== rbacLevel) {
      sources.push({
        kind: 'policy',
        label: policyIds.size ? [...new Set([...policyIds].map((id) => id.replace(/^custom:/, '').replace(/#\d+$/, '')))].join(', ') : 'Custom policy',
        level,
      });
    }

    rows.push({ service, level, sources });
  }
  return rows;
}

// ── detail ───────────────────────────────────────────────────────────────

export interface PrincipalProject {
  id: string;
  name: string;
  role: 'project_admin' | 'member' | null;
  via: 'direct' | 'group' | 'legacy' | 'implicit';
  groupName?: string;
}

export interface PrincipalDetail {
  /** Set when the caller asked not to compute the effective table (`effective` is then empty). */
  effectiveSkipped?: true;
  principal: {
    type: PrincipalType;
    id: string;
    label: string;
    sublabel: string;
    role?: string;
    status?: string;
    memberCount?: number;
    [extra: string]: unknown;
  };
  effective: EffectiveService[];
  groups: Array<{ id: string; name: string }>;
  projects: PrincipalProject[];
  policies: PolicyRow[];
  tokens: Array<Record<string, unknown>> | null;
}

function tokenSummary(t: IApiToken): Record<string, unknown> {
  return {
    id: String(t._id),
    label: t.label,
    prefix: t.tokenPrefix ?? null,
    projectId: t.projectId ?? null,
    scoped: t.servicePermissions != null,
    createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
    expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
    lastUsedAt: t.lastUsed ? new Date(t.lastUsed).toISOString() : null,
    status: tokenStatus(t),
  };
}

async function userProjects(
  tenant: IamTenant,
  db: DatabaseProvider,
  user: IUser,
  groupList: ReadonlyArray<{ id: string; name: string }>,
  projectNames: Map<string, string>,
): Promise<PrincipalProject[]> {
  const out = new Map<string, PrincipalProject>();
  const name = (id: string) => projectNames.get(id) ?? id;
  if (user.role === 'owner' || user.role === 'admin') {
    for (const [id, projectName] of projectNames) out.set(id, { id, name: projectName, role: 'project_admin', via: 'implicit' });
    return [...out.values()];
  }
  for (const id of (user.projectIds ?? []).map(String)) {
    out.set(id, { id, name: name(id), role: user.role === 'project_admin' ? 'project_admin' : 'member', via: 'legacy' });
  }
  for (const m of await db.listUserProjectsByUser(String(user._id))) {
    if (m.projectId) out.set(String(m.projectId), { id: String(m.projectId), name: name(String(m.projectId)), role: m.role, via: 'direct' });
  }
  const groupRows = await Promise.all(groupList.map((group) => db.listGroupProjectsByGroup(group.id)));
  groupList.forEach((group, i) => {
    for (const gp of groupRows[i]) {
      const id = String(gp.projectId);
      const existing = out.get(id);
      // a direct membership already says everything; otherwise a group can add or upgrade
      if (existing && (existing.via === 'direct' || existing.role === 'project_admin')) continue;
      out.set(id, { id, name: name(id), role: gp.role, via: 'group', groupName: group.name });
    }
  });
  return [...out.values()];
}

/** Custom policies that apply to a principal: naming it, one of its groups, or everyone of its kind. */
export function policiesAffecting(
  policies: ReadonlyArray<Parameters<typeof policyReferences>[0] & { policyId: string }>,
  subject: { type: PrincipalType; id: string; groupIds: string[]; ownerId?: string },
): string[] {
  const out: string[] = [];
  for (const policy of policies) {
    const refs = policyReferences(policy);
    let hit = refs.any;
    if (!hit && subject.type === 'user') {
      hit = refs.anyUser || refs.users.has(subject.id) || subject.groupIds.some((g) => refs.groups.has(g));
    } else if (!hit && subject.type === 'group') {
      hit = refs.groups.has(subject.id);
    } else if (!hit && subject.type === 'token') {
      hit = refs.anyToken
        || refs.tokens.has(subject.id)
        || (!!subject.ownerId && refs.users.has(subject.ownerId))
        || subject.groupIds.some((g) => refs.groups.has(g));
    }
    if (hit) out.push(policy.policyId);
  }
  return out;
}

export interface PrincipalDetailOptions {
  /**
   * Leave out the effective table - the part that asks the engine about every service - so the profile
   * of a principal opens fast and the table is loaded when it is looked at.
   */
  skipEffective?: boolean;
}

export async function getPrincipalDetail(
  tenant: IamTenant,
  input: { type: PrincipalType; id: string; projectId?: string | null },
  options: PrincipalDetailOptions = {},
): Promise<PrincipalDetail> {
  const policies = await listPolicies(tenant.tenantDbName);
  const projectNames = await runWithTenantScope(tenant.tenantDbName, async (db) => {
    const projects = await db.listProjects(tenant.tenantId);
    return new Map(projects.map((p) => [String(p._id), p.name] as const));
  });

  if (input.type === 'group') {
    const loaded = await runWithTenantScope(tenant.tenantDbName, async (db) => {
      const group = await find(() => db.findGroupById(input.id));
      if (!group || isForeign(group, tenant.tenantId)) throw new PrincipalError('principal_not_found', 'Group not found');
      const [counts, projectLinks] = await Promise.all([
        db.iamCountGroupMembers([input.id]),
        db.listGroupProjectsByGroup(input.id),
      ]);
      return { group, memberCount: counts[input.id] ?? 0, projectLinks };
    });
    const grant = groupToGrant(loaded.group);
    const effective: EffectiveService[] = options.skipEffective ? [] : MATRIX_SERVICES.map((def) => {
      const level = grant
        ? getEffectiveServicePermission({ role: grant.tenantRole, servicePermissions: grant.servicePermissions }, def.id as PermissionService)
        : 'none';
      return {
        service: def.id,
        level: asLevel(level),
        sources: level === 'none' ? [] : [{ kind: 'group' as const, label: loaded.group.name, level: asLevel(level) }],
      };
    });
    const affecting = new Set(policiesAffecting(policies, { type: 'group', id: input.id, groupIds: [] }));
    return {
      ...(options.skipEffective ? { effectiveSkipped: true as const } : {}),
      principal: {
        type: 'group',
        id: input.id,
        label: loaded.group.name,
        sublabel: loaded.group.description ?? '',
        memberCount: loaded.memberCount,
        source: loaded.group.source ?? 'local',
        tenantRole: loaded.group.tenantRole ?? null,
      },
      effective,
      groups: [],
      projects: loaded.projectLinks.map((gp): PrincipalProject => ({
        id: String(gp.projectId),
        name: projectNames.get(String(gp.projectId)) ?? String(gp.projectId),
        role: gp.role,
        via: 'group',
        groupName: loaded.group.name,
      })),
      policies: await toPolicyRows(tenant, policies.filter((p) => affecting.has(p.policyId))),
      tokens: null,
    };
  }

  const evaluation = await loadEvaluationPrincipal(tenant, { type: input.type, id: input.id }, input.projectId ?? null, { workspaceLevel: true });

  const activeProjectId = evaluation.principal.contextProjectId ?? input.projectId ?? null;
  const effective = options.skipEffective
    ? []
    : await computeEffectivePermissions(
      tenant,
      evaluation,
      evaluation.narrowing ? projectNames.get(evaluation.narrowing.projectId) : (activeProjectId ? projectNames.get(activeProjectId) : undefined),
    );

  // The groups were read when the principal was built; only the owned tokens and the project rows are new reads.
  const groupList = evaluation.groups;
  const { ownedTokens, projects } = await runWithTenantScope(tenant.tenantDbName, async (db) => {
    const [ownedTokens, projects] = await Promise.all([
      evaluation.type === 'user'
        ? db.iamListTokens({ tenantId: tenant.tenantId, userId: String(evaluation.user._id), limit: 100 }).then((page) => page.items)
        : Promise.resolve(null),
      userProjects(tenant, db, evaluation.user, groupList, projectNames),
    ]);
    return { ownedTokens, projects };
  });

  const affecting = new Set(policiesAffecting(policies, {
    type: evaluation.type,
    id: evaluation.id,
    groupIds: groupList.map((g) => g.id),
    ownerId: evaluation.type === 'token' ? String(evaluation.user._id) : undefined,
  }));

  const principal: PrincipalDetail['principal'] = evaluation.type === 'user'
    ? {
        type: 'user',
        id: evaluation.id,
        label: evaluation.label,
        sublabel: evaluation.user.email || '',
        role: evaluation.role,
        status: evaluation.accountDisabled ? 'disabled' : 'active',
        email: evaluation.user.email || '',
        authProvider: evaluation.user.authProvider ?? 'local',
        canLogin: evaluation.user.canLogin !== false,
      }
    : {
        type: 'token',
        id: evaluation.id,
        label: evaluation.label,
        sublabel: evaluation.token?.tokenPrefix ? `${evaluation.token.tokenPrefix}…` : '',
        role: evaluation.role,
        status: evaluation.token ? tokenStatus(evaluation.token) : 'active',
        ownerId: String(evaluation.user._id),
        ownerLabel: userLabel(evaluation.user),
        projectId: evaluation.token?.projectId ?? null,
        scope: evaluation.tokenScope == null ? null : normalizeServicePermissions(evaluation.tokenScope),
        expiresAt: evaluation.token?.expiresAt ? new Date(evaluation.token.expiresAt).toISOString() : null,
        lastUsedAt: evaluation.token?.lastUsed ? new Date(evaluation.token.lastUsed).toISOString() : null,
      };

  return {
    ...(options.skipEffective ? { effectiveSkipped: true as const } : {}),
    principal,
    effective,
    groups: groupList.map((g) => ({ id: g.id, name: g.name })),
    projects,
    policies: await toPolicyRows(tenant, policies.filter((p) => affecting.has(p.policyId))),
    tokens: ownedTokens ? ownedTokens.map(tokenSummary) : null,
  };
}
