/**
 * Who may do what to which person: one pure module that the write endpoints
 * enforce and the directory reports (`allowedActions`), so a screen can never
 * offer what the server would refuse.
 *
 * The rules:
 *  - Only an owner or admin administers people (`canAdministerPeople` is the one
 *    place that says so; the route gate - the `members` service - sits on top).
 *  - Never upward: nobody acts on someone above them. The owner is acted on by the
 *    owner alone, and an admin acts on admins as before.
 *  - The owner role is immutable, and nobody changes their own role.
 *  - Giving or taking away the admin role is for owners and admins only.
 *  - A directory-managed account (LDAP, SSO) keeps its name, email and password
 *    in the directory: they are read-only here, and the account is disabled
 *    rather than deleted (it would be created again at its next sign-in).
 *
 * Nothing here reads the database or the request.
 */

import {
  ASSIGNABLE_ROLES,
  isAssignableRole,
  isDirectoryManaged,
  isGroupDirectoryManaged,
  isPendingInvite,
  roleRank,
  type ActionDenial,
  type AllowedAction,
  type AssignableRole,
  type PeopleErrorCode,
} from '@/lib/iam/identity';
import { canActOnTokensOf } from '@/lib/services/apiTokens/tokenGovernance';

/** The signed-in person asking. `role` is the role as the database holds it NOW. */
export interface PolicyActor {
  id: string;
  role: string;
}

/** The person acted on. */
export interface PolicyTarget {
  id: string;
  role: string;
  canLogin?: boolean | null;
  authProvider?: string | null;
  status?: string | null;
  invitedBy?: string | null;
  inviteAcceptedAt?: Date | string | null;
}

/** The facts of a stored user row the rules need (a row has `_id`, the policy speaks of `id`). */
export function targetOf(user: {
  _id?: unknown;
  role?: string | null;
  canLogin?: boolean | null;
  authProvider?: string | null;
  status?: string | null;
  invitedBy?: string | null;
  inviteAcceptedAt?: Date | string | null;
}): PolicyTarget {
  return {
    id: String(user._id ?? ''),
    role: String(user.role ?? ''),
    canLogin: user.canLogin,
    authProvider: user.authProvider,
    status: user.status,
    invitedBy: user.invitedBy,
    inviteAcceptedAt: user.inviteAcceptedAt,
  };
}

export type PolicyRefusal = {
  ok: false;
  status: 400 | 403 | 409;
  code: PeopleErrorCode;
  message: string;
};
export type PolicyVerdict = { ok: true } | PolicyRefusal;

const OK: PolicyVerdict = { ok: true };

function refuse(status: PolicyRefusal['status'], code: PeopleErrorCode, message: string): PolicyRefusal {
  return { ok: false, status, code, message };
}

const isSelf = (actor: PolicyActor, target: Pick<PolicyTarget, 'id'>): boolean =>
  String(actor.id) === String(target.id);

/** An owner or an admin. */
export function isOwnerOrAdmin(role: string | undefined | null): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Who may WRITE people (invite, edit, change roles, disable, delete, group
 * memberships). Today: owners and admins. Opening this up later (a delegated
 * `members` grant) is a one-line change here, and the never-upward, owner and
 * self rules below hold whoever passes it.
 */
export function canAdministerPeople(role: string | undefined | null): boolean {
  return isOwnerOrAdmin(role);
}

// ── the base rule ────────────────────────────────────────────────────────

/** May the actor act on this person at all? (administer + never upward + the owner only by themself). */
export function canActOnPerson(actor: PolicyActor, target: PolicyTarget): PolicyVerdict {
  if (!canAdministerPeople(actor.role)) {
    return refuse(403, 'forbidden', 'Only owners and admins can manage people');
  }
  if (target.role === 'owner' && !isSelf(actor, target)) {
    return actor.role === 'owner'
      ? refuse(403, 'owner_immutable', 'The owner account cannot be changed')
      : refuse(403, 'higher_privileges', 'You cannot act on an account with more privileges than yours');
  }
  if (roleRank(actor.role) < roleRank(target.role)) {
    return refuse(403, 'higher_privileges', 'You cannot act on an account with more privileges than yours');
  }
  return OK;
}

// ── profile ──────────────────────────────────────────────────────────────

export type ProfileField = 'name' | 'email';

/** `fields` are the fields whose value would actually change. */
export function checkProfileChange(
  actor: PolicyActor,
  target: PolicyTarget,
  fields: readonly ProfileField[],
): PolicyVerdict {
  const base = canActOnPerson(actor, target);
  if (!base.ok) return base;
  if (fields.length > 0 && isDirectoryManaged(target)) {
    return refuse(409, 'directory_managed', 'The name and email of this account are managed by the directory');
  }
  return OK;
}

// ── role ─────────────────────────────────────────────────────────────────

export type RoleChangeVerdict = PolicyVerdict & { noop?: boolean };

/**
 * `actor` gives `target` the role `next`. A change to the role the person already
 * has is accepted as a no-op (`noop`): nothing is written and nothing is audited.
 */
export function checkRoleChange(actor: PolicyActor, target: PolicyTarget, next: unknown): RoleChangeVerdict {
  if (next === 'owner') {
    return refuse(400, 'invalid_role', 'The owner role cannot be assigned');
  }
  if (!isAssignableRole(next)) {
    return refuse(400, 'invalid_role', `Invalid role. Must be ${ASSIGNABLE_ROLES.join(', ')}`);
  }
  if (!canAdministerPeople(actor.role)) {
    return refuse(403, 'forbidden', 'Only owners and admins can change roles');
  }
  if (target.role === 'owner') {
    return refuse(403, 'owner_immutable', 'The role of the owner cannot be changed');
  }
  if (isSelf(actor, target)) {
    return refuse(403, 'cannot_change_own_role', 'You cannot change your own role');
  }
  if (roleRank(actor.role) < roleRank(target.role)) {
    return refuse(403, 'higher_privileges', 'You cannot change the role of an account with more privileges than yours');
  }
  // Redundant while only owners and admins administer people; kept so that opening
  // `canAdministerPeople` up can never let anyone else hand out or take away admin.
  if ((target.role === 'admin') !== (next === 'admin') && !isOwnerOrAdmin(actor.role)) {
    return refuse(403, 'admin_grant_requires_admin', 'Only owners and admins can grant or remove the admin role');
  }
  if (next === target.role) return { ok: true, noop: true };
  return OK;
}

/** The roles `actor` could give `target` (empty when the role cannot be changed at all). */
export function assignableRoles(actor: PolicyActor, target: PolicyTarget): AssignableRole[] {
  return ASSIGNABLE_ROLES.filter((role) => checkRoleChange(actor, target, role).ok);
}

// ── permissions, status, delete ──────────────────────────────────────────

/** Edit the per-service permission overrides of a person. */
export function checkPermissionsEdit(actor: PolicyActor, target: PolicyTarget): PolicyVerdict {
  if (!canAdministerPeople(actor.role)) {
    return refuse(403, 'forbidden', 'Only owners and admins can manage permissions');
  }
  if (target.role === 'owner') {
    return refuse(403, 'owner_immutable', 'Owner permissions cannot be changed');
  }
  if (roleRank(actor.role) < roleRank(target.role)) {
    return refuse(403, 'higher_privileges', 'You cannot change the permissions of an account with more privileges than yours');
  }
  return OK;
}

/** Disable or enable. The status route itself repeats the self / owner / tenant guards (userLifecycle.ts). */
export function checkStatusChange(actor: PolicyActor, target: PolicyTarget): PolicyVerdict {
  if (!canAdministerPeople(actor.role)) {
    return refuse(403, 'forbidden', 'Only owners and admins can change the status of an account');
  }
  if (isSelf(actor, target)) {
    return refuse(400, 'self_not_allowed', 'You cannot change the status of your own account');
  }
  if (target.role === 'owner') {
    return refuse(403, 'owner_immutable', 'Owner accounts cannot be disabled');
  }
  if (roleRank(actor.role) < roleRank(target.role)) {
    return refuse(403, 'higher_privileges', 'You cannot change the status of an account with more privileges than yours');
  }
  return OK;
}

export function checkDelete(actor: PolicyActor, target: PolicyTarget): PolicyVerdict {
  if (!canAdministerPeople(actor.role)) {
    return refuse(403, 'forbidden', 'Only owners and admins can delete users');
  }
  if (isSelf(actor, target)) {
    return refuse(400, 'self_not_allowed', 'You cannot delete your own account');
  }
  if (target.role === 'owner') {
    return refuse(403, 'owner_immutable', 'Cannot delete the owner account');
  }
  if (roleRank(actor.role) < roleRank(target.role)) {
    return refuse(403, 'higher_privileges', 'You cannot delete an account with more privileges than yours');
  }
  if (isDirectoryManaged(target)) {
    return refuse(409, 'directory_managed', 'This account is managed by the directory; disable it instead (it would be created again at its next sign-in)');
  }
  return OK;
}

// ── group membership ─────────────────────────────────────────────────────

/** Whether belonging to the group gives a person access (a tenant role or service permissions). */
export function groupGrantsAccess(group: { tenantRole?: string | null; servicePermissions?: Record<string, unknown> | null }): boolean {
  return Boolean(group.tenantRole) || Object.keys(group.servicePermissions ?? {}).length > 0;
}

/** Add or remove `target` to / from a group. A group of a directory is changed by the directory. */
export function checkGroupMembership(
  actor: PolicyActor,
  target: PolicyTarget,
  group: { source?: string | null; tenantRole?: string | null; servicePermissions?: Record<string, unknown> | null },
): PolicyVerdict {
  if (!canAdministerPeople(actor.role)) {
    return refuse(403, 'forbidden', 'Only owners and admins can manage group members');
  }
  if (isGroupDirectoryManaged(group)) {
    return refuse(409, 'group_directory_managed', 'Membership of directory groups is managed by the directory');
  }
  // Belonging to such a group is a grant, and handing out access is for owners and admins.
  if (groupGrantsAccess(group) && !isOwnerOrAdmin(actor.role)) {
    return refuse(403, 'forbidden', 'Only owners and admins can add people to a group that grants access');
  }
  if (target.role === 'owner' && !isSelf(actor, target) && actor.role !== 'owner') {
    return refuse(403, 'higher_privileges', 'You cannot act on an account with more privileges than yours');
  }
  return OK;
}

// ── tokens ───────────────────────────────────────────────────────────────

/**
 * Whose tokens the viewer sees in the directory: their own always; an owner or admin
 * those of everyone they may act on (the owner role everyone's, an admin everyone's
 * but the owner's); nobody else anyone else's. `owner` is null when the token's
 * owner cannot be resolved - only the owner role reaches those.
 */
export function canSeeTokensOf(
  actor: PolicyActor,
  owner: Pick<PolicyTarget, 'id' | 'role' | 'canLogin'> | null,
): boolean {
  if (owner && isSelf(actor, owner)) return true;
  if (!isOwnerOrAdmin(actor.role)) return false;
  return owner !== null ? canActOnTokensOf(actor.role, owner) : actor.role === 'owner';
}

// ── what the viewer is offered ───────────────────────────────────────────

export interface AllowedActions {
  editProfile: AllowedAction;
  changeRole: AllowedAction;
  editPermissions: AllowedAction;
  disable: AllowedAction;
  enable: AllowedAction;
  delete: AllowedAction;
  copyInvitationLink: AllowedAction;
  manageGroups: AllowedAction;
  manageProjects: AllowedAction;
  mintToken: AllowedAction;
  revokeTokens: AllowedAction;
}

const DENIAL_OF: Partial<Record<PeopleErrorCode, ActionDenial>> = {
  forbidden: 'forbidden',
  owner_immutable: 'owner_immutable',
  higher_privileges: 'higher_privileges',
  directory_managed: 'directory_managed',
  group_directory_managed: 'directory_managed',
  self_not_allowed: 'self',
  cannot_change_own_role: 'self',
  admin_grant_requires_admin: 'forbidden',
};

function asAction(verdict: PolicyVerdict): AllowedAction {
  if (verdict.ok) return { allowed: true };
  return { allowed: false, reason: DENIAL_OF[verdict.code] ?? 'forbidden' };
}

const allow: AllowedAction = { allowed: true };
const deny = (reason: ActionDenial): AllowedAction => ({ allowed: false, reason });

/**
 * Everything the viewer may do to this person - the same verdicts the write
 * endpoints reach. `profileFields` of `editProfile` are judged as if a name were
 * changed, so a directory-managed account reads as not editable.
 */
export function computeAllowedActions(actor: PolicyActor, target: PolicyTarget): AllowedActions {
  const base = canActOnPerson(actor, target);
  const baseAction = asAction(base);
  const disabled = target.status === 'disabled';

  const changeRoleAction = assignableRoles(actor, target).length > 0
    ? allow
    : asAction(checkRoleChange(actor, target, target.role === 'admin' ? 'user' : 'admin'));

  let copyInvitationLink: AllowedAction;
  if (!base.ok) copyInvitationLink = baseAction;
  else if (isPendingInvite(target)) copyInvitationLink = allow;
  else copyInvitationLink = deny(disabled ? 'account_disabled' : 'no_pending_invite');

  // Tokens: the viewer's own always; others' by the never-upward rule for owners and admins.
  const tokenVerdict: AllowedAction = isSelf(actor, target) || canSeeTokensOf(actor, target)
    ? allow
    : deny(canAdministerPeople(actor.role) ? 'higher_privileges' : 'forbidden');

  return {
    editProfile: asAction(checkProfileChange(actor, target, ['name'])),
    changeRole: changeRoleAction,
    editPermissions: asAction(checkPermissionsEdit(actor, target)),
    disable: asAction(checkStatusChange(actor, target)),
    enable: asAction(checkStatusChange(actor, target)),
    delete: asAction(checkDelete(actor, target)),
    copyInvitationLink,
    manageGroups: baseAction,
    manageProjects: baseAction,
    mintToken: disabled && !isSelf(actor, target) ? deny('account_disabled') : tokenVerdict,
    revokeTokens: tokenVerdict,
  };
}

/** The actions on a group. A directory group has its members and name from the directory; its grants stay editable. */
export interface AllowedGroupActions {
  edit: AllowedAction;
  delete: AllowedAction;
  manageMembers: AllowedAction;
  manageProjects: AllowedAction;
}

export function computeAllowedGroupActions(actor: PolicyActor, group: { source?: string | null }): AllowedGroupActions {
  if (!canAdministerPeople(actor.role)) {
    const no = deny('forbidden');
    return { edit: no, delete: no, manageMembers: no, manageProjects: no };
  }
  const managed = isGroupDirectoryManaged(group);
  return {
    edit: allow,
    delete: managed ? deny('directory_managed') : allow,
    manageMembers: managed ? deny('directory_managed') : allow,
    manageProjects: allow,
  };
}
