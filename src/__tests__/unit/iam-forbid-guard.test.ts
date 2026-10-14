/**
 * A forbid that cannot be evaluated must not be skipped (forbidGuard.ts).
 *
 * Cedar ignores a policy that errors while it is evaluated. For a deny rule that
 * means "stops blocking", so an allow is refused when a deny rule of the set
 * errored: a custom one counts as a deny that names it, a managed one fails the
 * decision. A deny is left alone, and so are permits that error.
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

import { authorize, configureIamEngine, getIamEngineStats, resetIamEngineForTests } from '@/lib/iam/engine';
import { userPrincipal } from '@/lib/iam/entities';
import { invalidateTenantPolicies } from '@/lib/iam/events';
import { guardForbidErrors } from '@/lib/iam/forbidGuard';
import { deletePolicy } from '@/lib/iam/store';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

describe('guardForbidErrors (pure)', () => {
  const forbids = new Set(['custom:block', 'custom:multi#1', 'managed:boundary:project-read']);
  const allow = { allowed: true, reasons: ['managed:rbac:user-read'], errors: [], errorPolicyIds: [] as string[] };

  it('leaves an allow alone when nothing errored, or only permits did', () => {
    expect(guardForbidErrors(allow, forbids)).toMatchObject({ kind: 'decided', allowed: true, reasons: ['managed:rbac:user-read'], erroredForbids: [] });
    const permitErrored = { ...allow, errors: ['custom:grant: boom'], errorPolicyIds: ['custom:grant'] };
    expect(guardForbidErrors(permitErrored, forbids)).toMatchObject({ kind: 'decided', allowed: true });
  });

  it('turns an allow into a deny that names the custom forbid that errored', () => {
    const outcome = guardForbidErrors({ ...allow, errors: ['custom:block: boom'], errorPolicyIds: ['custom:block', 'custom:block'] }, forbids);
    expect(outcome).toMatchObject({ kind: 'decided', allowed: false, reasons: ['custom:block'], erroredForbids: ['custom:block'] });
    expect(outcome.kind === 'decided' && outcome.notes[0]).toContain('counts as a deny');
  });

  it('knows which statement of a multi-statement policy is the forbid', () => {
    const outcome = guardForbidErrors({ ...allow, errors: ['x'], errorPolicyIds: ['custom:multi#0', 'custom:multi#1'] }, forbids);
    expect(outcome).toMatchObject({ kind: 'decided', allowed: false, erroredForbids: ['custom:multi#1'] });
  });

  it('fails the decision when a managed forbid errored - nobody can vouch for an allow then', () => {
    const outcome = guardForbidErrors({ ...allow, errors: ['managed:boundary:project-read: boom'], errorPolicyIds: ['managed:boundary:project-read', 'custom:block'] }, forbids);
    expect(outcome.kind).toBe('failed');
  });

  it('never changes a deny', () => {
    const deny = { allowed: false, reasons: ['custom:other'], errors: ['custom:block: boom'], errorPolicyIds: ['custom:block'] };
    expect(guardForbidErrors(deny, forbids)).toMatchObject({ kind: 'decided', allowed: false, reasons: ['custom:other'], erroredForbids: [] });
  });
});

describe('the engine', () => {
  let env: IamTestDb;
  const tenant = () => env.tenantDbName;

  beforeAll(async () => {
    env = await createIamTestDb('tenant_forbid_guard');
    hoisted.getDatabase.mockResolvedValue(env.db);
  });
  afterAll(async () => {
    configureIamEngine({ validateRequests: false, versionCheckMs: 5_000 });
    await env.cleanup();
  });
  beforeEach(() => {
    // Request validation off, as in production: the rules below meet data the schema would have rejected.
    configureIamEngine({ validateRequests: false, versionCheckMs: 5_000 });
    resetIamEngineForTests();
  });

  /** Straight into the collection: the store would (rightly) refuse a rule that cannot be evaluated. */
  async function putPolicy(policyId: string, cedar: string): Promise<void> {
    const now = new Date().toISOString();
    await env.db.runWithTenant(tenant(), async () => {
      await env.db.iamDocPut('iam_policies', policyId, {
        _id: policyId, policyId, name: policyId, cedar, spec: null, enabled: true,
        createdBy: 'tester', updatedBy: 'tester', createdAt: now, updatedAt: now,
      });
      await env.db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
    });
    invalidateTenantPolicies(tenant());
  }

  const person = userPrincipal({ userId: 'u1', user: { role: 'user' } });
  const agent = { kind: 'resource', type: 'agent', id: 'a1', service: 'agents', projectId: 'p1' } as const;
  const ask = (action = 'agent.invoke') => authorize({ tenant: tenant(), principal: person, action, resource: agent, context: { channel: 'dashboard' } });

  // `tags` is an optional attribute the agent entity below does not have: reading it is an evaluation error.
  const ERRORING_FORBID = 'forbid (principal, action == Action::"agent.invoke", resource is Agent) when { resource.tags.contains("blocked") };';

  it('counts a custom forbid that errors as a deny, names it, and keeps the problem in the errors', async () => {
    expect((await ask()).allowed).toBe(true);
    await putPolicy('block-invoke', ERRORING_FORBID);
    const before = getIamEngineStats().forbidErrors;
    const result = await ask();
    expect(result.allowed).toBe(false);
    expect(result.failed).toBeUndefined();
    expect(result.reasons).toEqual(['custom:block-invoke']);
    expect(result.errors.some((e) => e.startsWith('custom:block-invoke:'))).toBe(true);
    expect(result.errors.some((e) => e.includes('counts as a deny'))).toBe(true);
    expect(result.obligations).toEqual({});
    expect(getIamEngineStats().forbidErrors).toBe(before + 1);
    // other actions are not touched by it
    expect((await ask('agent.get')).allowed).toBe(true);
    await deletePolicy(tenant(), 'block-invoke');
    expect((await ask()).allowed).toBe(true);
  });

  it('applies to any statement of a policy that holds several', async () => {
    await putPolicy('several', `permit (principal, action == Action::"agent.get", resource);\n${ERRORING_FORBID}`);
    const result = await ask();
    expect(result).toMatchObject({ allowed: false, reasons: ['custom:several#1'] });
    await deletePolicy(tenant(), 'several');
  });

  it('does not make a deny out of a permit that errors, nor change a deny that was a deny already', async () => {
    await putPolicy('erroring-permit', 'permit (principal, action == Action::"agent.invoke", resource is Agent) when { resource.tags.contains("x") };');
    expect((await ask()).allowed).toBe(true); // the managed rule allows it, as before
    const denied = userPrincipal({ userId: 'u2', user: { role: 'user', servicePermissions: { agents: 'none' } } });
    const result = await authorize({ tenant: tenant(), principal: denied, action: 'agent.invoke', resource: agent, context: { channel: 'dashboard' } });
    expect(result).toMatchObject({ allowed: false, reasons: [] });
    await deletePolicy(tenant(), 'erroring-permit');
  });

  it('is not triggered by a forbid that evaluates fine, whether it matches or not', async () => {
    await putPolicy('plain', 'forbid (principal == User::"someone-else", action == Action::"agent.invoke", resource);');
    const result = await ask();
    expect(result).toMatchObject({ allowed: true, errors: [] });
    await deletePolicy(tenant(), 'plain');
  });
});
