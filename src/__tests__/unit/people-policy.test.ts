/**
 * Who may do what to which person: the truth tables of the one policy the write
 * endpoints enforce and the directory reports as `allowedActions`.
 */
import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canActOnPerson,
  canAdministerPeople,
  canSeeTokensOf,
  checkDelete,
  checkGroupMembership,
  checkPermissionsEdit,
  checkProfileChange,
  checkRoleChange,
  checkStatusChange,
  computeAllowedActions,
  computeAllowedGroupActions,
  groupGrantsAccess,
  isOwnerOrAdmin,
  type PolicyActor,
  type PolicyTarget,
} from '@/lib/services/users/peoplePolicy';

const OWNER: PolicyActor = { id: 'owner-1', role: 'owner' };
const ADMIN: PolicyActor = { id: 'admin-1', role: 'admin' };
const PA: PolicyActor = { id: 'pa-1', role: 'project_admin' };
const USER: PolicyActor = { id: 'user-1', role: 'user' };
const ACTORS = { owner: OWNER, admin: ADMIN, project_admin: PA, user: USER };

const target = (over: Partial<PolicyTarget> & Pick<PolicyTarget, 'id' | 'role'>): PolicyTarget => ({ canLogin: true, ...over });
const T_OWNER = target({ id: 'owner-1', role: 'owner' });
const T_ADMIN = target({ id: 'admin-2', role: 'admin' });
const T_PA = target({ id: 'pa-2', role: 'project_admin' });
const T_USER = target({ id: 'user-2', role: 'user' });
const T_SERVICE = target({ id: 'svc-1', role: 'user', canLogin: false });
const T_LDAP = target({ id: 'ldap-1', role: 'user', authProvider: 'ldap' });
const T_SSO_ADMIN = target({ id: 'sso-1', role: 'admin', authProvider: 'oidc' });

const code = (verdict: { ok: boolean; code?: string }) => (verdict.ok ? 'ok' : verdict.code);

describe('who may administer people', () => {
  it('is owners and admins, nobody else', () => {
    expect(canAdministerPeople('owner')).toBe(true);
    expect(canAdministerPeople('admin')).toBe(true);
    for (const role of ['project_admin', 'user', '', undefined, null, 'root']) {
      expect(canAdministerPeople(role as string)).toBe(false);
    }
    expect(isOwnerOrAdmin('owner')).toBe(true);
    expect(isOwnerOrAdmin('project_admin')).toBe(false);
  });
});

describe('the base rule (administer + never upward)', () => {
  it.each([
    // actor, target, expected
    ['owner', T_ADMIN, 'ok'], ['owner', T_PA, 'ok'], ['owner', T_USER, 'ok'], ['owner', T_OWNER, 'ok'], // the owner is acted on by themself
    ['admin', T_ADMIN, 'ok'], ['admin', T_PA, 'ok'], ['admin', T_USER, 'ok'], ['admin', T_SERVICE, 'ok'], ['admin', T_LDAP, 'ok'],
    ['admin', T_OWNER, 'higher_privileges'],
    ['project_admin', T_USER, 'forbidden'], ['project_admin', T_ADMIN, 'forbidden'], ['project_admin', T_OWNER, 'forbidden'],
    ['user', T_USER, 'forbidden'], ['user', T_SERVICE, 'forbidden'], ['user', T_OWNER, 'forbidden'],
  ] as const)('%s acting on %j -> %s', (who, to, expected) => {
    expect(code(canActOnPerson(ACTORS[who], to))).toBe(expected);
  });

  it('keeps the owner away from a second owner: only the owner themself', () => {
    expect(code(canActOnPerson(OWNER, target({ id: 'owner-2', role: 'owner' })))).toBe('owner_immutable');
  });

  it('judges the role as it is passed in (the database role), never a claim', () => {
    // an admin demoted since their session was issued reaches the policy as a user
    expect(code(canActOnPerson({ id: 'admin-1', role: 'user' }, T_USER))).toBe('forbidden');
  });
});

describe('changing a role', () => {
  it.each([
    // actor, target, next, expected
    ['owner', T_USER, 'admin', 'ok'], ['owner', T_USER, 'project_admin', 'ok'], ['owner', T_ADMIN, 'user', 'ok'], ['owner', T_PA, 'admin', 'ok'],
    ['admin', T_USER, 'admin', 'ok'], ['admin', T_USER, 'project_admin', 'ok'], ['admin', T_ADMIN, 'user', 'ok'], ['admin', T_PA, 'user', 'ok'],
    ['admin', T_LDAP, 'project_admin', 'ok'], // the role of a directory account is ours to set
    ['admin', T_SERVICE, 'admin', 'ok'],
    ['admin', T_OWNER, 'user', 'owner_immutable'],
    ['owner', T_OWNER, 'admin', 'owner_immutable'],
    ['project_admin', T_USER, 'admin', 'forbidden'], ['project_admin', T_USER, 'user', 'forbidden'],
    ['user', T_USER, 'admin', 'forbidden'],
  ] as const)('%s changes %j to %s -> %s', (who, to, next, expected) => {
    expect(code(checkRoleChange(ACTORS[who], to, next))).toBe(expected);
  });

  it('the owner role is never assignable, and unknown roles are refused before anything else', () => {
    for (const who of Object.values(ACTORS)) {
      expect(checkRoleChange(who, T_USER, 'owner')).toMatchObject({ ok: false, status: 400, code: 'invalid_role' });
    }
    for (const next of ['root', '', undefined, null, 7, { role: 'admin' }]) {
      expect(checkRoleChange(OWNER, T_USER, next)).toMatchObject({ ok: false, status: 400, code: 'invalid_role' });
    }
  });

  it('nobody changes their own role - not even to the role they have', () => {
    expect(checkRoleChange(ADMIN, { ...T_ADMIN, id: ADMIN.id }, 'user')).toMatchObject({ ok: false, status: 403, code: 'cannot_change_own_role' });
    expect(checkRoleChange(ADMIN, { ...T_ADMIN, id: ADMIN.id }, 'admin')).toMatchObject({ ok: false, code: 'cannot_change_own_role' });
    // the owner's role is immutable first
    expect(checkRoleChange(OWNER, T_OWNER, 'admin')).toMatchObject({ ok: false, code: 'owner_immutable' });
  });

  it('accepts the role a person already has as a no-op', () => {
    expect(checkRoleChange(ADMIN, T_USER, 'user')).toEqual({ ok: true, noop: true });
    expect(checkRoleChange(OWNER, T_ADMIN, 'admin')).toEqual({ ok: true, noop: true });
    expect(checkRoleChange(ADMIN, T_USER, 'admin')).toEqual({ ok: true });
  });

  it('lists the roles an actor could give', () => {
    expect(assignableRoles(OWNER, T_USER)).toEqual(['admin', 'project_admin', 'user']);
    expect(assignableRoles(ADMIN, T_ADMIN)).toEqual(['admin', 'project_admin', 'user']);
    expect(assignableRoles(ADMIN, T_OWNER)).toEqual([]);
    expect(assignableRoles(OWNER, T_OWNER)).toEqual([]);
    expect(assignableRoles(ADMIN, { ...T_USER, id: ADMIN.id })).toEqual([]);
    expect(assignableRoles(PA, T_USER)).toEqual([]);
    expect(assignableRoles(USER, T_USER)).toEqual([]);
  });
});

describe('editing a profile', () => {
  it('lets an owner or admin edit anyone they may act on', () => {
    expect(code(checkProfileChange(ADMIN, T_USER, ['name', 'email']))).toBe('ok');
    expect(code(checkProfileChange(ADMIN, T_SERVICE, ['name']))).toBe('ok');
    expect(code(checkProfileChange(OWNER, T_ADMIN, ['email']))).toBe('ok');
  });

  it('lets the owner edit their own profile and nobody else touch it', () => {
    expect(code(checkProfileChange(OWNER, T_OWNER, ['name']))).toBe('ok');
    expect(code(checkProfileChange(ADMIN, T_OWNER, ['name']))).toBe('higher_privileges');
  });

  it('keeps name and email of a directory account read-only, unless nothing would change', () => {
    expect(checkProfileChange(ADMIN, T_LDAP, ['name'])).toMatchObject({ ok: false, status: 409, code: 'directory_managed' });
    expect(checkProfileChange(OWNER, T_SSO_ADMIN, ['email'])).toMatchObject({ ok: false, status: 409, code: 'directory_managed' });
    expect(code(checkProfileChange(ADMIN, T_LDAP, []))).toBe('ok');
  });

  it('refuses everyone who does not administer people', () => {
    for (const who of [PA, USER]) expect(code(checkProfileChange(who, T_USER, ['name']))).toBe('forbidden');
  });
});

describe('permissions, status and delete', () => {
  it('permissions: never the owner\'s, never upward', () => {
    expect(code(checkPermissionsEdit(ADMIN, T_USER))).toBe('ok');
    expect(code(checkPermissionsEdit(ADMIN, T_ADMIN))).toBe('ok');
    expect(code(checkPermissionsEdit(OWNER, T_USER))).toBe('ok');
    expect(code(checkPermissionsEdit(OWNER, T_OWNER))).toBe('owner_immutable');
    expect(code(checkPermissionsEdit(ADMIN, T_OWNER))).toBe('owner_immutable');
    expect(code(checkPermissionsEdit(PA, T_USER))).toBe('forbidden');
  });

  it('status: not yourself, not the owner', () => {
    expect(code(checkStatusChange(ADMIN, T_USER))).toBe('ok');
    expect(code(checkStatusChange(ADMIN, T_LDAP))).toBe('ok'); // disabling is what a directory account gets instead of a delete
    expect(checkStatusChange(ADMIN, { ...T_USER, id: ADMIN.id })).toMatchObject({ ok: false, status: 400, code: 'self_not_allowed' });
    expect(checkStatusChange(ADMIN, T_OWNER)).toMatchObject({ ok: false, status: 403, code: 'owner_immutable' });
    expect(code(checkStatusChange(USER, T_USER))).toBe('forbidden');
  });

  it('delete: not yourself, not the owner, not a directory account', () => {
    expect(code(checkDelete(ADMIN, T_USER))).toBe('ok');
    expect(code(checkDelete(ADMIN, T_ADMIN))).toBe('ok');
    expect(code(checkDelete(OWNER, T_SERVICE))).toBe('ok');
    expect(checkDelete(ADMIN, { ...T_ADMIN, id: ADMIN.id })).toMatchObject({ ok: false, status: 400, code: 'self_not_allowed' });
    expect(checkDelete(ADMIN, T_OWNER)).toMatchObject({ ok: false, status: 403, code: 'owner_immutable' });
    expect(checkDelete(ADMIN, T_LDAP)).toMatchObject({ ok: false, status: 409, code: 'directory_managed' });
    expect(checkDelete(OWNER, T_SSO_ADMIN)).toMatchObject({ ok: false, status: 409, code: 'directory_managed' });
    expect(code(checkDelete(PA, T_USER))).toBe('forbidden');
  });
});

describe('group membership', () => {
  const local = { source: 'local', tenantRole: null, servicePermissions: {} };

  it('lets owners and admins change the members of a local group', () => {
    expect(code(checkGroupMembership(ADMIN, T_USER, local))).toBe('ok');
    expect(code(checkGroupMembership(OWNER, T_ADMIN, { ...local, tenantRole: 'admin' }))).toBe('ok');
    expect(code(checkGroupMembership(ADMIN, T_LDAP, local))).toBe('ok'); // a directory person can join a local group
  });

  it('leaves the members of a directory group to the directory', () => {
    expect(checkGroupMembership(ADMIN, T_USER, { source: 'ldap' })).toMatchObject({ ok: false, status: 409, code: 'group_directory_managed' });
    expect(checkGroupMembership(OWNER, T_USER, { source: 'oidc' })).toMatchObject({ code: 'group_directory_managed' });
    expect(code(checkGroupMembership(ADMIN, T_USER, {}))).toBe('ok'); // a missing source is local
  });

  it('refuses everyone who does not administer people, and an admin acting on the owner', () => {
    expect(code(checkGroupMembership(PA, T_USER, local))).toBe('forbidden');
    expect(code(checkGroupMembership(USER, T_USER, local))).toBe('forbidden');
    expect(code(checkGroupMembership(ADMIN, T_OWNER, local))).toBe('higher_privileges');
    expect(code(checkGroupMembership(OWNER, T_OWNER, local))).toBe('ok');
  });

  it('knows which groups grant access', () => {
    expect(groupGrantsAccess({})).toBe(false);
    expect(groupGrantsAccess({ tenantRole: null, servicePermissions: {} })).toBe(false);
    expect(groupGrantsAccess({ tenantRole: 'admin' })).toBe(true);
    expect(groupGrantsAccess({ servicePermissions: { agents: 'read' } })).toBe(true);
  });
});

describe('whose tokens are seen', () => {
  it('everyone sees their own', () => {
    for (const who of Object.values(ACTORS)) {
      expect(canSeeTokensOf(who, { id: who.id, role: who.role, canLogin: true })).toBe(true);
    }
  });

  it('an owner sees everyone\'s, an admin everyone\'s but the owner\'s', () => {
    for (const to of [T_ADMIN, T_PA, T_USER, T_SERVICE, T_LDAP]) expect(canSeeTokensOf(OWNER, to), to.id).toBe(true);
    for (const to of [T_ADMIN, T_PA, T_USER, T_SERVICE, T_LDAP]) expect(canSeeTokensOf(ADMIN, to), to.id).toBe(true);
    expect(canSeeTokensOf(ADMIN, T_OWNER)).toBe(false);
  });

  it('nobody else sees anyone else\'s, service accounts included', () => {
    for (const who of [PA, USER]) {
      for (const to of [T_ADMIN, T_PA, T_USER, T_SERVICE, T_OWNER]) expect(canSeeTokensOf(who, to), `${who.role} -> ${to.id}`).toBe(false);
    }
  });

  it('an owner whose account cannot be resolved is reached by the owner role only', () => {
    expect(canSeeTokensOf(OWNER, null)).toBe(true);
    expect(canSeeTokensOf(ADMIN, null)).toBe(false);
    expect(canSeeTokensOf(PA, null)).toBe(false);
  });
});

describe('what the viewer is offered', () => {
  const reasonOf = (a: { allowed: boolean; reason?: string }) => (a.allowed ? 'ok' : a.reason);

  it('an admin looking at a plain user may do everything', () => {
    const actions = computeAllowedActions(ADMIN, T_USER);
    for (const [name, action] of Object.entries(actions)) {
      if (name === 'copyInvitationLink') continue; // needs a pending invitation
      expect(action, name).toEqual({ allowed: true });
    }
    expect(actions.copyInvitationLink).toEqual({ allowed: false, reason: 'no_pending_invite' });
  });

  it('offers the invitation link only while the invitation is pending', () => {
    const pending = target({ id: 'invited-1', role: 'user', invitedBy: 'owner-1' });
    expect(computeAllowedActions(ADMIN, pending).copyInvitationLink).toEqual({ allowed: true });
    expect(computeAllowedActions(ADMIN, { ...pending, inviteAcceptedAt: new Date() }).copyInvitationLink).toEqual({ allowed: false, reason: 'no_pending_invite' });
    expect(computeAllowedActions(ADMIN, { ...pending, status: 'disabled' }).copyInvitationLink).toEqual({ allowed: false, reason: 'account_disabled' });
  });

  it('looking at yourself: no role change, no disable, no delete; the rest stays', () => {
    const me = target({ id: ADMIN.id, role: 'admin' });
    const actions = computeAllowedActions(ADMIN, me);
    expect(reasonOf(actions.changeRole)).toBe('self');
    expect(reasonOf(actions.disable)).toBe('self');
    expect(reasonOf(actions.enable)).toBe('self');
    expect(reasonOf(actions.delete)).toBe('self');
    expect(actions.editProfile.allowed).toBe(true);
    expect(actions.manageGroups.allowed).toBe(true);
    expect(actions.mintToken.allowed).toBe(true);
    expect(actions.revokeTokens.allowed).toBe(true);
  });

  it('an admin looking at the owner is offered nothing but the reasons', () => {
    const actions = computeAllowedActions(ADMIN, T_OWNER);
    expect(reasonOf(actions.editProfile)).toBe('higher_privileges');
    expect(reasonOf(actions.changeRole)).toBe('owner_immutable');
    expect(reasonOf(actions.editPermissions)).toBe('owner_immutable');
    expect(reasonOf(actions.disable)).toBe('owner_immutable');
    expect(reasonOf(actions.delete)).toBe('owner_immutable');
    expect(reasonOf(actions.manageGroups)).toBe('higher_privileges');
    expect(reasonOf(actions.mintToken)).toBe('higher_privileges');
    expect(reasonOf(actions.revokeTokens)).toBe('higher_privileges');
  });

  it('a directory account: nothing to edit, nothing to delete, but a role, a status and groups', () => {
    const actions = computeAllowedActions(ADMIN, T_LDAP);
    expect(reasonOf(actions.editProfile)).toBe('directory_managed');
    expect(reasonOf(actions.delete)).toBe('directory_managed');
    expect(actions.changeRole.allowed).toBe(true);
    expect(actions.disable.allowed).toBe(true);
    expect(actions.manageGroups.allowed).toBe(true);
  });

  it('a disabled account is not given new tokens', () => {
    const off = target({ id: 'off-1', role: 'user', status: 'disabled' });
    expect(reasonOf(computeAllowedActions(ADMIN, off).mintToken)).toBe('account_disabled');
    expect(computeAllowedActions(ADMIN, off).revokeTokens.allowed).toBe(true);
  });

  it('someone who does not administer people is offered nothing on others', () => {
    for (const who of [PA, USER]) {
      const actions = computeAllowedActions(who, T_USER);
      for (const [name, action] of Object.entries(actions)) {
        expect(action.allowed, `${who.role} ${name}`).toBe(false);
        expect(action.reason, `${who.role} ${name}`).toBe('forbidden');
      }
    }
  });

  it('agrees with the checks it summarises', () => {
    for (const who of Object.values(ACTORS)) {
      for (const to of [T_OWNER, T_ADMIN, T_PA, T_USER, T_SERVICE, T_LDAP, { ...T_USER, id: who.id }]) {
        const actions = computeAllowedActions(who, to);
        expect(actions.delete.allowed, `${who.role} delete ${to.id}`).toBe(checkDelete(who, to).ok);
        expect(actions.editPermissions.allowed, `${who.role} permissions ${to.id}`).toBe(checkPermissionsEdit(who, to).ok);
        expect(actions.disable.allowed, `${who.role} disable ${to.id}`).toBe(checkStatusChange(who, to).ok);
        expect(actions.changeRole.allowed, `${who.role} role ${to.id}`).toBe(assignableRoles(who, to).length > 0);
        expect(actions.editProfile.allowed, `${who.role} profile ${to.id}`).toBe(checkProfileChange(who, to, ['name']).ok);
      }
    }
  });
});

describe('what the viewer is offered on a group', () => {
  it('owners and admins edit, delete and fill a local group', () => {
    for (const who of [OWNER, ADMIN]) {
      expect(computeAllowedGroupActions(who, { source: 'local' })).toEqual({
        edit: { allowed: true }, delete: { allowed: true }, manageMembers: { allowed: true }, manageProjects: { allowed: true },
      });
    }
  });

  it('a directory group keeps its members and its existence in the directory; its grants stay editable', () => {
    const actions = computeAllowedGroupActions(ADMIN, { source: 'ldap' });
    expect(actions.edit).toEqual({ allowed: true });
    expect(actions.manageProjects).toEqual({ allowed: true });
    expect(actions.delete).toEqual({ allowed: false, reason: 'directory_managed' });
    expect(actions.manageMembers).toEqual({ allowed: false, reason: 'directory_managed' });
  });

  it('anyone else gets nothing', () => {
    for (const who of [PA, USER]) {
      for (const action of Object.values(computeAllowedGroupActions(who, { source: 'local' }))) {
        expect(action).toEqual({ allowed: false, reason: 'forbidden' });
      }
    }
  });
});

describe('external accounts (a host application\'s people who use a portal)', () => {
  const T_EXTERNAL = target({ id: 'ext-1', role: 'user', canLogin: false, kind: 'external' });
  const GRANTING = { tenantRole: 'admin' };
  const PLAIN = {};

  it('keep the host\'s profile: name and email are not edited here', () => {
    expect(code(checkProfileChange(OWNER, T_EXTERNAL, ['name']))).toBe('external_user');
    expect(code(checkProfileChange(ADMIN, T_EXTERNAL, ['email']))).toBe('external_user');
    expect(code(checkProfileChange(ADMIN, T_EXTERNAL, []))).toBe('ok');
  });

  it('always have the User role and no personal permissions', () => {
    expect(code(checkRoleChange(OWNER, T_EXTERNAL, 'admin'))).toBe('external_user');
    expect(code(checkRoleChange(ADMIN, T_EXTERNAL, 'project_admin'))).toBe('external_user');
    // saying what is already true is not a change
    expect(checkRoleChange(ADMIN, T_EXTERNAL, 'user')).toMatchObject({ ok: true, noop: true });
    expect(assignableRoles(OWNER, T_EXTERNAL)).toEqual([]);
    expect(code(checkPermissionsEdit(OWNER, T_EXTERNAL))).toBe('external_user');
  });

  it('join groups that grant nothing, and never groups that grant access', () => {
    expect(code(checkGroupMembership(ADMIN, T_EXTERNAL, PLAIN))).toBe('ok');
    expect(code(checkGroupMembership(OWNER, T_EXTERNAL, GRANTING))).toBe('external_user');
    expect(code(checkGroupMembership(OWNER, T_EXTERNAL, { servicePermissions: { agents: 'write' } }))).toBe('external_user');
    expect(code(checkGroupMembership(OWNER, T_USER, GRANTING))).toBe('ok');
  });

  it('can still be disabled and deleted by an administrator', () => {
    expect(code(checkStatusChange(ADMIN, T_EXTERNAL))).toBe('ok');
    expect(code(checkDelete(ADMIN, T_EXTERNAL))).toBe('ok');
    expect(code(checkStatusChange(USER, T_EXTERNAL))).toBe('forbidden');
  });

  it('are reported to the directory with the reason', () => {
    const actions = computeAllowedActions(ADMIN, T_EXTERNAL);
    expect(actions.editProfile).toEqual({ allowed: false, reason: 'external_user' });
    expect(actions.changeRole).toEqual({ allowed: false, reason: 'external_user' });
    expect(actions.editPermissions).toEqual({ allowed: false, reason: 'external_user' });
    expect(actions.manageProjects).toEqual({ allowed: false, reason: 'external_user' });
    expect(actions.mintToken).toEqual({ allowed: false, reason: 'external_user' });
    expect(actions.disable.allowed).toBe(true);
    expect(actions.delete.allowed).toBe(true);
    expect(actions.manageGroups.allowed).toBe(true);
  });
});
