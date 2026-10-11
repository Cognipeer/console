/**
 * Facts about people that the server and the screens must agree on: the tenant
 * roles and their order, who an account is managed by, how a row is classified in
 * the directory, and the stable codes the people endpoints answer with.
 *
 * Pure on purpose (no database, no server module): the Authorization center
 * imports it as well, so a rule that is stated here is stated once.
 */

// ── roles ────────────────────────────────────────────────────────────────

export const TENANT_ROLES = ['owner', 'admin', 'project_admin', 'user'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** The roles an administrator may give to a person. The owner role is never assignable. */
export const ASSIGNABLE_ROLES = ['admin', 'project_admin', 'user'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Higher outranks lower: nobody acts on someone above them. `project_admin` and `user` are not ordered by privilege here. */
export const ROLE_RANK: Readonly<Record<TenantRole, number>> = {
  owner: 3,
  admin: 2,
  project_admin: 1,
  user: 0,
};

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && (TENANT_ROLES as readonly string[]).includes(value);
}

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/** Rank of a role. A value that is not a role ranks below every real one. */
export function roleRank(role: unknown): number {
  return isTenantRole(role) ? ROLE_RANK[role] : -1;
}

// ── who manages an account ───────────────────────────────────────────────

export const AUTH_PROVIDERS = ['local', 'ldap', 'oidc', 'saml'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/** Where the account signs in. A missing or unknown value is a local account (every pre-existing row). */
export function providerOf(user: { authProvider?: unknown }): AuthProvider {
  const provider = user.authProvider;
  return typeof provider === 'string' && (AUTH_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as AuthProvider)
    : 'local';
}

/** An account whose name, email and password belong to an external directory (LDAP, SSO). */
export function isDirectoryManaged(user: { authProvider?: unknown }): boolean {
  return providerOf(user) !== 'local';
}

/** What a directory-managed account cannot be edited for here: the directory is the source of truth. */
export const DIRECTORY_READ_ONLY_FIELDS = ['name', 'email', 'password'] as const;
export type DirectoryReadOnlyField = (typeof DIRECTORY_READ_ONLY_FIELDS)[number];

/** A group whose members come from a directory (any source but `local`). */
export function isGroupDirectoryManaged(group: { source?: unknown }): boolean {
  return typeof group.source === 'string' && group.source !== '' && group.source !== 'local';
}

// ── how the directory classifies a person ────────────────────────────────

export type UserKind = 'person' | 'service' | 'external';

/**
 * An EXTERNAL account is a person of a host application who uses a portal's embed (`kind === 'external'`): they cannot sign in
 * either, but they are not a service account. A service account is an identity that cannot sign in (`canLogin === false`); a
 * missing flag means it can.
 */
export function userKind(user: { canLogin?: boolean | null; kind?: string | null }): UserKind {
  if (user.kind === 'external') return 'external';
  return user.canLogin === false ? 'service' : 'person';
}

export type ListStatus = 'active' | 'disabled' | 'invited';

type StatusFacts = {
  canLogin?: boolean | null;
  status?: string | null;
  invitedBy?: string | null;
  inviteAcceptedAt?: Date | string | null;
};

/** An invitation was sent to an account that can sign in and has not been accepted yet (and it is not disabled). */
export function isPendingInvite(user: StatusFacts): boolean {
  return user.canLogin !== false
    && user.status !== 'disabled'
    && Boolean(user.invitedBy)
    && !user.inviteAcceptedAt;
}

/** `disabled` outranks `invited`, which outranks `active`. A missing status is active. */
export function listStatusOf(user: StatusFacts): ListStatus {
  if (user.status === 'disabled') return 'disabled';
  return isPendingInvite(user) ? 'invited' : 'active';
}

// ── stable codes ─────────────────────────────────────────────────────────

/**
 * `code` of an error answer of the people endpoints (users, groups, tokens, the
 * directory, the account). The `error` text is English and for logs and fallbacks;
 * screens translate by this code. A code is only ever added, never renamed.
 */
export const PEOPLE_ERROR_CODES = [
  'invalid_body',
  'invalid_filter',
  'invalid_cursor',
  'invalid_role',
  'invalid_action',
  'user_not_found',
  'group_not_found',
  'token_not_found',
  'principal_not_found',
  'forbidden',
  'owner_immutable',
  'cannot_change_own_role',
  'admin_grant_requires_admin',
  'higher_privileges',
  'self_not_allowed',
  'directory_managed',
  'group_directory_managed',
  'email_taken',
  'email_required',
  'quota_exceeded',
  'rate_limited',
  'too_many_ids',
  'password_managed_externally',
  'invalid_password',
  'invalid_current_password',
  'no_pending_invite',
  'external_user',
] as const;
export type PeopleErrorCode = (typeof PEOPLE_ERROR_CODES)[number];

/** Why an action is not available to the viewer. */
export type ActionDenial =
  | 'forbidden'
  | 'self'
  | 'owner_immutable'
  | 'higher_privileges'
  | 'directory_managed'
  | 'no_pending_invite'
  | 'account_disabled'
  | 'external_user';

export interface AllowedAction {
  allowed: boolean;
  reason?: ActionDenial;
}
