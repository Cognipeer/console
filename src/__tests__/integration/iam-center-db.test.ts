/**
 * Authorization center persistence and previews on BOTH backends: policies with a
 * spec, the tenant settings and the impact preview (its audience, its bounds).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

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

import type { DatabaseProvider } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { onIamInvalidation, type IamInvalidation } from '@/lib/iam/events';
import { DEADLINE_MS, MAX_EVALUATIONS, MAX_PRINCIPALS, holdPreviewForTests, previewPolicy, PreviewInputError } from '@/lib/iam/preview';
import { getPrincipalCacheStats, resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { compileSpec, compileSpecToCedar, parsePolicySpec, type PolicySpec } from '@/lib/iam/policySpec';
import { getIamSettings, getIamSettingsRecord, resetIamSettingsCacheForTests, updateIamSettings } from '@/lib/iam/settings';
import { IamPolicyError, createPolicy, deletePolicy, getPolicy, listPolicies, updatePolicy } from '@/lib/iam/store';
import { describeForEachProvider } from './db-parity.helper';

const specOf = (over: Partial<PolicySpec> = {}): PolicySpec => ({
  effect: 'forbid', principals: { any: true }, actions: ['agents.write'], resources: { any: true }, ...over,
});
const normalized = (spec: PolicySpec): PolicySpec => {
  const r = parsePolicySpec(spec);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
};

describeForEachProvider('Authorization center persistence', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenant: string;
  const userIds: Record<string, string> = {};
  let engineering: string;

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `iamcdb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tenant = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'CDB', slug, dbName: tenant, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.runWithTenant!(tenant, async () => {
      for (const [name, role] of [['owner', 'owner'], ['admin', 'admin'], ['alice', 'user'], ['bob', 'user'], ['carol', 'user']] as const) {
        userIds[name] = String((await db.createUser({ tenantId, email: `${name}@cdb.example`, name, password: 'h', role, licenseId: 'FREE', features: [] }))._id);
      }
      const group = await db.createGroup({ tenantId, name: 'Engineering', createdBy: 't', source: 'local' } as never);
      engineering = String(group._id);
      for (const name of ['alice', 'bob']) await db.addGroupMember({ groupId: engineering, userId: userIds[name], tenantId, role: 'member' });
    });
    configureIamEngine({ validateRequests: false });
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
  });

  describe('policies with a spec', () => {
    it('stores the spec next to its Cedar and hands both back', async () => {
      const spec = normalized(specOf({ principals: { groups: [engineering] }, conditions: { channels: ['api'], ipRanges: ['10.0.0.0/8'] } }));
      const out = await compileSpec(spec, { tenantDbName: tenant, tenantId });
      expect(out.ok, JSON.stringify(out.errors)).toBe(true);
      const created = await createPolicy(tenant, { policyId: 'with-spec', name: 'S', cedar: out.cedar, spec: out.spec!, enabled: false }, 'u1');
      expect(created.enabled).toBe(false);
      expect(created.spec).toEqual(spec);
      const read = await getPolicy(tenant, 'with-spec');
      expect(read!.spec).toEqual(spec);
      expect(read!.cedar).toBe(out.cedar);
      expect((await listPolicies(tenant)).find((p) => p.policyId === 'with-spec')!.spec).toEqual(spec);
    });

    it('refuses a spec whose Cedar was edited behind its back, on create and on update', async () => {
      const spec = normalized(specOf());
      const cedar = compileSpecToCedar(spec);
      await expect(createPolicy(tenant, { name: 'x', cedar: `${cedar}\n// tampered`, spec }, 'u')).rejects.toMatchObject({ code: 'invalid_input' });
      await createPolicy(tenant, { policyId: 'guarded', name: 'g', cedar, spec }, 'u');
      await expect(updatePolicy(tenant, 'guarded', { cedar: 'forbid(principal, action, resource);', spec }, 'u')).rejects.toBeInstanceOf(IamPolicyError);
      await expect(updatePolicy(tenant, 'guarded', { spec }, 'u')).rejects.toMatchObject({ code: 'invalid_input' }); // a spec travels with its Cedar
      expect((await getPolicy(tenant, 'guarded'))!.cedar).toBe(cedar);
      await deletePolicy(tenant, 'guarded');
    });

    it('turns raw when the Cedar is replaced without a spec, and back to a form when a spec comes with it', async () => {
      const spec = normalized(specOf());
      await createPolicy(tenant, { policyId: 'flip', name: 'f', cedar: compileSpecToCedar(spec), spec }, 'u');
      const raw = await updatePolicy(tenant, 'flip', { cedar: 'forbid(principal, action == Action::"models.write", resource is Service);' }, 'u');
      expect(raw.spec).toBeNull();
      expect((await getPolicy(tenant, 'flip'))!.spec).toBeNull();
      const other = normalized(specOf({ actions: ['Write'] }));
      const back = await updatePolicy(tenant, 'flip', { cedar: compileSpecToCedar(other), spec: other }, 'u');
      expect(back.spec).toEqual(other);
      // a change that does not touch the Cedar keeps the spec
      const renamed = await updatePolicy(tenant, 'flip', { name: 'renamed', enabled: false }, 'u');
      expect(renamed.spec).toEqual(other);
      await deletePolicy(tenant, 'flip');
    });

    it('reads a policy stored before specs existed (no spec key) as raw Cedar', async () => {
      await db.runWithTenant!(tenant, async () => {
        const now = new Date().toISOString();
        await db.iamDocPut('iam_policies', 'legacy-row', {
          _id: 'legacy-row', policyId: 'legacy-row', name: 'old', cedar: 'forbid(principal, action == Action::"tool.delete", resource is Tool);',
          mode: 'enforce', enabled: true, createdBy: 'x', updatedBy: 'x', createdAt: now, updatedAt: now,
        });
      });
      expect((await getPolicy(tenant, 'legacy-row'))!.spec).toBeNull();
      expect((await getPolicy(tenant, 'legacy-row'))!.cedar).toContain('tool.delete');
      await deletePolicy(tenant, 'legacy-row');
    });
  });

  describe('tenant settings', () => {
    it('defaults, merges, persists and is isolated per tenant', async () => {
      resetIamSettingsCacheForTests();
      expect(await getIamSettings(tenant)).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
      expect((await getIamSettingsRecord(tenant)).updatedBy).toBeNull();

      expect(await updateIamSettings(tenant, { tokens: { maxLifetimeDays: 60 } }, 'u1')).toEqual({ tokens: { maxLifetimeDays: 60, requireExpiry: false } });
      expect(await updateIamSettings(tenant, { tokens: { requireExpiry: true } }, 'u2')).toEqual({ tokens: { maxLifetimeDays: 60, requireExpiry: true } });
      resetIamSettingsCacheForTests(); // as if read by another node
      expect(await getIamSettings(tenant)).toEqual({ tokens: { maxLifetimeDays: 60, requireExpiry: true } });
      const record = await getIamSettingsRecord(tenant);
      expect(record).toMatchObject({ updatedBy: 'u2' });
      expect(typeof record.updatedAt).toBe('string');

      // a copy: mutating the answer changes nothing
      const copy = await getIamSettings(tenant);
      copy.tokens.maxLifetimeDays = 1;
      expect((await getIamSettings(tenant)).tokens.maxLifetimeDays).toBe(60);

      expect(await getIamSettings(`${tenant}_other`)).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
      await expect(updateIamSettings(tenant, { tokens: { maxLifetimeDays: 0 } }, 'u')).rejects.toThrow();
      expect(await updateIamSettings(tenant, { tokens: { maxLifetimeDays: null, requireExpiry: false } }, 'u')).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
    });

    it('a stored document that is damaged reads as the defaults', async () => {
      await db.runWithTenant!(tenant, () => db.iamDocPut('iam_meta', 'settings', { tokens: { maxLifetimeDays: 'forever', requireExpiry: 'maybe' } }));
      resetIamSettingsCacheForTests();
      expect(await getIamSettings(tenant)).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
      await db.runWithTenant!(tenant, () => db.iamDocDelete('iam_meta', 'settings'));
      resetIamSettingsCacheForTests();
    });
  });

  describe('impact preview', () => {
    const tenantRef = () => ({ tenantDbName: tenant, tenantId });

    it('evaluates the current set against the draft over the people it targets', async () => {
      const spec = specOf({ principals: { groups: [engineering] } });
      const result = await previewPolicy(tenantRef(), { spec });
      expect(result.truncated).toBe(false);
      expect(result.evaluated).toBeGreaterThanOrEqual(2);
      expect(result.flips).toEqual({ allowToDeny: 2, denyToAllow: 0 }); // alice and bob, agents.write
      expect(result.samples.map((s) => s.principal.label).sort()).toEqual(['alice', 'bob']);
      expect(result.samples.every((s) => s.action === 'agents.write' && s.before && !s.after)).toBe(true);
    });

    it('is bounded by the evaluation count and by time, and says so', async () => {
      const wide = specOf({ actions: ['Read', 'Write', 'Admin'], principals: { any: true } });
      const capped = await previewPolicy(tenantRef(), { spec: wide }, { maxEvaluations: 25 });
      expect(capped.evaluated).toBeLessThanOrEqual(25);
      expect(capped.truncated).toBe(true);
      const full = await previewPolicy(tenantRef(), { spec: wide });
      expect(full.evaluated).toBeGreaterThan(25);
      expect(full.evaluated).toBeLessThanOrEqual(2000);
      const timed = await previewPolicy(tenantRef(), { spec: wide }, { deadlineMs: 1 });
      expect(timed.evaluated).toBeLessThan(full.evaluated);
      expect(timed.truncated).toBe(true);
    });

    it('does not change anything: no policy, no audit row, nothing in the principal cache', async () => {
      const before = (await listPolicies(tenant)).length;
      const rows = (await db.runWithTenant!(tenant, () => db.iamListAuditEvents({ tenantId, limit: 200 }))).items.length;
      resetPrincipalCacheForTests();
      await previewPolicy(tenantRef(), { spec: specOf({ principals: { any: true } }) });
      expect((await listPolicies(tenant)).length).toBe(before);
      expect((await db.runWithTenant!(tenant, () => db.iamListAuditEvents({ tenantId, limit: 200 }))).items.length).toBe(rows);
      // a preview walks many people: it must not push the hot entries of live traffic out of the cache
      expect(getPrincipalCacheStats().entries).toBe(0);
    });

    it('answers previews of different workspaces concurrently and independently', async () => {
      // Each preview owns one pair of preparsed Cedar sets for its whole run, so they cannot trample each other.
      const slug = `iamcdb-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const otherTenant = `tenant_${slug}`;
      const otherId = String((await db.createTenant({ companyName: 'CDB2', slug, dbName: otherTenant, licenseType: 'FREE', ownerId: 'x' }))._id);
      const otherUsers: Record<string, string> = {};
      await db.runWithTenant!(otherTenant, async () => {
        for (const name of ['dora', 'erol']) {
          otherUsers[name] = String((await db.createUser({ tenantId: otherId, email: `${name}@cdb2.example`, name, password: 'h', role: 'user', licenseId: 'FREE', features: [] }))._id);
        }
      });
      const results = await Promise.all([
        previewPolicy(tenantRef(), { spec: specOf({ principals: { users: [userIds.alice] } }) }),
        previewPolicy({ tenantDbName: otherTenant, tenantId: otherId }, { spec: specOf({ principals: { users: [otherUsers.dora] } }) }),
        previewPolicy({ tenantDbName: otherTenant, tenantId: otherId }, { spec: specOf({ principals: { users: [otherUsers.erol] } }) }).catch((e) => e),
      ]);
      expect(results[0].samples.map((s) => s.principal.label)).toEqual(['alice']);
      expect(results[1].samples.map((s) => s.principal.label)).toEqual(['dora']);
      // ... but ONE preview per workspace at a time: the second of the same workspace is refused, not queued
      expect(results[2]).toBeInstanceOf(PreviewInputError);
      expect(results[2]).toMatchObject({ code: 'rate_limited', status: 429 });
      // and once the first is over the workspace can preview again
      const again = await previewPolicy({ tenantDbName: otherTenant, tenantId: otherId }, { spec: specOf({ principals: { users: [otherUsers.erol] } }) });
      expect(again.samples.map((s) => s.principal.label)).toEqual(['erol']);
    });

    it('more previews than slots wait for a free pair of sets and all complete', async () => {
      const many = await Promise.all(
        Array.from({ length: 7 }, async (_, i) => {
          const slug = `iamcdb-m${i}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const dbName = `tenant_${slug}`;
          const id = String((await db.createTenant({ companyName: `M${i}`, slug, dbName, licenseType: 'FREE', ownerId: 'x' }))._id);
          let uid = '';
          await db.runWithTenant!(dbName, async () => {
            uid = String((await db.createUser({ tenantId: id, email: `u${i}@m.example`, name: `u${i}`, password: 'h', role: 'user', licenseId: 'FREE', features: [] }))._id);
          });
          return previewPolicy({ tenantDbName: dbName, tenantId: id }, { spec: specOf({ principals: { users: [uid] } }) }).then((r) => r.samples.map((s) => s.principal.label));
        }),
      );
      expect(many).toEqual(Array.from({ length: 7 }, (_, i) => [`u${i}`]));
    }, 60_000);

    it('says how many people it looked at: exact for a named audience and for a directory it listed to its end', async () => {
      const group = await previewPolicy(tenantRef(), { spec: specOf({ principals: { groups: [engineering] } }) });
      expect(group.principals).toEqual({ evaluated: 2, targeted: 2 });
      expect(group.truncated).toBe(false);
      const named = await previewPolicy(tenantRef(), { spec: specOf({ principals: { users: [userIds.alice, userIds.bob, userIds.carol] } }) });
      expect(named.principals).toEqual({ evaluated: 3, targeted: 3 });
      expect(named.truncated).toBe(false);
      // everyone, in a workspace the preview can list completely: owner, admin, alice, bob, carol - nobody was left out
      const everyone = await previewPolicy(tenantRef(), { spec: specOf({ principals: { any: true } }) });
      expect(everyone.principals).toEqual({ evaluated: 5, targeted: 5 });
      expect(everyone.truncated).toBe(false);
      expect(everyone.flips.allowToDeny).toBe(5); // all five can write agents today
    });

    it('checks the tokens of the people a policy names, and counts a policy about everybody over users and tokens', async () => {
      const token = await db.runWithTenant!(tenant, () => db.createApiToken({
        tenantId, userId: userIds.alice, label: 'alice-ci', tokenHash: `h-${Math.random()}`, tokenPrefix: 'cp_test', createdBy: userIds.alice,
      } as never));
      try {
        const named = await previewPolicy(tenantRef(), { spec: specOf({ principals: { users: [userIds.alice] } }) });
        expect(named.samples.map((s) => `${s.principal.type}:${s.principal.label}`).sort()).toEqual(['token:alice-ci', 'user:alice']);
        expect(named.principals.evaluated).toBe(2); // the person and the token
        expect(named.truncated).toBe(false);
        const everyone = await previewPolicy(tenantRef(), { spec: specOf({ principals: { any: true } }) });
        expect(everyone.principals).toEqual({ evaluated: 6, targeted: 6 });
      } finally {
        await db.runWithTenant!(tenant, () => db.deleteApiToken(String(token._id), userIds.alice));
      }
    });

    it('stops at the limits it exports and says it only looked at a sample', async () => {
      expect({ MAX_PRINCIPALS, MAX_EVALUATIONS, DEADLINE_MS }).toEqual({ MAX_PRINCIPALS: 1000, MAX_EVALUATIONS: 20_000, DEADLINE_MS: 5_000 });
      // the budget is people x actions: ten evaluations cannot cover five people x three levels
      const result = await previewPolicy(tenantRef(), { spec: specOf({ actions: ['Read', 'Write', 'Admin'], principals: { any: true } }) }, { maxEvaluations: 10 });
      expect(result.evaluated).toBeLessThanOrEqual(10);
      expect(result.truncated).toBe(true);
      expect(result.principals.targeted).toBe(5);
      expect(result.principals.evaluated).toBeLessThan(5);
    });

    it('refuses a second preview of a workspace that already has one running', async () => {
      const release = holdPreviewForTests(tenant);
      try {
        await expect(previewPolicy(tenantRef(), { spec: specOf() })).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
      } finally {
        release();
      }
      expect((await previewPolicy(tenantRef(), { spec: specOf({ principals: { users: [userIds.carol] } }) })).samples.map((s) => s.principal.label)).toEqual(['carol']);
    });

    // The access check says the owner's own session keeps the Authorization Engine whatever a rule says (owner safety):
    // the preview must not list the owner as losing it to a rule on `iam`.
    it('does not list the workspace owner\'s session as losing the Authorization Engine to a rule on iam (owner safety)', async () => {
      const result = await previewPolicy(tenantRef(), { spec: specOf({ principals: { any: true }, actions: ['iam.write'] }) });
      expect(result.principals).toEqual({ evaluated: 5, targeted: 5 });
      expect(result.flips).toEqual({ allowToDeny: 1, denyToAllow: 0 }); // the admin; the owner keeps the engine, plain members never had it
      expect(result.samples.map((s) => s.principal.label)).toEqual(['admin']);
      // any other service is not covered by the promise: the owner is listed there
      const other = await previewPolicy(tenantRef(), { spec: specOf({ principals: { users: [userIds.owner] }, actions: ['models.write'] }) });
      expect(other.samples.map((s) => s.principal.label)).toEqual(['owner']);
    });

    it('covers the people of the version an edit replaces', async () => {
      const spec = normalized(specOf({ principals: { users: [userIds.alice] } }));
      await createPolicy(tenant, { policyId: 'edited', name: 'e', cedar: compileSpecToCedar(spec), spec }, 'u');
      try {
        const edit = await previewPolicy(tenantRef(), { policyId: 'edited', spec: specOf({ principals: { users: [userIds.bob] } }) });
        expect(edit.flips).toEqual({ allowToDeny: 1, denyToAllow: 1 }); // bob loses, alice is freed
        const unchanged = await previewPolicy(tenantRef(), { policyId: 'edited' });
        expect(unchanged.flips).toEqual({ allowToDeny: 0, denyToAllow: 0 });
      } finally {
        await deletePolicy(tenant, 'edited');
      }
    });

    it('rejects drafts it cannot evaluate', async () => {
      await expect(previewPolicy(tenantRef(), {})).rejects.toBeInstanceOf(PreviewInputError);
      await expect(previewPolicy(tenantRef(), { spec: specOf(), cedar: 'x' })).rejects.toMatchObject({ code: 'validation' });
      await expect(previewPolicy(tenantRef(), { spec: specOf({ actions: ['nope'] }) })).rejects.toMatchObject({ code: 'validation' });
      await expect(previewPolicy(tenantRef(), { cedar: 'nonsense' })).rejects.toMatchObject({ code: 'validation', status: 400 });
      await expect(previewPolicy(tenantRef(), { policyId: 'missing' })).rejects.toMatchObject({ code: 'not_found', status: 404 });
      // another workspace's group is not a thing here
      await expect(previewPolicy({ tenantDbName: `${tenant}_x`, tenantId: 'someone-else' }, { spec: specOf({ principals: { groups: [engineering] } }) }))
        .rejects.toMatchObject({ code: 'validation' });
    });
  });

  describe('a directory bigger than the preview looks at', () => {
    const PEOPLE = MAX_PRINCIPALS + 40;
    let bigTenant: string;
    let bigTenantId: string;

    beforeAll(async () => {
      const slug = `iamcdb-big-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      bigTenant = `tenant_${slug}`;
      bigTenantId = String((await db.createTenant({ companyName: 'BIG', slug, dbName: bigTenant, licenseType: 'FREE', ownerId: 'x' }))._id);
      await db.runWithTenant!(bigTenant, async () => {
        const make = (email: string, role: 'owner' | 'admin' | 'user') =>
          db.createUser({ tenantId: bigTenantId, email, name: email, password: 'h', role, licenseId: 'FREE', features: [] });
        await make('boss@big.example', 'owner');
        for (let i = 0; i < 3; i++) await make(`admin${i}@big.example`, 'admin');
        for (let i = 0; i < PEOPLE - 4; i++) await make(`user${i}@big.example`, 'user');
      });
    }, 120_000);

    it('looks at MAX_PRINCIPALS of them, owners and admins first, and does not claim to know how many it reaches', async () => {
      // `models.admin` is something only an owner or an admin has, so the flips tell who was looked at.
      const result = await previewPolicy({ tenantDbName: bigTenant, tenantId: bigTenantId }, { spec: specOf({ actions: ['models.admin'], principals: { any: true } }) });
      expect(result.principals.evaluated).toBeLessThanOrEqual(MAX_PRINCIPALS);
      expect(result.principals.evaluated).toBeGreaterThan(100); // (how many more depends on the machine: the preview also has a time budget)
      expect(result.principals.targeted).toBeNull();
      expect(result.truncated).toBe(true);
      expect(result.flips).toEqual({ allowToDeny: 4, denyToAllow: 0 }); // the owner and the three admins, whoever else was left out
    }, 60_000);

    it('a group of that size is sampled too, but its size is known', async () => {
      const group = await db.runWithTenant!(bigTenant, async () => {
        const g = await db.createGroup({ tenantId: bigTenantId, name: 'Everybody', createdBy: 't', source: 'local' } as never);
        const users = await db.iamListUsers({ tenantId: bigTenantId, roles: ['user'], limit: 200 });
        for (const u of users.items) await db.addGroupMember({ groupId: String(g._id), userId: String(u._id), tenantId: bigTenantId, role: 'member' });
        return { id: String(g._id), size: users.items.length };
      });
      const result = await previewPolicy({ tenantDbName: bigTenant, tenantId: bigTenantId }, { spec: specOf({ principals: { groups: [group.id] } }) });
      expect(result.principals).toEqual({ evaluated: group.size, targeted: group.size });
      expect(result.truncated).toBe(false);
    }, 60_000);
  });

  it('every policy write signals the engine', async () => {
    const events: IamInvalidation[] = [];
    const off = onIamInvalidation((e) => events.push(e));
    try {
      const spec = normalized(specOf());
      await createPolicy(tenant, { policyId: 'sig', name: 's', cedar: compileSpecToCedar(spec), spec }, 'u');
      await updatePolicy(tenant, 'sig', { enabled: false }, 'u');
      await deletePolicy(tenant, 'sig');
      expect(events.filter((e) => e.kind === 'tenant-policies' && e.tenantDbName === tenant)).toHaveLength(3);
    } finally {
      off();
    }
  });
});
