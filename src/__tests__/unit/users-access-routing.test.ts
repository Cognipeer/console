/**
 * Which service gates the access routes under /api/users: most of the prefix is `members` (owners and admins); adding a
 * person to projects is the `projects` service (a project admin may), and what a person does about themself is no
 * service at all (the route declares itself authenticated).
 */
import { describe, expect, it } from 'vitest';
import { getPermissionServiceForPath } from '@/lib/security/rbac';

describe('routing of /api/users access paths', () => {
  it('keeps the people-management routes on the members service', () => {
    for (const path of ['/api/users', '/api/users/invite', '/api/users/external', '/api/users/external/issuers', '/api/users/u1', '/api/users/u1/disable', '/api/users/bulk']) {
      expect(getPermissionServiceForPath(path), path).toBe('members');
    }
  });

  it('gates adding a person to projects by the projects service, whoever the person is', () => {
    expect(getPermissionServiceForPath('/api/users/u1/projects')).toBe('projects');
    expect(getPermissionServiceForPath('/api/users/65f0c0ffee/projects/')).toBe('projects');
  });

  it('leaves the self-service paths to their own declaration', () => {
    expect(getPermissionServiceForPath('/api/users/me/access-request')).toBeNull();
    expect(getPermissionServiceForPath('/api/users/me')).toBeNull();
    // a person whose id merely starts with "me" is still a person of the members service
    expect(getPermissionServiceForPath('/api/users/mehmet/disable')).toBe('members');
  });
});
