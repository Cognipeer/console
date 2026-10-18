import { describe, expect, it } from 'vitest';
import {
  authorizeServiceRequest,
  getEffectiveServicePermissionWithGroups,
  getPermissionServiceForPath,
  getRequiredPermissionLevel,
  mergeServicePermissions,
  normalizeServicePermissions,
} from '@/lib/security/rbac';

describe('RBAC service routing', () => {
  it('maps API paths to service ids', () => {
    expect(getPermissionServiceForPath('/api/models')).toBe('models');
    expect(getPermissionServiceForPath('/api/client/v1/vector/indexes')).toBe('vector');
    expect(getPermissionServiceForPath('/api/users/permissions/services')).toBe('members');
  });

  it('checks the agents permission on the runs API and the session cancel: read to look, write to act', () => {
    const paths = [
      ['POST', '/api/client/v1/agents/support/runs'],
      ['GET', '/api/client/v1/agents/runs'],
      ['GET', '/api/client/v1/agents/runs/queue'],
      ['GET', '/api/client/v1/agents/runs/run_1'],
      ['POST', '/api/client/v1/agents/runs/run_1/cancel'],
      ['GET', '/api/client/v1/agents/runs/run_1/events'],
      ['GET', '/api/client/v1/agents/runs/run_1/events/stream'],
      ['POST', '/api/client/v1/agents/runs/run_1/actions/act_1'],
      ['POST', '/api/client/v1/agents/sessions/conv_1/cancel'],
      ['POST', '/api/client/v1/agents/conversations/conv_1/cancel'],
    ] as const;
    for (const [method, path] of paths) {
      expect(getPermissionServiceForPath(path)).toBe('agents');
      expect(getRequiredPermissionLevel(method, 'agents')).toBe(method === 'GET' ? 'read' : 'write');
    }
  });
});

describe('RBAC portals', () => {
  it('maps the portal ADMIN API to the admin-only portals service', () => {
    expect(getPermissionServiceForPath('/api/portals')).toBe('portals');
    expect(getPermissionServiceForPath('/api/portals/abc/stats')).toBe('portals');
    expect(authorizeServiceRequest({ role: 'user' }, 'GET', '/api/portals').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'user' }, 'POST', '/api/portals').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'admin' }, 'POST', '/api/portals').allowed).toBe(true);
    expect(authorizeServiceRequest({ role: 'owner' }, 'DELETE', '/api/portals/abc').allowed).toBe(true);
  });

  it('leaves the end-user runtime to the session hook and the portal access list', () => {
    // Unmapped on purpose: a plain tenant member (no service grants) must reach it.
    expect(getPermissionServiceForPath('/api/portal/branch-assistant/info')).toBeNull();
    expect(
      authorizeServiceRequest({ role: 'user' }, 'POST', '/api/portal/branch-assistant/conversations').allowed,
    ).toBe(true);
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

describe('API-token least-privilege scope (authorizeServiceRequest tokenScope arg)', () => {
  const owner = { role: 'owner' as const };

  it('unscoped token (null) inherits the owner unchanged (legacy behaviour)', () => {
    const d = authorizeServiceRequest(owner, 'GET', '/api/audit/logs', [], null);
    expect(d.allowed).toBe(true);
  });

  it('a scoped token is an allowlist: a service absent from the scope is denied even for an owner', () => {
    const d = authorizeServiceRequest(owner, 'GET', '/api/audit/logs', [], { models: 'read' });
    expect(d.allowed).toBe(false);
  });

  it('an empty scope {} denies everything', () => {
    const d = authorizeServiceRequest(owner, 'GET', '/api/audit/logs', [], {});
    expect(d.allowed).toBe(false);
  });

  it('a scoped token grants a listed service up to (but not above) the owner level', () => {
    const d = authorizeServiceRequest(owner, 'GET', '/api/audit/logs', [], { audit: 'read' });
    expect(d.allowed).toBe(true);
  });

  it('a token scope can never exceed the owner: admin scope on a service the owner lacks stays denied', () => {
    // A plain user has no permission on the admin `audit` service; naming
    // `audit: 'admin'` in the token scope cannot raise them above the owner.
    const d = authorizeServiceRequest({ role: 'user' }, 'GET', '/api/audit/logs', [], { audit: 'admin' });
    expect(d.allowed).toBe(false);
  });

  it('a scope can narrow write down to read (min cap)', () => {
    // owner has admin on models; scope caps it to read → a write (DELETE) is denied.
    const d = authorizeServiceRequest(owner, 'DELETE', '/api/models/m1', [], { models: 'read' });
    expect(d.allowed).toBe(false);
    // ...but a read (GET) on the same scoped service is allowed.
    const r = authorizeServiceRequest(owner, 'GET', '/api/models/m1', [], { models: 'read' });
    expect(r.allowed).toBe(true);
  });
});
