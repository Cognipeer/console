/**
 * The bound on a tenant's WHOLE custom policy set (store.ts): the per-policy limits
 * alone (50 statements, 64 KB, 500 policies) allow 25,000 statements, which is
 * ~67 ms of event-loop time per decision and ~5 s of blocked loop per policy write.
 * The store therefore also caps the total number of policies, statements and bytes,
 * counting disabled and monitor policies, and lets a change that does not grow the
 * set through so nobody is locked out of cleaning up.
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

import { invalidateTenantPolicies } from '@/lib/iam/events';
import {
  IamPolicyError,
  MAX_POLICIES_PER_TENANT,
  MAX_STATEMENTS_PER_TENANT,
  MAX_TENANT_POLICY_BYTES,
  createPolicy,
  deletePolicy,
  listPolicies,
  updatePolicy,
} from '@/lib/iam/store';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

beforeAll(async () => {
  env = await createIamTestDb('tenant_store_bounds');
  hoisted.getDatabase.mockResolvedValue(env.db);
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  for (const p of await listPolicies(tenant())) await deletePolicy(tenant(), p.policyId);
});

const statement = (n: number, pad = '') => `forbid(principal is User, action == Action::"models.write", resource is Service) when { principal.role == "role-${n}${pad}" };`;
const statements = (count: number, from = 0, pad = '') => Array.from({ length: count }, (_, i) => statement(from + i, pad)).join('\n');

/** Writes policies straight into the collection, the way a tenant that already crossed a cap would look. */
async function putRaw(policyId: string, cedar: string): Promise<void> {
  const now = new Date().toISOString();
  await env.db.runWithTenant(tenant(), async () => {
    await env.db.iamDocPut('iam_policies', policyId, {
      _id: policyId, policyId, name: policyId, cedar, spec: null, mode: 'enforce', enabled: true,
      createdBy: 't', updatedBy: 't', createdAt: now, updatedAt: now,
    });
  });
  invalidateTenantPolicies(tenant());
}

const limitError = async (promise: Promise<unknown>): Promise<IamPolicyError> => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(IamPolicyError);
  expect((error as IamPolicyError).code).toBe('limit_reached');
  return error as IamPolicyError;
};

// These render whole component trees (jsdom + Mantine) or run the policy engine; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('the caps', () => {
  it('are small enough to keep a decision in the low milliseconds', () => {
    expect(MAX_POLICIES_PER_TENANT).toBe(500);
    expect(MAX_STATEMENTS_PER_TENANT).toBe(500);
    expect(MAX_TENANT_POLICY_BYTES).toBe(256 * 1024);
  });
});

describe('statements in total', () => {
  it('refuses the policy that would take the workspace past 500 statements', async () => {
    for (let i = 0; i < 10; i++) {
      await createPolicy(tenant(), { policyId: `p${i}`, name: `p${i}`, cedar: statements(50, i * 50) }, 't');
    }
    expect((await listPolicies(tenant())).length).toBe(10);
    const error = await limitError(createPolicy(tenant(), { policyId: 'one-more', name: 'x', cedar: statement(9999) }, 't'));
    expect(error.message).toMatch(/at most 500 policy statements/);
    expect(error.message).toMatch(/would make 501/);
  });

  it('counts disabled and monitor policies too', async () => {
    for (let i = 0; i < 9; i++) {
      await createPolicy(tenant(), { policyId: `p${i}`, name: `p${i}`, cedar: statements(50, i * 50), mode: 'monitor', enabled: false }, 't');
    }
    await createPolicy(tenant(), { policyId: 'last', name: 'last', cedar: statements(50, 450) }, 't');
    await limitError(createPolicy(tenant(), { policyId: 'over', name: 'x', cedar: statement(1) }, 't'));
  });

  it('refuses an edit that grows the set past the cap, and allows one that shrinks it', async () => {
    for (let i = 0; i < 9; i++) await createPolicy(tenant(), { policyId: `p${i}`, name: `p${i}`, cedar: statements(50, i * 50) }, 't');
    await createPolicy(tenant(), { policyId: 'a', name: 'a', cedar: statements(20, 450) }, 't');
    await createPolicy(tenant(), { policyId: 'b', name: 'b', cedar: statements(20, 470) }, 't'); // 490 in total
    await updatePolicy(tenant(), 'a', { cedar: statements(30, 450) }, 't'); // 500: allowed
    await limitError(updatePolicy(tenant(), 'a', { cedar: statements(31, 450) }, 't')); // 501
    await limitError(updatePolicy(tenant(), 'b', { cedar: statements(21, 470) }, 't')); // 501
    // shrinking is always fine
    const smaller = await updatePolicy(tenant(), 'a', { cedar: statements(5, 450) }, 't');
    expect(smaller.cedar).toBe(statements(5, 450));
  });

  it('never blocks a tenant that is already over a cap from cleaning up', async () => {
    // 20 policies x 50 statements = 1000: crossed before the cap existed (or by a racing pair of writes)
    for (let i = 0; i < 20; i++) await putRaw(`old${i}`, statements(50, i * 50));
    await limitError(createPolicy(tenant(), { policyId: 'new', name: 'x', cedar: statement(5) }, 't'));
    // an edit that keeps the size, or shrinks it, goes through
    await updatePolicy(tenant(), 'old0', { cedar: statements(50, 0) }, 't');
    await updatePolicy(tenant(), 'old1', { cedar: statements(3, 50) }, 't');
    await deletePolicy(tenant(), 'old2');
    // toggles never look at the totals at all
    expect((await updatePolicy(tenant(), 'old3', { enabled: false, mode: 'monitor' }, 't')).enabled).toBe(false);
  });
});

describe('total size', () => {
  it('refuses a write that takes the Cedar text past 256 KB, naming the sizes', async () => {
    // 4 policies of ~62 KB each stay under the per-policy 64 KB and the statement cap
    const big = (n: number) => `${statement(n, 'x'.repeat(61_000))}`;
    for (let i = 0; i < 4; i++) {
      await createPolicy(tenant(), { policyId: `b${i}`, name: `b${i}`, cedar: big(i) }, 't');
    }
    const error = await limitError(createPolicy(tenant(), { policyId: 'b4', name: 'x', cedar: big(4) }, 't'));
    expect(error.message).toMatch(/at most 256 KB of Cedar/);
    // a small policy still fits in the remaining room
    await createPolicy(tenant(), { policyId: 'small', name: 'small', cedar: statement(1) }, 't');
  });
});

describe('number of policies', () => {
  it('stops at 500 policies and says so with the same code the API maps to 409 limit_reached', async () => {
    for (let i = 0; i < MAX_POLICIES_PER_TENANT; i++) await putRaw(`m${i}`, statement(i));
    const error = await limitError(createPolicy(tenant(), { policyId: 'extra', name: 'x', cedar: statement(1) }, 't'));
    expect(error.message).toMatch(/at most 500 custom policies/);
  });
});

describe('an update of a policy that is not there', () => {
  it('answers not_found, not a limit error', async () => {
    const error = await updatePolicy(tenant(), 'ghost', { cedar: statement(1) }, 't').then(() => null, (e: unknown) => e);
    expect((error as IamPolicyError).code).toBe('not_found');
  });
});
