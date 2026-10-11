/**
 * Data layer of the IAM center "Principals" tab. It also carries the pieces the
 * "Audit" tab shares with it: the HTTP helper, the deep links out of both tabs
 * and the cursor pager.
 *
 * Response shapes mirror the /api/iam contract:
 *   GET /api/iam/principals?type=user|group|token&q=&limit=&cursor=
 *   GET /api/iam/principals/:type/:id?projectId=
 *
 * The parsers are deliberately tolerant (unknown fields ignored, missing ones
 * defaulted, malformed rows dropped) so a payload that drifts a little degrades
 * a column instead of crashing the tab. Free of React and Next so a contract
 * test can feed it handler payloads in the node test environment.
 */

import { normalizeServicePermissions, type UserServicePermissions } from '@/lib/security/rbac';
import type { ApiTokenRow } from '../tokens/tokenModel';
import { checkHref, iamHref, newPolicyHref, policyHref } from '../links';

// ── primitives ────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

export const asRecord = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Non-empty string, else null. */
export const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** String or finite number rendered as a string id, else null. */
export const asId = (v: unknown): string | null => {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};
export const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

// ── HTTP ──────────────────────────────────────────────────────────────────

/** A non-2xx answer of /api/iam/*: `{ error, code, details? }`. */
export class IamApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IamApiError';
  }
}

/** Reads the `{ error, code, details }` body of a failed response. */
export async function toIamApiError(res: Response): Promise<IamApiError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  let details: unknown;
  try {
    const body = asRecord(await res.json());
    message = asString(body.error) ?? asString(body.message) ?? message;
    code = asString(body.code) ?? undefined;
    details = body.details;
  } catch {
    /* the error body is not JSON: keep the status line */
  }
  return new IamApiError(message, res.status, code, details);
}

/** JSON request helper of the IAM center. Resolves `null` for a 204. */
export async function iamRequest(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) throw await toIamApiError(res);
  if (res.status === 204) return null;
  return res.json();
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

// ── principals ────────────────────────────────────────────────────────────

export const PRINCIPAL_TYPES = ['user', 'group', 'token'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export function isPrincipalType(v: unknown): v is PrincipalType {
  return typeof v === 'string' && (PRINCIPAL_TYPES as readonly string[]).includes(v);
}

/** A principal that can be simulated in the Access check (groups cannot sign in). */
export type SimulatablePrincipalType = Exclude<PrincipalType, 'group'>;
export function isSimulatable(type: string): type is SimulatablePrincipalType {
  return type === 'user' || type === 'token';
}

export interface PrincipalRef {
  type: PrincipalType;
  id: string;
  label: string;
}

/** The principal a drawer shows; `summary` is the list row it was opened from. */
export interface PrincipalTarget {
  type: PrincipalType;
  id: string;
  summary?: PrincipalSummary | null;
}

export interface PrincipalSummary extends PrincipalRef {
  sublabel: string | null;
  role: string | null;
  status: string | null;
  /** Groups only. */
  memberCount: number | null;
  /** Custom policies that reference the principal, one of its groups, or everyone. */
  policyCount: number;

  // What the directory list adds. Left `undefined` (not null) when a server does not send them.
  /** Users: the sign-in address. */
  email?: string;
  /** Users: a person, or a service account (cannot sign in). */
  kind?: 'person' | 'service' | 'external';
  /** Users: where the account lives: local, ldap, oidc or saml. */
  authProvider?: string;
  /** Users: name, email and password are kept in a directory, not here. */
  managed?: boolean;
  createdAt?: string;
  invitedAt?: string;
  /** Groups: local or ldap (a directory group). */
  source?: string;
  /** Groups: the workspace role every member gets. */
  tenantRole?: string;

  // Tokens.
  prefix?: string;
  ownerId?: string;
  ownerLabel?: string;
  ownerKind?: 'person' | 'service';
  ownerDisabled?: boolean;
  /** The owner's account no longer exists. */
  ownerMissing?: boolean;
  projectId?: string;
  projectName?: string;
  scoped?: boolean;
  expiresAt?: string;
  lastUsedAt?: string;

  /** What THIS viewer may do to the row's principal; `undefined` when the server did not say. */
  allowedActions?: AllowedActions;
}

const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const optString = (v: unknown): string | undefined => asString(v) ?? undefined;
const optKind = (v: unknown): 'person' | 'service' | 'external' | undefined => (v === 'person' || v === 'service' || v === 'external' ? v : undefined);

export function parsePrincipalSummary(raw: unknown, fallbackType?: PrincipalType): PrincipalSummary | null {
  const r = asRecord(raw);
  const type = isPrincipalType(r.type) ? r.type : fallbackType;
  const id = asId(r.id);
  if (!type || !id) return null;
  const summary: PrincipalSummary = {
    type,
    id,
    label: asString(r.label) ?? asString(r.name) ?? id,
    sublabel: asString(r.sublabel),
    role: asString(r.role),
    status: asString(r.status),
    memberCount: asNumber(r.memberCount),
    policyCount: Math.max(0, asNumber(r.policyCount) ?? 0),
  };
  const actions = parseAllowedActions(r.allowedActions);
  if (actions) summary.allowedActions = actions;
  if (type === 'user') {
    summary.email = optString(r.email);
    summary.kind = optKind(r.kind);
    summary.authProvider = optString(r.authProvider);
    summary.managed = asBool(r.managed);
    summary.createdAt = optString(r.createdAt);
    summary.invitedAt = optString(r.invitedAt);
  } else if (type === 'group') {
    summary.source = optString(r.source);
    summary.tenantRole = optString(r.tenantRole);
  } else {
    summary.prefix = optString(r.prefix);
    summary.ownerId = optString(r.ownerId);
    summary.ownerLabel = optString(r.ownerLabel);
    summary.ownerKind = r.ownerKind === 'person' || r.ownerKind === 'service' ? r.ownerKind : undefined;
    summary.ownerDisabled = asBool(r.ownerDisabled);
    summary.ownerMissing = asBool(r.ownerMissing);
    summary.projectId = optString(r.projectId);
    summary.projectName = optString(r.projectName);
    summary.scoped = asBool(r.scoped);
    summary.expiresAt = optString(r.expiresAt);
    summary.lastUsedAt = optString(r.lastUsedAt);
    summary.createdAt = optString(r.createdAt);
  }
  return summary;
}

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export interface PrincipalListQuery {
  type: PrincipalType;
  q?: string;
  limit?: number;
  cursor?: string | null;
  /** Filters of the segment (`role`, `status`, `kind`, `source`, `sort`, `dir`, `ownerId`, `projectId`, `scoped`). */
  filters?: Record<string, string>;
  /** Ask the server for the exact `total` of this view (one scan; ask on the first page only). */
  count?: boolean;
  /** Hydrate saved ids (at most 100), intersected with the other filters. */
  ids?: readonly string[];
}

export interface PrincipalPage {
  items: PrincipalSummary[];
  nextCursor: string | null;
  /** Exact size of the filtered view, when it was asked for. */
  total?: number;
  /** People list, when the total was asked for: the workspace's external accounts (a host application's people who use a portal's embed). */
  externalTotal?: number;
}

export function clampLimit(limit: number | undefined, fallback = DEFAULT_PAGE_SIZE): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

/** Most ids the server hydrates in one request. */
export const MAX_HYDRATE_IDS = 100;

export function principalsListUrl(query: PrincipalListQuery): string {
  const params = new URLSearchParams();
  params.set('type', query.type);
  const q = query.q?.trim();
  if (q) params.set('q', q);
  params.set('limit', String(clampLimit(query.limit)));
  if (query.cursor) params.set('cursor', query.cursor);
  for (const [key, value] of Object.entries(query.filters ?? {})) {
    // The type, search text, limit and cursor have their own fields; a filter never overrides them.
    if (value !== '' && !['type', 'q', 'limit', 'cursor', 'count', 'ids'].includes(key)) params.set(key, value);
  }
  if (query.count) params.set('count', '1');
  const ids = (query.ids ?? []).filter(Boolean).slice(0, MAX_HYDRATE_IDS);
  if (ids.length > 0) params.set('ids', ids.join(','));
  return `/api/iam/principals?${params.toString()}`;
}

export function parsePrincipalPage(raw: unknown, type: PrincipalType): PrincipalPage {
  const r = asRecord(raw);
  const items: PrincipalSummary[] = [];
  const seen = new Set<string>();
  for (const entry of asArray(r.items)) {
    const item = parsePrincipalSummary(entry, type);
    if (!item) continue;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  const total = asNumber(r.total);
  const externalTotal = asNumber(r.externalTotal);
  return {
    items,
    nextCursor: asString(r.nextCursor),
    ...(total !== null && total >= 0 ? { total: Math.floor(total) } : {}),
    ...(externalTotal !== null && externalTotal >= 0 ? { externalTotal: Math.floor(externalTotal) } : {}),
  };
}

export async function fetchPrincipals(query: PrincipalListQuery, signal?: AbortSignal): Promise<PrincipalPage> {
  return parsePrincipalPage(await iamRequest(principalsListUrl(query), { signal }), query.type);
}

// ── principal detail ──────────────────────────────────────────────────────

export const PERMISSION_LEVELS = ['none', 'read', 'write', 'admin'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const LEVEL_RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function parseLevel(v: unknown): PermissionLevel | null {
  return typeof v === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(v)
    ? (v as PermissionLevel)
    : null;
}

/** Where a level of the effective permissions table comes from. */
export const SOURCE_KINDS = ['role', 'direct', 'group', 'token-scope', 'project', 'policy'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export function isSourceKind(v: unknown): v is SourceKind {
  return typeof v === 'string' && (SOURCE_KINDS as readonly string[]).includes(v);
}

export interface EffectiveSource {
  /** One of SOURCE_KINDS; an unknown kind from a newer server is kept as is. */
  kind: string;
  label: string;
  level: PermissionLevel | null;
}

export interface EffectiveRow {
  service: string;
  level: PermissionLevel;
  sources: EffectiveSource[];
}

export function parseEffective(raw: unknown): EffectiveRow[] {
  const rows: EffectiveRow[] = [];
  const seen = new Set<string>();
  for (const entry of asArray(raw)) {
    const r = asRecord(entry);
    const service = asString(r.service);
    if (!service || seen.has(service)) continue;
    seen.add(service);
    const sources: EffectiveSource[] = [];
    for (const s of asArray(r.sources)) {
      const sr = asRecord(s);
      const kind = asString(sr.kind);
      if (!kind) continue;
      sources.push({ kind, label: asString(sr.label) ?? '', level: parseLevel(sr.level) });
    }
    rows.push({ service, level: parseLevel(r.level) ?? 'none', sources });
  }
  return rows;
}

/** Highest level first, then by display label. */
export function sortEffective(rows: EffectiveRow[], labelOf: (service: string) => string): EffectiveRow[] {
  return [...rows].sort(
    (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || labelOf(a.service).localeCompare(labelOf(b.service)),
  );
}

/**
 * Which rows of the effective permissions table to show: the services the
 * principal can use (`access`, the default), every service, or one level.
 */
export type EffectiveLevelFilter = 'access' | 'all' | PermissionLevel;

export interface EffectiveFilter {
  query: string;
  level: EffectiveLevelFilter;
  labelOf: (service: string) => string;
}

export function filterEffective(rows: EffectiveRow[], filter: EffectiveFilter): EffectiveRow[] {
  const q = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.level === 'access' ? row.level === 'none' : filter.level !== 'all' && row.level !== filter.level) {
      return false;
    }
    if (!q) return true;
    return row.service.toLowerCase().includes(q) || filter.labelOf(row.service).toLowerCase().includes(q);
  });
}

/** How many services sit at each level. */
export function countByLevel(rows: EffectiveRow[]): Record<PermissionLevel, number> {
  const counts: Record<PermissionLevel, number> = { none: 0, read: 0, write: 0, admin: 0 };
  for (const row of rows) counts[row.level]++;
  return counts;
}

export interface GroupRef {
  id: string;
  name: string;
  /** local or ldap (a directory group, whose membership the directory sets). */
  source?: string;
  /** The workspace role the group gives its members. */
  tenantRole?: string;
  /** The membership can be removed here (a local group). `undefined` = the server did not say. */
  removable?: boolean;
}

export interface ProjectRef {
  id: string;
  name: string;
  role: string | null;
  /** How the principal got into the project: direct, group, legacy or implicit (owners and admins reach every project). */
  via: string | null;
  groupName: string | null;
  /** A direct (or legacy) membership: it can be changed or removed from here. `undefined` = the server did not say. */
  removable?: boolean;
}

function parseGroups(raw: unknown): GroupRef[] {
  const out: GroupRef[] = [];
  const seen = new Set<string>();
  for (const entry of asArray(raw)) {
    const r = asRecord(entry);
    const id = asId(r.id) ?? asId(r.groupId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: asString(r.name) ?? asString(r.label) ?? id,
      source: optString(r.source),
      tenantRole: optString(r.tenantRole),
      removable: asBool(r.removable),
    });
  }
  return out;
}

function parseProjects(raw: unknown): ProjectRef[] {
  const out: ProjectRef[] = [];
  const seen = new Set<string>();
  for (const entry of asArray(raw)) {
    const r = asRecord(entry);
    const id = asId(r.id) ?? asId(r.projectId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: asString(r.name) ?? asString(r.label) ?? id,
      role: asString(r.role),
      via: asString(r.via),
      groupName: asString(r.groupName),
      removable: asBool(r.removable),
    });
  }
  return out;
}

// ── attached policies ─────────────────────────────────────────────────────

export type PolicyEffect = 'permit' | 'forbid' | 'mixed';

/** `PolicySpec.principals`, normalised. */
export interface PolicyPrincipalsSpec {
  any: boolean;
  anyUser: boolean;
  anyToken: boolean;
  users: string[];
  groups: string[];
  tokens: string[];
}

/** The part of a `PolicyRow` the principal drawer needs. */
export interface AttachedPolicy {
  policyId: string;
  name: string;
  description: string;
  effect: PolicyEffect | null;
  enabled: boolean;
  /** Who the policy targets; null for a raw Cedar policy (no spec). */
  principals: PolicyPrincipalsSpec | null;
  updatedAt: string | null;
}

const idList = (v: unknown): string[] =>
  asArray(v)
    .map((x) => asId(x))
    .filter((x): x is string => x !== null);

function parsePolicyPrincipals(spec: unknown): PolicyPrincipalsSpec | null {
  if (spec === null || spec === undefined || typeof spec !== 'object') return null;
  const p = asRecord(asRecord(spec).principals);
  return {
    any: p.any === true,
    anyUser: p.anyUser === true,
    anyToken: p.anyToken === true,
    users: idList(p.users),
    groups: idList(p.groups),
    tokens: idList(p.tokens),
  };
}

export function parseAttachedPolicy(raw: unknown): AttachedPolicy | null {
  const r = asRecord(raw);
  const policyId = asId(r.policyId) ?? asId(r.id);
  if (!policyId) return null;
  const effect = r.effect === 'permit' || r.effect === 'forbid' || r.effect === 'mixed' ? r.effect : null;
  return {
    policyId,
    name: asString(r.name) ?? policyId,
    description: asString(r.description) ?? '',
    effect,
    enabled: r.enabled !== false,
    principals: parsePolicyPrincipals(r.spec),
    updatedAt: asString(r.updatedAt),
  };
}

export type PolicyReach =
  | { kind: 'everyone' }
  | { kind: 'anyUser' }
  | { kind: 'anyToken' }
  | { kind: 'direct' }
  | { kind: 'group'; groupIds: string[] }
  | { kind: 'viaOwner' }
  | { kind: 'raw' };

/**
 * Why a policy applies to a principal, derived from the policy's own spec. A
 * policy can reach one principal in several ways (directly and through a
 * group), so this is a list. A raw Cedar policy has no spec to read.
 *
 * A token is also reached through its owner: a user policy matches the tokens
 * that user owns and a group policy the tokens of its members (the token scope
 * still caps what the policy can grant). `ownerId` is the owner of a token when
 * the server told us; `groupIds` are the principal's groups (a token's owner's).
 */
export function policyReach(
  policy: AttachedPolicy,
  principal: { type: PrincipalType; id: string },
  groupIds: readonly string[],
  ownerId?: string | null,
): PolicyReach[] {
  const spec = policy.principals;
  if (!spec) return [{ kind: 'raw' }];
  if (spec.any) return [{ kind: 'everyone' }];

  const out: PolicyReach[] = [];
  if (principal.type === 'user') {
    if (spec.users.includes(principal.id)) out.push({ kind: 'direct' });
    if (spec.anyUser) out.push({ kind: 'anyUser' });
  } else if (principal.type === 'token') {
    if (spec.tokens.includes(principal.id)) out.push({ kind: 'direct' });
    if (spec.anyToken) out.push({ kind: 'anyToken' });
  } else if (spec.groups.includes(principal.id)) {
    out.push({ kind: 'direct' });
  }

  if (principal.type !== 'group') {
    const viaGroups = spec.groups.filter((g) => groupIds.includes(g));
    if (viaGroups.length > 0) out.push({ kind: 'group', groupIds: viaGroups });
    if (principal.type === 'token') {
      const viaOwner = ownerId ? spec.users.includes(ownerId) : out.length === 0 && spec.users.length > 0;
      if (viaOwner) out.push({ kind: 'viaOwner' });
    }
  }
  return out;
}

// ── detail payload ────────────────────────────────────────────────────────

/**
 * What the server adds to `principal` beyond the list row (all optional: an
 * older or leaner server simply leaves them out).
 */
export interface PrincipalExtras {
  /** Tokens: the user who owns the token. */
  ownerId: string | null;
  ownerLabel: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Tokens: whether the token has a scope that caps it (null when the server did not say). */
  scoped: boolean | null;
  /** Users: `local`, `ldap`, `oidc` or `saml`; `canLogin === false` is a service account (or an external one, see `kind`). */
  authProvider: string | null;
  canLogin: boolean | null;
  /** Users: a person, a service account, or an external account (a host application's person who uses a portal's embed). */
  kind: 'person' | 'service' | 'external' | null;
  /** Groups: `local` or `ldap` (directory), and the tenant role every member gets. */
  source: string | null;
  tenantRole: string | null;

  // Users: the profile facts.
  email: string | null;
  createdAt: string | null;
  invitedAt: string | null;
  inviteAcceptedAt: string | null;
  /** An invitation was sent and not accepted yet. */
  pendingInvite: boolean | null;
  disabledAt: string | null;
  disabledBy: string | null;
  disabledReason: string | null;
  /** Users: name, email and password are kept in a directory (read-only here). */
  managed: ManagedInfo | null;
  /** Users: the DIRECT per-service overrides; groups: the grants. `null` when the server did not send them. */
  servicePermissions: UserServicePermissions | null;
  /** Tokens: project the token was minted in. */
  projectId: string | null;
  projectName: string | null;
  createdBy: string | null;
}

/** Which profile fields a directory keeps. */
export interface ManagedInfo {
  directory: boolean;
  provider: string | null;
  readOnly: string[];
}

/** One thing the viewer may or may not do to the principal, with the reason when not. */
export interface AllowedAction {
  allowed: boolean;
  /** `forbidden`, `self`, `owner_immutable`, `higher_privileges`, `directory_managed`, `no_pending_invite`, `account_disabled`, `external_user`. */
  reason?: string;
}

export type AllowedActions = Record<string, AllowedAction>;

export const USER_ACTION_IDS = [
  'editProfile',
  'changeRole',
  'editPermissions',
  'disable',
  'enable',
  'delete',
  'copyInvitationLink',
  'manageGroups',
  'manageProjects',
  'mintToken',
  'revokeTokens',
] as const;
export type UserActionId = (typeof USER_ACTION_IDS)[number];

export function parseAllowedActions(raw: unknown): AllowedActions | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: AllowedActions = {};
  for (const [id, value] of Object.entries(raw as Rec)) {
    if (typeof value === 'boolean') {
      out[id] = { allowed: value };
      continue;
    }
    const r = asRecord(value);
    if (typeof r.allowed !== 'boolean') continue;
    const reason = asString(r.reason);
    out[id] = reason ? { allowed: r.allowed, reason } : { allowed: r.allowed };
  }
  return out;
}

export function parseManaged(raw: unknown): ManagedInfo | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = asRecord(raw);
  return {
    directory: r.directory === true,
    provider: asString(r.provider),
    readOnly: asArray(r.readOnly).filter((x): x is string => typeof x === 'string'),
  };
}

function parseOverrides(raw: unknown): UserServicePermissions | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return normalizeServicePermissions(raw);
}

/** A token of a user, as the user's detail lists it. */
export interface OwnedToken {
  id: string;
  label: string;
  /** Visible start of the token (`cp_8f2a`), never the secret. */
  prefix: string | null;
  scoped: boolean;
  status: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** The project the token was minted in. */
  projectId: string | null;
  createdAt: string | null;
}

export interface PrincipalDetail {
  principal: PrincipalSummary;
  extras: PrincipalExtras;
  effective: EffectiveRow[];
  /** True when the server skipped the effective table (`effective=0`); the Access section loads it on demand. */
  effectiveSkipped: boolean;
  groups: GroupRef[];
  projects: ProjectRef[];
  policies: AttachedPolicy[];
  /** Owned tokens (users only); null when the server did not send the list. */
  tokens: OwnedToken[] | null;
  /** The viewer may not see this person's tokens (the workspace owner's, for an admin). */
  tokensHidden: boolean;
  /** More tokens than the list carries. */
  tokensTruncated: boolean;
  tokensTotal: number | null;
  /** What THIS viewer may do to the principal; null when the server did not say (older servers). */
  allowedActions: AllowedActions | null;
  /** Users: the roles THIS viewer may give this person. */
  assignableRoles: string[] | null;
  /** Tokens: the row the token forms consume. */
  tokenRow: ApiTokenRow | null;
}

function parseExtras(raw: unknown): PrincipalExtras {
  const r = asRecord(raw);
  return {
    ownerId: asId(r.ownerId),
    ownerLabel: asString(r.ownerLabel),
    expiresAt: asString(r.expiresAt),
    lastUsedAt: asString(r.lastUsedAt),
    scoped: r.scope === undefined ? null : r.scope !== null && typeof r.scope === 'object',
    authProvider: asString(r.authProvider),
    canLogin: typeof r.canLogin === 'boolean' ? r.canLogin : null,
    kind: optKind(r.kind) ?? null,
    source: asString(r.source),
    tenantRole: asString(r.tenantRole),
    email: asString(r.email),
    createdAt: asString(r.createdAt),
    invitedAt: asString(r.invitedAt),
    inviteAcceptedAt: asString(r.inviteAcceptedAt),
    pendingInvite: typeof r.pendingInvite === 'boolean' ? r.pendingInvite : null,
    disabledAt: asString(r.disabledAt),
    disabledBy: asString(r.disabledBy),
    disabledReason: asString(r.disabledReason),
    managed: parseManaged(r.managed),
    servicePermissions: parseOverrides(r.servicePermissions),
    projectId: asId(r.projectId),
    projectName: asString(r.projectName),
    createdBy: asId(r.createdBy),
  };
}

export function parseOwnedToken(raw: unknown): OwnedToken | null {
  const r = asRecord(raw);
  const id = asId(r.id);
  if (!id) return null;
  return {
    id,
    label: asString(r.label) ?? asString(r.name) ?? id,
    prefix: asString(r.prefix) ?? asString(r.tokenPrefix),
    scoped: r.scoped === true,
    status: asString(r.status),
    expiresAt: asString(r.expiresAt),
    lastUsedAt: asString(r.lastUsedAt) ?? asString(r.lastUsed),
    projectId: asId(r.projectId),
    createdAt: asString(r.createdAt),
  };
}

/** The list-row form of an owned token, for opening its own detail. */
export function ownedTokenSummary(token: OwnedToken): PrincipalSummary {
  return {
    type: 'token',
    id: token.id,
    label: token.label,
    sublabel: token.prefix ? `${token.prefix}…` : null,
    role: null,
    status: token.status,
    memberCount: null,
    policyCount: 0,
  };
}

export function principalDetailUrl(
  type: PrincipalType,
  id: string,
  projectId?: string | null,
  options: { effective?: boolean } = {},
): string {
  const base = `/api/iam/principals/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
  const query: string[] = [];
  if (projectId) query.push(`projectId=${encodeURIComponent(projectId)}`);
  // The effective table is the expensive part: ask without it first, then with it.
  if (options.effective === false) query.push('effective=0');
  return query.length > 0 ? `${base}?${query.join('&')}` : base;
}

/** `tokenRow` of a token detail: the dashboard token shape (`_id`, `label`, expiry, allowlist...). */
function parseTokenRow(raw: unknown): ApiTokenRow | null {
  const r = asRecord(raw);
  const id = asId(r._id) ?? asId(r.id);
  if (!id) return null;
  return { ...(r as unknown as ApiTokenRow), _id: id, label: asString(r.label) ?? id, createdAt: asString(r.createdAt) ?? '' };
}

function parseStringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((x): x is string => typeof x === 'string' && x !== '');
}

export function parsePrincipalDetail(raw: unknown, type: PrincipalType, id: string): PrincipalDetail {
  const r = asRecord(raw);
  const policies = asArray(r.policies)
    .map(parseAttachedPolicy)
    .filter((p): p is AttachedPolicy => p !== null);
  const parsed =
    parsePrincipalSummary(r.principal, type) ?? {
      type,
      id,
      label: id,
      sublabel: null,
      role: null,
      status: null,
      memberCount: null,
      policyCount: 0,
    };
  // For a token the server reports its OWNER's role here; it is not a role of the token.
  const principal: PrincipalSummary = {
    ...parsed,
    role: parsed.type === 'token' ? null : parsed.role,
    policyCount: parsed.policyCount === 0 && policies.length > 0 ? policies.length : parsed.policyCount,
  };
  const tokens = Array.isArray(r.tokens)
    ? r.tokens.map(parseOwnedToken).filter((t): t is OwnedToken => t !== null)
    : null;
  const inner = asRecord(r.principal);
  // The viewer-specific parts sit next to `principal`; an older or leaner shape may nest them inside it.
  const pick = (key: string): unknown => (r[key] !== undefined ? r[key] : inner[key]);
  const tokensTotal = asNumber(pick('tokensTotal'));
  return {
    principal,
    extras: parseExtras(r.principal),
    effective: parseEffective(r.effective),
    effectiveSkipped: r.effectiveSkipped === true,
    groups: parseGroups(r.groups),
    projects: parseProjects(r.projects),
    policies,
    tokens,
    tokensHidden: pick('tokensHidden') === true,
    tokensTruncated: pick('tokensTruncated') === true,
    tokensTotal: tokensTotal === null ? null : Math.max(0, Math.floor(tokensTotal)),
    allowedActions: parseAllowedActions(pick('allowedActions')),
    assignableRoles: parseStringList(pick('assignableRoles')),
    tokenRow: type === 'token' ? parseTokenRow(pick('tokenRow')) : null,
  };
}

export async function fetchPrincipalDetail(
  type: PrincipalType,
  id: string,
  projectId?: string | null,
  signal?: AbortSignal,
  options: { effective?: boolean } = {},
): Promise<PrincipalDetail> {
  return parsePrincipalDetail(
    await iamRequest(principalDetailUrl(type, id, projectId, options), { signal }),
    type,
    id,
  );
}

// ── deep links ────────────────────────────────────────────────────────────

/**
 * Links out of the Principals and Audit tabs. The builders of the other tabs'
 * links are the IAM center's own (`../links`, the one place that also parses
 * them), so a renamed parameter cannot leave these pointing at nothing. The two
 * tabs this part owns (`principals`, `audit`) are built with its generic form.
 */
export const iamLinks = {
  /** Principals tab with the detail drawer of one principal open. */
  principal: (type: PrincipalType, id: string) => iamHref('principals', { principalType: type, principalId: id }),
  /** Access check prefilled with a principal (and optionally a catalog action). */
  simulate: (type: SimulatablePrincipalType, id: string, action?: string | null) =>
    checkHref({ principalType: type, principalId: id, action: action ?? undefined }),
  /** Access check loaded from a recorded decision. */
  decision: (decisionId: string) => checkHref({ decisionId }),
  /** Policy editor prefilled for one principal. */
  createPolicy: (type: PrincipalType, id: string) => newPolicyHref({ principalType: type, principalId: id }),
  /** Policies tab with one policy opened in the editor. */
  policy: (policyId: string) => policyHref(policyId),
  /** Audit tab filtered to one principal (a group: the denials of its members). */
  audit: (type: PrincipalType, id: string) => iamHref('audit', { principalType: type, principalId: id }),
  /** The segment of the Principals tab that lists the tokens of one person. */
  tokensOf: (ownerId: string) => iamHref('principals', { principalType: 'token', ownerId }),
  /** Principals tab with a full-screen form open for a person (`edit=role|profile|access|memberships`). */
  editPerson: (userId: string, edit: 'profile' | 'role' | 'access' | 'memberships') =>
    iamHref('principals', { principalType: 'user', principalId: userId, edit }),
};

// ── cursor pager ──────────────────────────────────────────────────────────

/**
 * Paging over a cursor API that can only go forward: the cursor each page was
 * fetched with is remembered, so "previous" is a pop. The state carries the
 * filter key it belongs to; reading it with another key yields page 1, which
 * resets paging in the same render that changes a filter (no stale-cursor
 * request in between).
 */
export interface PagerState {
  key: string;
  cursors: Array<string | null>;
}

/** A pager on page 1 for `key`. */
export function newPager(key: string): PagerState {
  return { key, cursors: [null] };
}

export const initialPager: PagerState = newPager('');

function pagerStack(state: PagerState, key: string): Array<string | null> {
  return state.key === key && state.cursors.length > 0 ? state.cursors : [null];
}

export function pagerPage(state: PagerState, key: string): number {
  return pagerStack(state, key).length;
}

export function pagerCursor(state: PagerState, key: string): string | null {
  const stack = pagerStack(state, key);
  return stack[stack.length - 1] ?? null;
}

export function pagerNext(state: PagerState, key: string, nextCursor: string): PagerState {
  return { key, cursors: [...pagerStack(state, key), nextCursor] };
}

export function pagerPrev(state: PagerState, key: string): PagerState {
  const stack = pagerStack(state, key);
  return { key, cursors: stack.length > 1 ? stack.slice(0, -1) : stack };
}
