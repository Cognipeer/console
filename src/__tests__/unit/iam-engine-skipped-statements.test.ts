/**
 * One custom statement that no longer loads (it was valid when saved, so this
 * means damaged data or a Cedar upgrade) must not make every request of the
 * workspace unanswerable: the statements that do load keep applying, the bad one
 * is skipped, listed and reported as a degraded engine. If not even the managed
 * set can be loaded the result is flagged as a FAILURE - never an allow.
 *
 * The WASM preparse is wrapped so a statement containing a marker string refuses
 * to load, which is the situation without having to find text Cedar accepts at
 * save time and rejects at load time.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn(), breakTenantSets: false }));
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
vi.mock('@/lib/iam/cedar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/cedar')>();
  return {
    ...actual,
    preparsePolicySet: (setId: string, record: Record<string, string>) => {
      if (hoisted.breakTenantSets && setId.startsWith('tenant:')) {
        return { ok: false as const, errors: [{ message: 'the set cannot be loaded' }] };
      }
      const poisoned = Object.entries(record).filter(([, text]) => text.includes('POISON')).map(([id]) => id);
      if (poisoned.length > 0) return { ok: false as const, errors: poisoned.map((id) => ({ message: `cannot load ${id}` })) };
      return actual.preparsePolicySet(setId, record);
    },
  };
});

import { authorizeGate, configureIamEngine, describeTenantPolicySet, getIamEngineStats, resetIamEngineForTests } from '@/lib/iam/engine';
import { userPrincipal } from '@/lib/iam/entities';
import { engineHealth } from '@/lib/iam/selfTest';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;
const member = () => userPrincipal({ userId: 'u1', user: { role: 'user' } });
const gate = (service: string, method: string) => authorizeGate({ tenant: tenant(), principal: member(), service, method });

const GOOD = 'forbid(principal, action == Action::"models.write", resource is Service);';
const BAD = 'forbid(principal is User, action == Action::"agents.write", resource is Service) when { principal.role == "POISON" };';

beforeAll(async () => {
  env = await createIamTestDb('tenant_skipped_statements');
  hoisted.getDatabase.mockResolvedValue(env.db);
});
afterAll(async () => {
  configureIamEngine({ validateRequests: false });
  await env.cleanup();
});
beforeEach(async () => {
  hoisted.breakTenantSets = false;
  configureIamEngine({ validateRequests: false, versionCheckMs: 5_000 });
  for (const p of await listPolicies(tenant())) await deletePolicy(tenant(), p.policyId);
  resetIamEngineForTests();
});

describe('a statement that does not load', () => {
  it('is skipped and named; the statements that load keep applying, and the managed rules still decide the rest', async () => {
    await createPolicy(tenant(), { policyId: 'good', name: 'good', cedar: GOOD }, 't');
    await createPolicy(tenant(), { policyId: 'poison', name: 'poison', cedar: BAD }, 't');

    const described = await describeTenantPolicySet(tenant());
    expect(described).toMatchObject({ custom: 1, skipped: ['custom:poison'] });

    expect((await gate('models', 'POST')).allowed).toBe(false); // the good forbid applies
    expect((await gate('models', 'POST')).reasons).toEqual(['custom:good']);
    const stillAllowed = await gate('agents', 'POST'); // the bad forbid does not
    expect(stillAllowed).toMatchObject({ allowed: true, errors: [] });
    expect(stillAllowed.failed).toBeFalsy();
  });

  it('is counted for the whole process and makes the engine degraded - not down', async () => {
    expect(engineHealth().status).toBe('ok');
    await createPolicy(tenant(), { policyId: 'poison', name: 'poison', cedar: BAD }, 't');
    await gate('agents', 'GET');
    expect(getIamEngineStats().skippedStatements).toBe(1);
    expect(engineHealth()).toMatchObject({
      status: 'degraded',
      message: 'Some custom policy statements could not be loaded and are not applied',
      details: { skippedStatements: 1 },
    });

    // fixing the policy (here: removing it) brings the engine back
    await deletePolicy(tenant(), 'poison');
    await gate('agents', 'GET');
    expect(getIamEngineStats().skippedStatements).toBe(0);
    expect(engineHealth().status).toBe('ok');
  });

  it('when every statement is bad the workspace is decided by the managed rules alone', async () => {
    await createPolicy(tenant(), { policyId: 'poison-a', name: 'a', cedar: BAD }, 't');
    await createPolicy(tenant(), { policyId: 'poison-b', name: 'b', cedar: BAD.replace('agents.write', 'models.write') }, 't');
    expect(await describeTenantPolicySet(tenant())).toMatchObject({ custom: 0, skipped: ['custom:poison-a', 'custom:poison-b'] });
    expect((await gate('agents', 'POST')).allowed).toBe(true);
    expect((await gate('members', 'POST')).allowed).toBe(false); // role arithmetic: a plain member cannot change members
  });

  it('a set that cannot be loaded even without the bad statements is a FAILURE of the engine, never an allow', async () => {
    await createPolicy(tenant(), { policyId: 'good', name: 'good', cedar: GOOD }, 't');
    resetIamEngineForTests();
    hoisted.breakTenantSets = true;
    const result = await gate('agents', 'GET');
    expect(result).toMatchObject({ allowed: false, failed: true });
    expect(result.errors.join(' ')).toMatch(/tenant policy set failed to load/);
    expect(getIamEngineStats().setLoadFailures).toBeGreaterThan(0);

    // ... and the engine recovers by itself once the set loads again
    hoisted.breakTenantSets = false;
    resetIamEngineForTests();
    expect((await gate('agents', 'GET')).allowed).toBe(true);
  });
});
