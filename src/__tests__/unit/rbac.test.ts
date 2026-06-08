import { describe, expect, it } from 'vitest';
import {
  authorizeServiceRequest,
  getEffectiveServicePermissionWithGroups,
  getPermissionServiceForPath,
  mergeServicePermissions,
  normalizeServicePermissions,
} from '@/lib/security/rbac';

describe('RBAC service routing', () => {
  it('maps API paths to service ids', () => {
    expect(getPermissionServiceForPath('/api/models')).toBe('models');
    expect(getPermissionServiceForPath('/api/client/v1/vector/indexes')).toBe('vector');
    expect(getPermissionServiceForPath('/api/users/permissions/services')).toBe('members');
  });
});

describe('RBAC authorization', () => {
  it('allows owners to access admin services', () => {
    const decision = authorizeServiceRequest({ role: 'owner' }, 'DELETE', '/api/users/user-1');
    expect(decision.allowed).toBe(true);
  });

  it('denies admin services to users without explicit permission', () => {
    const decision = authorizeServiceRequest({ role: 'user' }, 'GET', '/api/audit/logs');
    expect(decision.allowed).toBe(false);
  });

  it('uses explicit service permissions over role defaults', () => {
    const decision = authorizeServiceRequest(
      { role: 'user', servicePermissions: { audit: 'read' } },
      'GET',
      '/api/audit/logs',
    );
    expect(decision.allowed).toBe(true);
  });

  it('normalizes invalid service permissions out', () => {
    expect(normalizeServicePermissions({ models: 'read', unknown: 'admin', audit: 'invalid' }))
      .toEqual({ models: 'read' });
  });
});

describe('RBAC group-inherited permissions', () => {
  it('raises a plain user to admin on an admin service via a group tenantRole', () => {
    const user = { role: 'user' as const };
    // Without groups: denied admin service.
    expect(getEffectiveServicePermissionWithGroups(user, [], 'audit')).toBe('none');
    // In an admin-granting group: allowed.
    expect(getEffectiveServicePermissionWithGroups(user, [{ tenantRole: 'admin' }], 'audit')).toBe('admin');
  });

  it('grants a specific service through a group servicePermissions override', () => {
    const user = { role: 'user' as const };
    const grants = [{ servicePermissions: { audit: 'read' as const } }];
    expect(getEffectiveServicePermissionWithGroups(user, grants, 'audit')).toBe('read');
    // Unrelated admin service stays denied.
    expect(getEffectiveServicePermissionWithGroups(user, grants, 'license')).toBe('none');
  });

  it('never lowers a user below their own access', () => {
    const user = { role: 'admin' as const };
    // A weak group grant cannot demote an admin.
    expect(getEffectiveServicePermissionWithGroups(user, [{ tenantRole: 'user' }], 'audit')).toBe('admin');
  });

  it('authorizeServiceRequest honours group grants', () => {
    const denied = authorizeServiceRequest({ role: 'user' }, 'GET', '/api/audit/logs');
    expect(denied.allowed).toBe(false);

    const allowed = authorizeServiceRequest(
      { role: 'user' },
      'GET',
      '/api/audit/logs',
      [{ tenantRole: 'admin' }],
    );
    expect(allowed.allowed).toBe(true);
  });

  it('merges service permission maps keeping the highest level', () => {
    expect(mergeServicePermissions([
      { models: 'read', audit: 'read' },
      { models: 'admin' },
      null,
      { audit: 'none' },
    ])).toEqual({ models: 'admin', audit: 'read' });
  });
});
