import { describe, expect, it } from 'vitest';
import {
  RBAC_SERVICE_DEFINITIONS,
  authorizeServiceRequest,
  getEffectiveServicePermission,
  getPermissionServiceForPath,
  getRequiredPermissionLevel,
  getServiceDefinition,
  isPermissionService,
  normalizeServicePermissions,
} from '@/lib/security/rbac';

describe('resources RBAC service', () => {
  it('maps /api/resources and its children to the resources service', () => {
    expect(getPermissionServiceForPath('/api/resources')).toBe('resources');
    expect(getPermissionServiceForPath('/api/resources/')).toBe('resources');
    expect(getPermissionServiceForPath('/api/resources/agent/abc')).toBe('resources');
    // a similarly-named prefix must not be swallowed
    expect(getPermissionServiceForPath('/api/resourcesx')).toBeNull();
  });

  it('is a recognised, labelled admin service', () => {
    expect(isPermissionService('resources')).toBe(true);
    const def = getServiceDefinition('resources');
    expect(def.id).toBe('resources');
    expect(def.adminService).toBe(true);
    expect(def.label).toBeTruthy();
    expect(def.description).toBeTruthy();
    expect(def.category).toBe('admin');
    expect(RBAC_SERVICE_DEFINITIONS.filter((d) => d.id === 'resources')).toHaveLength(1);
    // survives normalisation (otherwise a stored grant would be silently dropped)
    expect(normalizeServicePermissions({ resources: 'read' })).toEqual({ resources: 'read' });
  });

  it('GET requires read', () => {
    expect(getRequiredPermissionLevel('GET', 'resources')).toBe('read');
  });

  it('defaults: owner/admin -> admin, project_admin/user -> none', () => {
    expect(getEffectiveServicePermission({ role: 'owner' }, 'resources')).toBe('admin');
    expect(getEffectiveServicePermission({ role: 'admin' }, 'resources')).toBe('admin');
    expect(getEffectiveServicePermission({ role: 'project_admin' }, 'resources')).toBe('none');
    expect(getEffectiveServicePermission({ role: 'user' }, 'resources')).toBe('none');
  });

  it('authorizes by default only for owner/admin, or with an explicit grant', () => {
    expect(authorizeServiceRequest({ role: 'admin' }, 'GET', '/api/resources').allowed).toBe(true);
    expect(authorizeServiceRequest({ role: 'user' }, 'GET', '/api/resources').allowed).toBe(false);
    expect(
      authorizeServiceRequest({ role: 'user', servicePermissions: { resources: 'read' } }, 'GET', '/api/resources/agent/1').allowed,
    ).toBe(true);
  });
});

describe('/api/prompt-optimizer RBAC mapping (previously unmapped = no authorization)', () => {
  it('maps the prompt optimizer routes to the prompts service', () => {
    expect(getPermissionServiceForPath('/api/prompt-optimizer')).toBe('prompts');
    expect(getPermissionServiceForPath('/api/prompt-optimizer/opt-1/run')).toBe('prompts');
  });
});

describe('/api/skills RBAC mapping (previously unmapped = no authorization)', () => {
  it('maps the skills list and item routes to the agents service', () => {
    expect(getPermissionServiceForPath('/api/skills')).toBe('agents');
    expect(getPermissionServiceForPath('/api/skills/skill-1')).toBe('agents');
  });

  it('denies a caller with agents:none and requires write for mutations', () => {
    const none = { role: 'user', servicePermissions: { agents: 'none' as const } };
    expect(authorizeServiceRequest(none, 'GET', '/api/skills').allowed).toBe(false);
    const reader = { role: 'user', servicePermissions: { agents: 'read' as const } };
    expect(authorizeServiceRequest(reader, 'GET', '/api/skills').allowed).toBe(true);
    expect(authorizeServiceRequest(reader, 'POST', '/api/skills').allowed).toBe(false);
    expect(authorizeServiceRequest(reader, 'DELETE', '/api/skills/skill-1').allowed).toBe(false);
  });
});
