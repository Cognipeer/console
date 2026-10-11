/**
 * Service levels add up in an ALLOW rule: Admin includes Write and Read, Write includes Read.
 *
 * Cedar treats `webhooks.read`, `webhooks.write` and `webhooks.admin` as three unrelated actions, so a permit that
 * names only `webhooks.admin` used to let a person administer the service and still not read it (the gate asks
 * `webhooks.read` for a GET): the effective level - which counts a level only when every lower one is allowed - came
 * out as none. The policy compiler now adds the lower levels to every allow rule; a deny rule keeps naming exactly
 * what it blocks; raw Cedar is warned instead (it is the author's literal statement).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { impliedLevelActionIds } from '@/lib/iam/actions';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { probeServiceLevel, resetEffectiveLevelsForTests } from '@/lib/iam/effective';
import { userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import {
  compileSpec,
  compileSpecToCedar,
  currentCatalogView,
  parsePolicySpec,
  withImpliedLevels,
  type PolicySpec,
} from '@/lib/iam/policySpec';
import { validateCustomPolicyText } from '@/lib/iam/policyText';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import type { UserServicePermissions } from '@/lib/security/rbac';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

beforeAll(async () => {
  env = await createIamTestDb('tenant_level_semantics');
  hoisted.getDatabase.mockResolvedValue(env.db);
});
afterAll(async () => {
  configureIamEngine({ validateRequests: false });
  await env.cleanup();
});
beforeEach(async () => {
  configureIamEngine({ validateRequests: false, versionCheckMs: 5_000 });
  for (const p of await listPolicies(tenant())) await deletePolicy(tenant(), p.policyId);
  resetIamEngineForTests();
  resetEffectiveLevelsForTests();
});

const user = (role: string, servicePermissions?: UserServicePermissions): IamPrincipal =>
  userPrincipal({ userId: `u-${role}`, user: { role, servicePermissions }, groupGrants: [] });

const view = currentCatalogView();
const base = (over: Partial<PolicySpec>): unknown => ({
  effect: 'permit',
  principals: { anyUser: true },
  actions: ['webhooks.admin'],
  resources: { any: true },
  ...over,
});
const parsed = (over: Partial<PolicySpec>) => {
  const out = parsePolicySpec(base(over), view);
  if (!out.ok) throw new Error(JSON.stringify(out.errors));
  return out.spec;
};

/** Saves a rule the way the Policies screen does: compile the spec, store its Cedar next to it. */
async function saveSpec(policyId: string, over: Partial<PolicySpec>): Promise<void> {
  const out = await compileSpec(base(over), undefined, view);
  expect(out.ok, JSON.stringify(out.errors)).toBe(true);
  await createPolicy(tenant(), { policyId, name: policyId, cedar: out.cedar, spec: out.spec }, 't');
  resetEffectiveLevelsForTests();
}

describe('the levels an action includes', () => {
  const def = (id: string) => view.actions.get(id)!;

  it('Admin includes Write and Read, Write includes Read, Read includes nothing - for the groups and for every service', () => {
    expect(impliedLevelActionIds(def('Admin'))).toEqual(['Write', 'Read']);
    expect(impliedLevelActionIds(def('Write'))).toEqual(['Read']);
    expect(impliedLevelActionIds(def('Read'))).toEqual([]);
    expect(impliedLevelActionIds(def('webhooks.admin'))).toEqual(['webhooks.write', 'webhooks.read']);
    expect(impliedLevelActionIds(def('webhooks.write'))).toEqual(['webhooks.read']);
    expect(impliedLevelActionIds(def('webhooks.read'))).toEqual([]);
  });

  it('a verb about one resource has no level above or below it to add', () => {
    for (const id of ['agent.approve', 'agent.session_manage_others', 'agent.invoke', 'agent.delete', 'portal.use']) {
      expect(impliedLevelActionIds(def(id)), id).toEqual([]);
    }
  });
});

describe('an allow rule adds the lower levels', () => {
  it('naming only <service>.admin also names its write and read, after the one the author chose', () => {
    expect(parsed({ actions: ['webhooks.admin'] }).actions).toEqual(['webhooks.admin', 'webhooks.write', 'webhooks.read']);
    expect(parsed({ actions: ['webhooks.write'] }).actions).toEqual(['webhooks.write', 'webhooks.read']);
    expect(parsed({ actions: ['webhooks.read'] }).actions).toEqual(['webhooks.read']);
  });

  it('the level groups add up the same way, and the order of what was chosen is kept', () => {
    expect(parsed({ actions: ['Admin'] }).actions).toEqual(['Admin', 'Write', 'Read']);
    expect(parsed({ actions: ['agents.admin', 'models.read', 'Write'] }).actions)
      .toEqual(['agents.admin', 'models.read', 'Write', 'agents.write', 'agents.read', 'Read']);
  });

  it('adds each level once, is idempotent, and leaves verbs about one resource alone', () => {
    const once = withImpliedLevels(['webhooks.admin', 'webhooks.read'], view);
    expect(once).toEqual(['webhooks.admin', 'webhooks.read', 'webhooks.write']);
    expect(withImpliedLevels(once, view)).toEqual(once);
    expect(parsed({ actions: ['agent.approve', 'agent.session_view_others'] }).actions).toEqual(['agent.approve', 'agent.session_view_others']);
  });

  it('the Cedar it compiles to names all of them', () => {
    const cedar = compileSpecToCedar(parsed({ actions: ['webhooks.admin'] }), view);
    expect(cedar).toContain('action in [Action::"webhooks.admin", Action::"webhooks.write", Action::"webhooks.read"]');
  });

  it('a deny rule blocks exactly what it names: nothing is added', () => {
    expect(parsed({ effect: 'forbid', actions: ['webhooks.admin'] }).actions).toEqual(['webhooks.admin']);
    expect(parsed({ effect: 'forbid', actions: ['Write'] }).actions).toEqual(['Write']);
    expect(compileSpecToCedar(parsed({ effect: 'forbid', actions: ['Admin'] }), view)).toContain('action in Action::"Admin"');
  });

  it('reads back as it was stored: a stored rule compares equal to itself once normalised', () => {
    const stored = parsed({ actions: ['webhooks.admin'] });
    const again = parsePolicySpec(stored, view);
    expect(again.ok && again.spec).toEqual(stored);
  });
});

describe('what the engine does with it (a person with no say over webhooks)', () => {
  // The role `user` holds Write on ordinary services and nothing on administration services such as webhooks.
  const person = () => user('user');

  it('is the starting point: no access to webhooks at all', async () => {
    expect((await probeServiceLevel(tenant(), person(), 'webhooks', {})).level).toBe('none');
  });

  it('a permit that names only webhooks.admin makes the person an administrator of webhooks - they can read, change and administer', async () => {
    await saveSpec('only-admin', { principals: { anyUser: true }, actions: ['webhooks.admin'], resources: { services: ['webhooks'] } });
    const probed = await probeServiceLevel(tenant(), person(), 'webhooks', {});
    expect(probed.level).toBe('admin');
    // not a single service more than the rule's own
    expect((await probeServiceLevel(tenant(), person(), 'members', {})).level).toBe('none');
    expect((await probeServiceLevel(tenant(), person(), 'agents', {})).level).toBe('write');
  });

  it('the same rule written as raw Cedar - exactly what it names - does not: that is why the editor adds the levels', async () => {
    await createPolicy(tenant(), {
      policyId: 'raw-admin', name: 'raw',
      cedar: 'permit(principal is User, action == Action::"webhooks.admin", resource is Service);',
    }, 't');
    expect((await probeServiceLevel(tenant(), person(), 'webhooks', {})).level).toBe('none');
  });

  it('a permit that names only <service>.write also lets the person read', async () => {
    await saveSpec('only-write', { actions: ['webhooks.write'], resources: { services: ['webhooks'] } });
    expect((await probeServiceLevel(tenant(), person(), 'webhooks', {})).level).toBe('write');
  });

  it('a permit of the Admin level group on one service adds up the same way, on that service only', async () => {
    await saveSpec('admin-group', { actions: ['Admin'], resources: { services: ['webhooks'] } });
    expect((await probeServiceLevel(tenant(), person(), 'webhooks', {})).level).toBe('admin');
    expect((await probeServiceLevel(tenant(), person(), 'sso', {})).level).toBe('none');
  });

  it('a deny of webhooks.admin stops administering and nothing else: the person still reads and changes', async () => {
    await saveSpec('no-admin', { effect: 'forbid', actions: ['webhooks.admin'], resources: { services: ['webhooks'] } });
    const administrator = user('admin');
    expect((await probeServiceLevel(tenant(), administrator, 'webhooks', {})).level).toBe('write');
  });

  it('a deny of Read still wins over an allow that adds it: a person cannot be allowed past a deny', async () => {
    await saveSpec('only-admin', { actions: ['webhooks.admin'], resources: { services: ['webhooks'] } });
    await saveSpec('no-read', { effect: 'forbid', actions: ['webhooks.read'], resources: { services: ['webhooks'] } });
    expect((await probeServiceLevel(tenant(), person(), 'webhooks', {})).level).toBe('none');
  });
});

describe('raw Cedar is the author\'s literal statement, so it is warned about, not changed', () => {
  const warnings = (cedar: string) => validateCustomPolicyText(cedar).warnings.map((w) => w.message);

  it('a permit that names a level without the lower ones says that levels do not add up in text', () => {
    const [message] = warnings('permit(principal is User, action == Action::"webhooks.admin", resource is Service);')
      .filter((m) => /do not add up/.test(m));
    expect(message).toMatch(/names webhooks\.admin but not webhooks\.write, webhooks\.read/);
    expect(message).toMatch(/guided editor, which adds them/);
    expect(warnings('permit(principal is User, action in Action::"Write", resource);').join(' ')).toMatch(/names Write but not Read/);
  });

  it('says nothing once the lower levels are listed, for a deny rule, or for a verb about one resource', () => {
    const quiet = (cedar: string) => expect(warnings(cedar).filter((m) => /do not add up/.test(m)), cedar).toEqual([]);
    quiet('permit(principal is User, action in [Action::"webhooks.admin", Action::"webhooks.write", Action::"webhooks.read"], resource is Service);');
    quiet('permit(principal is User, action in [Action::"Admin", Action::"Write", Action::"Read"], resource);');
    quiet('permit(principal is User, action == Action::"webhooks.read", resource is Service);');
    quiet('forbid(principal is User, action == Action::"webhooks.admin", resource is Service);');
    quiet('forbid(principal, action in Action::"Write", resource);');
  });

  it('a rule built in the guided editor never gets it (the compiler already added the levels)', async () => {
    const out = await compileSpec(base({ actions: ['webhooks.admin'], resources: { services: ['webhooks'] } }), undefined, view);
    expect(out.ok).toBe(true);
    expect(out.warnings.map((w) => w.message).filter((m) => /do not add up/.test(m))).toEqual([]);
  });
});
