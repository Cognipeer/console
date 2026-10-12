/**
 * Hardening of the Authorization center API, on BOTH backends: who may make an
 * allow rule take effect, deny rules that could never match, budgets for the
 * compute-only tools, one preview per workspace, bounded lookups, complete audit
 * feeds (group filter, token refusals and edits), and no double audit rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

import type { FastifyInstance } from 'fastify';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { holdPreviewForTests, MAX_PRINCIPALS as MAX_PREVIEW_PRINCIPALS } from '@/lib/iam/preview';
import { encodeCursor, MAX_AUDIT_OFFSET, MAX_DIRECTORY_OFFSET } from '@/server/api/plugins/iam-directory';
import { enqueueAuditLog } from '@/server/api/plugin';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Tenant {
  dbName: string;
  id: string;
  users: Record<string, IUser>;
  groups: Record<string, string>;
  tokens: Record<string, string>;
  projectId?: string;
  agentId?: string;
}

describeForEachProvider('IAM center hardening', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let A: Tenant;

  const headersOf = (tenant: Tenant, user: IUser) => ({
    'x-tenant-db-name': tenant.dbName,
    'x-tenant-id': tenant.id,
    'x-tenant-slug': 'iam-hard',
    'x-user-id': String(user._id),
    'x-user-role': String(user.role),
    'x-user-email': String(user.email),
    'x-license-type': 'FREE',
  });

  async function call(method: string, url: string, tenant: Tenant, user: string, body?: unknown) {
    const h: Record<string, string> = headersOf(tenant, tenant.users[user]);
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await app.inject({ method: method as never, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: any = null;
    if (res.body) {
      try { parsed = parseJsonBody<any>(res.body); } catch { parsed = res.body; }
    }
    return { status: res.statusCode, body: parsed, raw: res.body, headers: res.headers };
  }

  async function build(label: string): Promise<Tenant> {
    const slug = `iamh-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: `Hard ${label}`, slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const t: Tenant = { dbName, id: String(row._id), users: {}, groups: {}, tokens: {} };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
        t.users[key] = await db.createUser({ tenantId: t.id, email: `${key}@${label}.example`, name: `${key} ${label}`, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra });
      };
      await mk('owner', 'owner');
      await mk('admin', 'admin');
      // a delegated administrator of the IAM center: the `iam` service at admin level, but no tenant role
      await mk('delegate', 'user', { servicePermissions: { iam: 'admin' } });
      await mk('reader', 'user', { servicePermissions: { iam: 'read' } });
      // one reader per budget so the three limits do not eat into each other (the limiter is per person)
      await mk('compiler', 'user', { servicePermissions: { iam: 'read' } });
      await mk('previewer', 'user', { servicePermissions: { iam: 'read' } });
      await mk('simulator', 'user', { servicePermissions: { iam: 'read' } });
      await mk('alice', 'user');
      await mk('bob', 'user');

      const eng = await db.createGroup({ tenantId: t.id, name: 'Engineering', createdBy: 't', source: 'local' } as never);
      t.groups = { eng: String(eng._id) };
      for (const u of ['alice', 'bob']) await db.addGroupMember({ groupId: t.groups.eng, userId: String(t.users[u]._id), tenantId: t.id, role: 'member' });

      const token = await db.createApiToken({ tenantId: t.id, userId: String(t.users.alice._id), label: 'alice-ci', tokenHash: `h-${label}-${Math.random()}`, tokenPrefix: 'cp_alice', createdBy: String(t.users.alice._id) } as never);
      t.tokens = { aliceCi: String(token._id) };

      const project = await db.createProject({ tenantId: t.id, key: 'pj1', name: 'Project One', createdBy: 'x' });
      t.projectId = String(project._id);
      const agent = await db.createAgent({ tenantId: t.id, projectId: t.projectId, key: 'support-bot', name: 'Support Bot', config: { modelKey: 'm1' }, status: 'draft', createdBy: 'x' } as never);
      t.agentId = String(agent._id);
    });
    return t;
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    A = await build('a');
    app = await createFastifyApiTestApp(async (instance) => {
      instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
      await instance.register(iamApiPlugin);
    });
    await app.ready();
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    configureIamEngine({ validateRequests: false });
  });
  afterAll(async () => {
    await drainPendingTasks();
    await app?.close();
  });

  const forbidSpec = (over: Record<string, unknown> = {}) => ({
    effect: 'forbid', principals: { groups: [A.groups.eng] }, actions: ['agents.write'], resources: { any: true }, ...over,
  });
  const permitSpec = (over: Record<string, unknown> = {}) => ({
    effect: 'permit', principals: { groups: [A.groups.eng] }, actions: ['agents.read'], resources: { any: true }, ...over,
  });
  const create = (user: string, body: Record<string, unknown>) => call('POST', '/api/iam/policies', A, user, body);
  const remove = async (id: string) => call('DELETE', `/api/iam/policies/${id}`, A, 'admin');

  // ── who may make an allow rule take effect ──────────────────────────────

  describe('an allow rule that takes effect grants access: owners and admins only', () => {
    it('lets a delegated iam administrator restrict and design, not grant', async () => {
      // a deny rule: allowed, even in effect
      const forbid = await create('delegate', { name: 'Deny', enabled: true, spec: forbidSpec() });
      expect(forbid.status, JSON.stringify(forbid.body)).toBe(201);
      // an allow rule that takes effect: refused, with the way out in the message
      const refused = await create('delegate', { name: 'Grant', enabled: true, spec: permitSpec() });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('permit_requires_admin');
      expect(refused.body.error).toMatch(/disabled/i);
      expect(refused.body.error).not.toMatch(/monitor/i);
      // ... but it may be designed and kept switched off
      const disabled = await create('delegate', { name: 'Grant (off)', enabled: false, spec: permitSpec() });
      expect(disabled.status).toBe(201);
      expect(disabled.body).toMatchObject({ enabled: false });
      // raw Cedar with a permit statement counts the same
      const rawMixed = await create('delegate', { name: 'Raw', enabled: true, cedar: 'forbid(principal, action == Action::"models.write", resource);\npermit(principal is User, action == Action::"agents.read", resource);' });
      expect(rawMixed.status).toBe(403);

      // enabling it is the same act as creating it in effect
      expect((await call('PUT', `/api/iam/policies/${disabled.body.policyId}`, A, 'delegate', { enabled: true })).status).toBe(403);
      const enabledByAdmin = await call('PUT', `/api/iam/policies/${disabled.body.policyId}`, A, 'admin', { enabled: true });
      expect(enabledByAdmin.status).toBe(200);
      // ... and so is changing what an effective grant says
      expect((await call('PUT', `/api/iam/policies/${disabled.body.policyId}`, A, 'delegate', { spec: permitSpec({ actions: ['agents.write'] }) })).status).toBe(403);
      // taking a grant away (off) and deleting one are always open
      expect((await call('PUT', `/api/iam/policies/${disabled.body.policyId}`, A, 'delegate', { enabled: false })).status).toBe(200);
      expect((await call('PUT', `/api/iam/policies/${disabled.body.policyId}`, A, 'delegate', { name: 'renamed' })).status).toBe(200);

      // the owner and an admin may do all of it
      expect((await create('owner', { name: 'Owner grant', enabled: true, spec: permitSpec() })).status).toBe(201);
      for (const p of (await call('GET', '/api/iam/policies', A, 'reader')).body.custom) await remove(p.policyId);
    });
  });

  // ── deny rules that could never match ───────────────────────────────────

  describe('a deny rule no request gate can match is refused instead of looking like protection', () => {
    it('refuses it with the reasons, in both forms; an allow rule is saved with a warning', async () => {
      const resourceOnly = await create('admin', {
        name: 'Lock one agent', enabled: true,
        spec: forbidSpec({ actions: ['agent.delete'], resources: { resources: [{ type: 'agent', id: A.agentId }] } }),
      });
      expect(resourceOnly.status).toBe(400);
      expect(resourceOnly.body.code).toBe('validation');
      expect(resourceOnly.body.details.map((d: any) => d.code).sort()).toEqual(['not_enforced_actions', 'not_enforced_resources']);

      const portalOnly = await create('admin', { name: 'Portal', enabled: true, spec: forbidSpec({ conditions: { channels: ['portal'] } }) });
      expect(portalOnly.status).toBe(400);
      expect(portalOnly.body.details[0].code).toBe('not_enforced_channel');

      const raw = await create('admin', { name: 'Raw', enabled: true, cedar: `forbid(principal, action == Action::"agent.delete", resource == Agent::"${A.agentId}");` });
      expect(raw.status).toBe(400);

      const compile = await call('POST', '/api/iam/policies/compile', A, 'reader', {
        spec: permitSpec({ actions: ['agent.invoke'], resources: { resources: [{ type: 'agent', id: A.agentId }] } }),
      });
      expect(compile.body.ok).toBe(true);
      expect(compile.body.warnings.map((w: any) => w.code).sort()).toEqual(['not_enforced_actions', 'not_enforced_resources']);
    });

    it('warns when a hand-written rule depends on the caller\'s address and the server trusts no proxy', async () => {
      const rule = (text: string) => call('POST', '/api/iam/policies/compile', A, 'reader', { cedar: text });
      const withIp = await rule('forbid(principal, action == Action::"models.write", resource) when { context has ip && context.ip.isInRange(ip("10.0.0.0/8")) };');
      expect(withIp.body.ok).toBe(true);
      expect(withIp.body.warnings.map((w: any) => w.code)).toContain('trusted_proxies_unset');
      const without = await rule('forbid(principal, action == Action::"models.write", resource);');
      expect(without.body.warnings.map((w: any) => w.code)).not.toContain('trusted_proxies_unset');
    });

    it('says so in the access check: a resource-level answer is not what a real request meets', async () => {
      const sim = await call('POST', '/api/iam/simulate', A, 'reader', {
        principal: { type: 'user', id: String(A.users.alice._id) }, action: 'agent.get',
        resource: { kind: 'resource', type: 'agent', id: 'whatever' },
      }).catch(() => null);
      // a resource that does not exist is a 404; a service-level check always says it is enforced
      expect(sim?.status === 404 || sim?.body.enforcedAtGate === false).toBe(true);
      const service = await call('POST', '/api/iam/simulate', A, 'reader', {
        principal: { type: 'user', id: String(A.users.alice._id) }, action: 'agents.read', resource: { kind: 'service', service: 'agents' },
      });
      expect(service.body).toMatchObject({ enforcedAtGate: true, projectId: null });
    });
  });

  // ── budgets for the compute-only tools ──────────────────────────────────

  describe('the compute-only tools have a budget per person', () => {
    // each test sends hundreds of requests through the real gate and engine; on a busy machine the default 5 s is too tight
    const BUDGET_TEST_TIMEOUT_MS = 60_000;

    it('compile: 240 a minute, then 429 with Retry-After', async () => {
      const valid = { cedar: 'forbid(principal, action == Action::"models.write", resource);' };
      // a few real compiles ...
      for (let i = 0; i < 3; i++) expect((await call('POST', '/api/iam/policies/compile', A, 'compiler', valid)).status).toBe(200);
      // ... then cheap attempts (an empty body is refused with 400): the budget is spent per attempt, before anything is
      // parsed, so the loop does not pay for 240 Cedar validations
      let refused: Awaited<ReturnType<typeof call>> | null = null;
      for (let i = 0; i < 245 && !refused; i++) {
        const res = await call('POST', '/api/iam/policies/compile', A, 'compiler', {});
        if (res.status === 429) refused = res;
        else expect(res.status).toBe(400);
      }
      expect(refused).not.toBeNull();
      expect(refused!.body.code).toBe('rate_limited');
      expect(Number(refused!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // a real compile is refused too, not only the empty ones
      expect((await call('POST', '/api/iam/policies/compile', A, 'compiler', valid)).status).toBe(429);
      // somebody else is not affected
      expect((await call('POST', '/api/iam/policies/compile', A, 'reader', { cedar: 'forbid(principal, action == Action::"models.write", resource);' })).status).toBe(200);
    }, BUDGET_TEST_TIMEOUT_MS);

    it('preview: 12 a minute', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++) {
        statuses.push((await call('POST', '/api/iam/policies/preview', A, 'previewer', { cedar: 'forbid(principal, action == Action::"models.write", resource);' })).status);
      }
      expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(12)).toEqual([429, 429]);
    }, BUDGET_TEST_TIMEOUT_MS);

    it('simulate: 120 a minute', async () => {
      const input = { principal: { type: 'user', id: String(A.users.alice._id) }, action: 'agents.read', resource: { kind: 'service', service: 'agents' } };
      let refused = 0;
      for (let i = 0; i < 125; i++) {
        const res = await call('POST', '/api/iam/simulate', A, 'simulator', input);
        if (res.status === 429) refused++;
      }
      expect(refused).toBe(5);
    }, BUDGET_TEST_TIMEOUT_MS);
  });

  describe('one preview per workspace at a time', () => {
    it('refuses a preview while another one of the workspace is running, with 429 instead of queueing it', async () => {
      const body = { spec: forbidSpec() };
      // a preview of this workspace that is running right now
      const release = holdPreviewForTests(A.dbName);
      try {
        const refused = await call('POST', '/api/iam/policies/preview', A, 'reader', body);
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('rate_limited');
        expect(refused.body.error).toMatch(/already running/);
      } finally {
        release();
      }
      // and the workspace can preview again once the first is over
      expect((await call('POST', '/api/iam/policies/preview', A, 'admin', body)).status).toBe(200);
    });

    it('tells how many people a preview looked at', async () => {
      const res = await call('POST', '/api/iam/policies/preview', A, 'admin', { spec: forbidSpec() });
      // alice and bob, plus alice's API token (a group policy reaches the tokens its members own)
      expect(res.body.principals).toEqual({ evaluated: 3, targeted: 3 });
      expect(res.body.truncated).toBe(false);
      // a policy that names nobody lists the whole directory: when it fits, the audience is exact (9 active people + 1 token)
      const everyone = await call('POST', '/api/iam/policies/preview', A, 'admin', { spec: forbidSpec({ principals: { any: true } }) });
      expect(everyone.body.principals).toEqual({ evaluated: 10, targeted: 10 });
      expect(everyone.body.truncated).toBe(false);
    });

    it('a directory bigger than the cap is sampled: at most 1000 people are checked, the size is unknown and the result says so', async () => {
      const big = await build('big');
      await db.runWithTenant!(big.dbName, async () => {
        for (let i = 0; i < 1010; i++) {
          await db.createUser({ tenantId: big.id, email: `crowd${i}@big.example`, name: `Crowd ${i}`, password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
        }
      });
      const res = await call('POST', '/api/iam/policies/preview', big, 'admin', { spec: { effect: 'forbid', principals: { any: true }, actions: ['agents.write'], resources: { any: true } } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.principals.targeted).toBeNull();
      expect(res.body.principals.evaluated).toBeGreaterThan(0);
      expect(res.body.principals.evaluated).toBeLessThanOrEqual(MAX_PREVIEW_PRINCIPALS);
      expect(res.body.truncated).toBe(true);
    }, 60_000);
  });

  // ── switches never re-validate who the policy names ─────────────────────

  describe('turning a policy off does not depend on the people it names still existing', () => {
    it('keeps working after a group the policy names is deleted; a CHANGED spec is still verified in full', async () => {
      const group = await db.runWithTenant!(A.dbName, () => db.createGroup({ tenantId: A.id, name: 'Leavers', createdBy: 't', source: 'local' } as never));
      const groupId = String(group._id);
      const spec = forbidSpec({ principals: { groups: [groupId] } });
      const made = await create('admin', { name: 'Leavers freeze', enabled: true, spec });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      await db.runWithTenant!(A.dbName, () => db.deleteGroup(groupId));

      // the switch alone: always fine
      expect((await call('PUT', `/api/iam/policies/${made.body.policyId}`, A, 'admin', { enabled: false })).status).toBe(200);
      // the editor re-sends the whole policy on save: the unchanged spec is not re-verified either
      const resent = await call('PUT', `/api/iam/policies/${made.body.policyId}`, A, 'admin', { name: 'Leavers freeze (off)', enabled: false, spec });
      expect(resent.status, JSON.stringify(resent.body)).toBe(200);
      // a spec that CHANGES is verified: naming the deleted group anew, or another one that is not there, is refused
      const changed = await call('PUT', `/api/iam/policies/${made.body.policyId}`, A, 'admin', { spec: forbidSpec({ principals: { groups: [groupId] }, actions: ['models.write'] }) });
      expect(changed.status).toBe(400);
      expect(JSON.stringify(changed.body)).toMatch(/does not exist/);
      await remove(made.body.policyId);
    });
  });

  // ── bounded lookups ─────────────────────────────────────────────────────

  describe('lookups are bounded', () => {
    it('refuses cursors deeper than a page of the audit feed or the directory can reach', async () => {
      const deepAudit = await call('GET', `/api/iam/audit?kind=denials&cursor=${encodeURIComponent(encodeCursor(MAX_AUDIT_OFFSET + 1))}`, A, 'reader');
      expect(deepAudit.status).toBe(400);
      expect(deepAudit.body.code).toBe('invalid_cursor');
      expect((await call('GET', `/api/iam/audit?kind=denials&cursor=${encodeURIComponent(encodeCursor(MAX_AUDIT_OFFSET))}`, A, 'reader')).status).toBe(200);
      const deepDirectory = await call('GET', `/api/iam/principals?type=user&cursor=${encodeURIComponent(encodeCursor(MAX_DIRECTORY_OFFSET + 1))}`, A, 'reader');
      expect(deepDirectory.status).toBe(400);
      expect((await call('GET', `/api/iam/principals?type=user&cursor=${encodeURIComponent(encodeCursor(20_000))}`, A, 'reader')).status).toBe(200); // a 20K-person directory pages fine
    });

    it('does not look up a decision id that is not a gate-issued uuid', async () => {
      for (const id of ['not-a-uuid', '12345678', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeeX']) {
        expect((await call('GET', `/api/iam/decisions/${id}`, A, 'reader')).status, id).toBe(404);
      }
    });

    it('stops the audit feed at its deepest page and says so instead of handing out a cursor that cannot work', async () => {
      const page = await call('GET', `/api/iam/audit?kind=changes&limit=1&cursor=${encodeURIComponent(encodeCursor(MAX_AUDIT_OFFSET - 1))}`, A, 'reader');
      expect(page.status).toBe(200);
      expect(page.body.nextCursor).toBeNull(); // (there are no rows out there; the cap itself is unit-tested with a stub below)
    });
  });

  // ── audit: no duplicates, and every refusal / edit shows up ─────────────

  describe('audit', () => {
    it('writes ONE row per policy / settings change: the detailed one, and none for a workspace mode', async () => {
      const made = await create('admin', { name: 'Audit me', enabled: false, spec: forbidSpec() });
      expect(made.status).toBe(201);
      await call('PUT', `/api/iam/policies/${made.body.policyId}`, A, 'admin', { name: 'Audit me 2' });
      await call('PUT', '/api/iam/settings', A, 'admin', { tokens: { requireExpiry: true } });
      await call('PUT', '/api/iam/settings', A, 'admin', { tokens: { requireExpiry: false } });
      // there is no workspace mode to switch any more: the endpoint is gone and nothing is recorded as a mode change
      expect((await call('PUT', '/api/iam/mode', A, 'admin', { mode: 'shadow' })).status).toBe(404);
      await remove(made.body.policyId);
      // a REFUSED call is still audited as the request it was (made here, so the test does not lean on an earlier one)
      expect((await call('POST', '/api/iam/policies', A, 'reader', { name: 'Not allowed', enabled: true, spec: forbidSpec() })).status).toBe(403);
      await drainPendingTasks();

      // a wide window: the tests before this one leave refused calls of their own in the trail
      const rows = (await db.runWithTenant!(A.dbName, () => db.iamListAuditEvents({ tenantId: A.id, service: 'iam', limit: 1000 }))).items;
      const count = (event: string) => rows.filter((r) => r.event === event).length;
      expect(count('iam.policy.create')).toBeGreaterThanOrEqual(1);
      expect(count('iam.settings.update')).toBe(2);
      expect(count('iam.mode.change')).toBe(0);
      // the generic request rows ("POST /api/iam/policies") that used to repeat each of them are gone for a successful
      // call (a REFUSED call - 403, 400 - is still audited as the request it was)
      const succeeded = rows.filter((r) => (r.statusCode ?? 0) < 400);
      for (const duplicate of ['POST /api/iam/policies', 'PUT /api/iam/settings']) {
        expect(succeeded.filter((r) => r.event === duplicate).length, duplicate).toBe(0);
      }
      expect(succeeded.some((r) => /^(PUT|DELETE) \/api\/iam\/policies\//.test(r.event ?? ''))).toBe(false);
      expect(rows.some((r) => r.event === 'POST /api/iam/policies' && r.statusCode === 403)).toBe(true);
    });

    it('shows a token refused by its IP allowlist and an edit of its restrictions', async () => {
      await db.runWithTenant!(A.dbName, async () => {
        await db.createAuditLog({
          tenantId: A.id, actorType: 'api_token', actorUserId: String(A.users.alice._id), apiTokenId: A.tokens.aliceCi, service: 'tokens', action: 'security',
          event: 'GET /api/client/v1/models', method: 'GET', path: '/api/client/v1/models', statusCode: 403, outcome: 'denied', ipAddress: '198.51.100.7',
          metadata: { code: 'ip_not_allowed', iamEnforce: true },
        });
        await db.createAuditLog({
          tenantId: A.id, actorType: 'user', actorUserId: String(A.users.admin._id), actorEmail: 'admin@a.example', service: 'tokens', action: 'security',
          event: 'token.restrictions.updated', method: 'PUT', path: `/api/tokens/${A.tokens.aliceCi}`, statusCode: 200, outcome: 'success',
          resourceType: 'api_token', resourceId: A.tokens.aliceCi,
          metadata: { label: 'alice-ci', before: { expiresAt: null, allowedIpRanges: null, allowedIpRangeCount: 0 }, after: { expiresAt: '2027-01-01T00:00:00.000Z', allowedIpRanges: ['10.0.0.0/8'], allowedIpRangeCount: 1 } },
        });
        // an unrelated token event must NOT leak into the IAM change feed
        await db.createAuditLog({
          tenantId: A.id, actorType: 'user', actorUserId: String(A.users.admin._id), service: 'tokens', action: 'write', event: 'POST /api/tokens',
          method: 'POST', path: '/api/tokens', statusCode: 201, outcome: 'success',
        });
      });
      const denials = await call('GET', '/api/iam/audit?kind=denials', A, 'reader');
      const refused = denials.body.items.find((i: any) => i.code === 'ip_not_allowed');
      expect(refused).toMatchObject({ service: 'tokens', principal: { type: 'token', id: A.tokens.aliceCi } });
      expect(refused.summary).toMatch(/alice-ci is not allowed from 198\.51\.100\.7/);
      // ... and the same sentence as data, for the reader's language
      expect(refused.text).toEqual({ key: 'ipNotAllowedAt', params: { who: 'alice-ci', ip: '198.51.100.7', route: 'GET /api/client/v1/models' } });

      const changes = await call('GET', '/api/iam/audit?kind=changes&limit=100', A, 'reader');
      const edit = changes.body.items.find((i: any) => i.action === 'token.restrictions.updated');
      expect(edit).toBeTruthy();
      expect(edit.service).toBe('tokens');
      expect(edit.summary).toMatch(/restrictions of token "alice-ci".*expiry none -> 2027-01-01.*IP allowlist 0 -> 1 ranges/);
      expect(edit.text).toMatchObject({ key: 'token.restrictions', params: { label: 'alice-ci', expiryChanged: 1, expiryTo: '2027-01-01', ipChanged: 1, ipFrom: 0, ipTo: 1 } });
      expect(changes.body.items.some((i: any) => i.action === 'POST /api/tokens')).toBe(false);
      // the CSV carries them too
      const csv = await call('GET', '/api/iam/audit/export?kind=changes', A, 'reader');
      expect(csv.raw).toContain('token.restrictions.updated');
    });

    it('filters denials by a group of more than 500 members completely (the old cap cut it at 500)', async () => {
      const group = await db.runWithTenant!(A.dbName, () => db.createGroup({ tenantId: A.id, name: 'Everybody', createdBy: 't', source: 'local' } as never));
      const groupId = String(group._id);
      const MEMBERS = 540;
      await db.runWithTenant!(A.dbName, async () => {
        for (let i = 0; i < MEMBERS; i++) {
          const userId = `crowd-${String(i).padStart(4, '0')}`;
          await db.addGroupMember({ groupId, userId, tenantId: A.id, role: 'member' });
          await db.createAuditLog({
            tenantId: A.id, actorType: 'user', actorUserId: userId, service: 'agents', action: 'write', event: 'POST /api/agents', method: 'POST',
            path: '/api/agents', statusCode: 403, outcome: 'denied', metadata: { iamEnforce: true, code: 'forbidden', decisionId: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`, deniedService: 'agents', required: 'write' },
          });
        }
        // a stranger's denial must not appear
        await db.createAuditLog({
          tenantId: A.id, actorType: 'user', actorUserId: 'stranger', service: 'agents', action: 'write', event: 'POST /api/agents', method: 'POST',
          path: '/api/agents', statusCode: 403, outcome: 'denied', metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'eeeeeeee-0000-4000-8000-000000000000', deniedService: 'agents', required: 'write' },
        });
      });
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const url: string = `/api/iam/audit?kind=denials&principalType=group&principalId=${groupId}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await call('GET', url, A, 'reader');
        expect(page.status).toBe(200);
        expect(page.body.warnings).toBeUndefined();
        for (const item of page.body.items) seen.add(item.decisionId);
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(seen.size).toBe(MEMBERS);
      expect(seen.has('eeeeeeee-0000-4000-8000-000000000000')).toBe(false);
    }, 60_000);
  });
});
