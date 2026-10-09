import { afterEach, describe, expect, it } from 'vitest';
import {
  RBAC_SERVICE_DEFINITIONS,
  authorizeServiceRequest,
  getEffectiveServicePermission,
  getPermissionServiceForPath,
  getRequiredPermissionLevel,
  getServiceDefinition,
  isPermissionService,
  normalizeServicePermissions,
  registerPathServiceResolver,
  resetPathServiceResolversForTests,
} from '@/lib/security/rbac';
import { canonicalizeRequestPathname } from '@/lib/security/requestPath';
import { registerResourceUsageAccess } from '@/lib/resources/usageAccess';

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

describe('path service resolvers', () => {
  const prefix = '/api/zz-resolver-test/';

  afterEach(() => {
    resetPathServiceResolversForTests();
    // the production resolver lives in the resources module; restore it for other tests in this file
    registerResourceUsageAccess();
  });

  it('consults a registered resolver for the prefix and its children', () => {
    registerPathServiceResolver(prefix, (pathname) => (pathname.endsWith('/a') ? 'tools' : 'agents'));
    expect(getPermissionServiceForPath('/api/zz-resolver-test/x/a')).toBe('tools');
    expect(getPermissionServiceForPath('/api/zz-resolver-test/x/b')).toBe('agents');
    expect(getPermissionServiceForPath('/api/zz-resolver-test/x/b/')).toBe('agents');
    // similarly named prefix is not swallowed
    expect(getPermissionServiceForPath('/api/zz-resolver-testx/x')).toBeNull();
  });

  it('falls through to the static map when the resolver returns null or throws', () => {
    registerPathServiceResolver('/api/models/', () => null);
    expect(getPermissionServiceForPath('/api/models/abc')).toBe('models');
    registerPathServiceResolver('/api/models/', () => {
      throw new Error('boom');
    });
    expect(getPermissionServiceForPath('/api/models/abc')).toBe('models');
  });

  it('registering the same prefix again replaces the resolver', () => {
    registerPathServiceResolver(prefix, () => 'tools');
    registerPathServiceResolver(prefix, () => 'agents');
    expect(getPermissionServiceForPath('/api/zz-resolver-test/x')).toBe('agents');
  });
});

describe('/api/resource-usage RBAC', () => {
  it('is gated by the service that owns the type, admin-only for unknown types', () => {
    registerResourceUsageAccess();
    expect(getPermissionServiceForPath('/api/resource-usage/tool/t1')).toBe('tools');
    expect(getPermissionServiceForPath('/api/resource-usage/agent/a1')).toBe('agents');
    expect(getPermissionServiceForPath('/api/resource-usage/model/m1')).toBe('models');
    expect(getPermissionServiceForPath('/api/resource-usage/not-a-type/x')).toBe('resources');
    expect(getPermissionServiceForPath('/api/resource-usage')).toBe('resources');
    expect(getPermissionServiceForPath('/api/resource-usage/%E0%A4%A/x')).toBe('resources');
  });

  it('keeps the route gated even when no resolver was registered (static default)', () => {
    resetPathServiceResolversForTests();
    expect(getPermissionServiceForPath('/api/resource-usage/tool/t1')).toBe('resources');
    registerResourceUsageAccess();
  });

  it('GET needs read on the type\'s service', () => {
    registerResourceUsageAccess();
    const noTools = { role: 'user', servicePermissions: { tools: 'none' as const } };
    expect(authorizeServiceRequest(noTools, 'GET', '/api/resource-usage/tool/t1').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'user' }, 'GET', '/api/resource-usage/tool/t1').allowed).toBe(true);
    expect(authorizeServiceRequest({ role: 'user' }, 'GET', '/api/resource-usage/bogus/x').allowed).toBe(false);
    expect(authorizeServiceRequest({ role: 'admin' }, 'GET', '/api/resource-usage/bogus/x').allowed).toBe(true);
  });
});

describe('canonicalizeRequestPathname', () => {
  afterEach(() => {
    resetPathServiceResolversForTests();
    registerResourceUsageAccess();
  });

  it('decodes unreserved escapes the way the router does, keeps reserved ones encoded', () => {
    expect(canonicalizeRequestPathname('/api/resource%2Dusage/to%6Fl/1?x=1')).toBe('/api/resource-usage/tool/1');
    expect(canonicalizeRequestPathname('/api/a%2Fb')).toBe('/api/a%2Fb');
    expect(canonicalizeRequestPathname('/api//resource-usage///tool/1')).toBe('/api/resource-usage/tool/1');
    expect(canonicalizeRequestPathname('/api/%E0%A4%A')).toBe('/api/%E0%A4%A');
    expect(canonicalizeRequestPathname(undefined)).toBe('/');
  });

  it('an escaped spelling maps to the same service as the plain one', () => {
    registerResourceUsageAccess();
    expect(getPermissionServiceForPath(canonicalizeRequestPathname('/api/resource%2Dusage/to%6Fl/1'))).toBe('tools');
    expect(getPermissionServiceForPath(canonicalizeRequestPathname('/api/resource%2Dusage/b%6Fgus/1'))).toBe('resources');
    expect(getPermissionServiceForPath(canonicalizeRequestPathname('/api/resourc%65s'))).toBe('resources');
    // the raw spelling is NOT mapped: this is the hole the canonical form closes
    expect(getPermissionServiceForPath('/api/resource%2Dusage/tool/1')).toBeNull();
  });
});
