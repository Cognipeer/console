/**
 * Effective levels (src/lib/iam/effective.ts): what a principal can do with each
 * service, as the engine decides it.
 *
 * A workspace without custom policies is answered straight from the principal's
 * level sets (`managedLevel`), which must be the very answer the engine gives;
 * a workspace with custom policies is probed through the engine, one decision per
 * level and service, and memoised for a few seconds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
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

import { configureIamEngine, getIamEngineStats, resetIamEngineForTests } from '@/lib/iam/engine';
import {
  EFFECTIVE_SERVICES,
  computeEffectiveLevels,
  managedLevel,
  probeServiceLevel,
  resetEffectiveLevelsForTests,
  type EffectiveLevel,
} from '@/lib/iam/effective';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { createPolicy, deletePolicy, listPolicies, updatePolicy } from '@/lib/iam/store';
import {
  RBAC_SERVICE_DEFINITIONS,
  type GroupTenantGrant,
  type PermissionService,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { createIamTestDb, mulberry32, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

beforeAll(async () => {
  env = await createIamTestDb('tenant_effective');
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

const user = (role: string, servicePermissions?: UserServicePermissions, groupGrants: GroupTenantGrant[] = []): IamPrincipal =>
  userPrincipal({ userId: `u-${role}`, user: { role, servicePermissions }, groupGrants });

const ADMIN_SERVICES = RBAC_SERVICE_DEFINITIONS.filter((d) => d.adminService && !d.deprecated).map((d) => d.id);

describe('the services a level is reported for', () => {
  it('are all but the retired ones', () => {
    expect(EFFECTIVE_SERVICES).toEqual(RBAC_SERVICE_DEFINITIONS.filter((d) => !d.deprecated).map((d) => d.id));
    expect(EFFECTIVE_SERVICES).not.toContain('aegis');
    expect(EFFECTIVE_SERVICES).toContain('iam');
  });
});

describe('managedLevel (no custom policy in force)', () => {
  it('an owner is admin everywhere, whatever their permission map says', () => {
    const owner = user('owner', { agents: 'none', members: 'read' });
    for (const service of EFFECTIVE_SERVICES) expect(managedLevel(owner, service), service).toBe('admin');
  });

  it('role defaults: an admin is admin, a user writes ordinary services and reads nothing of the administration ones', () => {
    for (const service of EFFECTIVE_SERVICES) expect(managedLevel(user('admin'), service)).toBe('admin');
    expect(managedLevel(user('user'), 'agents')).toBe('write');
    expect(managedLevel(user('user'), 'members')).toBe('none');
    expect(managedLevel(user('project_admin'), 'models')).toBe('write');
  });

  it('an explicit setting lowers or sets the level; a group only ever raises it', () => {
    expect(managedLevel(user('admin', { agents: 'read' }), 'agents')).toBe('read');
    expect(managedLevel(user('user', { agents: 'none' }), 'agents')).toBe('none');
    expect(managedLevel(user('user', { agents: 'none' }, [{ tenantRole: 'user' }]), 'agents')).toBe('write');
    expect(managedLevel(user('admin', { agents: 'read' }, [{ tenantRole: 'user' }]), 'agents')).toBe('write');
    expect(managedLevel(user('user', { models: 'read' }, [{ servicePermissions: { models: 'none' } }]), 'models')).toBe('read');
  });

  it('an administration service never reports Write: a change there needs Admin, so it is read or admin', () => {
    for (const service of ADMIN_SERVICES) {
      expect(managedLevel(user('user', { [service]: 'write' } as UserServicePermissions), service), service).toBe('read');
      expect(managedLevel(user('user', { [service]: 'admin' } as UserServicePermissions), service), service).toBe('admin');
      expect(managedLevel(user('user', { [service]: 'read' } as UserServicePermissions), service), service).toBe('read');
    }
  });

  it('a token is capped by its scope: unscoped inherits, an empty scope reads nothing, an absent service is none', () => {
    const owner = user('admin');
    const token = (scope: UserServicePermissions | null) => tokenPrincipal({ tokenId: 't', owner, scope });
    expect(managedLevel(token(null), 'agents')).toBe('admin');
    expect(managedLevel(token({}), 'agents')).toBe('none');
    expect(managedLevel(token({ models: 'admin' }), 'agents')).toBe('none');
    expect(managedLevel(token({ agents: 'read' }), 'agents')).toBe('read');
    expect(managedLevel(token({ agents: 'write' }), 'agents')).toBe('write');
    // a scope cannot widen a weak owner
    expect(managedLevel(tokenPrincipal({ tokenId: 't', owner: user('user', { agents: 'read' }), scope: { agents: 'admin' } }), 'agents')).toBe('read');
    // adminService: a write-capped token cannot change members, an admin-capped one can
    expect(managedLevel(token({ members: 'write' }), 'members')).toBe('read');
    expect(managedLevel(token({ members: 'admin' }), 'members')).toBe('admin');
  });

  it('is exactly what the engine says, for random users, groups and token scopes (every service, every level)', async () => {
    const seed = process.env.IAM_FUZZ_SEED ? Number(process.env.IAM_FUZZ_SEED) : (Date.now() & 0x7fffffff);
    const rnd = mulberry32(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
    const grades: ServicePermissionLevel[] = ['none', 'read', 'write', 'admin'];
    const randomPerms = (): UserServicePermissions =>
      Object.fromEntries(EFFECTIVE_SERVICES.filter(() => rnd() < 0.25).map((s) => [s, pick(grades)])) as UserServicePermissions;

    const mismatches: string[] = [];
    for (let i = 0; i < 120; i++) {
      const grants: GroupTenantGrant[] = Array.from({ length: Math.floor(rnd() * 3) }, () => ({
        ...(rnd() < 0.5 ? { tenantRole: pick(['user', 'admin', 'project_admin'] as const) } : {}),
        ...(rnd() < 0.5 ? { servicePermissions: randomPerms() } : {}),
      }));
      const owner = userPrincipal({
        userId: `fz-${i}`, user: { role: pick(['owner', 'admin', 'user', 'project_admin', undefined, 'weird']) as string | undefined, servicePermissions: rnd() < 0.7 ? randomPerms() : undefined }, groupGrants: grants,
      });
      const principal = rnd() < 0.5 ? owner : tokenPrincipal({ tokenId: `fz-t-${i}`, owner, scope: rnd() < 0.3 ? null : rnd() < 0.15 ? {} : randomPerms() });
      for (const service of EFFECTIVE_SERVICES) {
        const probed = (await probeServiceLevel(tenant(), principal, service, {})).level;
        const direct = managedLevel(principal, service);
        if (probed !== direct) mismatches.push(`${service}: engine ${probed}, managedLevel ${direct} for ${JSON.stringify({ role: principal.role, token: principal.token?.scoped })}`);
      }
    }
    expect(mismatches.slice(0, 5), `seed ${seed}`).toEqual([]);
  }, 120_000);
});

describe('probeServiceLevel', () => {
  it('walks Read, Write, Admin and stops at the first level the engine refuses', async () => {
    const admin = user('admin');
    const probed = await probeServiceLevel(tenant(), admin, 'agents', {});
    expect(probed.level).toBe('admin');
    expect(probed.reasons.length).toBeGreaterThanOrEqual(3);

    const reader = await probeServiceLevel(tenant(), user('user', { agents: 'read' }), 'agents', {});
    expect(reader.level).toBe('read');
    expect((await probeServiceLevel(tenant(), user('user', { agents: 'none' }), 'agents', {})).level).toBe('none');
  });

  it('a level above a refused one is never reported, however much a policy grants there', async () => {
    await createPolicy(tenant(), { policyId: 'no-read', name: 'no read', cedar: 'forbid(principal, action == Action::"agents.read", resource is Service);' }, 't');
    await createPolicy(tenant(), { policyId: 'grant-admin', name: 'admin', cedar: 'permit(principal is User, action == Action::"agents.admin", resource is Service);' }, 't');
    expect((await probeServiceLevel(tenant(), user('user'), 'agents', {})).level).toBe('none');
  });

  it('throws when the engine could not decide - an outage is not a level', async () => {
    resetIamEngineForTests();
    hoisted.getDatabase.mockRejectedValueOnce(new Error('db down'));
    await expect(probeServiceLevel('tenant_effective_never_loaded', user('admin'), 'agents', {})).rejects.toThrow(/db down/);
    hoisted.getDatabase.mockResolvedValue(env.db);
  });
});

describe('computeEffectiveLevels', () => {
  it('a workspace without custom policies is answered from the principal alone: no engine decision at all', async () => {
    const before = getIamEngineStats().decisions;
    const out = await computeEffectiveLevels(tenant(), user('user', { agents: 'read' }));
    expect(out.source).toBe('managed');
    expect(Object.keys(out.levels).sort()).toEqual([...EFFECTIVE_SERVICES].sort());
    expect(out.levels.agents).toBe('read');
    expect(out.levels.models).toBe('write');
    expect(out.levels.members).toBe('none');
    expect(getIamEngineStats().decisions).toBe(before);
  });

  it('with a custom policy in force every service is probed through the engine, and the policy shows', async () => {
    await createPolicy(tenant(), { policyId: 'freeze', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 't');
    await createPolicy(tenant(), { policyId: 'hide-prompts', name: 'hide', cedar: 'forbid(principal, action in Action::"Read", resource) when { resource.service == "prompts" };' }, 't');
    await createPolicy(tenant(), { policyId: 'members-read', name: 'members', cedar: 'permit(principal is User, action == Action::"members.read", resource is Service);' }, 't');
    const out = await computeEffectiveLevels(tenant(), user('user'));
    expect(out.source).toBe('engine');
    expect(out.levels.models).toBe('read'); // can read, a custom policy stops writes
    expect(out.levels.prompts).toBe('none'); // a read ban hides the service altogether
    expect(out.levels.members).toBe('read'); // granted by a custom permit
    expect(out.levels.agents).toBe('write'); // untouched
    expect(out.levels.tools).toBe(managedLevel(user('user'), 'tools'));
  });

  it('a disabled custom policy puts the workspace back on the principal-only answer', async () => {
    await createPolicy(tenant(), { policyId: 'freeze', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 't');
    expect((await computeEffectiveLevels(tenant(), user('user'))).levels.models).toBe('read');
    await updatePolicy(tenant(), 'freeze', { enabled: false }, 't');
    const out = await computeEffectiveLevels(tenant(), user('user'));
    expect(out.source).toBe('managed');
    expect(out.levels.models).toBe('write');
  });

  it('the policy context counts: a rule about a project or a channel applies where the check is made', async () => {
    await createPolicy(tenant(), { policyId: 'frozen-project', name: 'p', cedar: 'forbid(principal, action in Action::"Write", resource) when { context has projectId && context.projectId == "p-frozen" };' }, 't');
    const principal = user('user');
    expect((await computeEffectiveLevels(tenant(), principal, { projectId: 'p-frozen' })).levels.agents).toBe('read');
    expect((await computeEffectiveLevels(tenant(), principal, { projectId: 'p-other' })).levels.agents).toBe('write');
    expect((await computeEffectiveLevels(tenant(), principal)).levels.agents).toBe('write');
  });

  it('remembers the engine\'s answer for a few seconds, per policy-set version, principal and context', async () => {
    await createPolicy(tenant(), { policyId: 'freeze', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 't');
    const principal = user('user');
    const first = await computeEffectiveLevels(tenant(), principal);
    const decisions = getIamEngineStats().decisions;
    const second = await computeEffectiveLevels(tenant(), principal);
    expect(getIamEngineStats().decisions).toBe(decisions); // memoised: nothing asked of the engine
    expect(second.levels).toEqual(first.levels);

    // another principal, another context and another policy set each get their own answer
    await computeEffectiveLevels(tenant(), user('admin'));
    expect(getIamEngineStats().decisions).toBeGreaterThan(decisions);
    const afterOther = getIamEngineStats().decisions;
    await computeEffectiveLevels(tenant(), principal, { projectId: 'p1' });
    expect(getIamEngineStats().decisions).toBeGreaterThan(afterOther);

    await updatePolicy(tenant(), 'freeze', { cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "agents" };' }, 't');
    const changed = await computeEffectiveLevels(tenant(), principal);
    expect(changed.levels.models).toBe('write');
    expect(changed.levels.agents).toBe('read');
  });

  it('hands out copies: changing an answer does not change what is remembered', async () => {
    await createPolicy(tenant(), { policyId: 'freeze', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 't');
    const principal = user('user');
    const first = await computeEffectiveLevels(tenant(), principal);
    first.levels.models = 'admin';
    first.levels.agents = 'none';
    const second = await computeEffectiveLevels(tenant(), principal);
    expect(second.levels.models).toBe('read');
    expect(second.levels.agents).toBe('write');
    second.levels.models = 'none' as EffectiveLevel;
    expect((await computeEffectiveLevels(tenant(), principal)).levels.models).toBe('read');
  });

  it('throws when the engine cannot decide, and remembers nothing about it', async () => {
    await createPolicy(tenant(), { policyId: 'freeze', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 't');
    resetIamEngineForTests();
    hoisted.getDatabase.mockRejectedValue(new Error('db down'));
    try {
      await expect(computeEffectiveLevels(tenant(), user('user'))).rejects.toThrow();
    } finally {
      hoisted.getDatabase.mockResolvedValue(env.db);
    }
    expect((await computeEffectiveLevels(tenant(), user('user'))).levels.models).toBe('read');
  });

  it('for a different principal of the same role the answer is its own (the key is the whole principal, not the role)', async () => {
    await createPolicy(tenant(), { policyId: 'freeze', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 't');
    const a = user('user', { agents: 'read' });
    const b = user('user', { agents: 'admin' });
    expect((await computeEffectiveLevels(tenant(), a)).levels.agents).toBe('read');
    expect((await computeEffectiveLevels(tenant(), b)).levels.agents).toBe('admin');
  });
});

describe('every service of the matrix has a level of its own kind', () => {
  it('only none, read, write or admin; administration services never report write', async () => {
    const out = await computeEffectiveLevels(tenant(), user('admin', { members: 'write' as ServicePermissionLevel }));
    for (const service of EFFECTIVE_SERVICES as readonly PermissionService[]) {
      expect(['none', 'read', 'write', 'admin']).toContain(out.levels[service]);
    }
    for (const service of ADMIN_SERVICES) expect(out.levels[service]).not.toBe('write');
    expect(out.levels.members).toBe('read');
  });
});
