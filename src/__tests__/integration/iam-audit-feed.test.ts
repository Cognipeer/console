/**
 * The audit tab's feed (src/lib/iam/auditFeed.ts) on BOTH backends: the denials
 * the policy engine produced - including the "authorization unavailable" refusals
 * - and the changes made to policies and settings. The dry-run feed of the removed
 * monitor mode is gone, and so are the rows of the removed mode switch.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

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

import type { DatabaseProvider } from '@/lib/database';
import { IAM_CHANGE_RESOURCE_TYPES } from '@/lib/iam/audit';
import { AUDIT_KINDS, TOKEN_RESTRICTIONS_EVENT, listAuditFeed, type AuditFeedQuery } from '@/lib/iam/auditFeed';
import { DECISION_ID_RE, getDecision } from '@/lib/iam/decisions';
import { describeForEachProvider } from './db-parity.helper';

describe('the kinds of feed', () => {
  it('are the denials and the changes - nothing else', () => {
    expect([...AUDIT_KINDS]).toEqual(['denials', 'changes']);
    expect([...IAM_CHANGE_RESOURCE_TYPES]).toEqual(['iam-policy', 'iam-settings']);
  });
});

describeForEachProvider('Authorization audit feed', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  let alice: string;
  let tokenId: string;
  const tenant = () => ({ tenantDbName, tenantId });
  const query = (over: Partial<AuditFeedQuery> = {}): AuditFeedQuery => ({ kind: 'denials', limit: 50, offset: 0, ...over });

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `iamaf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tenantDbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'AF', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.switchToTenant(tenantDbName);
    await db.runWithTenant!(tenantDbName, async () => {
      alice = String((await db.createUser({ tenantId, email: 'alice@af.example', name: 'Alice', password: 'h', role: 'user', licenseId: 'FREE', features: [] }))._id);
      tokenId = String((await db.createApiToken({ tenantId, userId: alice, label: 'alice-ci', tokenHash: `h-${Math.random()}`, tokenPrefix: 'cp_af', createdBy: alice } as never))._id);

      const base = { tenantId, actorType: 'user' as const, actorUserId: alice, action: 'write' as const, outcome: 'denied' as const };
      // a refusal because the engine could not decide: a denial of the caller by us, with a decision id
      await db.createAuditLog({
        ...base, service: 'agents', event: 'POST /api/agents', method: 'POST', path: '/api/agents', statusCode: 503,
        metadata: { iamEnforce: true, code: 'authorization_unavailable', decisionId: 'dec-unavailable', deniedService: 'agents', required: 'write' },
      });
      await db.createAuditLog({
        ...base, service: 'models', action: 'read', event: 'GET /api/models', method: 'GET', path: '/api/models', statusCode: 503,
        metadata: { iamEnforce: true, code: 'authorization_unavailable', decisionId: 'dec-unavailable-get', deniedService: 'models', required: 'read' },
      });
      // an ordinary denial by a policy, one by the project, one for an undeclared route
      await db.createAuditLog({
        ...base, service: 'agents', event: 'DELETE /api/agents/x', method: 'DELETE', path: '/api/agents/x', statusCode: 403,
        metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-policy', deniedService: 'agents', required: 'write', policyIds: ['freeze'], reasons: ['custom:freeze'] },
      });
      await db.createAuditLog({
        ...base, service: 'agents', event: 'POST /api/agents/y', method: 'POST', path: '/api/agents/y', statusCode: 403,
        metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-project', deniedService: 'agents', required: 'write', reasons: ['managed:boundary:project-write'] },
      });
      await db.createAuditLog({
        ...base, service: 'agents', event: 'GET /api/new-thing', method: 'GET', path: '/api/new-thing', statusCode: 403,
        metadata: { iamEnforce: true, code: 'route_not_declared' },
      });
      // a token's refusal; the same refusal of the engine, but this is a plain 403 of something else (no iamEnforce): not part of the feed
      await db.createAuditLog({
        ...base, service: 'tools', event: 'POST /api/tools', method: 'POST', path: '/api/tools', apiTokenId: tokenId, actorType: 'api_token',
        metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-token', deniedService: 'tools', required: 'write', reasons: ['managed:boundary:token-cap-write'] },
      });
      await db.createAuditLog({ ...base, service: 'tools', event: 'POST /api/tools', method: 'POST', path: '/api/tools', metadata: { plain: true } });

      // changes: a policy, the settings, an old row of the mode switch that no longer exists, a token restriction
      const ok = { tenantId, actorType: 'user' as const, actorUserId: alice, actorEmail: 'alice@af.example', action: 'admin' as const, outcome: 'success' as const, service: 'iam' };
      await db.createAuditLog({
        ...ok, event: 'iam.policy.create', method: 'POST', path: '/api/iam/policies', resourceType: 'iam-policy', resourceId: 'freeze',
        metadata: { iamChange: true, policyId: 'freeze', name: 'Freeze agents', effect: 'forbid', enabled: false },
      });
      await db.createAuditLog({
        ...ok, event: 'iam.policy.update', method: 'PUT', path: '/api/iam/policies/freeze', resourceType: 'iam-policy', resourceId: 'freeze',
        metadata: { iamChange: true, policyId: 'freeze', name: 'Freeze agents', effect: 'forbid', enabled: true },
      });
      await db.createAuditLog({
        ...ok, event: 'iam.settings.update', method: 'PUT', path: '/api/iam/settings', resourceType: 'iam-settings',
        metadata: { iamChange: true, tokens: { maxLifetimeDays: 30, requireExpiry: true } },
      });
      await db.createAuditLog({
        ...ok, event: 'iam.mode.change', method: 'PUT', path: '/api/iam/mode', resourceType: 'iam-mode',
        metadata: { iamChange: true, from: 'shadow', to: 'enforce' },
      });
      await db.createAuditLog({
        ...ok, service: 'tokens', event: TOKEN_RESTRICTIONS_EVENT, method: 'PATCH', path: '/api/tokens/x', resourceType: 'api-token', resourceId: tokenId,
        metadata: { label: 'alice-ci', before: { expiresAt: null, allowedIpRangeCount: 0 }, after: { expiresAt: '2027-01-01T00:00:00.000Z', allowedIpRangeCount: 2 } },
      });
    });
  });

  describe('denials', () => {
    it('lists the refusals because the engine could not decide, with their decision id, as a sentence of their own', async () => {
      const page = await listAuditFeed(tenant(), query());
      const unavailable = page.items.filter((i) => i.code === 'authorization_unavailable');
      expect(unavailable.map((i) => i.decisionId).sort()).toEqual(['dec-unavailable', 'dec-unavailable-get']);
      for (const item of unavailable) {
        expect(item).toMatchObject({ kind: 'denials', principal: { type: 'user', id: alice, label: 'Alice' } });
        expect(item.text).toEqual({ key: 'unavailable', params: { route: `${item.method} ${item.route}` } });
        expect(item.summary).toBe(`Refused ${item.method} ${item.route}: authorization was temporarily unavailable`);
      }
      // a GET is refused, and listed, too
      expect(unavailable.find((i) => i.method === 'GET')).toMatchObject({ service: 'models', route: '/api/models' });
    });

    it('words the other denials by what decided them', async () => {
      const page = await listAuditFeed(tenant(), query());
      const by = (decisionId: string) => page.items.find((i) => i.decisionId === decisionId)!;
      expect(by('dec-policy')).toMatchObject({ policyId: 'freeze', action: 'agents.write', text: { key: 'denied.policy', params: expect.objectContaining({ policies: 'freeze' }) } });
      expect(by('dec-project').text?.key).toBe('denied.project');
      expect(by('dec-token')).toMatchObject({ principal: { type: 'token', id: tokenId, label: 'alice-ci' }, text: { key: 'denied.tokenScope' } });
      expect(page.items.find((i) => i.code === 'route_not_declared')?.text?.key).toBe('undeclared');
    });

    it('lists only what the gates wrote as a decision of the engine', async () => {
      const page = await listAuditFeed(tenant(), query());
      expect(page.items).toHaveLength(6);
      expect(page.items.every((i) => i.kind === 'denials')).toBe(true);
      expect(page.hasMore).toBe(false);
    });

    it('filters by service and by person, and pages', async () => {
      expect((await listAuditFeed(tenant(), query({ service: 'models' }))).items.map((i) => i.decisionId)).toEqual(['dec-unavailable-get']);
      expect((await listAuditFeed(tenant(), query({ principalType: 'token', principalId: tokenId }))).items.map((i) => i.decisionId)).toEqual(['dec-token']);
      const first = await listAuditFeed(tenant(), query({ limit: 4 }));
      expect(first.items).toHaveLength(4);
      expect(first.hasMore).toBe(true);
      const second = await listAuditFeed(tenant(), query({ limit: 4, offset: 4 }));
      expect(second.items).toHaveLength(2);
      expect(second.hasMore).toBe(false);
    });
  });

  describe('changes', () => {
    it('lists the policy and settings changes, in the words of the engine-only product (enabled or disabled)', async () => {
      const page = await listAuditFeed(tenant(), query({ kind: 'changes' }));
      const byAction = (action: string) => page.items.filter((i) => i.action === action);
      expect(byAction('iam.policy.create')[0]).toMatchObject({
        policyId: 'freeze', actor: 'alice@af.example', summary: 'Created policy "Freeze agents" (forbid, disabled)',
        text: { key: 'policy.created', params: { name: 'Freeze agents', effect: 'forbid', enabled: 0 } },
      });
      expect(byAction('iam.policy.update')[0]).toMatchObject({
        summary: 'Updated policy "Freeze agents" (forbid)',
        text: { key: 'policy.updated', params: { name: 'Freeze agents', effect: 'forbid', enabled: 1 } },
      });
      expect(byAction('iam.settings.update')[0].text?.key).toBe('settings.updated');
      expect(byAction(TOKEN_RESTRICTIONS_EVENT)[0]).toMatchObject({ service: 'tokens', text: { key: 'token.restrictions' } });
      for (const item of page.items) expect(item.text?.params).not.toHaveProperty('mode');
    });

    it('does not list the rows the removed mode switch left behind', async () => {
      const page = await listAuditFeed(tenant(), query({ kind: 'changes' }));
      expect(page.items.map((i) => i.action).sort()).toEqual(['iam.policy.create', 'iam.policy.update', 'iam.settings.update', TOKEN_RESTRICTIONS_EVENT].sort());
      expect(page.items.some((i) => i.action === 'iam.mode.change')).toBe(false);
    });
  });

  describe('looking a decision up by the id the caller was shown', () => {
    const FORBIDDEN = '3f2b8c1e-5a47-4d1a-9b0e-0a1b2c3d4e5f';
    const UNAVAILABLE = '9d8c7b6a-1111-4222-8333-444455556666';
    const UNDECLARED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const OLD = '12345678-1234-4234-8234-123456789abc';
    let bob: string;
    // a workspace of its own, so these rows are not part of the feed expectations above
    let lookupDb: string;
    let lookupId: string;
    const lookup = () => ({ tenantDbName: lookupDb, tenantId: lookupId });

    beforeAll(async () => {
      const slug = `iamaf-l-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      lookupDb = `tenant_${slug}`;
      lookupId = String((await db.createTenant({ companyName: 'AFL', slug, dbName: lookupDb, licenseType: 'FREE', ownerId: 'x' }))._id);
      await db.runWithTenant!(lookupDb, async () => {
        bob = String((await db.createUser({ tenantId: lookupId, email: 'bob@af.example', name: 'Bob', password: 'h', role: 'user', licenseId: 'FREE', features: [] }))._id);
        const base = { tenantId: lookupId, actorType: 'user' as const, actorUserId: bob, outcome: 'denied' as const };
        await db.createAuditLog({
          ...base, service: 'agents', action: 'write', event: 'POST /api/agents', method: 'POST', path: '/api/agents', statusCode: 403,
          metadata: { iamEnforce: true, code: 'forbidden', decisionId: FORBIDDEN, deniedService: 'agents', required: 'write', policyIds: ['freeze'], reasons: ['custom:freeze'], contextProjectId: 'p-1', contextIp: '10.1.2.3' },
        });
        await db.createAuditLog({
          ...base, service: 'agents', action: 'write', event: 'POST /api/agents', method: 'POST', path: '/api/agents', statusCode: 503,
          metadata: { iamEnforce: true, code: 'authorization_unavailable', decisionId: UNAVAILABLE, deniedService: 'agents', required: 'write' },
        });
        await db.createAuditLog({
          ...base, service: 'agents', action: 'read', event: 'GET /api/new-thing', method: 'GET', path: '/api/new-thing', statusCode: 403,
          metadata: { iamEnforce: true, code: 'route_not_declared', decisionId: UNDECLARED },
        });
      });
    });

    it('resolves a refusal to the request, the person and what decided it, with a ready-to-run access check', async () => {
      const decision = await getDecision(lookup(), FORBIDDEN);
      expect(decision).toMatchObject({
        decisionId: FORBIDDEN, code: 'forbidden', service: 'agents', required: 'write', method: 'POST', route: '/api/agents',
        principal: { type: 'user', id: bob, label: 'Bob' }, policyIds: ['freeze'], reasons: ['custom:freeze'],
      });
      expect(decision?.simulateInput).toMatchObject({
        principal: { type: 'user', id: bob }, action: 'agents.write', resource: { kind: 'service', service: 'agents' },
        context: { projectId: 'p-1', channel: 'dashboard', ip: '10.1.2.3' },
      });
    });

    it('a refusal because the engine could not decide resolves too, but there is nothing to replay', async () => {
      const decision = await getDecision(lookup(), UNAVAILABLE);
      expect(decision).toMatchObject({ decisionId: UNAVAILABLE, code: 'authorization_unavailable', service: 'agents', required: 'write', policyIds: [], reasons: [] });
      expect(decision?.simulateInput).toBeNull();
      // an undeclared route is not replayable either
      expect((await getDecision(lookup(), UNDECLARED))?.simulateInput).toBeNull();
    });

    it('is null for an id that was never issued, one that cannot be an id, and another workspace\'s', async () => {
      expect(await getDecision(lookup(), OLD)).toBeNull();
      for (const nonsense of ['', 'not-a-decision-id', "x'; y", '3f2b8c1e']) {
        expect(await getDecision(lookup(), nonsense), nonsense).toBeNull();
      }
      expect(await getDecision({ tenantDbName: lookupDb, tenantId: 'another-tenant' }, FORBIDDEN)).toBeNull();
      expect(await getDecision(tenant(), FORBIDDEN)).toBeNull(); // the other workspace has no such decision
      expect(DECISION_ID_RE.test(FORBIDDEN)).toBe(true);
    });
  });
});
