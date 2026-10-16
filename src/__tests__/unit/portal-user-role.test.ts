import { describe, expect, it } from 'vitest';
import { RBAC_SERVICE_DEFINITIONS, getRoleDefaultPermission } from '@/lib/security/rbac';

describe('portal_user role', () => {
  it('holds no service permission by default: it signs in only to use portals', () => {
    for (const service of RBAC_SERVICE_DEFINITIONS) {
      expect(getRoleDefaultPermission('portal_user', service.id)).toBe('none');
    }
  });

  it('is not a stand-in for the roles that do hold permissions', () => {
    expect(getRoleDefaultPermission('user', 'agents')).toBe('write');
    expect(getRoleDefaultPermission('portal_user', 'agents')).toBe('none');
    expect(getRoleDefaultPermission('portal_user', 'portals')).toBe('none');
    expect(getRoleDefaultPermission('portal_user', 'iam')).toBe('none');
  });
});
