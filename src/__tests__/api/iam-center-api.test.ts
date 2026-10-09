/**
 * Authorization center API (/api/iam/*) end to end: the REAL plugin, the REAL
 * gate (legacy mode), a real database - on BOTH SQLite and MongoDB.
 *
 *   RBAC (read vs admin)  catalog  policies (CRUD, spec / Cedar, validation, audit)
 *   compile  preview  simulate  decisions  principals  audit (+CSV)  settings
 *   tenant isolation of every endpoint
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
import { authorizeGate, configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { userPrincipal } from '@/lib/iam/entities';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { recordPolicyMonitor } from '@/lib/iam/shadow/policyMonitor';
import { flushShadowEvents, resetShadowBufferForTests, resetAuthzModeCacheForTests } from '@/lib/iam/shadow';
import { resetIamSettingsCacheForTests } from '@/lib/iam/settings';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { enqueueAuditLog } from '@/server/api/plugin';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Tenant {
  dbName: string;
  id: string;
  users: Record<string, IUser>;
  groups: Record<string, string>;
  projects: Record<string, string>;
  tokens: Record<string, string>;
  agentId?: string;
}

describeForEachProvider('IAM center API', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let A: Tenant;
  let B: Tenant;

  const headers = (tenant: Tenant, user: IUser) => ({
    'x-tenant-db-name': tenant.dbName,
    'x-tenant-id': tenant.id,
    'x-tenant-slug': 'iam-center',
    'x-user-id': String(user._id),
    'x-user-role': String(user.role),
    'x-user-email': String(user.email),
    'x-license-type': 'FREE',
  });

  async function call(method: string, url: string, tenant: Tenant, user: IUser | string, body?: unknown) {
    const actor = typeof user === 'string' ? tenant.users[user] : user;
    const h: Record<string, string> = headers(tenant, actor);
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await app.inject({ method: method as never, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: any = null;
    if (res.body) {
      try { parsed = parseJsonBody<any>(res.body); } catch { parsed = res.body; }
    }
    return { status: res.statusCode, body: parsed, raw: res.body, headers: res.headers };
  }

  async function build(label: string): Promise<Tenant> {
    const slug = `iamc-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const tenantRow = await db.createTenant({ companyName: `Center ${label}`, slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const t: Tenant = { dbName, id: String(tenantRow._id), users: {}, groups: {}, projects: {}, tokens: {} };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
        t.users[key] = await db.createUser({ tenantId: t.id, email: `${key}@${label}.example`, name: `${key[0].toUpperCase()}${key.slice(1)} ${label}`, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra });
      };
      await mk('owner', 'owner');
      await mk('admin', 'admin');
      await mk('reader', 'user', { servicePermissions: { iam: 'read' } });
      await mk('plain', 'user');
      await mk('alice', 'user');
      await mk('bob', 'user', { servicePermissions: { agents: 'read' } });
      await mk('carol', 'user', { status: 'disabled' });
      await mk('dave', 'user');

      const eng = await db.createGroup({ tenantId: t.id, name: 'Engineering', description: 'All engineers', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      const ops = await db.createGroup({ tenantId: t.id, name: 'Operations', createdBy: 't', source: 'local' } as never);
      t.groups = { eng: String(eng._id), ops: String(ops._id) };
      for (const u of ['alice', 'bob']) await db.addGroupMember({ groupId: t.groups.eng, userId: String(t.users[u]._id), tenantId: t.id, role: 'member' });
      await db.addGroupMember({ groupId: t.groups.ops, userId: String(t.users.carol._id), tenantId: t.id, role: 'member' });

      const p1 = await db.createProject({ tenantId: t.id, key: 'pj1', name: 'Project One', createdBy: 'x' });
      const p2 = await db.createProject({ tenantId: t.id, key: 'pj2', name: 'Project Two', createdBy: 'x' });
      t.projects = { pj1: String(p1._id), pj2: String(p2._id) };
      // alice works in Project Two only; dave also in Project One, where the project limits agents to read
      await db.upsertUserProject({ tenantId: t.id, userId: String(t.users.alice._id), projectId: t.projects.pj2, role: 'member' });
      await db.upsertUserProject({ tenantId: t.id, userId: String(t.users.dave._id), projectId: t.projects.pj1, role: 'member', servicePermissions: { agents: 'read' } });
      await db.upsertUserProject({ tenantId: t.id, userId: String(t.users.dave._id), projectId: t.projects.pj2, role: 'member' });

      const ci = await db.createApiToken({ tenantId: t.id, userId: String(t.users.alice._id), label: 'alice-ci', tokenHash: `h-${label}-1-${Math.random()}`, tokenPrefix: 'cp_alice', createdBy: String(t.users.alice._id) } as never);
      const scoped = await db.createApiToken({ tenantId: t.id, userId: String(t.users.bob._id), label: 'bob-scoped', tokenHash: `h-${label}-2-${Math.random()}`, tokenPrefix: 'cp_bob', servicePermissions: { agents: 'read' }, createdBy: String(t.users.bob._id) } as never);
      t.tokens = { aliceCi: String(ci._id), bobScoped: String(scoped._id) };

      try {
        const agent = await db.createAgent({ tenantId: t.id, projectId: t.projects.pj1, key: 'support-bot', name: 'Support Bot', config: { modelKey: 'm1' }, status: 'draft', createdBy: 'x' } as never);
        t.agentId = String(agent._id);
      } catch { /* the agent fixture is optional */ }
    });
    return t;
  }

  beforeAll(async () => {
    delete process.env.IAM_ENFORCE_DISABLED; // gates stay in legacy mode (the stored mode is legacy); this only avoids the global off switch
    process.env.IAM_ENFORCE_DISABLED = '1';
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    A = await build('a');
    B = await build('b');
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
    await drainPendingTasks(); // audit rows queued by the last requests must land before the database goes away
    await app?.close();
    resetShadowBufferForTests();
  });

  const memberSpec = (t: Tenant, over: Record<string, unknown> = {}) => ({
    effect: 'forbid',
    principals: { groups: [t.groups.eng] },
    actions: ['agents.write'],
    resources: { any: true },
    ...over,
  });

  // ── RBAC ────────────────────────────────────────────────────────────────

  describe('who may call what', () => {
    it('refuses a member without the iam service everywhere', async () => {
      for (const [method, url, body] of [
        ['GET', '/api/iam/catalog'], ['GET', '/api/iam/policies'], ['GET', '/api/iam/principals?type=user'],
        ['GET', '/api/iam/audit'], ['GET', '/api/iam/settings'], ['GET', '/api/iam/decisions/abc-12345678'],
        ['POST', '/api/iam/simulate', {}], ['POST', '/api/iam/policies/compile', {}], ['POST', '/api/iam/policies', {}],
      ] as const) {
        expect((await call(method, url, A, 'plain', body)).status, `${method} ${url}`).toBe(403);
      }
    });

    it('lets iam:read view and run the compute-only tools, but not change anything', async () => {
      for (const url of ['/api/iam/catalog', '/api/iam/policies', '/api/iam/principals?type=user', '/api/iam/audit', '/api/iam/settings']) {
        expect((await call('GET', url, A, 'reader')).status, url).toBe(200);
      }
      expect((await call('POST', '/api/iam/policies/compile', A, 'reader', { spec: memberSpec(A) })).status).toBe(200);
      expect((await call('POST', '/api/iam/policies/preview', A, 'reader', { spec: memberSpec(A) })).status).toBe(200);
      expect((await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'user', id: String(A.users.alice._id) }, action: 'agents.read', resource: { kind: 'service', service: 'agents' } })).status).toBe(200);

      expect((await call('POST', '/api/iam/policies', A, 'reader', { name: 'x', mode: 'monitor', spec: memberSpec(A) })).status).toBe(403);
      expect((await call('PUT', '/api/iam/policies/p-1', A, 'reader', { name: 'y' })).status).toBe(403);
      expect((await call('DELETE', '/api/iam/policies/p-1', A, 'reader')).status).toBe(403);
      expect((await call('PUT', '/api/iam/settings', A, 'reader', { tokens: { requireExpiry: true } })).status).toBe(403);
    });

    it('lets an admin do all of it', async () => {
      const created = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Admin made', mode: 'monitor', enabled: false, spec: memberSpec(A) });
      expect(created.status).toBe(201);
      expect((await call('DELETE', `/api/iam/policies/${created.body.policyId}`, A, 'admin')).status).toBe(204);
    });
  });

  // ── catalog ─────────────────────────────────────────────────────────────

  it('serves the catalog', async () => {
    const res = await call('GET', '/api/iam/catalog', A, 'reader');
    expect(res.status).toBe(200);
    const { services, actions, resourceTypes, contextAttrs, channels } = res.body;
    expect(services.find((s: any) => s.id === 'agents')).toMatchObject({ id: 'agents', adminService: false, labelKey: 'iamApi.services.agents' });
    expect(services.find((s: any) => s.id === 'members')).toMatchObject({ adminService: true });
    expect(actions.find((a: any) => a.id === 'Write')).toMatchObject({ kind: 'group', level: 'write' });
    expect(actions.find((a: any) => a.id === 'agents.read')).toMatchObject({ kind: 'service', level: 'read', service: 'agents', labelKey: 'iamApi.action.service.read', labelParams: { service: 'agents' } });
    expect(actions.find((a: any) => a.id === 'agent.invoke')).toMatchObject({ kind: 'resource', level: 'write', resourceType: 'agent', verb: 'invoke', service: 'agents' });
    expect(resourceTypes.find((t: any) => t.type === 'agent')).toMatchObject({ service: 'agents', labelKey: 'resources.types.agent' });
    expect(contextAttrs).toEqual(['projectId', 'channel', 'ip', 'now', 'method', 'path']);
    expect(channels).toEqual(['dashboard', 'api', 'portal']);
  });

  // ── policies ────────────────────────────────────────────────────────────

  describe('policies', () => {
    it('creates, lists, reads, updates and deletes a spec policy; every write is audited', async () => {
      const created = await call('POST', '/api/iam/policies', A, 'admin', { name: '  Freeze agents  ', description: 'Nobody in Engineering changes agents', mode: 'monitor', enabled: true, spec: memberSpec(A) });
      expect(created.status).toBe(201);
      const row = created.body;
      expect(row).toMatchObject({
        name: 'Freeze agents', description: 'Nobody in Engineering changes agents', effect: 'forbid', mode: 'monitor', enabled: true,
        statementCount: 1, updatedBy: String(A.users.admin._id), monitorStats: { wouldAllow: 0, wouldDeny: 0, since: null },
      });
      expect(row.policyId).toMatch(/^p-[0-9a-f]{12}$/);
      expect(row.spec).toMatchObject({ effect: 'forbid', actions: ['agents.write'] });
      expect(row.cedar).toContain('forbid (');
      expect(row.cedar).toContain(`Group::"${A.groups.eng}"`);
      expect(typeof row.createdAt).toBe('string');

      const list = await call('GET', '/api/iam/policies', A, 'reader');
      expect(list.body.managed).toHaveLength(12);
      expect(list.body.managed[0]).toMatchObject({ id: 'managed:rbac:user-read', group: 'rbac', effect: 'permit' });
      expect(list.body.managed[0].name).toBeTruthy();
      expect(list.body.managed[0].description).toBeTruthy();
      expect(list.body.managed[0].cedar).toContain('permit');
      expect(list.body.custom.map((p: any) => p.policyId)).toContain(row.policyId);

      expect((await call('GET', `/api/iam/policies/${row.policyId}`, A, 'reader')).body.policyId).toBe(row.policyId);

      // update: rename + enforce + new spec
      const updated = await call('PUT', `/api/iam/policies/${row.policyId}`, A, 'admin', {
        name: 'Freeze agents v2', mode: 'enforce', enabled: true,
        spec: memberSpec(A, { actions: ['Write'], resources: { services: ['agents', 'models'] } }),
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: 'Freeze agents v2', mode: 'enforce', monitorStats: null });
      expect(updated.body.spec.actions).toEqual(['Write']);
      expect(updated.body.cedar).toContain('["agents", "models"]');

      // a toggle that sends neither spec nor cedar keeps the policy as it is
      const toggled = await call('PUT', `/api/iam/policies/${row.policyId}`, A, 'admin', { enabled: false });
      expect(toggled.body).toMatchObject({ enabled: false, name: 'Freeze agents v2' });
      expect(toggled.body.cedar).toBe(updated.body.cedar);
      expect(toggled.body.spec).toEqual(updated.body.spec);

      // switching to raw Cedar drops the spec
      const raw = await call('PUT', `/api/iam/policies/${row.policyId}`, A, 'admin', { cedar: 'forbid(principal, action == Action::"models.write", resource is Service);' });
      expect(raw.status).toBe(200);
      expect(raw.body.spec).toBeNull();
      expect(raw.body.cedar).toContain('models.write');

      expect((await call('DELETE', `/api/iam/policies/${row.policyId}`, A, 'admin')).status).toBe(204);
      expect((await call('GET', `/api/iam/policies/${row.policyId}`, A, 'admin')).status).toBe(404);
      expect((await call('DELETE', `/api/iam/policies/${row.policyId}`, A, 'admin')).status).toBe(404);

      // audit: create + 3 updates + delete, each with the policy facts and the Cedar
      const audit = await call('GET', '/api/iam/audit?kind=changes&limit=50', A, 'reader');
      const mine = audit.body.items.filter((i: any) => i.policyId === row.policyId);
      expect(mine.map((i: any) => i.action).sort()).toEqual(['iam.policy.create', 'iam.policy.delete', 'iam.policy.update', 'iam.policy.update', 'iam.policy.update']);
      expect(mine.every((i: any) => i.kind === 'changes' && i.service === 'iam' && i.principal === null)).toBe(true);
      expect(mine.find((i: any) => i.action === 'iam.policy.create').summary).toMatch(/Created policy "Freeze agents" \(forbid, monitor\)/);
      expect(mine[0].actor).toBe(String(A.users.admin.email));

      const rows = await db.iamListAuditEvents({ tenantId: A.id, resourceTypes: ['iam-policy'], limit: 50 });
      const createRow = rows.items.find((r) => r.event === 'iam.policy.create' && r.resourceId === row.policyId)!;
      expect(createRow).toMatchObject({ service: 'iam', action: 'admin', outcome: 'success', resourceType: 'iam-policy' });
      expect(createRow.metadata).toMatchObject({ policyId: row.policyId, name: 'Freeze agents', mode: 'monitor', effect: 'forbid', statementCount: 1, iamChange: true });
      expect(String(createRow.metadata!.cedar)).toContain('forbid (');
      expect(Buffer.byteLength(String(createRow.metadata!.cedar))).toBeLessThanOrEqual(4096);
    });

    it('stores raw Cedar as is and reports mixed effects', async () => {
      const cedar = 'forbid(principal, action == Action::"models.write", resource is Service);\npermit(principal is User, action == Action::"agents.read", resource is Service);';
      const res = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Raw', mode: 'enforce', enabled: true, cedar });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ spec: null, cedar, effect: 'mixed', statementCount: 2, mode: 'enforce', monitorStats: null });
      await call('DELETE', `/api/iam/policies/${res.body.policyId}`, A, 'admin');
    });

    it('validates the request body', async () => {
      const bad = async (body: unknown, message: RegExp) => {
        const res = await call('POST', '/api/iam/policies', A, 'admin', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe('validation');
        expect(res.body.error).toBeTruthy();
        expect(JSON.stringify(res.body.details)).toMatch(message);
      };
      await bad({}, /name is required/);
      await bad({ name: 'x', enabled: true, spec: memberSpec(A) }, /mode must be/);
      await bad({ name: 'x', mode: 'monitor' }, /spec or Cedar/);
      await bad({ name: 'x', mode: 'monitor', spec: memberSpec(A), cedar: 'permit(principal, action, resource);' }, /not both/);
      await bad({ name: 'x', mode: 'weird', spec: memberSpec(A) }, /mode must be/);
      await bad({ name: 'x'.repeat(200), mode: 'monitor', spec: memberSpec(A) }, /at most 120/);
      await bad({ name: 'x', mode: 'monitor', enabled: 'yes', spec: memberSpec(A) }, /enabled must be/);
      await bad({ name: 'x', mode: 'monitor', spec: memberSpec(A), surprise: 1 }, /Unknown field/);
      await bad({ name: 'x', mode: 'monitor', spec: memberSpec(A, { actions: [] }) }, /at least one action/);
      await bad({ name: 'x', mode: 'monitor', spec: memberSpec(A, { actions: ['nope.nope'] }) }, /not an action/);
      expect((await call('POST', '/api/iam/policies', A, 'admin', undefined)).status).toBe(400);
    });

    it('verifies that every id of a spec exists in THIS workspace', async () => {
      const refuse = async (spec: unknown, what: RegExp) => {
        const res = await call('POST', '/api/iam/policies', A, 'admin', { name: 'x', mode: 'monitor', spec });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body.details)).toMatch(what);
      };
      await refuse(memberSpec(A, { principals: { users: ['0123456789abcdef01234567'] } }), /user .* does not exist/);
      await refuse(memberSpec(A, { principals: { users: ['definitely-not-there'] } }), /does not exist/);
      await refuse(memberSpec(A, { principals: { groups: ['0123456789abcdef01234567'] } }), /group .* does not exist/);
      await refuse(memberSpec(A, { principals: { tokens: ['0123456789abcdef01234567'] } }), /token .* does not exist/);
      await refuse(memberSpec(A, { resources: { projects: ['0123456789abcdef01234567'] } }), /project .* does not exist/);
      await refuse(memberSpec(A, { resources: { resources: [{ type: 'agent', id: '0123456789abcdef01234567' }] } }), /agent .* does not exist/);
      // ... and ids of ANOTHER workspace are just as unknown
      await refuse(memberSpec(A, { principals: { users: [String(B.users.alice._id)] } }), /does not exist/);
      await refuse(memberSpec(A, { principals: { groups: [B.groups.eng] } }), /does not exist/);
      await refuse(memberSpec(A, { principals: { tokens: [B.tokens.aliceCi] } }), /does not exist/);
      await refuse(memberSpec(A, { resources: { projects: [B.projects.pj1] } }), /does not exist/);
    });

    it('accepts real users, groups, tokens, projects and resources', async () => {
      const res = await call('POST', '/api/iam/policies', A, 'admin', {
        name: 'Everything real', mode: 'monitor',
        spec: memberSpec(A, {
          principals: { users: [String(A.users.alice._id)], groups: [A.groups.eng], tokens: [A.tokens.aliceCi] },
          actions: ['agents.write', 'agent.delete'],
          resources: { projects: [A.projects.pj1], services: ['agents'], ...(A.agentId ? { resources: [{ type: 'agent', id: A.agentId }] } : {}) },
        }),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await call('DELETE', `/api/iam/policies/${res.body.policyId}`, A, 'admin');
    });

    it('rejects invalid Cedar with line and column, and the reserved @managed annotation', async () => {
      const res = await call('POST', '/api/iam/policies', A, 'admin', {
        name: 'Broken', mode: 'monitor',
        cedar: 'permit(principal is User, action, resource)\nwhen { principal.nonexistent == "x" };',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation');
      expect(res.body.details[0].message).toMatch(/nonexistent/);
      expect(res.body.details[0]).toMatchObject({ line: 2 });
      expect(typeof res.body.details[0].col).toBe('number');

      const syntax = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Syntax', mode: 'monitor', cedar: 'permit(principal action resource);' });
      expect(syntax.status).toBe(400);
      expect(syntax.body.details[0].line).toBe(1);

      const managed = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Sneaky', mode: 'enforce', cedar: '@managed("rbac") permit(principal is User, action, resource);' });
      expect(managed.status).toBe(400);
      expect(JSON.stringify(managed.body.details)).toMatch(/reserved/);
    });

    it('answers 404 for unknown or malformed policy ids, and refuses to exceed the policy limit', async () => {
      expect((await call('GET', '/api/iam/policies/nope', A, 'admin')).status).toBe(404);
      expect((await call('GET', '/api/iam/policies/Bad%20Id!', A, 'admin')).status).toBe(404);
      expect((await call('PUT', '/api/iam/policies/nope', A, 'admin', { name: 'x' })).status).toBe(404);
      expect((await call('PUT', '/api/iam/policies/nope', A, 'admin', { cedar: 'forbid(principal, action, resource);' })).status).toBe(404);

      // a tenant at the limit cannot add more (filled directly: creating 500 through the API is slow)
      const tight = await build('limit');
      await db.runWithTenant!(tight.dbName, async () => {
        for (let i = 0; i < 500; i++) {
          await db.iamDocPut('iam_policies', `bulk-${i}`, { _id: `bulk-${i}`, policyId: `bulk-${i}`, name: 'b', cedar: 'forbid(principal, action == Action::"tool.delete", resource is Tool);', mode: 'monitor', enabled: false, createdBy: 'x', updatedBy: 'x', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        }
      });
      const full = await call('POST', '/api/iam/policies', tight, 'admin', { name: 'one too many', mode: 'monitor', cedar: 'forbid(principal, action, resource);' });
      expect(full.status).toBe(409);
      expect(full.body.code).toBe('limit_reached');
    }, 120_000);
  });

  // ── compile ─────────────────────────────────────────────────────────────

  describe('compile', () => {
    it('compiles a spec to Cedar', async () => {
      const res = await call('POST', '/api/iam/policies/compile', A, 'reader', { spec: memberSpec(A, { actions: ['models.read'], resources: { services: ['agents'] } }) });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.cedar).toContain('Action::"models.read"');
      expect(res.body.errors).toEqual([]);
      expect(res.body.warnings.map((w: any) => w.message).join(' ')).toMatch(/never apply/);
    });

    it('reports an invalid spec without throwing', async () => {
      const res = await call('POST', '/api/iam/policies/compile', A, 'reader', { spec: memberSpec(A, { principals: { users: ['nobody'] } }) });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, cedar: '' });
      expect(res.body.errors[0].message).toMatch(/does not exist/);
    });

    it('checks raw Cedar and locates the problem', async () => {
      const good = await call('POST', '/api/iam/policies/compile', A, 'reader', { cedar: 'forbid(principal, action == Action::"models.write", resource is Service);' });
      expect(good.body).toMatchObject({ ok: true, errors: [] });
      expect(good.body.cedar).toContain('models.write');
      // a deny rule no request gate can match is refused instead of looking like protection
      const inert = await call('POST', '/api/iam/policies/compile', A, 'reader', { cedar: 'forbid(principal, action == Action::"agent.delete", resource is Agent);' });
      expect(inert.body.ok).toBe(false);
      expect(inert.body.errors[0].message).toMatch(/individual resources|whole services/);
      const bad = await call('POST', '/api/iam/policies/compile', A, 'reader', { cedar: 'forbid(principal,\n  action == Action::"nope.nope",\n  resource);' });
      expect(bad.body.ok).toBe(false);
      expect(bad.body.errors[0]).toMatchObject({ line: 2 });
    });

    it('needs exactly one of spec / cedar and never records an audit row for a successful call', async () => {
      expect((await call('POST', '/api/iam/policies/compile', A, 'reader', {})).status).toBe(400);
      expect((await call('POST', '/api/iam/policies/compile', A, 'reader', { spec: memberSpec(A), cedar: 'x' })).status).toBe(400);
      expect((await call('POST', '/api/iam/policies/compile', A, 'reader', { cedar: 5 })).status).toBe(400);
      const before = (await db.iamListAuditEvents({ tenantId: A.id, limit: 200 })).items.filter((r) => String(r.path).includes('/compile')).length;
      await call('POST', '/api/iam/policies/compile', A, 'reader', { spec: memberSpec(A) });
      await new Promise((r) => setTimeout(r, 30));
      const after = (await db.iamListAuditEvents({ tenantId: A.id, limit: 200 })).items.filter((r) => String(r.path).includes('/compile')).length;
      expect(after).toBe(before);
    });
  });

  // ── preview ─────────────────────────────────────────────────────────────

  describe('preview', () => {
    it('shows who would lose access', async () => {
      const res = await call('POST', '/api/iam/policies/preview', A, 'reader', { spec: memberSpec(A) });
      expect(res.status).toBe(200);
      expect(res.body.evaluated).toBeGreaterThan(0);
      expect(res.body.truncated).toBe(false);
      expect(res.body.flips.allowToDeny).toBeGreaterThan(0);
      expect(res.body.flips.denyToAllow).toBe(0);
      const sample = res.body.samples[0];
      expect(sample).toMatchObject({ action: 'agents.write', resource: { kind: 'service', service: 'agents' }, before: true, after: false });
      expect(['alice', 'bob']).toContain(String(sample.principal.label).split(' ')[0].toLowerCase());
      expect(res.body.samples.every((s: any) => s.before === true && s.after === false)).toBe(true);
    });

    it('shows who would gain access, and evaluates an edit against the stored version', async () => {
      const grant = await call('POST', '/api/iam/policies/preview', A, 'reader', {
        spec: { effect: 'permit', principals: { users: [String(A.users.plain._id)] }, actions: ['members.read'], resources: { any: true } },
      });
      expect(grant.body.flips.denyToAllow).toBeGreaterThan(0);
      expect(grant.body.samples[0]).toMatchObject({ action: 'members.read', before: false, after: true });

      const stored = await call('POST', '/api/iam/policies', A, 'admin', { name: 'To edit', mode: 'enforce', spec: memberSpec(A) });
      try {
        // moving the stored forbid from Engineering to Operations frees Engineering: the preview of an EDIT
        // covers the people of the version being replaced as well as the new one
        const edit = await call('POST', '/api/iam/policies/preview', A, 'reader', { policyId: stored.body.policyId, spec: memberSpec(A, { principals: { groups: [A.groups.ops] } }) });
        expect(edit.body.flips.denyToAllow).toBeGreaterThan(0);
        const same = await call('POST', '/api/iam/policies/preview', A, 'reader', { policyId: stored.body.policyId });
        expect(same.body.flips).toEqual({ allowToDeny: 0, denyToAllow: 0 });
      } finally {
        await call('DELETE', `/api/iam/policies/${stored.body.policyId}`, A, 'admin');
      }
    });

    it('previews raw Cedar and a policy that changes nothing', async () => {
      const raw = await call('POST', '/api/iam/policies/preview', A, 'reader', { cedar: 'forbid(principal, action == Action::"agents.write", resource);' });
      expect(raw.status).toBe(200);
      expect(raw.body.flips.allowToDeny).toBeGreaterThan(0);
      const nothing = await call('POST', '/api/iam/policies/preview', A, 'reader', { spec: memberSpec(A, { principals: { groups: [A.groups.ops] }, actions: ['agents.read'] }) });
      expect(nothing.body.flips.allowToDeny).toBeGreaterThanOrEqual(0);
    });

    it('rejects bad input and unknown policies', async () => {
      expect((await call('POST', '/api/iam/policies/preview', A, 'reader', {})).status).toBe(400);
      expect((await call('POST', '/api/iam/policies/preview', A, 'reader', { spec: memberSpec(A, { actions: [] }) })).body.code).toBe('validation');
      expect((await call('POST', '/api/iam/policies/preview', A, 'reader', { cedar: 'nonsense' })).body.code).toBe('validation');
      expect((await call('POST', '/api/iam/policies/preview', A, 'reader', { policyId: 'does-not-exist' })).status).toBe(404);
    });
  });

  // ── simulate ────────────────────────────────────────────────────────────

  describe('simulate', () => {
    const alice = () => ({ type: 'user', id: String(A.users.alice._id) });
    const svc = (service: string) => ({ kind: 'service', service });

    it('answers allowed / denied with the legacy comparison and the principal summary', async () => {
      const ok = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agents.write', resource: svc('agents') });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ allowed: true, defaultDeny: false, mode: 'legacy', legacy: { allowed: true, service: 'agents', required: 'write' } });
      expect(ok.body.reasons[0]).toMatchObject({ managed: true, effect: 'permit', policyId: null });
      expect(ok.body.reasons[0].name).toBeTruthy();
      expect(ok.body.principalSummary).toMatchObject({ type: 'user', id: alice().id, role: 'user' });
      expect(ok.body.principalSummary.groups).toEqual([{ id: A.groups.eng, name: 'Engineering' }]);

      const denied = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'members.write', resource: svc('members') });
      expect(denied.body).toMatchObject({ allowed: false, defaultDeny: true, reasons: [], legacy: { allowed: false, service: 'members', required: 'admin' } });
    });

    it('explains which policy decided, including the monitor difference', async () => {
      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'No agent writes for Engineering', mode: 'enforce', spec: memberSpec(A) });
      const monitored = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Watch models', mode: 'monitor', spec: memberSpec(A, { actions: ['models.write'] }) });
      try {
        const blocked = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agents.write', resource: svc('agents') });
        expect(blocked.body.allowed).toBe(false);
        expect(blocked.body.defaultDeny).toBe(false);
        expect(blocked.body.reasons).toEqual([expect.objectContaining({ policyId: policy.body.policyId, managed: false, name: 'No agent writes for Engineering', effect: 'forbid', cedarId: `custom:${policy.body.policyId}` })]);
        expect(blocked.body.legacy.allowed).toBe(true); // the current rules still allow it

        const watched = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'models.write', resource: svc('models') });
        expect(watched.body.allowed).toBe(true);
        expect(watched.body.monitor).toMatchObject({ allowed: false, differs: true });
        expect(watched.body.monitor.reasons[0]).toMatchObject({ policyId: monitored.body.policyId, effect: 'forbid' });
      } finally {
        await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'admin');
        await call('DELETE', `/api/iam/policies/${monitored.body.policyId}`, A, 'admin');
      }
    });

    it('evaluates a token: owner groups count, the scope caps, and a group policy reaches it', async () => {
      const scoped = { type: 'token', id: A.tokens.aliceCi };
      const plainTok = await call('POST', '/api/iam/simulate', A, 'reader', { principal: scoped, action: 'agents.write', resource: svc('agents') });
      expect(plainTok.body.allowed).toBe(true);
      expect(plainTok.body.principalSummary).toMatchObject({ type: 'token', label: 'alice-ci', tokenScope: null });
      const bobTok = { type: 'token', id: B.tokens.bobScoped };
      expect((await call('POST', '/api/iam/simulate', A, 'reader', { principal: bobTok, action: 'agents.read', resource: svc('agents') })).status).toBe(404); // another workspace's token

      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Eng no writes', mode: 'enforce', spec: memberSpec(A) });
      try {
        const viaToken = await call('POST', '/api/iam/simulate', A, 'reader', { principal: scoped, action: 'agents.write', resource: svc('agents') });
        expect(viaToken.body.allowed).toBe(false); // the group forbid reaches the token of a member
        expect(viaToken.body.reasons[0].policyId).toBe(policy.body.policyId);
        const scopedTok = await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'token', id: A.tokens.bobScoped }, action: 'agents.write', resource: svc('agents') });
        expect(scopedTok.body.allowed).toBe(false);
        expect(scopedTok.body.principalSummary.tokenScope).toEqual({ agents: 'read' });
      } finally {
        await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'admin');
      }
      const capped = await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'token', id: A.tokens.bobScoped }, action: 'agents.write', resource: svc('agents') });
      expect(capped.body.allowed).toBe(false);
      expect(capped.body.reasons.map((r: any) => r.cedarId)).toEqual(['managed:boundary:token-cap-write']);
      expect(capped.body.reasons[0]).toMatchObject({ managed: true, effect: 'forbid' });
    });

    it('applies the project context: narrowing, project resources and per-request conditions', async () => {
      const dave = { type: 'user', id: String(A.users.dave._id) };
      const inPj1 = await call('POST', '/api/iam/simulate', A, 'reader', { principal: dave, action: 'agents.write', resource: { kind: 'project', projectId: A.projects.pj1 } });
      expect(inPj1.body.allowed).toBe(false); // the project says agents: read
      expect(inPj1.body.reasons.map((r: any) => r.cedarId)).toEqual(['managed:boundary:project-write']);
      expect(inPj1.body.legacy.allowed).toBe(true); // the current rules know nothing of project settings
      const inPj2 = await call('POST', '/api/iam/simulate', A, 'reader', { principal: dave, action: 'agents.write', resource: { kind: 'project', projectId: A.projects.pj2 } });
      expect(inPj2.body.allowed).toBe(true);
      const ctxProject = await call('POST', '/api/iam/simulate', A, 'reader', { principal: dave, action: 'agents.write', resource: svc('agents'), context: { projectId: A.projects.pj1 } });
      expect(ctxProject.body.allowed).toBe(false);
      // a new resource in a project
      // no project chosen: the project a request without an active project would run in - what the gate does,
      // not a workspace-level wish. Dave works in two projects (which one comes first depends on the backend):
      // in Project One the settings say agents: read, in Project Two nothing narrows.
      const noProject = await call('POST', '/api/iam/simulate', A, 'reader', { principal: dave, action: 'agents.write', resource: svc('agents') });
      expect([A.projects.pj1, A.projects.pj2]).toContain(noProject.body.projectId);
      expect(noProject.body.allowed).toBe(noProject.body.projectId !== A.projects.pj1);
      // a person with exactly one project always runs in it
      const aliceNoProject = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agents.write', resource: svc('agents') });
      expect(aliceNoProject.body.projectId).toBe(A.projects.pj2);
      // the effective-permissions table still shows the workspace level until a project is picked
      expect((await call('GET', `/api/iam/principals/user/${A.users.dave._id}`, A, 'reader')).body.effective.find((e: any) => e.service === 'agents').level).toBe('write');
      const create = await call('POST', '/api/iam/simulate', A, 'reader', { principal: dave, action: 'agent.create', resource: { kind: 'project', projectId: A.projects.pj2 } });
      expect(create.body.allowed).toBe(true);
      const createBlocked = await call('POST', '/api/iam/simulate', A, 'reader', { principal: dave, action: 'agent.create', resource: { kind: 'project', projectId: A.projects.pj1 } });
      expect(createBlocked.body.allowed).toBe(false);

      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Office only', mode: 'enforce', spec: { effect: 'forbid', principals: { any: true }, actions: ['agents.write'], resources: { any: true }, conditions: { ipRanges: ['203.0.113.0/24'], channels: ['dashboard'] } } });
      try {
        const sim = (ctx: Record<string, unknown>) => call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agents.write', resource: svc('agents'), context: ctx });
        expect((await sim({ ip: '203.0.113.9' })).body.allowed).toBe(false);
        expect((await sim({ ip: '198.51.100.9' })).body.allowed).toBe(true);
        expect((await sim({ ip: '203.0.113.9', channel: 'api' })).body.allowed).toBe(true);
        expect((await sim({})).body.allowed).toBe(true);
      } finally {
        await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'admin');
      }
    });

    it('finds a resource of the registry', async () => {
      if (!A.agentId) return;
      const ok = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agent.get', resource: { kind: 'resource', type: 'agent', id: A.agentId } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.allowed).toBe(true);
      const missing = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agent.get', resource: { kind: 'resource', type: 'agent', id: '0123456789abcdef01234567' } });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('resource_not_found');
      // another workspace's agent is just as unknown
      if (B.agentId) {
        expect((await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agent.get', resource: { kind: 'resource', type: 'agent', id: B.agentId } })).status).toBe(404);
      }
    });

    it('the workspace owner always reaches the Authorization Engine', async () => {
      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Lock everyone out', mode: 'enforce', spec: { effect: 'forbid', principals: { any: true }, actions: ['iam.write', 'iam.read'], resources: { any: true } } });
      try {
        const owner = await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'user', id: String(A.users.owner._id) }, action: 'iam.write', resource: svc('iam') });
        expect(owner.body).toMatchObject({ allowed: true, ownerSafety: true });
        const admin = await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'user', id: String(A.users.admin._id) }, action: 'iam.write', resource: svc('iam') });
        expect(admin.body.allowed).toBe(false);
      } finally {
        await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'admin');
      }
    });

    it('rejects malformed requests with details, and unknown principals with 404', async () => {
      const bad = async (body: unknown) => {
        const res = await call('POST', '/api/iam/simulate', A, 'reader', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe('validation');
        expect(res.body.details.length).toBeGreaterThan(0);
      };
      await bad({});
      await bad({ principal: { type: 'group', id: A.groups.eng }, action: 'agents.read', resource: svc('agents') });
      await bad({ principal: alice(), action: 'Read', resource: svc('agents') }); // a group action
      await bad({ principal: alice(), action: 'nope', resource: svc('agents') });
      await bad({ principal: alice(), action: 'agents.read', resource: { kind: 'service', service: 'nope' } });
      await bad({ principal: alice(), action: 'agents.read', resource: svc('models') }); // action and service disagree
      await bad({ principal: alice(), action: 'agent.get', resource: svc('agents') }); // needs a resource
      await bad({ principal: alice(), action: 'agents.read', resource: svc('agents'), context: { channel: 'sms' } });
      await bad({ principal: alice(), action: 'agents.read', resource: svc('agents'), context: { ip: 'not-an-ip' } });
      await bad({ principal: alice(), action: 'agents.read', resource: svc('agents'), context: { at: 'yesterday' } });
      const ghost = await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'user', id: '0123456789abcdef01234567' }, action: 'agents.read', resource: svc('agents') });
      expect(ghost.status).toBe(404);
      expect(ghost.body.code).toBe('principal_not_found');
      expect((await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'user', id: String(B.users.alice._id) }, action: 'agents.read', resource: svc('agents') })).status).toBe(404);
      expect((await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agents.read', resource: { kind: 'project', projectId: B.projects.pj1 } })).status).toBe(404);
    });
  });

  // ── decisions ───────────────────────────────────────────────────────────

  describe('decisions', () => {
    it('turns the decisionId of a 403 into an access check that reproduces it', async () => {
      const decisionId = '11111111-2222-3333-4444-555555555555';
      await db.runWithTenant!(A.dbName, () => db.createAuditLog({
        tenantId: A.id, actorType: 'user', actorUserId: String(A.users.alice._id), actorEmail: 'alice@a.example', service: 'agents', action: 'write',
        event: 'POST /api/agents', method: 'POST', path: '/api/agents', statusCode: 403, outcome: 'denied', ipAddress: '198.51.100.77',
        // the address the engine evaluated is what a replay uses; the audit row's own IP (a log value) is not
        metadata: { iamEnforce: true, code: 'forbidden', decisionId, deniedService: 'agents', required: 'write', policyIds: ['p-1'], reasons: ['custom:p-1'], contextProjectId: A.projects.pj1, contextIp: '::ffff:203.0.113.9' },
      }));
      const res = await call('GET', `/api/iam/decisions/${decisionId}`, A, 'reader');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        decisionId, service: 'agents', required: 'write', route: '/api/agents', method: 'POST', code: 'forbidden',
        principal: { type: 'user', id: String(A.users.alice._id), label: 'Alice a' },
        policyIds: ['p-1'],
      });
      expect(typeof res.body.at).toBe('string');
      expect(res.body.simulateInput).toMatchObject({
        principal: { type: 'user', id: String(A.users.alice._id) },
        action: 'agents.write',
        resource: { kind: 'service', service: 'agents' },
        context: { projectId: A.projects.pj1, channel: 'dashboard', ip: '203.0.113.9' },
      });
      // ... and that input is accepted as is by the access check
      const replay = await call('POST', '/api/iam/simulate', A, 'reader', res.body.simulateInput);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    });

    it('a token denial points at the token, an undeclared-route refusal cannot be replayed', async () => {
      await db.runWithTenant!(A.dbName, async () => {
        await db.createAuditLog({
          tenantId: A.id, actorType: 'api_token', actorUserId: String(A.users.bob._id), apiTokenId: A.tokens.bobScoped, service: 'models', action: 'read',
          event: 'GET /api/client/v1/models', method: 'GET', path: '/api/client/v1/models', statusCode: 403, outcome: 'denied',
          metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'aaaaaaaa-0000-4000-8000-000000000001', deniedService: 'models', required: 'read' },
        });
        await db.createAuditLog({
          tenantId: A.id, actorType: 'user', actorUserId: String(A.users.alice._id), service: 'iam', action: 'security',
          event: 'GET /api/undeclared', method: 'GET', path: '/api/undeclared', statusCode: 403, outcome: 'denied',
          metadata: { iamEnforce: true, code: 'route_not_declared', decisionId: 'bbbbbbbb-0000-4000-8000-000000000002' },
        });
      });
      const tok = await call('GET', '/api/iam/decisions/aaaaaaaa-0000-4000-8000-000000000001', A, 'reader');
      expect(tok.body.principal).toMatchObject({ type: 'token', id: A.tokens.bobScoped, label: 'bob-scoped' });
      expect(tok.body.simulateInput).toMatchObject({ principal: { type: 'token', id: A.tokens.bobScoped }, action: 'models.read', context: { channel: 'api' } });
      const undeclared = await call('GET', '/api/iam/decisions/bbbbbbbb-0000-4000-8000-000000000002', A, 'reader');
      expect(undeclared.body).toMatchObject({ code: 'route_not_declared', simulateInput: null });
    });

    it('answers 404 for an unknown id, a malformed id and another workspace\'s decision', async () => {
      const foreign = '99999999-8888-7777-6666-555555555555';
      await db.runWithTenant!(B.dbName, () => db.createAuditLog({
        tenantId: B.id, actorType: 'user', actorUserId: String(B.users.alice._id), service: 'agents', action: 'write', event: 'POST /api/agents',
        method: 'POST', path: '/api/agents', statusCode: 403, outcome: 'denied', metadata: { iamEnforce: true, code: 'forbidden', decisionId: foreign, deniedService: 'agents', required: 'write' },
      }));
      expect((await call('GET', `/api/iam/decisions/${foreign}`, B, 'reader')).status).toBe(200);
      expect((await call('GET', `/api/iam/decisions/${foreign}`, A, 'reader')).status).toBe(404);
      expect((await call('GET', '/api/iam/decisions/unknown-decision-id', A, 'reader')).status).toBe(404);
      // a well-formed id nobody holds is a (bounded) lookup; anything not shaped like a gate-issued uuid is not looked up at all
      expect((await call('GET', '/api/iam/decisions/cccccccc-0000-4000-8000-000000000003', A, 'reader')).status).toBe(404);
      expect((await call('GET', '/api/iam/decisions/abcdef12345', A, 'reader')).status).toBe(404);
      expect((await call('GET', '/api/iam/decisions/x', A, 'reader')).status).toBe(404);
      expect((await call('GET', '/api/iam/decisions/a%22b%27c', A, 'reader')).status).toBe(404);
    });
  });

  // ── principals ──────────────────────────────────────────────────────────

  describe('principals', () => {
    it('lists users with server-side paging, search and status', async () => {
      const first = await call('GET', '/api/iam/principals?type=user&limit=3', A, 'reader');
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(3);
      expect(typeof first.body.nextCursor).toBe('string');
      const second = await call('GET', `/api/iam/principals?type=user&limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`, A, 'reader');
      expect(second.body.items).toHaveLength(3);
      const third = await call('GET', `/api/iam/principals?type=user&limit=3&cursor=${encodeURIComponent(second.body.nextCursor)}`, A, 'reader');
      expect(third.body.items).toHaveLength(2);
      expect(third.body.nextCursor).toBeNull();
      const ids = [...first.body.items, ...second.body.items, ...third.body.items].map((i: any) => i.id);
      expect(new Set(ids).size).toBe(8);

      const search = await call('GET', '/api/iam/principals?type=user&q=ALICE', A, 'reader');
      expect(search.body.items).toEqual([expect.objectContaining({ type: 'user', id: String(A.users.alice._id), label: 'Alice a', sublabel: 'alice@a.example', role: 'user', status: 'active', policyCount: 0 })]);
      const carol = await call('GET', '/api/iam/principals?type=user&q=carol', A, 'reader');
      expect(carol.body.items[0].status).toBe('disabled');
    });

    it('lists groups with member counts and tokens with their owner', async () => {
      const groups = await call('GET', '/api/iam/principals?type=group', A, 'reader');
      expect(groups.body.items.map((g: any) => [g.label, g.memberCount])).toEqual([['Engineering', 2], ['Operations', 1]]);
      expect(groups.body.items[0]).toMatchObject({ type: 'group', sublabel: 'All engineers' });
      const tokens = await call('GET', '/api/iam/principals?type=token', A, 'reader');
      expect(tokens.body.items.map((t: any) => t.label).sort()).toEqual(['alice-ci', 'bob-scoped']);
      expect(tokens.body.items.find((t: any) => t.label === 'alice-ci')).toMatchObject({ type: 'token', status: 'active', sublabel: 'cp_alice… · Alice a' });
      expect((await call('GET', '/api/iam/principals?type=token&q=bob', A, 'reader')).body.items).toHaveLength(1);
    });

    it('counts the policies that name a principal', async () => {
      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Names alice', mode: 'monitor', spec: memberSpec(A, { principals: { users: [String(A.users.alice._id)], groups: [A.groups.eng], tokens: [A.tokens.aliceCi] } }) });
      try {
        expect((await call('GET', '/api/iam/principals?type=user&q=alice', A, 'reader')).body.items[0].policyCount).toBe(1);
        expect((await call('GET', '/api/iam/principals?type=user&q=bob', A, 'reader')).body.items[0].policyCount).toBe(0);
        expect((await call('GET', '/api/iam/principals?type=group&q=engineer', A, 'reader')).body.items[0].policyCount).toBe(1);
        expect((await call('GET', '/api/iam/principals?type=token&q=alice-ci', A, 'reader')).body.items[0].policyCount).toBe(1);
      } finally {
        await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'admin');
      }
    });

    it('rejects a bad type, cursor or limit gracefully', async () => {
      expect((await call('GET', '/api/iam/principals', A, 'reader')).status).toBe(400);
      expect((await call('GET', '/api/iam/principals?type=robot', A, 'reader')).status).toBe(400);
      expect((await call('GET', '/api/iam/principals?type=user&cursor=garbage', A, 'reader')).body.code).toBe('invalid_cursor');
      const clamped = await call('GET', '/api/iam/principals?type=user&limit=100000', A, 'reader');
      expect(clamped.status).toBe(200);
      expect(clamped.body.items.length).toBeLessThanOrEqual(100);
      expect((await call('GET', `/api/iam/principals?type=user&q=${'x'.repeat(500)}`, A, 'reader')).status).toBe(200);
    });

    it('describes a user: effective permissions with their sources, groups, projects, policies and tokens', async () => {
      const detail = await call('GET', `/api/iam/principals/user/${A.users.alice._id}`, A, 'reader');
      expect(detail.status).toBe(200);
      expect(detail.body.principal).toMatchObject({ type: 'user', id: String(A.users.alice._id), label: 'Alice a', role: 'user', status: 'active' });
      const agents = detail.body.effective.find((e: any) => e.service === 'agents');
      expect(agents.level).toBe('write');
      expect(agents.sources.map((s: any) => s.kind)).toContain('role');
      const members = detail.body.effective.find((e: any) => e.service === 'members');
      expect(members.level).toBe('none');
      expect(detail.body.effective.find((e: any) => e.service === 'aegis')).toBeUndefined(); // retired services are not in the matrix
      expect(detail.body.groups).toEqual([{ id: A.groups.eng, name: 'Engineering' }]);
      expect(detail.body.projects.map((p: any) => [p.name, p.role, p.via])).toEqual([['Project Two', 'member', 'direct']]);
      expect(detail.body.tokens.map((t: any) => t.label)).toEqual(['alice-ci']);
      expect(detail.body.tokens[0]).toMatchObject({ prefix: 'cp_alice', status: 'active', scoped: false });
      expect(detail.body.tokens[0].secret).toBeUndefined();
      expect(detail.body.policies).toEqual([]);

      // dave works in two projects; inside the first the explicit setting narrows, inside the second nothing does
      const daveDetail = await call('GET', `/api/iam/principals/user/${A.users.dave._id}?projectId=${A.projects.pj1}`, A, 'reader');
      expect(daveDetail.body.projects.map((p: any) => p.name).sort()).toEqual(['Project One', 'Project Two']);
      const narrowed = daveDetail.body.effective.find((e: any) => e.service === 'agents');
      expect(narrowed.level).toBe('read');
      expect(narrowed.sources.map((s: any) => s.kind)).toContain('project');
      const free = await call('GET', `/api/iam/principals/user/${A.users.dave._id}?projectId=${A.projects.pj2}`, A, 'reader');
      expect(free.body.effective.find((e: any) => e.service === 'agents').level).toBe('write');
    });

    it('shows group grants, the owner path, and the policies that apply (naming it, its groups, or everyone)', async () => {
      const policies = [
        await call('POST', '/api/iam/policies', A, 'admin', { name: 'Everyone', mode: 'monitor', spec: { effect: 'forbid', principals: { any: true }, actions: ['agents.write'], resources: { any: true } } }),
        await call('POST', '/api/iam/policies', A, 'admin', { name: 'Engineers', mode: 'monitor', spec: memberSpec(A) }),
        await call('POST', '/api/iam/policies', A, 'admin', { name: 'Operators', mode: 'monitor', spec: memberSpec(A, { principals: { groups: [A.groups.ops] } }) }),
      ];
      try {
        const bob = await call('GET', `/api/iam/principals/user/${A.users.bob._id}`, A, 'reader');
        expect(bob.body.policies.map((p: any) => p.name).sort()).toEqual(['Engineers', 'Everyone']);
        const group = bob.body.effective.find((e: any) => e.service === 'prompts');
        expect(group.sources.some((s: any) => s.kind === 'group' && s.label === 'Engineering' && s.level === 'write')).toBe(true);
        const direct = bob.body.effective.find((e: any) => e.service === 'agents');
        expect(direct.sources.map((s: any) => s.kind)).toEqual(expect.arrayContaining(['role', 'direct', 'group']));
        const owner = await call('GET', `/api/iam/principals/user/${A.users.owner._id}`, A, 'reader');
        expect(owner.body.effective.every((e: any) => e.level === 'admin')).toBe(true);
      } finally {
        for (const p of policies) await call('DELETE', `/api/iam/policies/${p.body.policyId}`, A, 'admin');
      }
    });

    it('describes a token: its scope caps what its owner can do, and enforced policies show as a source', async () => {
      const detail = await call('GET', `/api/iam/principals/token/${A.tokens.bobScoped}`, A, 'reader');
      expect(detail.status).toBe(200);
      expect(detail.body.principal).toMatchObject({ type: 'token', label: 'bob-scoped', ownerId: String(A.users.bob._id), role: 'user', scope: { agents: 'read' } });
      expect(detail.body.tokens).toBeNull();
      const agents = detail.body.effective.find((e: any) => e.service === 'agents');
      expect(agents.level).toBe('read');
      expect(agents.sources.some((s: any) => s.kind === 'token-scope' && s.level === 'read')).toBe(true);
      expect(detail.body.effective.find((e: any) => e.service === 'models').level).toBe('none'); // outside the scope

      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'No reads of prompts', mode: 'enforce', spec: { effect: 'forbid', principals: { users: [String(A.users.alice._id)] }, actions: ['prompts.read'], resources: { any: true } } });
      try {
        const aliceTok = await call('GET', `/api/iam/principals/token/${A.tokens.aliceCi}`, A, 'reader');
        const prompts = aliceTok.body.effective.find((e: any) => e.service === 'prompts');
        expect(prompts.level).toBe('none');
        expect(prompts.sources.some((s: any) => s.kind === 'policy')).toBe(true);
        expect(aliceTok.body.policies.map((p: any) => p.name)).toEqual(['No reads of prompts']); // the owner is named
      } finally {
        await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'admin');
      }
    });

    it('describes a group', async () => {
      const detail = await call('GET', `/api/iam/principals/group/${A.groups.eng}`, A, 'reader');
      expect(detail.status).toBe(200);
      expect(detail.body.principal).toMatchObject({ type: 'group', label: 'Engineering', memberCount: 2 });
      expect(detail.body.effective.find((e: any) => e.service === 'agents')).toMatchObject({ level: 'write', sources: [{ kind: 'group', label: 'Engineering', level: 'write' }] });
      expect(detail.body.effective.find((e: any) => e.service === 'members').level).toBe('none');
    });

    it('answers 404 for unknown principals and another workspace\'s principals', async () => {
      for (const path of [
        `user/${B.users.alice._id}`, `group/${B.groups.eng}`, `token/${B.tokens.aliceCi}`,
        'user/0123456789abcdef01234567', 'group/0123456789abcdef01234567', 'token/0123456789abcdef01234567', 'user/not-an-id', 'user/a%22b',
      ]) {
        const res = await call('GET', `/api/iam/principals/${path}`, A, 'reader');
        expect(res.status, path).toBe(404);
        expect(res.body.code).toBe('principal_not_found');
      }
      expect((await call('GET', `/api/iam/principals/robot/${A.users.alice._id}`, A, 'reader')).status).toBe(400);
      expect((await call('GET', `/api/iam/principals/user/${A.users.alice._id}?projectId=a%22b`, A, 'reader')).status).toBe(400);
    });
  });

  // ── audit ───────────────────────────────────────────────────────────────

  describe('audit', () => {
    it('lists enforce-mode denials with their decision and deciding policy, filtered by principal, service and date', async () => {
      const t = await build('audit');
      const at = (ms: number) => new Date(Date.now() - ms);
      const row = (extra: Record<string, unknown>) => ({ tenantId: t.id, actorType: 'user' as const, action: 'write' as const, outcome: 'denied' as const, statusCode: 403, ...extra });
      await db.runWithTenant!(t.dbName, async () => {
        await db.createAuditLog(row({ actorUserId: String(t.users.alice._id), service: 'agents', event: 'POST /api/agents', method: 'POST', path: '/api/agents', metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-audit-0001', deniedService: 'agents', required: 'write', policyIds: ['pol-x'], reasons: ['custom:pol-x'] } }) as never);
        await db.createAuditLog(row({ actorType: 'api_token', actorUserId: String(t.users.bob._id), apiTokenId: t.tokens.bobScoped, service: 'models', action: 'read', event: 'GET /api/client/v1/models', method: 'GET', path: '/api/client/v1/models', metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-audit-0002', deniedService: 'models', required: 'read', reasons: ['managed:boundary:token-cap-read'] } }) as never);
        await db.createAuditLog(row({ actorUserId: String(t.users.alice._id), service: 'iam', action: 'security', event: 'GET /api/nowhere', method: 'GET', path: '/api/nowhere', metadata: { iamEnforce: true, code: 'route_not_declared', decisionId: 'dec-audit-0003' } }) as never);
        await db.createAuditLog(row({ actorUserId: String(t.users.alice._id), service: 'agents', event: 'POST /api/agents', method: 'POST', path: '/api/agents', metadata: { plain: 'legacy denial' } }) as never); // not an engine denial
      });
      const all = await call('GET', '/api/iam/audit?kind=denials', t, 'reader');
      expect(all.status).toBe(200);
      expect(all.body.items).toHaveLength(3);
      expect(all.body.nextCursor).toBeNull();
      const byDecision = (id: string) => all.body.items.find((i: any) => i.decisionId === id);
      expect(byDecision('dec-audit-0001')).toMatchObject({
        kind: 'denials', service: 'agents', action: 'agents.write', route: '/api/agents', method: 'POST', code: 'forbidden', policyId: 'pol-x',
        principal: { type: 'user', id: String(t.users.alice._id), label: 'Alice audit' },
      });
      expect(byDecision('dec-audit-0001').summary).toMatch(/Denied POST \/api\/agents: agents needs write by policy "pol-x"/);
      expect(byDecision('dec-audit-0002')).toMatchObject({ principal: { type: 'token', id: t.tokens.bobScoped, label: 'bob-scoped' }, action: 'models.read' });
      expect(byDecision('dec-audit-0002').summary).toMatch(/by the token scope/);
      expect(byDecision('dec-audit-0003')).toMatchObject({ code: 'route_not_declared', action: 'security' });

      const q = async (qs: string) => (await call('GET', `/api/iam/audit?kind=denials&${qs}`, t, 'reader')).body.items.map((i: any) => i.decisionId).sort();
      expect(await q(`principalType=user&principalId=${t.users.alice._id}`)).toEqual(['dec-audit-0001', 'dec-audit-0003']);
      expect(await q(`principalType=token&principalId=${t.tokens.bobScoped}`)).toEqual(['dec-audit-0002']);
      // a group stands for its members, and a member's token acts as the member
      expect(await q(`principalType=group&principalId=${t.groups.eng}`)).toEqual(['dec-audit-0001', 'dec-audit-0002', 'dec-audit-0003']);
      expect(await q(`principalType=group&principalId=${t.groups.ops}`)).toEqual([]);
      expect(await q(`principalType=user&principalId=${t.users.bob._id}`)).toEqual(['dec-audit-0002']);
      expect(await q('service=models')).toEqual(['dec-audit-0002']);
      expect(await q(`from=${encodeURIComponent(at(3_600_000).toISOString())}`)).toHaveLength(3);
      expect(await q(`from=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`)).toEqual([]);
      expect(await q(`to=${encodeURIComponent(at(3_600_000).toISOString())}`)).toEqual([]);

      const page = await call('GET', '/api/iam/audit?kind=denials&limit=2', t, 'reader');
      expect(page.body.items).toHaveLength(2);
      const rest = await call('GET', `/api/iam/audit?kind=denials&limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`, t, 'reader');
      expect(rest.body.items).toHaveLength(1);
      expect(rest.body.nextCursor).toBeNull();
    });

    it('lists what monitor-mode policies would have changed', async () => {
      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Watch agent writes', mode: 'monitor', spec: memberSpec(A) });
      try {
        const principal = userPrincipal({ userId: String(A.users.alice._id), user: { role: 'user' }, groupIds: [A.groups.eng] });
        const result = await authorizeGate({ tenant: A.dbName, principal, service: 'agents', method: 'POST' });
        expect(result.monitor).toMatchObject({ differs: true, policyIds: [policy.body.policyId] });
        for (let i = 0; i < 3; i++) {
          recordPolicyMonitor(A.dbName, result, { service: 'agents', method: 'POST', route: '/api/agents', requestId: `r${i}`, userId: String(A.users.alice._id), role: 'user' });
        }
        await flushShadowEvents(A.dbName);

        const feed = await call('GET', '/api/iam/audit?kind=monitor', A, 'reader');
        expect(feed.status).toBe(200);
        const item = feed.body.items.find((i: any) => i.policyId === policy.body.policyId);
        expect(item).toMatchObject({ kind: 'monitor', service: 'agents', method: 'POST', route: '/api/agents', action: 'agents.write', code: 'would_deny', principal: { type: 'user', id: String(A.users.alice._id) } });
        expect(item.summary).toMatch(/Policy "Watch agent writes" would deny POST \/api\/agents \(3 times/);

        // ... and the policy row carries the counts
        const row = (await call('GET', `/api/iam/policies/${policy.body.policyId}`, A, 'reader')).body;
        expect(row.monitorStats).toMatchObject({ wouldDeny: 3, wouldAllow: 0 });
        expect(typeof row.monitorStats.since).toBe('string');

        // editing the policy resets its counts
        const edited = await call('PUT', `/api/iam/policies/${policy.body.policyId}`, A, 'admin', { spec: memberSpec(A, { actions: ['Write'] }) });
        expect(edited.body.monitorStats).toMatchObject({ wouldDeny: 0, wouldAllow: 0, since: null });
        expect((await call('GET', '/api/iam/audit?kind=monitor', A, 'reader')).body.items.filter((i: any) => i.policyId === policy.body.policyId)).toEqual([]);

        // the engine report (shadow summary) does not mix the policy's counts into its totals
        const summary = await app.inject({ method: 'GET', url: '/api/iam/shadow/summary', headers: headers(A, A.users.admin) });
        const body = JSON.parse(summary.body);
        expect(body.categories.map((c: any) => c.category)).toEqual(['parity-mismatch', 'token-groups', 'project-narrowing', 'unmapped-path']);
      } finally {
        await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'admin');
      }
    });

    it('exports CSV with the same filters and neutralises spreadsheet formulas', async () => {
      const t = await build('csv');
      await db.runWithTenant!(t.dbName, async () => {
        await db.createAuditLog({
          tenantId: t.id, actorType: 'user', actorUserId: String(t.users.alice._id), service: 'agents', action: 'write', event: 'POST /api/agents', method: 'POST',
          path: '/api/agents,"quoted"', statusCode: 403, outcome: 'denied',
          metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-csv-0001', deniedService: 'agents', required: 'write', policyIds: ['=HYPERLINK("http://evil")'] },
        } as never);
      });
      await db.runWithTenant!(t.dbName, async () => {
        await db.createAuditLog({
          tenantId: t.id, actorType: 'user', actorUserId: String(t.users.bob._id), service: 'agents', action: 'write', event: 'POST /api/agents', method: 'POST',
          path: '/api/agents', statusCode: 403, outcome: 'denied', metadata: { iamEnforce: true, code: 'forbidden', decisionId: 'dec-csv-0002', deniedService: 'agents', required: 'write' },
        } as never);
      });
      const res = await call('GET', '/api/iam/audit/export?kind=denials', t, 'reader');
      expect(res.status).toBe(200);
      expect(String(res.headers['content-type'])).toMatch(/^text\/csv/);
      expect(String(res.headers['content-disposition'])).toMatch(/attachment; filename="iam-audit-denials-\d{4}-\d{2}-\d{2}\.csv"/);
      const lines = res.raw.trim().split('\n');
      expect(lines[0]).toBe('time,kind,principalType,principalId,principalLabel,actor,service,action,method,route,code,decisionId,policyId,summary');
      expect(lines).toHaveLength(3);
      expect(res.raw).toContain('"/api/agents,""quoted"""'); // quoting
      expect(res.raw).toContain(`'=HYPERLINK(`); // formula neutralised
      const filtered = await call('GET', `/api/iam/audit/export?kind=denials&principalType=user&principalId=${t.users.bob._id}`, t, 'reader');
      expect(filtered.raw.trim().split('\n')).toHaveLength(2);
      const empty = await call('GET', '/api/iam/audit/export?kind=changes', t, 'reader');
      expect(empty.raw.trim().split('\n')).toHaveLength(1); // header only
    });

    it('validates its filters', async () => {
      for (const [qs, code] of [
        ['kind=everything', 'invalid_kind'], ['from=not-a-date', 'invalid_date'], ['to=nope', 'invalid_date'],
        ['principalType=robot&principalId=x', 'invalid_principal'], ['principalType=user', 'invalid_principal'], ['principalId=abc', 'invalid_principal'],
        ['principalType=user&principalId=a%22b', 'invalid_principal'], ['service=spaceship', 'invalid_service'], ['cursor=zzz', 'invalid_cursor'],
      ] as const) {
        const res = await call('GET', `/api/iam/audit?${qs}`, A, 'reader');
        expect(res.status, qs).toBe(400);
        expect(res.body.code).toBe(code);
      }
      expect((await call('GET', '/api/iam/audit/export?kind=nope', A, 'reader')).status).toBe(400);
      expect((await call('GET', '/api/iam/audit?limit=100000', A, 'reader')).status).toBe(200);
    });
  });

  // ── settings and mode ───────────────────────────────────────────────────

  describe('settings', () => {
    it('reads defaults, merges updates, validates and audits', async () => {
      const t = await build('settings');
      resetIamSettingsCacheForTests();
      expect((await call('GET', '/api/iam/settings', t, 'reader')).body).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });

      const first = await call('PUT', '/api/iam/settings', t, 'admin', { tokens: { maxLifetimeDays: 90 } });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ tokens: { maxLifetimeDays: 90, requireExpiry: false } });
      const second = await call('PUT', '/api/iam/settings', t, 'admin', { tokens: { requireExpiry: true } });
      expect(second.body).toEqual({ tokens: { maxLifetimeDays: 90, requireExpiry: true } });
      expect((await call('GET', '/api/iam/settings', t, 'reader')).body).toEqual({ tokens: { maxLifetimeDays: 90, requireExpiry: true } });
      expect((await call('PUT', '/api/iam/settings', t, 'admin', { tokens: { maxLifetimeDays: null } })).body.tokens).toEqual({ maxLifetimeDays: null, requireExpiry: true });

      for (const body of [{ tokens: { maxLifetimeDays: 0 } }, { tokens: { maxLifetimeDays: 4000 } }, { tokens: { maxLifetimeDays: 1.5 } }, { tokens: { maxLifetimeDays: '30' } }, { tokens: { requireExpiry: 'yes' } }, { tokens: { surprise: 1 } }, { other: 1 }, { tokens: 5 }]) {
        const res = await call('PUT', '/api/iam/settings', t, 'admin', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe('validation');
        expect(res.body.details.length).toBeGreaterThan(0);
      }
      expect((await call('GET', '/api/iam/settings', t, 'reader')).body.tokens).toEqual({ maxLifetimeDays: null, requireExpiry: true }); // invalid input changed nothing

      const changes = await call('GET', '/api/iam/audit?kind=changes', t, 'reader');
      const updates = changes.body.items.filter((i: any) => i.action === 'iam.settings.update');
      expect(updates).toHaveLength(3);
      expect(updates.map((u: any) => u.summary).join(' | ')).toMatch(/token max lifetime 90 days/);
    });
  });

  describe('mode changes', () => {
    it('are audited with the previous and the new mode', async () => {
      const t = await build('mode');
      resetAuthzModeCacheForTests();
      const first = await call('PUT', '/api/iam/mode', t, 'owner', { mode: 'shadow' });
      expect(first.status).toBe(200);
      // choosing the mode that is already on changes nothing: it is not a row in the change history, and the
      // "last changed" stamp stays where it was
      const again = await call('PUT', '/api/iam/mode', t, 'owner', { mode: 'shadow' });
      expect(again.status).toBe(200);
      expect(again.body.mode).toBe('shadow');
      expect(again.body.updatedAt).toBe(first.body.updatedAt);
      expect((await call('PUT', '/api/iam/mode', t, 'owner', { mode: 'legacy' })).status).toBe(200);
      const changes = await call('GET', '/api/iam/audit?kind=changes', t, 'reader');
      const modes = changes.body.items.filter((i: any) => i.action === 'iam.mode.change').map((i: any) => i.summary);
      expect(modes).toHaveLength(2);
      expect(modes.join(' | ')).toContain('from legacy to shadow');
      expect(modes.join(' | ')).toContain('from shadow to legacy');
      expect(modes.join(' | ')).not.toContain('from shadow to shadow');
    });
  });

  // ── isolation ───────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('keeps every endpoint inside its workspace', async () => {
      const policyA = await call('POST', '/api/iam/policies', A, 'admin', { name: 'A only', mode: 'enforce', spec: memberSpec(A) });
      try {
        const id = policyA.body.policyId;
        // B does not see, read, change or delete A's policy
        expect((await call('GET', '/api/iam/policies', B, 'reader')).body.custom.map((p: any) => p.policyId)).not.toContain(id);
        expect((await call('GET', `/api/iam/policies/${id}`, B, 'reader')).status).toBe(404);
        expect((await call('PUT', `/api/iam/policies/${id}`, B, 'admin', { name: 'hijacked' })).status).toBe(404);
        expect((await call('DELETE', `/api/iam/policies/${id}`, B, 'admin')).status).toBe(404);
        expect((await call('GET', `/api/iam/policies/${id}`, A, 'reader')).body.name).toBe('A only');

        // B's policy set does not decide A's people (and vice versa)
        const simA = await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'user', id: String(A.users.alice._id) }, action: 'agents.write', resource: { kind: 'service', service: 'agents' } });
        expect(simA.body.allowed).toBe(false);
        const simB = await call('POST', '/api/iam/simulate', B, 'reader', { principal: { type: 'user', id: String(B.users.alice._id) }, action: 'agents.write', resource: { kind: 'service', service: 'agents' } });
        expect(simB.body.allowed).toBe(true);

        // directories
        for (const type of ['user', 'group', 'token']) {
          const listed = await call('GET', `/api/iam/principals?type=${type}&limit=100`, B, 'reader');
          const idsA = new Set([...Object.values(A.users).map((u) => String(u._id)), ...Object.values(A.groups), ...Object.values(A.tokens)]);
          expect(listed.body.items.length).toBeGreaterThan(0);
          expect(listed.body.items.some((i: any) => idsA.has(i.id)), type).toBe(false);
        }
        // audit and settings
        const auditB = await call('GET', '/api/iam/audit?kind=changes&limit=200', B, 'reader');
        expect(auditB.body.items.some((i: any) => i.policyId === id)).toBe(false);
        const auditA = await call('GET', '/api/iam/audit?kind=changes&limit=200', A, 'reader');
        expect(auditA.body.items.some((i: any) => i.policyId === id)).toBe(true);
        await call('PUT', '/api/iam/settings', A, 'admin', { tokens: { maxLifetimeDays: 30 } });
        resetIamSettingsCacheForTests();
        expect((await call('GET', '/api/iam/settings', B, 'reader')).body.tokens.maxLifetimeDays).toBeNull();
        expect((await call('GET', '/api/iam/audit/export?kind=changes', B, 'reader')).raw).not.toContain(id);
        // the preview of B's draft cannot even name A's group
        expect((await call('POST', '/api/iam/policies/preview', B, 'reader', { spec: memberSpec(A) })).status).toBe(400);
      } finally {
        await call('DELETE', `/api/iam/policies/${policyA.body.policyId}`, A, 'admin');
        await call('PUT', '/api/iam/settings', A, 'admin', { tokens: { maxLifetimeDays: null } });
      }
    });
  });
});
