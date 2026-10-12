/**
 * Boundaries (A2): no custom permit can exceed an API token's scope or the
 * project narrowing. The managed `managed:boundary:*` forbids sit in every
 * evaluation; the parity fuzz (iam-parity.test.ts) proves they change nothing
 * when a tenant has no custom policies, this file proves they hold when one
 * grants everything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { RBAC_SERVICE_DEFINITIONS, getServiceDefinition, normalizeServicePermissions, type PermissionService, type UserServicePermissions } from '@/lib/security/rbac';
import { authorize, authorizeGate, configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { AGENT_POLICIES, ALL_MANAGED_POLICIES, BOUNDARY_POLICIES, MANAGED_POLICIES, listManagedPolicies } from '@/lib/iam/managedPolicies';
import { narrowedLevelSets, projectDenySets } from '@/lib/iam/projectNarrowing';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import { validatePolicies } from '@/lib/iam/cedar';
import { getIamSchema } from '@/lib/iam/schemaState';
import { createIamTestDb, mulberry32, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;
const SERVICES = RBAC_SERVICE_DEFINITIONS.map((d) => d.id);

beforeAll(async () => {
  env = await createIamTestDb('tenant_boundaries');
  hoisted.getDatabase.mockResolvedValue(env.db);
});
afterAll(async () => {
  configureIamEngine({ validateRequests: false });
  await env.cleanup();
});
beforeEach(async () => {
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
  resetIamEngineForTests();
  for (const p of await listPolicies(tenant())) await deletePolicy(tenant(), p.policyId);
});

const permitAll = () => createPolicy(tenant(), { policyId: 'permit-all', name: 'permit all', cedar: 'permit(principal, action, resource);' }, 't');

describe('the managed set', () => {
  it('carries six RBAC permits, six boundary forbids, eight portal rules and two agent approval rules, all valid against the schema', () => {
    expect(Object.keys(MANAGED_POLICIES)).toHaveLength(6);
    expect(Object.keys(BOUNDARY_POLICIES)).toHaveLength(6);
    expect(Object.keys(ALL_MANAGED_POLICIES)).toHaveLength(23);
    const result = validatePolicies(getIamSchema().schema, { ...ALL_MANAGED_POLICIES });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    for (const [id, text] of Object.entries(BOUNDARY_POLICIES)) {
      expect(id.startsWith('managed:boundary:')).toBe(true);
      expect(text.startsWith('@managed("boundary") forbid')).toBe(true);
    }
    const info = listManagedPolicies();
    expect(info.filter((p) => p.effect === 'forbid').map((p) => p.group)).toEqual([...Array(6).fill('boundary'), ...Array(4).fill('portal')]);
    expect(info.filter((p) => p.effect === 'permit').map((p) => p.group)).toEqual([...Array(6).fill('rbac'), ...Array(4).fill('portal'), 'agent', 'agent', 'agent']);
    for (const [id, text] of Object.entries(AGENT_POLICIES)) {
      expect(id.startsWith('managed:agent:')).toBe(true);
      expect(text.startsWith('@managed("agent")')).toBe(true);
    }
  });
});

describe('projectDenySets', () => {
  it('lists the services a project explicitly denies, per level', () => {
    const deny = projectDenySets({ role: 'member', servicePermissions: { models: 'none', agents: 'read', prompts: 'write', vector: 'admin' } });
    expect(deny.read).toEqual(['models']);
    expect([...deny.write].sort()).toEqual(['agents', 'models']);
    expect([...deny.admin].sort()).toEqual(['agents', 'models', 'prompts']);
    expect(projectDenySets(null)).toEqual({ read: [], write: [], admin: [] });
    expect(projectDenySets({ role: 'member' })).toEqual({ read: [], write: [], admin: [] });
  });
});

describe('a permit-everything custom policy', () => {
  it('opens what RBAC refuses for an unscoped token, but never beyond a token scope', async () => {
    await permitAll();
    const owner = userPrincipal({ userId: 'u1', user: { role: 'user' } }); // plain users have no `members` access
    const plainToken = tokenPrincipal({ tokenId: 't-plain', owner, scope: null });
    const scoped = tokenPrincipal({ tokenId: 't-scoped', owner, scope: { agents: 'read' } });
    const empty = tokenPrincipal({ tokenId: 't-empty', owner, scope: {} });

    const allowed = async (p: IamPrincipal, service: string, method: string) =>
      (await authorizeGate({ tenant: tenant(), principal: p, service, method })).allowed;

    expect(await allowed(owner, 'members', 'POST')).toBe(true); // the custom permit grants it
    expect(await allowed(plainToken, 'members', 'POST')).toBe(true);

    expect(await allowed(scoped, 'agents', 'GET')).toBe(true);
    expect(await allowed(scoped, 'agents', 'POST')).toBe(false); // scope says read
    expect(await allowed(scoped, 'models', 'GET')).toBe(false); // service outside the scope
    expect(await allowed(scoped, 'members', 'GET')).toBe(false);
    for (const s of ['agents', 'models', 'members']) expect(await allowed(empty, s, 'GET')).toBe(false); // `{}` scopes nothing
  });

  it('reports the boundary that stopped it', async () => {
    await permitAll();
    const owner = userPrincipal({ userId: 'u1', user: { role: 'user' } });
    const scoped = tokenPrincipal({ tokenId: 't', owner, scope: { agents: 'read' } });
    const res = await authorizeGate({ tenant: tenant(), principal: scoped, service: 'agents', method: 'POST' });
    expect(res.allowed).toBe(false);
    expect(res.reasons).toEqual(['managed:boundary:token-cap-write']);
  });

  it('never exceeds the project narrowing, for a session and for a token of that user', async () => {
    await permitAll();
    const membership = { role: 'member' as const, servicePermissions: { agents: 'read', models: 'none' } satisfies UserServicePermissions };
    const user = { role: 'user' };
    const narrowedOwner: IamPrincipal = {
      ...userPrincipal({ userId: 'u1', user }),
      sets: narrowedLevelSets(user, [], membership),
      projDeny: projectDenySets(membership),
    };
    const allowed = async (p: IamPrincipal, service: string, method: string) =>
      (await authorizeGate({ tenant: tenant(), principal: p, service, method })).allowed;

    for (const p of [narrowedOwner, tokenPrincipal({ tokenId: 't', owner: narrowedOwner, scope: null })]) {
      expect(await allowed(p, 'agents', 'GET')).toBe(true);
      expect(await allowed(p, 'agents', 'POST')).toBe(false); // the project says read
      expect(await allowed(p, 'models', 'GET')).toBe(false); // the project says none
      expect(await allowed(p, 'prompts', 'POST')).toBe(true); // the project says nothing about it
    }
  });

  it('keeps an action outside the catalog denied however permissive the policy is', async () => {
    await permitAll();
    const owner = userPrincipal({ userId: 'o', user: { role: 'owner' } });
    const res = await authorize({ tenant: tenant(), principal: owner, action: 'nonsense.verb', resource: { kind: 'service', service: 'agents' } });
    expect(res.allowed).toBe(false);
    expect(res.failed).toBeFalsy();
    expect(res.errors.join(' ')).toMatch(/unknown action/);
  });

  it('fuzz: allowed <=> neither the token scope nor the project narrowing forbids it (4000 decisions)', async () => {
    await permitAll();
    const rnd = mulberry32(Number(process.env.IAM_FUZZ_SEED) || 424242);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    const LEVELS = ['none', 'read', 'write', 'admin'] as const;
    const RANK = { none: 0, read: 1, write: 2, admin: 3 } as const;
    const randomPerms = (density: number): UserServicePermissions => {
      const out: Record<string, string> = {};
      for (const s of SERVICES) if (rnd() < density) out[s] = pick(LEVELS);
      return out as UserServicePermissions;
    };

    let decisions = 0;
    let mismatches = 0;
    let allows = 0;
    while (decisions < 4000) {
      const user = { role: pick(['owner', 'admin', 'project_admin', 'user']), servicePermissions: rnd() < 0.5 ? randomPerms(0.2) : null };
      const membership = rnd() < 0.5 ? { role: 'member' as const, servicePermissions: randomPerms(0.25) } : null;
      const scope = rnd() < 0.4 ? null : randomPerms(rnd() < 0.2 ? 0 : 0.4);
      const ownerBase = userPrincipal({ userId: 'u1', user });
      const owner: IamPrincipal = membership
        ? { ...ownerBase, sets: narrowedLevelSets(user, [], membership), projDeny: projectDenySets(membership) }
        : ownerBase;
      const kind = pick(['session', 'token']);
      const principal = kind === 'token' ? tokenPrincipal({ tokenId: 't1', owner, scope }) : owner;
      const capLevels = scope == null ? null : normalizeServicePermissions(scope);
      const projectLevels = membership ? normalizeServicePermissions(membership.servicePermissions) : {};

      for (let k = 0; k < 8 && decisions < 4000; k++) {
        const service = pick(SERVICES) as PermissionService;
        const method = pick(['GET', 'POST', 'DELETE', 'PUT']);
        const adminService = !!getServiceDefinition(service).adminService;
        const required = method === 'GET' ? 'read' : adminService ? 'admin' : 'write';
        // independent model of the two boundaries
        const capOk = kind !== 'token' || capLevels === null || RANK[capLevels[service] ?? 'none'] >= RANK[required];
        const projectLevel = projectLevels[service];
        const projectOk = projectLevel === undefined || RANK[projectLevel] >= RANK[required];
        const expected = capOk && projectOk;
        const got = (await authorizeGate({ tenant: tenant(), principal, service, method })).allowed;
        decisions++;
        if (got) allows++;
        if (got !== expected) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
    expect(allows).toBeGreaterThan(300);
    expect(allows).toBeLessThan(decisions);
  }, 120_000);
});
