/**
 * Rules about actions nothing in the product asks for.
 *
 * The request gates ask one question - may this principal do `<service>.read` or
 * `<service>.write` here? - plus the few handler-level checks and the levels some
 * routes declare for themselves. The catalog also lists `<service>.admin` for
 * every service, so a rule about it is easy to write and can never apply. The
 * policy compiler says so (never refuses: what counts as "asked" is read from the
 * routes the server registered, and is unknown before they are).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askedGateActions, registerGateAction } from '@/lib/iam/gateActions';
import { authz } from '@/lib/iam/routeAuthz';
import { recordRegisteredRoute, resetRouteRegistryForTests } from '@/lib/iam/routeRegistry';
import {
  compileSpec,
  currentCatalogView,
  gateReach,
  parsePolicySpec,
  unaskedWarnings,
  type PolicySpec,
} from '@/lib/iam/policySpec';
import { validateCustomPolicyText } from '@/lib/iam/policyText';

// The first compile of a file builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const spec = (over: Partial<PolicySpec> = {}): PolicySpec => {
  const parsed = parsePolicySpec({ effect: 'forbid', principals: { any: true }, actions: ['models.write'], resources: { any: true }, ...over });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.spec;
};
const reach = (s: PolicySpec) => gateReach(s, currentCatalogView());
const codes = (issues: Array<{ code?: string }>) => issues.map((i) => i.code).filter(Boolean);

/** A product that checks Read and Write on `models` and `agents`, Write (with Admin on top) on `members`, and Admin on `providers` by declaration. */
function registerRoutes(): void {
  recordRegisteredRoute('GET', '/api/zz/models', authz.service('models'));
  recordRegisteredRoute(['POST', 'PUT'], '/api/zz/models/:id', authz.service('models'));
  recordRegisteredRoute('GET', '/api/zz/agents', authz.service('agents'));
  recordRegisteredRoute('POST', '/api/zz/agents', authz.service('agents'));
  recordRegisteredRoute('GET', '/api/zz/members', authz.service('members'));
  recordRegisteredRoute('POST', '/api/zz/members', authz.service('members'));
  recordRegisteredRoute('POST', '/api/zz/providers/rotate', authz.service('providers', 'admin'));
  recordRegisteredRoute('GET', '/api/zz/open', authz.public());
}

beforeEach(() => {
  resetRouteRegistryForTests();
});

describe('which actions are asked', () => {
  it('is unknown, not "nothing", before any route is registered (a unit test that never booted the API)', () => {
    expect(askedGateActions()).toBeNull();
    expect(reach(spec({ actions: ['models.admin'] })).unasked).toEqual([]);
    expect(unaskedWarnings(spec({ actions: ['models.admin'] }), reach(spec({ actions: ['models.admin'] })))).toEqual([]);
  });

  it('is read from the registered routes: the level their method implies, or the one they declare', () => {
    registerRoutes();
    const asked = askedGateActions()!;
    for (const id of ['models.read', 'models.write', 'agents.read', 'agents.write', 'members.read', 'members.write', 'providers.admin']) {
      expect(asked.has(id), id).toBe(true);
    }
    for (const id of ['models.admin', 'agents.admin', 'members.admin', 'providers.read', 'providers.write', 'config.read']) {
      expect(asked.has(id), id).toBe(false);
    }
  });

  it('a route that is not gated by a service asks for nothing', () => {
    recordRegisteredRoute('GET', '/api/zz/open', authz.public());
    recordRegisteredRoute('GET', '/api/zz/anyone', authz.authenticated());
    recordRegisteredRoute('GET', '/api/zz/self', authz.self('verifies its own token'));
    // only service routes count; nothing was registered that is gated, so there is still nothing to judge by
    expect(askedGateActions()).toBeNull();
  });

  it('a route that no declaration covers but a prefix maps asks for its service', () => {
    recordRegisteredRoute('GET', '/api/agents/:id', undefined);
    recordRegisteredRoute('DELETE', '/api/agents/:id', undefined);
    const asked = askedGateActions()!;
    expect(asked.has('agents.read')).toBe(true);
    expect(asked.has('agents.write')).toBe(true);
  });

  it('includes the handler-level checks: admin on mcp is asked by the handlers, and a handler can register its own', () => {
    registerRoutes();
    expect(askedGateActions()!.has('mcp.admin')).toBe(true);
    // (registrations last for the life of the process; `ocr` is not used by the other tests of this file)
    expect(askedGateActions()!.has('ocr.admin')).toBe(false);
    registerGateAction('ocr', 'admin');
    expect(askedGateActions()!.has('ocr.admin')).toBe(true);
  });
});

describe('what a spec reaches', () => {
  beforeEach(registerRoutes);

  it('names the service-level actions nothing asks for', () => {
    expect(reach(spec({ actions: ['models.admin'] })).unasked).toEqual(['models.admin']);
    expect(reach(spec({ actions: ['models.write'] })).unasked).toEqual([]);
    expect(reach(spec({ actions: ['models.write', 'models.admin', 'agents.admin'] })).unasked).toEqual(['models.admin', 'agents.admin']);
    expect(reach(spec({ actions: ['members.admin'] })).unasked).toEqual(['members.admin']); // changes to it are checked as Write
  });

  it('a level group is asked wherever one of its services is asked at that level', () => {
    expect(reach(spec({ actions: ['Read'] })).unasked).toEqual([]);
    expect(reach(spec({ actions: ['Write'] })).unasked).toEqual([]);
    // Admin is asked by the providers route and by the mcp handler, so the group as a whole is reachable ...
    expect(reach(spec({ actions: ['Admin'] })).unasked).toEqual([]);
    // ... but not on a service nothing asks Admin of
    expect(reach(spec({ actions: ['Admin'], resources: { services: ['models', 'agents'] } })).unasked).toEqual(['Admin on models, agents']);
    expect(reach(spec({ actions: ['Admin'], resources: { services: ['models', 'providers'] } })).unasked).toEqual([]);
    expect(reach(spec({ actions: ['Admin'], resources: { services: ['models', 'agents', 'tools', 'prompts'] } })).unasked).toEqual(['Admin on models, agents, tools, ...']);
  });

  it('resource-level actions are not part of this (the gates do not check them at all - another warning says so)', () => {
    expect(reach(spec({ actions: ['agent.delete'] })).unasked).toEqual([]);
  });
});

describe('unaskedWarnings', () => {
  beforeEach(registerRoutes);
  const warn = (s: PolicySpec) => unaskedWarnings(s, reach(s));

  it('a deny rule that names only unasked actions would never block anything', () => {
    const [forbid] = warn(spec({ effect: 'forbid', actions: ['models.admin'] }));
    expect(forbid).toMatchObject({ code: 'not_asked_actions', field: 'actions', params: { actions: 'models.admin', effect: 'forbid' } });
    expect(forbid.message).toMatch(/Nothing in the product checks models\.admin yet, so this rule would never block anything/);
    expect(forbid.message).toMatch(/choose Read or Write/);
  });

  it('an allow rule that names only an Admin level is not dead weight: levels add up, so it grants what Write and Read grant', () => {
    // (parsePolicySpec adds the lower levels to every allow rule)
    const admin = spec({ effect: 'permit', actions: ['agents.admin', 'models.admin'] });
    expect(admin.actions).toEqual(['agents.admin', 'models.admin', 'agents.write', 'agents.read', 'models.write', 'models.read']);
    expect(reach(admin).unasked).toEqual([]);
    expect(warn(admin)).toEqual([]);
    // ... but written without them (a stored rule, or one built by hand) the Admin entries are still judged on their own
    const bare = { ...admin, actions: ['agents.admin', 'models.admin'] };
    expect(warn(bare)[0]).toMatchObject({ code: 'not_asked_actions', params: { actions: 'agents.admin, models.admin', effect: 'permit' } });
  });

  it('a rule that names some unasked actions among asked ones is only partly effective', () => {
    const [partly] = warn(spec({ actions: ['models.write', 'models.admin'] }));
    expect(partly).toMatchObject({ code: 'partly_not_asked_actions', field: 'actions', params: { actions: 'models.admin' } });
    expect(partly.message).toMatch(/those actions of this rule have no effect\. The other actions still apply/);
  });

  it('says nothing about a rule whose every action is asked', () => {
    expect(warn(spec({ actions: ['models.write'] }))).toEqual([]);
    expect(warn(spec({ actions: ['Read', 'Write'] }))).toEqual([]);
    expect(warn(spec({ actions: ['providers.admin'] }))).toEqual([]);
  });

  it('a forbid on <administration service>.admin is left to the "checked as Write" explanation instead', () => {
    expect(warn(spec({ effect: 'forbid', actions: ['members.admin'] }))).toEqual([]);
    // a permit of it grants what its lower levels grant (levels add up), so there is nothing to warn about
    expect(warn(spec({ effect: 'permit', actions: ['members.admin'] }))).toEqual([]);
    // mixed with another unasked action, only the other one is named
    expect(warn(spec({ effect: 'forbid', actions: ['members.admin', 'models.admin'] }))[0]).toMatchObject({ params: { actions: 'models.admin' } });
  });

  it('lists at most six names and says there are more', () => {
    const [warning] = warn(spec({
      actions: ['models.admin', 'agents.admin', 'prompts.admin', 'tools.admin', 'vector.admin', 'memory.admin', 'files.admin', 'rag.admin'],
    }));
    expect(String(warning.params?.actions).split(', ')).toHaveLength(7);
    expect(String(warning.params?.actions)).toMatch(/, \.\.\.$/);
  });
});

describe('the compiler', () => {
  beforeEach(registerRoutes);

  it('warns, never refuses: the rule compiles and can be saved', async () => {
    const out = await compileSpec(spec({ actions: ['models.admin'] }));
    expect(out.ok).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.cedar).toContain('Action::"models.admin"');
    expect(codes(out.warnings)).toContain('not_asked_actions');
    expect(out.warnings.find((w) => w.code === 'not_asked_actions')?.message).toMatch(/models\.admin/);
  });

  it('a partly effective rule gets the other warning', async () => {
    const out = await compileSpec(spec({ actions: ['agents.write', 'agents.admin'] }));
    expect(out.ok).toBe(true);
    expect(codes(out.warnings)).toContain('partly_not_asked_actions');
    expect(codes(out.warnings)).not.toContain('not_asked_actions');
  });

  it('a rule about asked actions has neither', async () => {
    const out = await compileSpec(spec({ actions: ['models.read', 'models.write'] }));
    expect(codes(out.warnings)).not.toContain('not_asked_actions');
    expect(codes(out.warnings)).not.toContain('partly_not_asked_actions');
  });

  it('before any route is registered the compiler has nothing to judge by and stays quiet', async () => {
    resetRouteRegistryForTests();
    const out = await compileSpec(spec({ actions: ['models.admin'] }));
    expect(out.ok).toBe(true);
    expect(codes(out.warnings)).not.toContain('not_asked_actions');
  });
});

describe('raw Cedar', () => {
  beforeEach(registerRoutes);
  const check = (cedar: string) => validateCustomPolicyText(cedar);

  it('a statement that names only unasked service actions is valid, with a warning that says so', () => {
    const result = check('forbid(principal, action == Action::"models.admin", resource is Service);');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.message)).toEqual([
      'This forbid statement only names actions that nothing in the product checks yet (models.admin), so it would never block anything.',
    ]);
    const permit = check('permit(principal is User, action in [Action::"models.admin", Action::"agents.admin"], resource is Service);');
    expect(permit.valid).toBe(true);
    expect(permit.warnings[0].message).toMatch(/This permit statement only names actions that nothing in the product checks yet \(models\.admin, agents\.admin\), so it would never grant anything\./);
  });

  it('a statement that names at least one asked action gets no such warning', () => {
    const result = check('forbid(principal, action in [Action::"models.write", Action::"models.admin"], resource is Service);');
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(check('forbid(principal, action in Action::"Write", resource is Service);').warnings).toEqual([]);
  });

  it('names the statement when there are several', () => {
    const result = check([
      'forbid(principal, action == Action::"models.write", resource is Service);',
      'forbid(principal, action == Action::"agents.admin", resource is Service);',
    ].join('\n'));
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toMatch(/\(statement 2\)$/);
    expect(result.warnings[0].policyId).toBe('candidate#1');
  });

  it('a statement about individual resources keeps its own, stronger treatment (a forbid is refused)', () => {
    const forbid = check('forbid(principal, action == Action::"agent.delete", resource is Agent);');
    expect(forbid.valid).toBe(false);
    expect(forbid.errors[0].message).toMatch(/would never block anything/);
    expect(check('permit(principal, action == Action::"agent.delete", resource is Agent);').valid).toBe(true);
  });

  it('before any route is registered there is no judgement', () => {
    resetRouteRegistryForTests();
    expect(check('forbid(principal, action == Action::"models.admin", resource is Service);').warnings).toEqual([]);
  });
});
