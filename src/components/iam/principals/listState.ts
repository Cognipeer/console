/**
 * The view state of the Principals list as a plain model that round-trips
 * through the address bar, and the request parameters built from it.
 *
 *   /dashboard/iam?tab=principals&principalType=user&q=ann&role=admin,user&status=active
 *
 * Filters, search and sort live in the URL (written with `replaceState`, so a
 * pasted link restores the same view); the paging cursor does NOT, because an
 * offset cursor drifts as rows change. Changing any filter starts at page 1.
 *
 * Pure module (no React, no Next): the node tests feed it `URLSearchParams`.
 */

import type { ParamReader } from '../links';

export type ListType = 'user' | 'group' | 'token';

export const USER_ROLES = ['owner', 'admin', 'project_admin', 'user', 'portal_user'] as const;
export const USER_STATUS_FILTERS = ['active', 'disabled', 'invited'] as const;
export const ACCESS_FILTERS = ['requested'] as const;
export const USER_KINDS = ['person', 'service', 'external'] as const;
export const USER_SOURCES = ['local', 'directory', 'ldap', 'oidc', 'saml'] as const;
export const GROUP_SOURCES = ['local', 'directory', 'ldap', 'oidc'] as const;
export const TOKEN_STATUS_FILTERS = ['active', 'expired'] as const;
export const SCOPED_FILTERS = ['true', 'false'] as const;
export const USER_SORTS = ['name', 'email', 'createdAt'] as const;
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export type UserSort = (typeof USER_SORTS)[number];
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** Everything the three segments can filter or sort by. Only the part that applies to the segment is used. */
export interface ListState {
  /** Free text (name, email, label). */
  q: string;
  /** Users: workspace roles (any of). */
  roles: string[];
  /** Users: active | disabled | invited. Tokens: active | expired. '' = any. */
  status: string;
  /** Users: person | service. */
  kind: string;
  /** Users: where the account comes from. Groups: local | directory | ldap. */
  source: string;
  /** Users: members of this group. */
  groupId: string;
  /** Tokens: the user who owns them. */
  ownerId: string;
  /** Users: people who reach the project. Groups: groups assigned to it. Tokens: minted in it. */
  projectId: string;
  /** Users: 'requested' = people who asked for access and still have no project. */
  access: string;
  /** Tokens: 'true' = scoped only, 'false' = unscoped only. */
  scoped: string;
  sort: UserSort;
  dir: SortDirection;
}

export const EMPTY_LIST_STATE: ListState = {
  q: '',
  roles: [],
  status: '',
  kind: '',
  source: '',
  groupId: '',
  ownerId: '',
  projectId: '',
  access: '',
  scoped: '',
  sort: 'name',
  dir: 'asc',
};

/** Query-string names owned by the list (everything the list writes and clears). */
export const LIST_PARAM_KEYS = [
  'q',
  'role',
  'status',
  'kind',
  'source',
  'group',
  'project',
  'ownerId',
  'scoped',
  'access',
  'sort',
  'dir',
  // an older name of `project`: read, and cleared from the address bar when the view is written
  'projectId',
] as const;

const oneOf = <T extends string>(allowed: readonly T[], value: string | null | undefined): T | '' =>
  value && (allowed as readonly string[]).includes(value) ? (value as T) : '';

/** Which list parameters mean something for a segment. */
const APPLICABLE: Record<ListType, ReadonlySet<string>> = {
  user: new Set(['q', 'role', 'status', 'kind', 'source', 'group', 'project', 'access', 'sort', 'dir']),
  group: new Set(['q', 'source', 'project']),
  token: new Set(['q', 'status', 'ownerId', 'project', 'scoped']),
};

export function appliesTo(type: ListType, param: (typeof LIST_PARAM_KEYS)[number]): boolean {
  return APPLICABLE[type].has(param);
}

/**
 * Reads the list state of one segment from the address bar. Anything that does
 * not apply to the segment, or is not a known value, is ignored (never an
 * error: a stale link degrades to an unfiltered list).
 */
export function parseListState(type: ListType, params: ParamReader): ListState {
  const state: ListState = { ...EMPTY_LIST_STATE, roles: [] };
  const q = params.get('q');
  state.q = q ? q.trim().slice(0, 100) : '';
  const idOf = (...names: string[]): string => {
    for (const name of names) {
      const value = (params.get(name) ?? '').trim().slice(0, 128);
      if (value) return value;
    }
    return '';
  };

  if (type === 'user') {
    const roles = (params.get('role') ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter((r): r is (typeof USER_ROLES)[number] => (USER_ROLES as readonly string[]).includes(r));
    state.roles = [...new Set(roles)];
    state.status = oneOf(USER_STATUS_FILTERS, params.get('status'));
    state.kind = oneOf(USER_KINDS, params.get('kind'));
    state.source = oneOf(USER_SOURCES, params.get('source'));
    state.groupId = idOf('group', 'groupId');
    state.projectId = idOf('project', 'projectId');
    state.access = oneOf(ACCESS_FILTERS, params.get('access'));
    state.sort = oneOf(USER_SORTS, params.get('sort')) || EMPTY_LIST_STATE.sort;
    state.dir = oneOf(SORT_DIRECTIONS, params.get('dir')) || EMPTY_LIST_STATE.dir;
  } else if (type === 'group') {
    state.source = oneOf(GROUP_SOURCES, params.get('source'));
    state.projectId = idOf('project', 'projectId');
  } else {
    state.status = oneOf(TOKEN_STATUS_FILTERS, params.get('status'));
    state.ownerId = idOf('ownerId', 'owner');
    state.projectId = idOf('project', 'projectId');
    state.scoped = oneOf(SCOPED_FILTERS, params.get('scoped'));
  }
  return state;
}

/**
 * The address-bar parameters of a list state: a value for every parameter the
 * list owns, `null` for the ones that are default or do not apply (so a switch
 * of segment removes the previous segment's filters from the URL).
 */
export function listStateToParams(type: ListType, state: ListState): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of LIST_PARAM_KEYS) out[key] = null;
  const q = state.q.trim();
  if (q) out.q = q;

  if (type === 'user') {
    if (state.roles.length > 0) out.role = state.roles.join(',');
    if (state.status) out.status = state.status;
    if (state.kind) out.kind = state.kind;
    if (state.source) out.source = state.source;
    if (state.groupId) out.group = state.groupId;
    if (state.projectId) out.project = state.projectId;
    if (state.access) out.access = state.access;
    if (state.sort !== EMPTY_LIST_STATE.sort) out.sort = state.sort;
    if (state.dir !== EMPTY_LIST_STATE.dir) out.dir = state.dir;
  } else if (type === 'group') {
    if (state.source) out.source = state.source;
    if (state.projectId) out.project = state.projectId;
  } else {
    if (state.status) out.status = state.status;
    if (state.ownerId) out.ownerId = state.ownerId;
    if (state.projectId) out.project = state.projectId;
    if (state.scoped) out.scoped = state.scoped;
  }
  return out;
}

/** The filters of the request (`GET /api/iam/principals`), as query parameters. Sort is included for users. */
export function listStateToQuery(type: ListType, state: ListState): Record<string, string> {
  const query: Record<string, string> = {};
  const params = listStateToParams(type, state);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) query[key] = value;
  }
  // The server's own defaults (name, ascending) are not sent.
  return query;
}

/** How many filters (not the search text, not the sort) narrow the list. */
export function activeFilterCount(type: ListType, state: ListState): number {
  if (type === 'user') {
    return (
      (state.roles.length > 0 ? 1 : 0) +
      (state.status ? 1 : 0) +
      (state.kind ? 1 : 0) +
      (state.source ? 1 : 0) +
      (state.groupId ? 1 : 0) +
      (state.projectId ? 1 : 0) +
      (state.access ? 1 : 0)
    );
  }
  if (type === 'group') return (state.source ? 1 : 0) + (state.projectId ? 1 : 0);
  return (state.status ? 1 : 0) + (state.ownerId ? 1 : 0) + (state.projectId ? 1 : 0) + (state.scoped ? 1 : 0);
}

/** True when anything (filters or search) narrows the list. */
export function isNarrowed(type: ListType, state: ListState): boolean {
  return activeFilterCount(type, state) > 0 || state.q.trim() !== '';
}

/** Everything cleared, including the search text; the sort returns to its default. */
export function resetListState(): ListState {
  return { ...EMPTY_LIST_STATE, roles: [] };
}

/**
 * Identity of a list view: when it changes, paging, selection and the cached
 * total start over. The search text is part of it (it is a filter).
 */
export function listKey(type: ListType, state: ListState, pageSize: number): string {
  const params = listStateToParams(type, state);
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return [type, ...parts, `size=${pageSize}`].join('\u0000');
}

export function sameListState(type: ListType, a: ListState, b: ListState): boolean {
  return listKey(type, a, 0) === listKey(type, b, 0);
}

/** Page size from a stored/URL value, snapped to the allowed sizes. */
export function normalizePageSize(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

// ── overlays (full-screen forms) ──────────────────────────────────────────

export const NEW_KINDS = ['person', 'service', 'external', 'group', 'token', 'import'] as const;
export const EDIT_KINDS = ['profile', 'role', 'access', 'memberships', 'project', 'group', 'token'] as const;

export type NewKind = (typeof NEW_KINDS)[number];
export type EditKind = (typeof EDIT_KINDS)[number];

/** A form opened over the list: creating something (`new`) or editing the open principal (`edit`). */
export interface OverlayState {
  new: NewKind | null;
  edit: EditKind | null;
}

export const NO_OVERLAY: OverlayState = { new: null, edit: null };

export function parseOverlay(params: ParamReader): OverlayState {
  const created = params.get('new');
  const edited = params.get('edit');
  return {
    new: (NEW_KINDS as readonly string[]).includes(created ?? '') ? (created as NewKind) : null,
    edit: (EDIT_KINDS as readonly string[]).includes(edited ?? '') ? (edited as EditKind) : null,
  };
}

export function overlayToParams(overlay: OverlayState): Record<string, string | null> {
  // Only one overlay at a time; creating wins.
  return { new: overlay.new, edit: overlay.new ? null : overlay.edit };
}
