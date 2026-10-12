/**
 * IAM document store + custom policy store, run against BOTH backends
 * (SQLite and MongoDB) — the collections/tables are created lazily and must
 * behave identically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { runWithTenantScope } from '@/lib/database';
import {
  IamPolicyError,
  createPolicy,
  customCedarIds,
  deletePolicy,
  getPolicy,
  getPolicyVersion,
  listPolicies,
  policyIdFromCedarId,
  updatePolicy,
} from '@/lib/iam/store';
import { onIamInvalidation, type IamInvalidation } from '@/lib/iam/events';
import { describeForEachProvider } from './db-parity.helper';

// (a deny rule the request gates can match: a whole-service action on a Service)
const FORBID_DELETE = 'forbid(principal, action == Action::"agents.write", resource is Service);';

describeForEachProvider('IAM document store (raw)', (getDb) => {
  let tenant: string;
  beforeEach(() => {
    tenant = `tenant_iamdoc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    hoisted.getDatabase.mockImplementation(async () => getDb());
  });

  it('put / get / replace / delete round-trips JSON and creates the collection lazily', async () => {
    await runWithTenantScope(tenant, async (db) => {
      expect(await db.iamDocGet('iam_policies', 'a')).toBeNull();
      const put = await db.iamDocPut('iam_policies', 'a', { name: 'A', nested: { x: [1, 2, { y: true }] }, n: null });
      expect(put.id).toBe('a');
      const got = await db.iamDocGet('iam_policies', 'a');
      expect(got?.data).toEqual({ name: 'A', nested: { x: [1, 2, { y: true }] }, n: null });
      expect(got?.updatedAt).toBeInstanceOf(Date);
      await db.iamDocPut('iam_policies', 'a', { name: 'A2' });
      expect((await db.iamDocGet('iam_policies', 'a'))?.data).toEqual({ name: 'A2' });
      expect(await db.iamDocDelete('iam_policies', 'a')).toBe(true);
      expect(await db.iamDocDelete('iam_policies', 'a')).toBe(false);
      expect(await db.iamDocGet('iam_policies', 'a')).toBeNull();
    });
  });

  it('lists ordered by id with prefix and limit; clear removes only this tenant', async () => {
    const other = `${tenant}_other`;
    await runWithTenantScope(other, (db) => db.iamDocPut('iam_meta', 'keep', { v: 1 }));
    await runWithTenantScope(tenant, async (db) => {
      for (const id of ['b:2', 'a:1', 'b:1', 'c']) await db.iamDocPut('iam_meta', id, { id });
      expect((await db.iamDocList('iam_meta')).map((d) => d.id)).toEqual(['a:1', 'b:1', 'b:2', 'c']);
      expect((await db.iamDocList('iam_meta', { idPrefix: 'b:' })).map((d) => d.id)).toEqual(['b:1', 'b:2']);
      expect((await db.iamDocList('iam_meta', { limit: 2 })).map((d) => d.id)).toEqual(['a:1', 'b:1']);
      // regex metacharacters in a prefix are literal
      await db.iamDocPut('iam_meta', 'x.y', { id: 'x.y' });
      await db.iamDocPut('iam_meta', 'xzy', { id: 'xzy' });
      expect((await db.iamDocList('iam_meta', { idPrefix: 'x.' })).map((d) => d.id)).toEqual(['x.y']);
      expect(await db.iamDocClear('iam_meta')).toBe(6);
      expect(await db.iamDocList('iam_meta')).toEqual([]);
    });
    await runWithTenantScope(other, async (db) => {
      expect((await db.iamDocGet('iam_meta', 'keep'))?.data).toEqual({ v: 1 });
    });
  });

  it('isolates tenants (same id, different tenant)', async () => {
    const other = `${tenant}_b`;
    await runWithTenantScope(tenant, (db) => db.iamDocPut('iam_meta', 'same', { who: 'a' }));
    await runWithTenantScope(other, (db) => db.iamDocPut('iam_meta', 'same', { who: 'b' }));
    expect((await runWithTenantScope(tenant, (db) => db.iamDocGet('iam_meta', 'same')))?.data).toEqual({ who: 'a' });
    expect((await runWithTenantScope(other, (db) => db.iamDocGet('iam_meta', 'same')))?.data).toEqual({ who: 'b' });
  });

  it('increments atomically, creating document and field', async () => {
    await runWithTenantScope(tenant, async (db) => {
      expect(await db.iamDocIncrement('iam_meta', 'c', 'value')).toBe(1);
      expect(await db.iamDocIncrement('iam_meta', 'c', 'value', 4)).toBe(5);
      const results = await Promise.all(Array.from({ length: 25 }, () => db.iamDocIncrement('iam_meta', 'c', 'value')));
      expect(new Set(results).size).toBe(25);
      expect(Math.max(...results)).toBe(30);
      expect((await db.iamDocGet('iam_meta', 'c'))?.data.value).toBe(30);
      // other fields survive
      await db.iamDocPut('iam_meta', 'd', { keep: 'me', value: 10 });
      expect(await db.iamDocIncrement('iam_meta', 'd', 'value', 2)).toBe(12);
      expect((await db.iamDocGet('iam_meta', 'd'))?.data).toEqual({ keep: 'me', value: 12 });
    });
  });

  it('refuses unknown collections and malformed counter fields', async () => {
    await runWithTenantScope(tenant, async (db) => {
      await expect(db.iamDocGet('users' as never, 'x')).rejects.toThrow(/Unknown IAM collection/);
      await expect(db.iamDocPut('iam_policies; DROP TABLE users' as never, 'x', {})).rejects.toThrow(/Unknown IAM collection/);
      await expect(db.iamDocIncrement('iam_meta', 'c', 'a.b')).rejects.toThrow(/Invalid IAM counter field/);
    });
  });

  it('does not require or change anything for tenants that never use it', async () => {
    // reading a never-created collection is a plain miss
    await runWithTenantScope(`${tenant}_fresh`, async (db) => {
      expect(await db.iamDocGet('iam_policies', 'nothing')).toBeNull();
      expect(await db.iamDocList('iam_policies')).toEqual([]);
    });
  });
});

describeForEachProvider('Custom policy store', (getDb) => {
  let tenant: string;
  let events: IamInvalidation[];
  let off: () => void;

  beforeEach(() => {
    tenant = `tenant_iampol_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    hoisted.getDatabase.mockImplementation(async () => getDb());
    events = [];
    off?.();
    off = onIamInvalidation((e) => events.push(e));
  });

  it('creates, reads, lists, updates and deletes; every write bumps the version and signals invalidation', async () => {
    expect(await getPolicyVersion(tenant)).toBe(0);
    expect(await listPolicies(tenant)).toEqual([]);

    const created = await createPolicy(tenant, { policyId: 'no-agent-delete', name: 'No agent delete', description: 'because', cedar: FORBID_DELETE }, 'u1');
    expect(created).toMatchObject({
      _id: 'no-agent-delete', policyId: 'no-agent-delete', name: 'No agent delete', description: 'because',
      cedar: FORBID_DELETE, enabled: true, createdBy: 'u1', updatedBy: 'u1',
    });
    expect(created).not.toHaveProperty('mode'); // a policy is enabled or disabled, nothing else
    expect(await getPolicyVersion(tenant)).toBe(1);
    expect(events).toContainEqual({ kind: 'tenant-policies', tenantDbName: tenant });

    const got = await getPolicy(tenant, 'no-agent-delete');
    expect(got).toMatchObject({ policyId: 'no-agent-delete', enabled: true });
    expect(got!.createdAt).toBeInstanceOf(Date);
    expect(got!.updatedAt).toBeInstanceOf(Date);

    const second = await createPolicy(tenant, { name: 'Disabled one', cedar: 'forbid(principal, action == Action::"tools.write", resource is Service);', enabled: false, service: 'tools' }, 'u2');
    expect(second.policyId).toMatch(/^p-[0-9a-f]{12}$/);
    expect(second.enabled).toBe(false);
    expect(await getPolicyVersion(tenant)).toBe(2);

    expect((await listPolicies(tenant)).map((p) => p.policyId).sort()).toEqual([second.policyId, 'no-agent-delete'].sort());
    expect((await listPolicies(tenant, { enabled: true })).map((p) => p.policyId)).toEqual(['no-agent-delete']);
    expect((await listPolicies(tenant, { enabled: false })).map((p) => p.policyId)).toEqual([second.policyId]);
    expect((await listPolicies(tenant, { service: 'tools' })).map((p) => p.policyId)).toEqual([second.policyId]);

    const updated = await updatePolicy(tenant, 'no-agent-delete', { name: 'Renamed', enabled: false, description: null }, 'u3');
    expect(updated).toMatchObject({ name: 'Renamed', enabled: false, updatedBy: 'u3', createdBy: 'u1' });
    expect(updated.description).toBeUndefined();
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    expect(await getPolicyVersion(tenant)).toBe(3);

    expect(await deletePolicy(tenant, 'no-agent-delete')).toBe(true);
    expect(await deletePolicy(tenant, 'no-agent-delete')).toBe(false);
    expect(await getPolicy(tenant, 'no-agent-delete')).toBeNull();
    expect(await getPolicyVersion(tenant)).toBe(4); // the failed second delete does not bump
  });

  it('rejects invalid Cedar at write time (create AND update) and does not change anything', async () => {
    await expect(createPolicy(tenant, { name: 'bad', cedar: 'permit(principal is User, action, resource) when { principal.nope == "x" };' }, 'u'))
      .rejects.toMatchObject({ name: 'IamPolicyError', code: 'validation' });
    await expect(createPolicy(tenant, { name: 'syntax', cedar: 'permit(' }, 'u')).rejects.toBeInstanceOf(IamPolicyError);
    expect(await getPolicyVersion(tenant)).toBe(0);
    expect(await listPolicies(tenant)).toEqual([]);

    await createPolicy(tenant, { policyId: 'ok', name: 'ok', cedar: FORBID_DELETE }, 'u');
    await expect(updatePolicy(tenant, 'ok', { cedar: 'forbid(principal, action == Action::"nope.nope", resource);' }, 'u'))
      .rejects.toMatchObject({ code: 'validation' });
    expect((await getPolicy(tenant, 'ok'))!.cedar).toBe(FORBID_DELETE);
    expect(await getPolicyVersion(tenant)).toBe(1);
  });

  it('reports validation details to the caller', async () => {
    try {
      await createPolicy(tenant, { name: 'bad', cedar: 'permit(principal is User, action, resource) when { principal.nope == "x" };' }, 'u');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IamPolicyError);
      expect((error as IamPolicyError).details.length).toBeGreaterThan(0);
      expect((error as IamPolicyError).details[0].message).toMatch(/nope/);
    }
  });

  it('conflict on duplicate id, not_found on missing update, invalid_input on bad ids/names', async () => {
    await createPolicy(tenant, { policyId: 'dup', name: 'dup', cedar: FORBID_DELETE }, 'u');
    await expect(createPolicy(tenant, { policyId: 'dup', name: 'dup', cedar: FORBID_DELETE }, 'u')).rejects.toMatchObject({ code: 'conflict' });
    await expect(updatePolicy(tenant, 'missing', { name: 'x' }, 'u')).rejects.toMatchObject({ code: 'not_found' });
    await expect(createPolicy(tenant, { policyId: 'Bad Id!', name: 'x', cedar: FORBID_DELETE }, 'u')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createPolicy(tenant, { name: '  ', cedar: FORBID_DELETE }, 'u')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  describe('the retired mode field', () => {
    // (what an old client still sends: a body with a `mode` the store no longer knows)
    type CreateInput = Parameters<typeof createPolicy>[1];
    const withMode = (mode: unknown): CreateInput => ({ name: 'x', cedar: FORBID_DELETE, mode }) as unknown as CreateInput;

    it('"enforce" is accepted and means a normal policy; nothing is stored for it', async () => {
      const created = await createPolicy(tenant, { policyId: 'old-client', ...withMode('enforce') }, 'u');
      expect(created.enabled).toBe(true);
      const stored = await runWithTenantScope(tenant, (db) => db.iamDocGet('iam_policies', 'old-client'));
      expect(stored?.data).not.toHaveProperty('mode');
      expect((await updatePolicy(tenant, 'old-client', { ...withMode('enforce'), enabled: false }, 'u')).enabled).toBe(false);
    });

    it('"monitor" and anything else is refused as a validation error, on create and on update, and changes nothing', async () => {
      await createPolicy(tenant, { policyId: 'keep', name: 'keep', cedar: FORBID_DELETE }, 'u');
      const version = await getPolicyVersion(tenant);
      for (const mode of ['monitor', 'weird', 5, null]) {
        await expect(createPolicy(tenant, { policyId: 'new', ...withMode(mode) }, 'u'), String(mode)).rejects.toMatchObject({ name: 'IamPolicyError', code: 'validation' });
        await expect(updatePolicy(tenant, 'keep', { mode } as never, 'u'), String(mode)).rejects.toMatchObject({ code: 'validation' });
      }
      const monitor = await createPolicy(tenant, { policyId: 'new', ...withMode('monitor') }, 'u').catch((e: unknown) => e);
      expect((monitor as IamPolicyError).message).toMatch(/Monitor mode no longer exists/);
      expect((monitor as IamPolicyError).details[0].message).toMatch(/enabled or disabled/);
      expect(await getPolicy(tenant, 'new')).toBeNull();
      expect(await getPolicyVersion(tenant)).toBe(version);
      expect((await getPolicy(tenant, 'keep'))!.enabled).toBe(true);
    });

    it('a policy an earlier build stored in monitor mode reads as disabled and is replaced by the next save', async () => {
      const now = new Date().toISOString();
      await runWithTenantScope(tenant, async (db) => {
        for (const [id, extra] of [['was-monitor', { mode: 'monitor', enabled: true }], ['was-enforce', { mode: 'enforce', enabled: true }], ['no-mode', { enabled: true }], ['was-off', { mode: 'enforce', enabled: false }]] as const) {
          await db.iamDocPut('iam_policies', id, {
            _id: id, policyId: id, name: id, cedar: FORBID_DELETE, spec: null, createdBy: 'x', updatedBy: 'x', createdAt: now, updatedAt: now, ...extra,
          });
        }
      });
      const enabled = (id: string) => getPolicy(tenant, id).then((p) => p?.enabled);
      expect(await enabled('was-monitor')).toBe(false);
      expect(await enabled('was-enforce')).toBe(true);
      expect(await enabled('no-mode')).toBe(true);
      expect(await enabled('was-off')).toBe(false);
      expect((await listPolicies(tenant, { enabled: true })).map((p) => p.policyId).sort()).toEqual(['no-mode', 'was-enforce']);
      expect(await getPolicy(tenant, 'was-monitor')).not.toHaveProperty('mode');

      // enabling it is a deliberate act of its own, and the stored document stops carrying the old field
      const enabledNow = await updatePolicy(tenant, 'was-monitor', { enabled: true }, 'u');
      expect(enabledNow.enabled).toBe(true);
      const stored = await runWithTenantScope(tenant, (db) => db.iamDocGet('iam_policies', 'was-monitor'));
      expect(stored?.data).not.toHaveProperty('mode');
      expect(stored?.data.enabled).toBe(true);
    });

    it('any other save of a monitor-mode policy keeps it disabled', async () => {
      const now = new Date().toISOString();
      await runWithTenantScope(tenant, (db) => db.iamDocPut('iam_policies', 'quiet', {
        _id: 'quiet', policyId: 'quiet', name: 'quiet', cedar: FORBID_DELETE, spec: null, mode: 'monitor', enabled: true,
        createdBy: 'x', updatedBy: 'x', createdAt: now, updatedAt: now,
      }));
      const renamed = await updatePolicy(tenant, 'quiet', { name: 'renamed' }, 'u');
      expect(renamed.enabled).toBe(false);
      expect((await runWithTenantScope(tenant, (db) => db.iamDocGet('iam_policies', 'quiet')))?.data.enabled).toBe(false);
    });
  });

  it('keeps tenants separate', async () => {
    const other = `${tenant}_x`;
    await createPolicy(tenant, { policyId: 'p', name: 'p', cedar: FORBID_DELETE }, 'u');
    expect(await listPolicies(other)).toEqual([]);
    expect(await getPolicyVersion(other)).toBe(0);
    expect(await getPolicyVersion(tenant)).toBe(1);
  });

  it('maps Cedar ids back to policy ids', () => {
    expect(customCedarIds('a', 1)).toEqual(['custom:a']);
    expect(customCedarIds('a', 3)).toEqual(['custom:a#0', 'custom:a#1', 'custom:a#2']);
    expect(policyIdFromCedarId('custom:a')).toBe('a');
    expect(policyIdFromCedarId('custom:a#2')).toBe('a');
    expect(policyIdFromCedarId('managed:rbac:user-read')).toBeNull();
  });
});
