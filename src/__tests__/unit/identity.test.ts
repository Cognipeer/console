/**
 * The facts about people the server and the screens share: roles and their order,
 * who manages an account, how the directory classifies a row, the error codes.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  AUTH_PROVIDERS,
  DIRECTORY_READ_ONLY_FIELDS,
  PEOPLE_ERROR_CODES,
  ROLE_RANK,
  TENANT_ROLES,
  isAssignableRole,
  isDirectoryManaged,
  isGroupDirectoryManaged,
  isPendingInvite,
  isTenantRole,
  listStatusOf,
  providerOf,
  roleRank,
  userKind,
} from '@/lib/iam/identity';

describe('roles', () => {
  it('knows the five tenant roles and never lets the owner role be assigned', () => {
    expect([...TENANT_ROLES]).toEqual(['owner', 'admin', 'project_admin', 'user', 'portal_user']);
    expect([...ASSIGNABLE_ROLES]).toEqual(['admin', 'project_admin', 'user', 'portal_user']);
    expect(isAssignableRole('owner')).toBe(false);
    for (const role of ASSIGNABLE_ROLES) expect(isAssignableRole(role)).toBe(true);
    for (const bad of ['', 'root', 'Admin', null, undefined, 3, {}]) {
      expect(isTenantRole(bad)).toBe(false);
      expect(isAssignableRole(bad)).toBe(false);
    }
  });

  it('orders roles owner > admin > project_admin > user, and anything else below them all', () => {
    expect(ROLE_RANK).toEqual({ owner: 3, admin: 2, project_admin: 1, user: 0, portal_user: 0 });
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('project_admin'));
    expect(roleRank('project_admin')).toBeGreaterThan(roleRank('user'));
    expect(roleRank('user')).toBeGreaterThan(roleRank('nope'));
    expect(roleRank(undefined)).toBe(-1);
  });

  it('treats portal_user as an assignable role that outranks nobody', () => {
    expect(isTenantRole('portal_user')).toBe(true);
    expect(isAssignableRole('portal_user')).toBe(true);
    expect(roleRank('portal_user')).toBeLessThanOrEqual(roleRank('user'));
  });
});

describe('who manages an account', () => {
  it('reads a missing or unknown provider as local (every pre-existing row has none)', () => {
    for (const user of [{}, { authProvider: undefined }, { authProvider: null }, { authProvider: '' }, { authProvider: 'github' }, { authProvider: 'local' }]) {
      expect(providerOf(user)).toBe('local');
      expect(isDirectoryManaged(user)).toBe(false);
    }
    for (const provider of AUTH_PROVIDERS.filter((p) => p !== 'local')) {
      expect(providerOf({ authProvider: provider })).toBe(provider);
      expect(isDirectoryManaged({ authProvider: provider })).toBe(true);
    }
  });

  it('keeps name, email and password in the directory for a managed account', () => {
    expect([...DIRECTORY_READ_ONLY_FIELDS]).toEqual(['name', 'email', 'password']);
  });

  it('calls a group managed when it comes from anywhere but this console', () => {
    expect(isGroupDirectoryManaged({})).toBe(false);
    expect(isGroupDirectoryManaged({ source: 'local' })).toBe(false);
    expect(isGroupDirectoryManaged({ source: undefined })).toBe(false);
    expect(isGroupDirectoryManaged({ source: '' })).toBe(false);
    expect(isGroupDirectoryManaged({ source: 'ldap' })).toBe(true);
    expect(isGroupDirectoryManaged({ source: 'oidc' })).toBe(true);
  });
});

describe('how the directory classifies a person', () => {
  it('a service account is an identity that cannot sign in; a missing flag means it can', () => {
    expect(userKind({})).toBe('person');
    expect(userKind({ canLogin: true })).toBe('person');
    expect(userKind({ canLogin: null })).toBe('person');
    expect(userKind({ canLogin: false })).toBe('service');
  });

  it('is invited only while an invitation to an enabled, login-capable account is unanswered', () => {
    const invited = { invitedBy: 'owner-1', canLogin: true };
    expect(isPendingInvite(invited)).toBe(true);
    expect(isPendingInvite({ invitedBy: 'owner-1' })).toBe(true); // canLogin missing = can sign in
    expect(isPendingInvite({ ...invited, inviteAcceptedAt: new Date() })).toBe(false);
    expect(isPendingInvite({ ...invited, inviteAcceptedAt: '2026-01-01T00:00:00Z' })).toBe(false);
    expect(isPendingInvite({ ...invited, status: 'disabled' })).toBe(false);
    expect(isPendingInvite({ ...invited, canLogin: false })).toBe(false); // a service account has nobody to invite
    expect(isPendingInvite({ canLogin: true })).toBe(false); // never invited (the workspace owner, directory users)
    expect(isPendingInvite({ invitedBy: '', canLogin: true })).toBe(false);
  });

  it('lets disabled outrank invited, and invited outrank active', () => {
    expect(listStatusOf({})).toBe('active');
    expect(listStatusOf({ status: 'active' })).toBe('active');
    expect(listStatusOf({ status: 'disabled' })).toBe('disabled');
    expect(listStatusOf({ invitedBy: 'o', status: 'disabled' })).toBe('disabled');
    expect(listStatusOf({ invitedBy: 'o' })).toBe('invited');
    expect(listStatusOf({ invitedBy: 'o', inviteAcceptedAt: new Date() })).toBe('active');
    expect(listStatusOf({ invitedBy: 'o', canLogin: false })).toBe('active');
  });
});

describe('error codes', () => {
  it('are unique, snake_case and include every code the people endpoints answer with', () => {
    expect(new Set(PEOPLE_ERROR_CODES).size).toBe(PEOPLE_ERROR_CODES.length);
    for (const code of PEOPLE_ERROR_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    for (const code of [
      'invalid_body', 'invalid_filter', 'invalid_cursor', 'invalid_role', 'user_not_found', 'group_not_found', 'forbidden',
      'owner_immutable', 'cannot_change_own_role', 'admin_grant_requires_admin', 'higher_privileges', 'self_not_allowed',
      'directory_managed', 'group_directory_managed', 'email_taken', 'email_required', 'quota_exceeded', 'rate_limited',
      'too_many_ids', 'password_managed_externally', 'invalid_password',
    ]) {
      expect(PEOPLE_ERROR_CODES, code).toContain(code);
    }
  });
});
