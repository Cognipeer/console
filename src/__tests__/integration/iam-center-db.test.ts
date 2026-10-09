/**
 * Authorization center persistence and previews on BOTH backends: policies with a
 * spec, the tenant settings, the monitor aggregates and the impact preview.
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
import { previewPolicy, PreviewInputError } from '@/lib/iam/preview';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { compileSpec, compileSpecToCedar, parsePolicySpec, type PolicySpec } from '@/lib/iam/policySpec';
import {
  clearPolicyMonitorStats,
  flushShadowEvents,
  getPolicyMonitorTotals,
  listShadowEntries,
  recordShadowEvent,
  resetShadowBufferForTests,
  summarizeShadowEntries,
} from '@/lib/iam/shadow';
import { shadowDocId } from '@/lib/iam/shadow/aggregate';
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
      const created = await createPolicy(tenant, { policyId: 'with-spec', name: 'S', cedar: out.cedar, spec: out.spec!, mode: 'monitor' }, 'u1');
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

  describe('monitor aggregates', () => {
    const event = (policyId: string, extra: Record<string, unknown> = {}) => ({
      category: 'policy-monitor' as const, service: 'agents', method: 'POST', route: '/api/agents', legacyAllowed: true, targetAllowed: false, policyId,
      sample: { requestId: 'r', userId: 'u', role: 'user', at: new Date().toISOString() }, ...extra,
    });

    it('count per policy, route and direction, survive a flush, and are cleared per policy', async () => {
      resetShadowBufferForTests();
      for (let i = 0; i < 3; i++) recordShadowEvent(tenant, event('pol-a'));
      recordShadowEvent(tenant, event('pol-a', { route: '/api/agents/:id' }));
      recordShadowEvent(tenant, event('pol-a', { legacyAllowed: false, targetAllowed: true }));
      for (let i = 0; i < 2; i++) recordShadowEvent(tenant, event('pol-b'));
      await flushShadowEvents(tenant);

      let totals = await getPolicyMonitorTotals(tenant);
      expect(totals.get('pol-a')).toMatchObject({ wouldDeny: 4, wouldAllow: 1 });
      expect(totals.get('pol-b')).toMatchObject({ wouldDeny: 2, wouldAllow: 0 });
      const entries = (await listShadowEntries(tenant)).filter((e) => e.category === 'policy-monitor');
      expect(entries).toHaveLength(4); // a-POST, a-POST-id, a-reverse, b
      expect(entries.every((e) => typeof e.policyId === 'string')).toBe(true);

      // more events accumulate onto the stored aggregate
      recordShadowEvent(tenant, event('pol-a'));
      await flushShadowEvents(tenant);
      expect((await getPolicyMonitorTotals(tenant)).get('pol-a')).toMatchObject({ wouldDeny: 5 });

      // clearing one policy touches neither the other policy nor pending events of others
      recordShadowEvent(tenant, event('pol-a')); // still pending
      recordShadowEvent(tenant, event('pol-b'));
      expect(await clearPolicyMonitorStats(tenant, 'pol-a')).toBe(3);
      totals = await getPolicyMonitorTotals(tenant);
      expect(totals.has('pol-a')).toBe(false);
      expect(totals.get('pol-b')).toMatchObject({ wouldDeny: 3 });
      expect(await clearPolicyMonitorStats(tenant, 'pol-a')).toBe(0);
      await clearPolicyMonitorStats(tenant, 'pol-b');
    });

    it('stay out of the engine report, and leave the ids of the other categories unchanged', async () => {
      recordShadowEvent(tenant, event('pol-x'));
      recordShadowEvent(tenant, {
        category: 'token-groups', service: 'agents', method: 'GET', route: '/api/agents', legacyAllowed: false, targetAllowed: true,
        sample: { requestId: 'r', userId: 'u', role: 'user', at: new Date().toISOString() },
      });
      await flushShadowEvents(tenant);
      const entries = await listShadowEntries(tenant);
      const summary = summarizeShadowEntries(entries);
      expect(summary.totals.events).toBe(1);
      expect(summary.categories.map((c) => c.category)).toEqual(['parity-mismatch', 'token-groups', 'project-narrowing', 'unmapped-path']);
      expect(summary.topRoutes.every((r) => r.category !== 'policy-monitor')).toBe(true);
      expect(summarizeShadowEntries(entries, { category: 'policy-monitor' }).topRoutes.map((r) => r.policyId)).toEqual(['pol-x']);

      // ids of pre-existing categories do not depend on the new policy field (no re-keying of stored aggregates)
      const { createHash } = await import('node:crypto');
      const legacyId = (e: { category: string; service: string; method: string; route: string; legacyAllowed: boolean; targetAllowed: boolean }) =>
        `agg:${createHash('sha1').update([e.category, e.service, e.method, e.route, e.legacyAllowed ? '1' : '0', e.targetAllowed ? '1' : '0'].join('|')).digest('hex').slice(0, 24)}`;
      const sample = { category: 'token-groups' as const, service: 'agents', method: 'GET', route: '/api/agents', legacyAllowed: false, targetAllowed: true };
      expect(shadowDocId(sample)).toBe(legacyId(sample));
      expect(shadowDocId({ ...sample, category: 'policy-monitor', policyId: 'pol-x' })).not.toBe(shadowDocId({ ...sample, category: 'policy-monitor', policyId: 'pol-y' }));
      await clearPolicyMonitorStats(tenant, 'pol-x');
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

    it('does not change anything: no policy, no audit row, no monitor count, no set leak between previews', async () => {
      const before = (await listPolicies(tenant)).length;
      const rows = (await db.runWithTenant!(tenant, () => db.iamListAuditEvents({ tenantId, limit: 200 }))).items.length;
      await previewPolicy(tenantRef(), { spec: specOf() });
      expect((await listPolicies(tenant)).length).toBe(before);
      expect((await db.runWithTenant!(tenant, () => db.iamListAuditEvents({ tenantId, limit: 200 }))).items.length).toBe(rows);
      await flushShadowEvents(tenant);
      expect([...(await getPolicyMonitorTotals(tenant)).keys()]).toEqual([]);
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

    it('says how many people it looked at, and that a big audience was only sampled', async () => {
      const group = await previewPolicy(tenantRef(), { spec: specOf({ principals: { groups: [engineering] } }) });
      expect(group.principals).toEqual({ evaluated: 2, targeted: 2 });
      expect(group.truncated).toBe(false);
      const named = await previewPolicy(tenantRef(), { spec: specOf({ principals: { users: [userIds.alice, userIds.bob, userIds.carol] } }) });
      expect(named.principals).toEqual({ evaluated: 3, targeted: 3 });
      expect(named.truncated).toBe(false);
      // everyone: the policy reaches the whole directory, the preview only a spread of it
      const everyone = await previewPolicy(tenantRef(), { spec: specOf({ principals: { any: true } }) });
      expect(everyone.principals.targeted).toBeNull();
      expect(everyone.principals.evaluated).toBeGreaterThan(0);
      expect(everyone.truncated).toBe(true);
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
