/**
 * Authorization center API (/api/iam/*) end to end: the REAL plugin, the REAL
 * gate and engine, a real database - on BOTH SQLite and MongoDB.
 *
 *   RBAC (read vs admin)  catalog  policies (CRUD, spec / Cedar, validation, audit)
 *   compile  preview  simulate  decisions  principals  audit (+CSV)  settings
 *   the retired workspace mode  tenant isolation of every endpoint
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
import { registerIamPortalResolver } from '@/enterprise/iam-portal';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { primeProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { recordRegisteredRoute, resetRouteRegistryForTests } from '@/lib/iam/routeRegistry';
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
        ['GET', '/api/iam/audit'], ['GET', '/api/iam/settings'], ['GET', '/api/iam/decisions/abc-12345678'], ['GET', '/api/iam/engine/stats'],
        ['POST', '/api/iam/simulate', {}], ['POST', '/api/iam/policies/compile', {}], ['POST', '/api/iam/policies', {}],
      ] as const) {
        expect((await call(method, url, A, 'plain', body)).status, `${method} ${url}`).toBe(403);
      }
    });

    it('lets iam:read view and run the compute-only tools, but not change anything', async () => {
      for (const url of ['/api/iam/catalog', '/api/iam/policies', '/api/iam/principals?type=user', '/api/iam/audit', '/api/iam/settings', '/api/iam/engine/stats']) {
        expect((await call('GET', url, A, 'reader')).status, url).toBe(200);
      }
      expect((await call('POST', '/api/iam/policies/compile', A, 'reader', { spec: memberSpec(A) })).status).toBe(200);
      expect((await call('POST', '/api/iam/policies/preview', A, 'reader', { spec: memberSpec(A) })).status).toBe(200);
      expect((await call('POST', '/api/iam/simulate', A, 'reader', { principal: { type: 'user', id: String(A.users.alice._id) }, action: 'agents.read', resource: { kind: 'service', service: 'agents' } })).status).toBe(200);

      expect((await call('POST', '/api/iam/policies', A, 'reader', { name: 'x', spec: memberSpec(A) })).status).toBe(403);
      expect((await call('PUT', '/api/iam/policies/p-1', A, 'reader', { name: 'y' })).status).toBe(403);
      expect((await call('DELETE', '/api/iam/policies/p-1', A, 'reader')).status).toBe(403);
      expect((await call('PUT', '/api/iam/settings', A, 'reader', { tokens: { requireExpiry: true } })).status).toBe(403);
    });

    it('lets an admin do all of it', async () => {
      const created = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Admin made', enabled: false, spec: memberSpec(A) });
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
      const created = await call('POST', '/api/iam/policies', A, 'admin', { name: '  Freeze agents  ', description: 'Nobody in Engineering changes agents', enabled: true, spec: memberSpec(A) });
      expect(created.status).toBe(201);
      const row = created.body;
      expect(row).toMatchObject({
        name: 'Freeze agents', description: 'Nobody in Engineering changes agents', effect: 'forbid', enabled: true,
        statementCount: 1, updatedBy: String(A.users.admin._id),
      });
      // a policy is enabled or disabled: there is no mode and no monitor counter any more
      for (const gone of ['mode', 'monitorStats']) expect(row).not.toHaveProperty(gone);
      expect(row.policyId).toMatch(/^p-[0-9a-f]{12}$/);
      expect(row.spec).toMatchObject({ effect: 'forbid', actions: ['agents.write'] });
      expect(row.cedar).toContain('forbid (');
      expect(row.cedar).toContain(`Group::"${A.groups.eng}"`);
      expect(typeof row.createdAt).toBe('string');

      const list = await call('GET', '/api/iam/policies', A, 'reader');
      expect(list.body.managed).toHaveLength(19); // six RBAC permits, six boundary forbids, four portal rules, three agent approval rules
      expect(list.body.managed.filter((m: any) => m.group === 'portal').map((m: any) => m.id)).toEqual([
        'managed:portal:use', 'managed:portal:use-boundary', 'managed:portal:agent', 'managed:portal:agent-boundary',
      ]);
      expect(list.body.managed[0]).toMatchObject({ id: 'managed:rbac:user-read', group: 'rbac', effect: 'permit' });
      expect(list.body.managed[0].name).toBeTruthy();
      expect(list.body.managed[0].description).toBeTruthy();
      expect(list.body.managed[0].cedar).toContain('permit');
      expect(list.body.custom.map((p: any) => p.policyId)).toContain(row.policyId);

      expect((await call('GET', `/api/iam/policies/${row.policyId}`, A, 'reader')).body.policyId).toBe(row.policyId);

      // update: rename + new spec
      const updated = await call('PUT', `/api/iam/policies/${row.policyId}`, A, 'admin', {
        name: 'Freeze agents v2', enabled: true,
        spec: memberSpec(A, { actions: ['Write'], resources: { services: ['agents', 'models'] } }),
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: 'Freeze agents v2', enabled: true });
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
      expect(mine.find((i: any) => i.action === 'iam.policy.create').summary).toMatch(/Created policy "Freeze agents" \(forbid\)/);
      expect(mine[0].actor).toBe(String(A.users.admin.email));

      const rows = await db.iamListAuditEvents({ tenantId: A.id, resourceTypes: ['iam-policy'], limit: 50 });
      const createRow = rows.items.find((r) => r.event === 'iam.policy.create' && r.resourceId === row.policyId)!;
      expect(createRow).toMatchObject({ service: 'iam', action: 'admin', outcome: 'success', resourceType: 'iam-policy' });
      expect(createRow.metadata).toMatchObject({ policyId: row.policyId, name: 'Freeze agents', enabled: true, effect: 'forbid', statementCount: 1, iamChange: true });
      expect(createRow.metadata).not.toHaveProperty('mode');
      expect(String(createRow.metadata!.cedar)).toContain('forbid (');
      expect(Buffer.byteLength(String(createRow.metadata!.cedar))).toBeLessThanOrEqual(4096);
    });

    it('narrows the list to one resource: the policies that name it and those for all of its kind, each with how', async () => {
      // a build with portals: a rule about portal.use takes effect there, so the editor accepts it
      registerIamPortalResolver(async () => null);
      const make = async (name: string, body: Record<string, unknown>) => {
        const res = await call('POST', '/api/iam/policies', A, 'admin', { name, enabled: true, ...body });
        expect(res.status, `${name} ${JSON.stringify(res.body)}`).toBe(201);
        return res.body.policyId as string;
      };
      const direct = await make('Block one portal', { cedar: 'forbid(principal, action == Action::"portal.use", resource == Portal::"P1");' });
      const all = await make('Block portal use', { spec: { effect: 'forbid', principals: { groups: [A.groups.eng] }, actions: ['portal.use'], resources: { any: true } } });
      const another = await make('Block another portal', { cedar: 'forbid(principal, action == Action::"portal.use", resource == Portal::"P2");' });
      const unrelated = await make('Freeze agents', { spec: memberSpec(A) });
      try {
        const scopes = (res: { body: { custom: Array<{ policyId: string; scope?: string }> } }) =>
          Object.fromEntries(res.body.custom.map((p) => [p.policyId, p.scope]));

        const one = await call('GET', '/api/iam/policies?resourceType=portal&resourceId=P1', A, 'reader');
        expect(one.status).toBe(200);
        expect(one.body.managed.length).toBeGreaterThan(0); // the built-in rules are listed as always
        expect(scopes(one)).toEqual({ [direct]: 'this', [all]: 'all' });
        expect(one.body.custom.find((p: any) => p.policyId === direct)).toMatchObject({ name: 'Block one portal', effect: 'forbid', enabled: true });

        // another portal: its own rule and the one for all portals
        expect(scopes(await call('GET', '/api/iam/policies?resourceType=portal&resourceId=P2', A, 'reader'))).toEqual({ [another]: 'this', [all]: 'all' });
        // one nobody wrote about: only what applies to every portal
        expect(scopes(await call('GET', '/api/iam/policies?resourceType=portal&resourceId=P3', A, 'reader'))).toEqual({ [all]: 'all' });
        // a type the narrowing does not judge answers an empty list, not a guess
        const agent = await call('GET', '/api/iam/policies?resourceType=agent&resourceId=P1', A, 'reader');
        expect(agent.status).toBe(200);
        expect(agent.body.custom).toEqual([]);

        // without the query it is the whole list, and no row has a scope
        const everything = await call('GET', '/api/iam/policies', A, 'reader');
        expect(everything.body.custom.map((p: any) => p.policyId)).toEqual(expect.arrayContaining([direct, all, another, unrelated]));
        expect(everything.body.custom.every((p: any) => p.scope === undefined)).toBe(true);

        // another workspace sees none of these
        expect((await call('GET', '/api/iam/policies?resourceType=portal&resourceId=P1', B, 'reader')).body.custom).toEqual([]);
      } finally {
        for (const id of [direct, all, another, unrelated]) await call('DELETE', `/api/iam/policies/${id}`, A, 'admin');
        registerIamPortalResolver(null);
      }
    });

    it('refuses a resource filter that is not a type and an id', async () => {
      for (const query of [
        'resourceType=portal', // the id is missing
        'resourceId=P1', // the type is missing
        'resourceType=&resourceId=',
        'resourceType=nope&resourceId=P1', // not a resource type
        'resourceType=portal&resourceId=not%20an%20id!', // not an id
        `resourceType=portal&resourceId=${'x'.repeat(300)}`,
        'resourceType=portal&resourceType=agent&resourceId=P1', // repeated
        'resourceType=portal&resourceId=P1&resourceId=P2',
      ]) {
        const res = await call('GET', `/api/iam/policies?${query}`, A, 'reader');
        expect([res.status, res.body.code], query).toEqual([400, 'validation']);
        expect(res.body.custom, query).toBeUndefined();
      }
    });

    it('stores raw Cedar as is and reports mixed effects', async () => {
      const cedar = 'forbid(principal, action == Action::"models.write", resource is Service);\npermit(principal is User, action == Action::"agents.read", resource is Service);';
      const res = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Raw', enabled: true, cedar });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ spec: null, cedar, effect: 'mixed', statementCount: 2, enabled: true });
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
      await bad({ name: 'x' }, /spec or Cedar/);
      await bad({ name: 'x', spec: memberSpec(A), cedar: 'permit(principal, action, resource);' }, /not both/);
      await bad({ name: 'x'.repeat(200), spec: memberSpec(A) }, /at most 120/);
      await bad({ name: 'x', enabled: 'yes', spec: memberSpec(A) }, /enabled must be/);
      await bad({ name: 'x', spec: memberSpec(A), surprise: 1 }, /Unknown field/);
      await bad({ name: 'x', spec: memberSpec(A, { actions: [] }) }, /at least one action/);
      await bad({ name: 'x', spec: memberSpec(A, { actions: ['nope.nope'] }) }, /not an action/);
      // the retired mode: "enforce" is what an enabled policy is (accepted, ignored); monitor and anything else is refused
      await bad({ name: 'x', mode: 'weird', spec: memberSpec(A) }, /mode is no longer used/);
      await bad({ name: 'x', mode: 'monitor', spec: memberSpec(A) }, /Monitor mode no longer exists/);
      const monitor = await call('POST', '/api/iam/policies', A, 'admin', { name: 'x', mode: 'monitor', spec: memberSpec(A) });
      expect(monitor.body.details).toEqual([expect.objectContaining({ code: 'monitor_removed', field: 'mode' })]);
      const enforce = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Spelled out', mode: 'enforce', enabled: false, spec: memberSpec(A) });
      expect(enforce.status).toBe(201);
      expect(enforce.body).not.toHaveProperty('mode');
      // ... on an update as well
      const retired = await call('PUT', `/api/iam/policies/${enforce.body.policyId}`, A, 'admin', { mode: 'monitor' });
      expect(retired.status).toBe(400);
      expect(retired.body.details).toEqual([expect.objectContaining({ code: 'monitor_removed', field: 'mode' })]);
      expect((await call('PUT', `/api/iam/policies/${enforce.body.policyId}`, A, 'admin', { mode: 'enforce', name: 'Still fine' })).status).toBe(200);
      await call('DELETE', `/api/iam/policies/${enforce.body.policyId}`, A, 'admin');
      expect((await call('POST', '/api/iam/policies', A, 'admin', undefined)).status).toBe(400);
    });

    it('verifies that every id of a spec exists in THIS workspace', async () => {
      const refuse = async (spec: unknown, what: RegExp) => {
        const res = await call('POST', '/api/iam/policies', A, 'admin', { name: 'x', spec });
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
        name: 'Everything real', enabled: false,
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
        name: 'Broken',
        cedar: 'permit(principal is User, action, resource)\nwhen { principal.nonexistent == "x" };',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation');
      expect(res.body.details[0].message).toMatch(/nonexistent/);
      expect(res.body.details[0]).toMatchObject({ line: 2 });
      expect(typeof res.body.details[0].col).toBe('number');

      const syntax = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Syntax', cedar: 'permit(principal action resource);' });
      expect(syntax.status).toBe(400);
      expect(syntax.body.details[0].line).toBe(1);

      const managed = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Sneaky', cedar: '@managed("rbac") permit(principal is User, action, resource);' });
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
          await db.iamDocPut('iam_policies', `bulk-${i}`, { _id: `bulk-${i}`, policyId: `bulk-${i}`, name: 'b', cedar: 'forbid(principal, action == Action::"tool.delete", resource is Tool);', enabled: false, createdBy: 'x', updatedBy: 'x', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        }
      });
      const full = await call('POST', '/api/iam/policies', tight, 'admin', { name: 'one too many', cedar: 'forbid(principal, action, resource);' });
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

    it('warns about a rule for an action nothing in the product asks for - read from the registered routes, never an error', async () => {
      // what the API plugin's onRoute hook records for a booted server: agents are checked for read (GET) and write (POST)
      recordRegisteredRoute('GET', '/api/agents', undefined);
      recordRegisteredRoute('POST', '/api/agents', undefined);
      try {
        const compile = (body: unknown) => call('POST', '/api/iam/policies/compile', A, 'reader', body);
        const never = await compile({ spec: memberSpec(A, { actions: ['agents.admin'] }) });
        expect(never.body.ok).toBe(true);
        expect(never.body.errors).toEqual([]);
        expect(never.body.warnings.find((w: any) => w.code === 'not_asked_actions')).toMatchObject({
          field: 'actions', params: { actions: 'agents.admin', effect: 'forbid' }, message: expect.stringContaining('would never block anything'),
        });
        const partly = await compile({ spec: memberSpec(A, { actions: ['agents.write', 'agents.admin'] }) });
        expect(partly.body.warnings.find((w: any) => w.code === 'partly_not_asked_actions')).toMatchObject({ field: 'actions', params: { actions: 'agents.admin' } });
        expect(partly.body.warnings.map((w: any) => w.code)).not.toContain('not_asked_actions');
        // a rule for what IS asked has no such warning; an allow rule says "grant"
        expect((await compile({ spec: memberSpec(A, { actions: ['agents.write'] }) })).body.warnings.map((w: any) => w.code)).not.toContain('not_asked_actions');
        const permit = await compile({ spec: { effect: 'permit', principals: { groups: [A.groups.eng] }, actions: ['agents.admin'], resources: { any: true } } });
        expect(permit.body.warnings.find((w: any) => w.code === 'not_asked_actions').message).toContain('would never grant anything');
        // raw Cedar gets the same warning as plain text
        const raw = await compile({ cedar: 'forbid(principal, action == Action::"agents.admin", resource);' });
        expect(raw.body.ok).toBe(true);
        expect(raw.body.warnings.map((w: any) => w.message).join(' ')).toMatch(/only names actions that nothing in the product checks yet \(agents\.admin\)/);
        // and it can still be saved (disabled here, so it does not touch the other tests)
        const saved = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Unasked', enabled: false, spec: memberSpec(A, { actions: ['agents.admin'] }) });
        expect(saved.status).toBe(201);
        await call('DELETE', `/api/iam/policies/${saved.body.policyId}`, A, 'admin');
      } finally {
        resetRouteRegistryForTests();
      }
      // without any registered route nothing can be said: no warning (unknown is not "asked by nobody")
      const unknown = await call('POST', '/api/iam/policies/compile', A, 'reader', { spec: memberSpec(A, { actions: ['agents.admin'] }) });
      expect(unknown.body.warnings.map((w: any) => w.code)).not.toContain('not_asked_actions');
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

      const stored = await call('POST', '/api/iam/policies', A, 'admin', { name: 'To edit', spec: memberSpec(A) });
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

    it('answers allowed / denied with the principal summary, and nothing but the engine\'s answer', async () => {
      const ok = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agents.write', resource: svc('agents') });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ allowed: true, defaultDeny: false, enforcedAtGate: true });
      // one answer: no workspace mode, no comparison with another rule set, no monitor verdict
      for (const gone of ['mode', 'legacy', 'monitor']) expect(ok.body).not.toHaveProperty(gone);
      expect(ok.body.reasons[0]).toMatchObject({ managed: true, effect: 'permit', policyId: null });
      expect(ok.body.reasons[0].name).toBeTruthy();
      expect(ok.body.principalSummary).toMatchObject({ type: 'user', id: alice().id, role: 'user' });
      expect(ok.body.principalSummary.groups).toEqual([{ id: A.groups.eng, name: 'Engineering' }]);

      const denied = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'members.write', resource: svc('members') });
      expect(denied.body).toMatchObject({ allowed: false, defaultDeny: true, reasons: [] });
    });

    it('explains which policy decided; a disabled policy takes no part', async () => {
      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'No agent writes for Engineering', spec: memberSpec(A) });
      const disabled = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Off: no model writes', enabled: false, spec: memberSpec(A, { actions: ['models.write'] }) });
      try {
        const blocked = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'agents.write', resource: svc('agents') });
        expect(blocked.body.allowed).toBe(false);
        expect(blocked.body.defaultDeny).toBe(false);
        expect(blocked.body.reasons).toEqual([expect.objectContaining({ policyId: policy.body.policyId, managed: false, name: 'No agent writes for Engineering', effect: 'forbid', cedarId: `custom:${policy.body.policyId}` })]);

        const off = await call('POST', '/api/iam/simulate', A, 'reader', { principal: alice(), action: 'models.write', resource: svc('models') });
        expect(off.body.allowed).toBe(true);
        expect(off.body.reasons.map((r: any) => r.policyId)).not.toContain(disabled.body.policyId);
        expect(off.body).not.toHaveProperty('monitor');
      } finally {
        await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'admin');
        await call('DELETE', `/api/iam/policies/${disabled.body.policyId}`, A, 'admin');
      }
    });

    it('evaluates a token: owner groups count, the scope caps, and a group policy reaches it', async () => {
      const scoped = { type: 'token', id: A.tokens.aliceCi };
      const plainTok = await call('POST', '/api/iam/simulate', A, 'reader', { principal: scoped, action: 'agents.write', resource: svc('agents') });
      expect(plainTok.body.allowed).toBe(true);
      expect(plainTok.body.principalSummary).toMatchObject({ type: 'token', label: 'alice-ci', tokenScope: null });
      const bobTok = { type: 'token', id: B.tokens.bobScoped };
      expect((await call('POST', '/api/iam/simulate', A, 'reader', { principal: bobTok, action: 'agents.read', resource: svc('agents') })).status).toBe(404); // another workspace's token

      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Eng no writes', spec: memberSpec(A) });
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

      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Office only', spec: { effect: 'forbid', principals: { any: true }, actions: ['agents.write'], resources: { any: true }, conditions: { ipRanges: ['203.0.113.0/24'], channels: ['dashboard'] } } });
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

    it('a token without a project runs in the workspace\'s default project, as the token gate does', async () => {
      const t = await build('defproj');
      const defaultProject = await db.runWithTenant!(t.dbName, () => db.createProject({ tenantId: t.id, key: 'default', name: 'Default', createdBy: 'x' }));
      const defaultId = String(defaultProject._id);
      // dave's settings in the DEFAULT project limit agents to read; his two other projects say nothing about it
      await db.runWithTenant!(t.dbName, async () => {
        await db.upsertUserProject({ tenantId: t.id, userId: String(t.users.dave._id), projectId: defaultId, role: 'member', servicePermissions: { agents: 'read' } });
      });
      const open = await db.runWithTenant!(t.dbName, () => db.createApiToken({
        tenantId: t.id, userId: String(t.users.dave._id), label: 'dave-open', tokenHash: `h-def-${Math.random()}`, tokenPrefix: 'cp_dave', createdBy: String(t.users.dave._id),
      } as never));
      const token = { type: 'token', id: String(open._id) };

      // no project given: the check runs where the gate would run the token - in the default project
      const write = await call('POST', '/api/iam/simulate', t, 'reader', { principal: token, action: 'agents.write', resource: svc('agents') });
      expect(write.status, JSON.stringify(write.body)).toBe(200);
      expect(write.body.projectId).toBe(defaultId);
      expect(write.body.allowed).toBe(false);
      expect(write.body.reasons.map((r: any) => r.cedarId)).toEqual(['managed:boundary:project-write']);
      expect((await call('POST', '/api/iam/simulate', t, 'reader', { principal: token, action: 'agents.read', resource: svc('agents') })).body.allowed).toBe(true);
      // an explicit project overrides it
      const elsewhere = await call('POST', '/api/iam/simulate', t, 'reader', { principal: token, action: 'agents.write', resource: svc('agents'), context: { projectId: t.projects.pj2 } });
      expect(elsewhere.body).toMatchObject({ allowed: true, projectId: t.projects.pj2 });

      // the principal detail agrees: the token is shown with the default project's limit ...
      const detail = await call('GET', `/api/iam/principals/token/${open._id}`, t, 'admin');
      expect(detail.body.effective.find((e: any) => e.service === 'agents').level).toBe('read');
      // ... where its owner, looked at in the workspace itself, is not limited by any project
      const owner = await call('GET', `/api/iam/principals/user/${t.users.dave._id}`, t, 'admin');
      expect(owner.body.effective.find((e: any) => e.service === 'agents').level).toBe('write');
    });

    it('an explicit "none" saved before the workspace\'s first decision is read as "not set"; one saved after it counts', async () => {
      const t = await build('levels');
      const dave = { type: 'user', id: String(t.users.dave._id) };
      const savePromptsNone = () => db.runWithTenant!(t.dbName, () => db.upsertUserProject({
        tenantId: t.id, userId: String(t.users.dave._id), projectId: t.projects.pj1, role: 'member', servicePermissions: { agents: 'read', prompts: 'none' },
      }));
      const prompts = async () => {
        const res = await call('POST', '/api/iam/simulate', t, 'reader', { principal: dave, action: 'prompts.write', resource: svc('prompts'), context: { projectId: t.projects.pj1 } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body;
      };
      const agents = async () => (await call('POST', '/api/iam/simulate', t, 'reader', { principal: dave, action: 'agents.write', resource: svc('agents'), context: { projectId: t.projects.pj1 } })).body;
      await savePromptsNone();

      // the row predates the workspace's activation instant: its none is not a decision somebody took
      primeProjectLevelsForTests(t.dbName, Date.now() + 3_600_000);
      expect((await prompts()).allowed).toBe(true);
      // ... while read / write / admin entries are always honoured
      expect((await agents()).allowed).toBe(false);

      // the instant is in the past (the row was saved after the workspace's first decision): the none counts
      primeProjectLevelsForTests(t.dbName, 0);
      const honoured = await prompts();
      expect(honoured.allowed).toBe(false);
      expect(honoured.reasons.map((r: any) => r.cedarId)).toEqual(['managed:boundary:project-write']);
      const detail = await call('GET', `/api/iam/principals/user/${t.users.dave._id}?projectId=${t.projects.pj1}`, t, 'reader');
      expect(detail.body.effective.find((e: any) => e.service === 'prompts').level).toBe('none');
    });

    it('an unrelated later save of an old row makes its old "none" count from then on (documented edge)', async () => {
      const t = await build('edge');
      const dave = { type: 'user', id: String(t.users.dave._id) };
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const save = (role: 'member' | 'project_admin') => db.runWithTenant!(t.dbName, () => db.upsertUserProject({
        tenantId: t.id, userId: String(t.users.dave._id), projectId: t.projects.pj1, role, servicePermissions: { prompts: 'none' },
      }));
      const promptsAllowed = async () => (await call('POST', '/api/iam/simulate', t, 'reader', { principal: dave, action: 'prompts.write', resource: svc('prompts'), context: { projectId: t.projects.pj1 } })).body.allowed;

      await save('member');
      await wait(25);
      primeProjectLevelsForTests(t.dbName, Date.now()); // the workspace's first decision happens now
      await wait(25);
      expect(await promptsAllowed()).toBe(true); // the old none is not read
      await save('project_admin'); // an unrelated change (the member's project role) saves the row again
      expect(await promptsAllowed()).toBe(false); // the row was saved after the activation: its none counts
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
      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Lock everyone out', spec: { effect: 'forbid', principals: { any: true }, actions: ['iam.write', 'iam.read'], resources: { any: true } } });
      try {
        // the policy is in force at the gate: an administrator and a reader are out of the center ...
        expect((await call('GET', '/api/iam/policies', A, 'admin')).status).toBe(403);
        expect((await call('GET', '/api/iam/policies', A, 'reader')).status).toBe(403);
        // ... and only the owner's own session still gets in, so it asks what the policy does to whom
        const owner = await call('POST', '/api/iam/simulate', A, 'owner', { principal: { type: 'user', id: String(A.users.owner._id) }, action: 'iam.write', resource: svc('iam') });
        expect(owner.body).toMatchObject({ allowed: true, ownerSafety: true });
        const admin = await call('POST', '/api/iam/simulate', A, 'owner', { principal: { type: 'user', id: String(A.users.admin._id) }, action: 'iam.write', resource: svc('iam') });
        expect(admin.body.allowed).toBe(false);
        // the owner's API TOKEN is an ordinary principal: the promise is about the signed-in owner
        expect(admin.body).not.toHaveProperty('ownerSafety');
      } finally {
        // only the owner can repair it
        expect((await call('DELETE', `/api/iam/policies/${policy.body.policyId}`, A, 'owner')).status).toBe(204);
      }
      expect((await call('GET', '/api/iam/policies', A, 'admin')).status).toBe(200);
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
      // an admin sees every token but the owner's
      const tokens = await call('GET', '/api/iam/principals?type=token', A, 'admin');
      expect(tokens.body.items.map((t: any) => t.label).sort()).toEqual(['alice-ci', 'bob-scoped']);
      expect(tokens.body.items.find((t: any) => t.label === 'alice-ci')).toMatchObject({ type: 'token', status: 'active', sublabel: 'cp_alice… · Alice a' });
      expect((await call('GET', '/api/iam/principals?type=token&q=bob', A, 'admin')).body.items).toHaveLength(1);
    });

    it('counts the policies that name a principal', async () => {
      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'Names alice', enabled: false, spec: memberSpec(A, { principals: { users: [String(A.users.alice._id)], groups: [A.groups.eng], tokens: [A.tokens.aliceCi] } }) });
      try {
        expect((await call('GET', '/api/iam/principals?type=user&q=alice', A, 'reader')).body.items[0].policyCount).toBe(1);
        expect((await call('GET', '/api/iam/principals?type=user&q=bob', A, 'reader')).body.items[0].policyCount).toBe(0);
        expect((await call('GET', '/api/iam/principals?type=group&q=engineer', A, 'reader')).body.items[0].policyCount).toBe(1);
        expect((await call('GET', '/api/iam/principals?type=token&q=alice-ci', A, 'admin')).body.items[0].policyCount).toBe(1);
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
      const detail = await call('GET', `/api/iam/principals/user/${A.users.alice._id}`, A, 'admin');
      expect(detail.status).toBe(200);
      expect(detail.body.principal).toMatchObject({ type: 'user', id: String(A.users.alice._id), label: 'Alice a', role: 'user', status: 'active' });
      const agents = detail.body.effective.find((e: any) => e.service === 'agents');
      expect(agents.level).toBe('write');
      expect(agents.sources.map((s: any) => s.kind)).toContain('role');
      const members = detail.body.effective.find((e: any) => e.service === 'members');
      expect(members.level).toBe('none');
      expect(detail.body.effective.find((e: any) => e.service === 'aegis')).toBeUndefined(); // retired services are not in the matrix
      // (a group also says where it comes from and whether the membership can be removed here)
      expect(detail.body.groups).toEqual([{ id: A.groups.eng, name: 'Engineering', source: 'local', tenantRole: 'user', removable: true }]);
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
        await call('POST', '/api/iam/policies', A, 'admin', { name: 'Everyone', enabled: false, spec: { effect: 'forbid', principals: { any: true }, actions: ['agents.write'], resources: { any: true } } }),
        await call('POST', '/api/iam/policies', A, 'admin', { name: 'Engineers', enabled: false, spec: memberSpec(A) }),
        await call('POST', '/api/iam/policies', A, 'admin', { name: 'Operators', enabled: false, spec: memberSpec(A, { principals: { groups: [A.groups.ops] } }) }),
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
      const detail = await call('GET', `/api/iam/principals/token/${A.tokens.bobScoped}`, A, 'admin');
      expect(detail.status).toBe(200);
      expect(detail.body.principal).toMatchObject({ type: 'token', label: 'bob-scoped', ownerId: String(A.users.bob._id), role: 'user', scope: { agents: 'read' } });
      expect(detail.body.tokens).toBeNull();
      const agents = detail.body.effective.find((e: any) => e.service === 'agents');
      expect(agents.level).toBe('read');
      expect(agents.sources.some((s: any) => s.kind === 'token-scope' && s.level === 'read')).toBe(true);
      expect(detail.body.effective.find((e: any) => e.service === 'models').level).toBe('none'); // outside the scope

      const policy = await call('POST', '/api/iam/policies', A, 'admin', { name: 'No reads of prompts', spec: { effect: 'forbid', principals: { users: [String(A.users.alice._id)] }, actions: ['prompts.read'], resources: { any: true } } });
      try {
        const aliceTok = await call('GET', `/api/iam/principals/token/${A.tokens.aliceCi}`, A, 'admin');
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
    it('lists denials with their decision and deciding policy, filtered by principal, service and date', async () => {
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

    it('lists a refusal because authorization was unavailable as a denial, with its decision', async () => {
      const t = await build('unavail');
      await db.runWithTenant!(t.dbName, () => db.createAuditLog({
        tenantId: t.id, actorType: 'user', actorUserId: String(t.users.alice._id), service: 'agents', action: 'read', event: 'GET /api/agents', method: 'GET',
        path: '/api/agents', statusCode: 503, outcome: 'denied',
        metadata: { iamEnforce: true, code: 'authorization_unavailable', decisionId: 'dec-unavail-0001', deniedService: 'agents', required: 'read' },
      } as never));
      const feed = await call('GET', '/api/iam/audit?kind=denials', t, 'reader');
      expect(feed.status).toBe(200);
      const item = feed.body.items.find((i: any) => i.decisionId === 'dec-unavail-0001');
      expect(item).toMatchObject({ kind: 'denials', code: 'authorization_unavailable', service: 'agents', method: 'GET', route: '/api/agents', principal: { type: 'user', id: String(t.users.alice._id) } });
      expect(item.summary).toMatch(/authorization was temporarily unavailable/);
      expect(item.text).toEqual({ key: 'unavailable', params: { route: 'GET /api/agents' } });
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
        ['kind=everything', 'invalid_kind'], ['kind=monitor', 'invalid_kind'], ['from=not-a-date', 'invalid_date'], ['to=nope', 'invalid_date'],
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

  describe('the retired workspace mode', () => {
    it('has no endpoints and records nothing', async () => {
      const t = await build('mode');
      for (const [method, url, body] of [
        ['GET', '/api/iam/mode'], ['PUT', '/api/iam/mode', { mode: 'shadow' }],
        ['GET', '/api/iam/shadow/summary'], ['GET', '/api/iam/shadow/entries'], ['POST', '/api/iam/shadow/reset'],
      ] as Array<[string, string, unknown?]>) {
        expect((await call(method, url, t, 'owner', body)).status, `${method} ${url}`).toBe(404);
      }
      const changes = await call('GET', '/api/iam/audit?kind=changes', t, 'reader');
      expect(changes.body.items.filter((i: any) => i.action === 'iam.mode.change')).toEqual([]);
    });
  });

  // ── isolation ───────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('keeps every endpoint inside its workspace', async () => {
      const policyA = await call('POST', '/api/iam/policies', A, 'admin', { name: 'A only', spec: memberSpec(A) });
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
          const listed = await call('GET', `/api/iam/principals?type=${type}&limit=100`, B, 'admin');
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
