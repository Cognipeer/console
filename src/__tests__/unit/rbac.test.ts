import { describe, expect, it } from 'vitest';
import {
  authorizeServiceRequest,
  getPermissionServiceForPath,
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
