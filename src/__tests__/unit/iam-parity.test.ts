/**
 * Policy engine parity: the managed Cedar policies + entity builder must make
 * EXACTLY the decision rbac.ts makes, for every combination of role, user
 * override, group grant, token scope, service and HTTP verb.
 *
 * Fuzz: >= 5,000 random decisions per run (IAM_FUZZ_SEED replays a run).
 * Any mismatch is a hard failure — it would mean the engine can silently
 * diverge from the gate it is meant to replace.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // The real helper closes over the module-local getDatabase, which this mock
    // cannot rebind — so re-implement it on top of the stubbed one.
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import {
  RBAC_SERVICE_DEFINITIONS,
  authorizeServiceRequest,
  getPermissionServiceForPath,
  getRequiredPermissionLevel,
  resolveCurrentServicePermission,
  type GroupTenantGrant,
  type PermissionService,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { authorize, authorizeGate, configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { tokenPrincipal, userPrincipal } from '@/lib/iam/entities';
import { createIamTestDb, mulberry32, type IamTestDb } from '../helpers/iamTestDb';

const RANK: Record<ServicePermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };
const SERVICES = RBAC_SERVICE_DEFINITIONS.map((d) => d.id);
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'get', 'post', 'PURGE', 'PROPFIND'];
const ROLES = ['owner', 'admin', 'project_admin', 'user', undefined, 'weird', ''];
const LEVELS = ['none', 'read', 'write', 'admin', undefined, 'bogus'];

let env: IamTestDb;

beforeAll(async () => {
  env = await createIamTestDb('tenant_parity');
  hoisted.getDatabase.mockResolvedValue(env.db);
  resetIamEngineForTests();
});
afterAll(async () => {
  configureIamEngine({ validateRequests: false });
  await env.cleanup();
});

function makeRandom(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const randomPerms = (): UserServicePermissions => {
    const o: Record<string, unknown> = {};
    for (const s of SERVICES) {
      if (rnd() < 0.2) {
        const l = pick(LEVELS);
        if (l !== undefined) o[s] = l;
      }
    }
    if (rnd() < 0.1) o['not-a-service'] = 'admin';
    return o as UserServicePermissions;
  };
  return { rnd, pick, randomPerms };
}

function legacyDecision(
  user: { role?: string; servicePermissions?: UserServicePermissions | null },
  grants: GroupTenantGrant[],
  scope: UserServicePermissions | null | undefined,
  service: PermissionService,
  method: string,
): boolean {
  const required = getRequiredPermissionLevel(method, service);
  const current = resolveCurrentServicePermission(user, service, grants, scope);
  return RANK[current] >= RANK[required];
}

describe('IAM engine parity with rbac.ts', () => {
  const seed = process.env.IAM_FUZZ_SEED ? Number(process.env.IAM_FUZZ_SEED) : (Date.now() & 0x7fffffff);

  for (const validate of [false, true]) {
    it(`fuzz: >= 5000 random decisions, 0 mismatches (validateRequest=${validate}, seed=${seed})`, async () => {
      configureIamEngine({ validateRequests: validate });
      const { rnd, pick, randomPerms } = makeRandom(seed + (validate ? 1 : 0));
      // IAM_FUZZ_DECISIONS scales the run (e.g. 50000); validated requests are ~4x slower.
      const scale = Number(process.env.IAM_FUZZ_DECISIONS) || 6000;
      const target = validate ? Math.max(1500, Math.floor(scale / 4)) : scale;
      let decisions = 0;
      let allows = 0;
      const mismatches: string[] = [];

      while (decisions < target) {
        const user = {
          role: pick(ROLES) as string | undefined,
          servicePermissions: rnd() < 0.5 ? randomPerms() : (rnd() < 0.5 ? null : undefined),
        };
        const grants: GroupTenantGrant[] = Array.from({ length: Math.floor(rnd() * 4) }, () => ({
          tenantRole: pick(['owner', 'admin', 'project_admin', 'user', undefined] as const) as GroupTenantGrant['tenantRole'],
          servicePermissions: rnd() < 0.5 ? randomPerms() : null,
        }));
        const kind = pick(['session', 'token', 'token'] as const);
        // token scope: unscoped, {} (deny all), or random
        const scope: UserServicePermissions | null | undefined =
          rnd() < 0.3 ? null : rnd() < 0.15 ? {} : rnd() < 0.1 ? undefined : randomPerms();

        const owner = userPrincipal({ userId: 'u1', user, groupGrants: kind === 'session' ? grants : [] });
        const principal = kind === 'session' ? owner : tokenPrincipal({ tokenId: 't1', owner, scope });

        for (let k = 0; k < 6 && decisions < target; k++) {
          const service = pick(SERVICES);
          const method = pick(METHODS);
          const expected = legacyDecision(
            user,
            kind === 'session' ? grants : [],
            kind === 'session' ? undefined : scope,
            service,
            method,
          );
          const got = await authorizeGate({ tenant: env.tenantDbName, principal, service, method });
          decisions++;
          if (expected) allows++;
          if (got.errors.length > 0 && got.allowed !== expected) {
            mismatches.push(`ERRORS ${got.errors.join('|')}`);
          }
          if (got.allowed !== expected) {
            mismatches.push(JSON.stringify({ user, grants: kind === 'session' ? grants : [], scope: kind === 'token' ? scope : 'n/a', kind, service, method, expected, got: got.allowed }));
          }
        }
      }
      console.log(`[iam-parity] validate=${validate} decisions=${decisions} allows=${allows} mismatches=${mismatches.length} seed=${seed}`);
      expect(mismatches.slice(0, 5)).toEqual([]);
      expect(decisions).toBeGreaterThanOrEqual(validate ? 1500 : 5000);
      expect(decisions).toBe(target);
      expect(allows).toBeGreaterThan(0);
      expect(allows).toBeLessThan(decisions);
    }, 120_000);
  }

  it('matches authorizeServiceRequest end-to-end for services reachable by a real path', async () => {
    configureIamEngine({ validateRequests: false });
    const { rnd, pick, randomPerms } = makeRandom(seed ^ 0x5bd1e995);
    const probes: Array<{ service: PermissionService; path: string }> = [];
    for (const s of SERVICES) {
      const path = `/api/${s}`;
      if (getPermissionServiceForPath(path) === s) probes.push({ service: s, path });
    }
    expect(probes.length).toBeGreaterThan(20);
    let n = 0;
    for (let i = 0; i < 1500; i++) {
      const user = { role: pick(ROLES) as string | undefined, servicePermissions: rnd() < 0.5 ? randomPerms() : null };
      const grants: GroupTenantGrant[] = Array.from({ length: Math.floor(rnd() * 3) }, () => ({
        tenantRole: pick(['admin', 'user', undefined] as const) as GroupTenantGrant['tenantRole'],
        servicePermissions: rnd() < 0.5 ? randomPerms() : null,
      }));
      const probe = pick(probes);
      const method = pick(METHODS);
      const legacy = authorizeServiceRequest(user, method, probe.path, grants);
      const principal = userPrincipal({ userId: 'u1', user, groupGrants: grants });
      const got = await authorizeGate({ tenant: env.tenantDbName, principal, service: probe.service, method });
      n++;
      expect(got.allowed, JSON.stringify({ user, grants, probe, method })).toBe(legacy.allowed);
    }
    expect(n).toBe(1500);
  });

  describe('named edge cases (rbac-semantics map)', () => {
    const gate = async (
      user: Parameters<typeof userPrincipal>[0]['user'],
      service: PermissionService,
      method: string,
      opts: { grants?: GroupTenantGrant[]; scope?: UserServicePermissions | null } = {},
    ) => {
      const owner = userPrincipal({ userId: 'u', user, groupGrants: opts.grants ?? [] });
      const principal = opts.scope === undefined ? owner : tokenPrincipal({ tokenId: 't', owner, scope: opts.scope });
      return (await authorizeGate({ tenant: env.tenantDbName, principal, service, method })).allowed;
    };

    it('owner ignores servicePermissions', async () => {
      expect(await gate({ role: 'owner', servicePermissions: { members: 'none' } }, 'members', 'DELETE')).toBe(true);
    });
    it('explicit read lowers an admin; explicit none denies even GET', async () => {
      expect(await gate({ role: 'admin', servicePermissions: { agents: 'read' } }, 'agents', 'POST')).toBe(false);
      expect(await gate({ role: 'admin', servicePermissions: { agents: 'read' } }, 'agents', 'GET')).toBe(true);
      expect(await gate({ role: 'admin', servicePermissions: { agents: 'none' } }, 'agents', 'GET')).toBe(false);
    });
    it('a group tenantRole raises a user-level none/read (groups only raise)', async () => {
      const user = { role: 'user', servicePermissions: { agents: 'none' as const } };
      expect(await gate(user, 'agents', 'POST')).toBe(false);
      expect(await gate(user, 'agents', 'POST', { grants: [{ tenantRole: 'user' }] })).toBe(true);
    });
    it('adminService: explicit write is not enough for a mutation, enough for GET', async () => {
      const user = { role: 'user', servicePermissions: { members: 'write' as const } };
      expect(await gate(user, 'members', 'GET')).toBe(true);
      expect(await gate(user, 'members', 'POST')).toBe(false);
      expect(await gate({ role: 'user', servicePermissions: { members: 'admin' as const } }, 'members', 'POST')).toBe(true);
    });
    it('role defaults: user=write non-admin, none on adminService; project_admin == user', async () => {
      expect(await gate({ role: 'user' }, 'agents', 'POST')).toBe(true);
      expect(await gate({ role: 'user' }, 'members', 'GET')).toBe(false);
      expect(await gate({ role: 'project_admin' }, 'providers', 'GET')).toBe(false);
      expect(await gate({ role: 'mystery' }, 'agents', 'GET')).toBe(false);
    });
    it('token scope: null inherits, {} denies everything, absent service = none, can only narrow', async () => {
      const user = { role: 'admin' };
      expect(await gate(user, 'agents', 'POST', { scope: null })).toBe(true);
      expect(await gate(user, 'agents', 'GET', { scope: {} })).toBe(false);
      expect(await gate(user, 'agents', 'GET', { scope: { models: 'admin' } })).toBe(false);
      expect(await gate(user, 'agents', 'GET', { scope: { agents: 'read' } })).toBe(true);
      expect(await gate(user, 'agents', 'POST', { scope: { agents: 'read' } })).toBe(false);
      // a scope cannot widen a weak owner
      expect(await gate({ role: 'user', servicePermissions: { agents: 'read' } }, 'agents', 'POST', { scope: { agents: 'admin' } })).toBe(false);
      // adminService mutation through a write-capped token
      expect(await gate(user, 'members', 'POST', { scope: { members: 'write' } })).toBe(false);
      expect(await gate(user, 'members', 'POST', { scope: { members: 'admin' } })).toBe(true);
    });
    it('HEAD/OPTIONS are reads, lowercase verbs normalised, unknown verbs are mutations', async () => {
      const user = { role: 'user', servicePermissions: { agents: 'read' as const } };
      expect(await gate(user, 'agents', 'HEAD')).toBe(true);
      expect(await gate(user, 'agents', 'OPTIONS')).toBe(true);
      expect(await gate(user, 'agents', 'get')).toBe(true);
      expect(await gate(user, 'agents', 'PURGE')).toBe(false);
    });
  });

  it('resource-level actions follow the same level as their service (agent.get/update on an Agent)', async () => {
    configureIamEngine({ validateRequests: true });
    const { rnd, pick, randomPerms } = makeRandom(seed ^ 0x1234567);
    for (let i = 0; i < 400; i++) {
      const user = { role: pick(ROLES) as string | undefined, servicePermissions: rnd() < 0.5 ? randomPerms() : null };
      const principal = userPrincipal({ userId: 'u1', user, groupGrants: [] });
      const [read, write] = await Promise.all([
        authorize({ tenant: env.tenantDbName, principal, action: 'agent.get', resource: { kind: 'resource', type: 'agent', id: 'a1', service: 'agents', projectId: 'p1' } }),
        authorize({ tenant: env.tenantDbName, principal, action: 'agent.update', resource: { kind: 'resource', type: 'agent', id: 'a1', service: 'agents', projectId: 'p1' } }),
      ]);
      expect(read.errors).toEqual([]);
      expect(write.errors).toEqual([]);
      expect(read.allowed).toBe(legacyDecision(user, [], undefined, 'agents', 'GET'));
      expect(write.allowed).toBe(legacyDecision(user, [], undefined, 'agents', 'POST'));
    }
    configureIamEngine({ validateRequests: false });
  });

  it('reports the managed policy that decided (explainability)', async () => {
    const principal = userPrincipal({ userId: 'u', user: { role: 'admin' }, groupIds: [] });
    const r = await authorizeGate({ tenant: env.tenantDbName, principal, service: 'agents', method: 'GET' });
    expect(r.allowed).toBe(true);
    expect(r.reasons).toEqual(['managed:rbac:user-read']);
    const t = tokenPrincipal({ tokenId: 't', owner: principal, scope: { agents: 'write' } });
    const rt = await authorizeGate({ tenant: env.tenantDbName, principal: t, service: 'agents', method: 'POST' });
    expect(rt.reasons).toEqual(['managed:rbac:token-write']);
  });
});
