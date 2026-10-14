/**
 * /api/quota/policies — what changed for group limits and agent-run limits:
 * write-time validation, the group mode, project moves, the opt-in target
 * resolution of the Limits table, and that the long-standing project-bound
 * flow (the project Quotas tab) still behaves as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({ db: null as unknown, cacheDel: vi.fn() }));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), del: h.cacheDel })),
}));

import { quotaApiPlugin } from '@/server/api/plugins/quota';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';

function headers(userId: string, role: string) {
  return {
    'content-type': 'application/json',
    'x-license-type': 'STARTER',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': TENANT,
    'x-tenant-slug': 'acme',
    'x-user-email': `${userId}@acme.test`,
    'x-user-id': userId,
    'x-user-role': role,
  };
}
const OWNER = headers('owner-1', 'owner');
const bare = (h: Record<string, string>) => {
  const { 'content-type': _ct, ...rest } = h;
  void _ct;
  return rest;
};

const USERS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT, email: 'owner@acme.test', name: 'Owner' },
  'member-1': { _id: 'member-1', role: 'user', tenantId: TENANT, email: 'm@acme.test', name: 'Member' },
  'alice-1': { _id: 'alice-1', role: 'user', tenantId: TENANT, email: 'alice@acme.test', name: 'Alice' },
};

const GROUP = { _id: 'g-1', tenantId: TENANT, name: 'Branch staff', description: 'Retail branches' };
const rpm = (perMinute: number) => ({ rateLimit: { requests: { perMinute } } });

describe('quota policy API', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    h.db = db;
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] ? { ...USERS[id] } : null) as never);
    db.findGroupById.mockImplementation(async (id: string) => (id === GROUP._id ? { ...GROUP } : null) as never);
    db.findProjectById.mockImplementation(async (id: string) =>
      (['proj-1', 'proj-2'].includes(id) ? { _id: id, tenantId: TENANT, name: id, key: id } : null) as never);
    db.createQuotaPolicy.mockImplementation(async (p: object) => ({ _id: 'new-policy', ...p }) as never);
    db.updateQuotaPolicy.mockImplementation(async (id: string, _t: string, data: object) => ({ _id: id, tenantId: TENANT, ...data }) as never);
    app = await createFastifyApiTestApp(quotaApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (body: unknown, hdrs = OWNER, query = '') =>
    app.inject({ method: 'POST', url: `/api/quota/policies${query}`, headers: hdrs, payload: JSON.stringify(body) });
  const patch = (id: string, body: unknown, query = '') =>
    app.inject({ method: 'PATCH', url: `/api/quota/policies/${id}${query}`, headers: OWNER, payload: JSON.stringify(body) });

  describe('POST — group limits', () => {
    it('stores a shared group limit with no project and answers with its mode', async () => {
      const res = await post({ scope: 'group', scopeId: 'g-1', groupMode: 'shared', domain: 'agent', limits: rpm(200) });

      expect(res.statusCode).toBe(201);
      const created = db.createQuotaPolicy.mock.calls[0][0] as Record<string, unknown>;
      expect(created).toMatchObject({ scope: 'group', scopeId: 'g-1', groupMode: 'shared', domain: 'agent', tenantId: TENANT });
      expect(created.projectId).toBeUndefined();
      expect(parseJsonBody<{ warnings?: string[] }>(res.body).warnings).toBeUndefined();
    });

    it('defaults a group limit to per-member counting', async () => {
      await post({ scope: 'group', scopeId: 'g-1', domain: 'llm', limits: rpm(5) }, OWNER, '?projectId=proj-1');
      expect(db.createQuotaPolicy.mock.calls[0][0]).toMatchObject({ groupMode: 'perMember', projectId: 'proj-1' });
    });

    it('refuses a group that is not in this tenant (404) and a group limit without a group (400)', async () => {
      const missing = await post({ scope: 'group', scopeId: 'ghost', domain: 'llm', limits: rpm(1) });
      expect(missing.statusCode).toBe(404);
      expect(parseJsonBody<{ code: string }>(missing.body).code).toBe('group_not_found');

      db.findGroupById.mockResolvedValueOnce({ ...GROUP, tenantId: 'other-tenant' } as never);
      expect((await post({ scope: 'group', scopeId: 'g-1', domain: 'llm', limits: rpm(1) })).statusCode).toBe(404);

      const none = await post({ scope: 'group', domain: 'llm', limits: rpm(1) });
      expect(none.statusCode).toBe(400);
      expect(parseJsonBody<{ code: string }>(none.body).code).toBe('group_required');
      expect(db.createQuotaPolicy).not.toHaveBeenCalled();
    });

    it('refuses a counting mode on anything but a group limit, and an unknown mode', async () => {
      const wrongScope = await post({ scope: 'user', scopeId: 'alice-1', groupMode: 'shared', domain: 'llm', limits: rpm(1) });
      expect(wrongScope.statusCode).toBe(400);
      expect(parseJsonBody<{ code: string }>(wrongScope.body).code).toBe('group_mode_requires_group_scope');

      const unknown = await post({ scope: 'group', scopeId: 'g-1', groupMode: 'weekly', domain: 'llm', limits: rpm(1) });
      expect(unknown.statusCode).toBe(400);
      expect(parseJsonBody<{ code: string }>(unknown.body).code).toBe('invalid_group_mode');
    });

    it('refuses unknown scopes and domains, and a project that does not exist', async () => {
      expect((await post({ scope: 'planet', domain: 'llm', limits: {} })).statusCode).toBe(400);
      expect((await post({ scope: 'tenant', domain: 'telepathy', limits: {} })).statusCode).toBe(400);
      const project = await post({ scope: 'tenant', domain: 'llm', limits: {}, projectId: 'nope' });
      expect(project.statusCode).toBe(404);
      expect(parseJsonBody<{ code: string }>(project.body).code).toBe('project_not_found');
    });

    it('validates the project the row is STORED in: ?projectId wins over the body, so it is the one that must exist', async () => {
      // a valid project in the body must not launder a bogus one in the query
      const res = await post({ scope: 'tenant', domain: 'llm', limits: {}, projectId: 'proj-1' }, OWNER, '?projectId=not-a-project');
      expect(res.statusCode).toBe(404);
      expect(parseJsonBody<{ code: string }>(res.body).code).toBe('project_not_found');
      expect(db.createQuotaPolicy).not.toHaveBeenCalled();
      // and the happy path stores the query's project
      expect((await post({ scope: 'tenant', domain: 'llm', limits: {} }, OWNER, '?projectId=proj-2')).statusCode).toBe(201);
      expect(db.createQuotaPolicy.mock.calls[0][0]).toMatchObject({ projectId: 'proj-2' });
    });
  });

  describe('POST — agent-run limits', () => {
    it('accepts an agent-run limit for everyone with no project', async () => {
      const res = await post({ scope: 'tenant', domain: 'agent', limits: { rateLimit: { tokens: { perDay: 50_000 } } } });
      expect(res.statusCode).toBe(201);
      expect(parseJsonBody<{ warnings?: string[] }>(res.body).warnings).toBeUndefined();
    });

    it('needs the agent for a limit narrowed to one agent', async () => {
      const res = await post({ scope: 'resource', domain: 'agent', limits: rpm(1) });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ code: string }>(res.body).code).toBe('agent_required');

      const ok = await post({ scope: 'resource', scopeId: 'credit-bot', domain: 'agent', limits: rpm(1) }, OWNER, '?projectId=proj-1');
      expect(ok.statusCode).toBe(201);
    });
  });

  describe('POST — limits of the older kinds are unchanged', () => {
    it('still creates a project-bound limit exactly as before', async () => {
      const res = await post({ scope: 'tenant', domain: 'global', priority: 100, limits: rpm(60), label: 'Project quota', projectId: 'proj-1' });

      expect(res.statusCode).toBe(201);
      expect(db.createQuotaPolicy.mock.calls[0][0]).toMatchObject({
        scope: 'tenant', domain: 'global', priority: 100, projectId: 'proj-1', label: 'Project quota', enabled: true, createdBy: 'owner-1',
      });
      expect(db.createQuotaPolicy.mock.calls[0][0]).not.toHaveProperty('groupMode');
      expect(parseJsonBody<{ warnings?: string[] }>(res.body).warnings).toBeUndefined();
    });

    it('creates a project-less limit of an older kind but says it will not be applied', async () => {
      const res = await post({ scope: 'user', scopeId: 'alice-1', domain: 'llm', limits: rpm(5) });
      expect(res.statusCode).toBe(201);
      expect(parseJsonBody<{ warnings?: string[] }>(res.body).warnings).toEqual(['project_required']);
    });

    it('keeps the 400 for a body without scope, domain or limits, and the 403 for a non-admin', async () => {
      expect((await post({ scope: 'tenant' })).statusCode).toBe(400);
      expect((await post({ scope: 'tenant', domain: 'llm', limits: {} }, headers('member-1', 'user'))).statusCode).toBe(403);
    });

    it('drops the cached policy set of the project it was created in', async () => {
      await post({ scope: 'tenant', domain: 'llm', limits: rpm(5), projectId: 'proj-1' });
      expect(h.cacheDel).toHaveBeenCalledWith('quota:policy-src:tenant_acme:tenant-1:proj-1');
    });

    it('drops the cached policy set of EVERY project when a tenant-wide limit is created', async () => {
      db.listProjects.mockResolvedValue([{ _id: 'proj-1' }, { _id: 'proj-2' }] as never);
      await post({ scope: 'group', scopeId: 'g-1', domain: 'agent', limits: rpm(5) });
      expect(h.cacheDel.mock.calls.map((c) => c[0]).sort()).toEqual([
        'quota:policy-src:tenant_acme:tenant-1:proj-1',
        'quota:policy-src:tenant_acme:tenant-1:proj-2',
      ]);
    });
  });

  describe('PATCH', () => {
    const stored = (over: Record<string, unknown> = {}) => ({
      _id: 'pol-1', tenantId: TENANT, scope: 'tenant', domain: 'llm', priority: 10, enabled: true, projectId: 'proj-1', limits: rpm(1), ...over,
    });

    it('404s a policy that is not there, or that is in another project than asserted', async () => {
      db.listQuotaPolicies.mockResolvedValue([stored()] as never);
      expect((await patch('nope', { enabled: false })).statusCode).toBe(404);
      expect((await patch('pol-1', { enabled: false }, '?projectId=proj-2')).statusCode).toBe(404);
      expect(db.updateQuotaPolicy).not.toHaveBeenCalled();
    });

    it('addresses the row by the project it is in now, and writes only the fields it knows', async () => {
      db.listQuotaPolicies.mockResolvedValue([stored()] as never);

      const res = await patch('pol-1', { enabled: false, tenantId: 'someone-else', _id: 'forged', createdBy: 'forged' });

      expect(res.statusCode).toBe(200);
      const [id, tenant, data, project] = db.updateQuotaPolicy.mock.calls[0];
      expect([id, tenant, project]).toEqual(['pol-1', TENANT, 'proj-1']);
      expect(data).toMatchObject({ enabled: false, updatedBy: 'owner-1' });
      expect(data).not.toHaveProperty('tenantId');
      expect(data).not.toHaveProperty('_id');
      expect(data).not.toHaveProperty('createdBy');
    });

    it('moves a limit to another project, or to all projects, and refreshes both caches', async () => {
      db.listQuotaPolicies.mockResolvedValue([stored({ scope: 'group', scopeId: 'g-1', domain: 'agent' })] as never);

      expect((await patch('pol-1', { projectId: 'proj-2' })).statusCode).toBe(200);
      expect(db.updateQuotaPolicy.mock.calls[0][3]).toBe('proj-1'); // found where it is...
      expect(db.updateQuotaPolicy.mock.calls[0][2]).toMatchObject({ projectId: 'proj-2' }); // ...and written where it goes
      expect(h.cacheDel.mock.calls.map((c) => c[0])).toEqual(
        expect.arrayContaining(['quota:policy-src:tenant_acme:tenant-1:proj-1', 'quota:policy-src:tenant_acme:tenant-1:proj-2']),
      );

      db.updateQuotaPolicy.mockClear();
      expect((await patch('pol-1', { projectId: '' })).statusCode).toBe(200);
      expect(db.updateQuotaPolicy.mock.calls[0][2]).toMatchObject({ projectId: '' });
    });

    it('re-validates against the stored policy: a mode cannot be put on a non-group limit', async () => {
      db.listQuotaPolicies.mockResolvedValue([stored()] as never);
      const res = await patch('pol-1', { groupMode: 'shared' });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ code: string }>(res.body).code).toBe('group_mode_requires_group_scope');
    });

    it('still serves the project Quotas tab: PATCH with ?projectId and the whole payload', async () => {
      db.listQuotaPolicies.mockResolvedValue([stored({ domain: 'global' })] as never);
      const res = await patch(
        'pol-1',
        { projectId: 'proj-1', scope: 'tenant', domain: 'global', priority: 100, enabled: true, label: 'Project quota', limits: rpm(30) },
        '?projectId=proj-1',
      );
      expect(res.statusCode).toBe(200);
      expect(db.updateQuotaPolicy.mock.calls[0][3]).toBe('proj-1');
    });
  });

  describe('GET', () => {
    const policies = [
      { _id: 'a', tenantId: TENANT, scope: 'group', scopeId: 'g-1', groupMode: 'shared', domain: 'agent', priority: 10, enabled: true, limits: rpm(1) },
      { _id: 'b', tenantId: TENANT, scope: 'user', scopeId: 'alice-1', domain: 'llm', priority: 10, enabled: true, projectId: 'proj-1', limits: rpm(1) },
      { _id: 'c', tenantId: TENANT, scope: 'token', scopeId: 'tok-1', domain: 'llm', priority: 10, enabled: true, projectId: 'proj-1', limits: rpm(1) },
      { _id: 'd', tenantId: TENANT, scope: 'resource', scopeId: 'credit-bot', domain: 'agent', priority: 10, enabled: true, projectId: 'proj-1', limits: rpm(1) },
      { _id: 'e', tenantId: TENANT, scope: 'user', scopeId: 'gone', domain: 'llm', priority: 10, enabled: true, projectId: 'proj-1', limits: rpm(1) },
    ];

    it('lists the policies as before, without target resolution unless asked', async () => {
      db.listQuotaPolicies.mockResolvedValue(policies as never);
      const res = await app.inject({ method: 'GET', url: '/api/quota/policies', headers: bare(OWNER) });
      const body = parseJsonBody<{ policies: Array<Record<string, unknown>> }>(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.policies).toHaveLength(5);
      expect(body.policies[0]).not.toHaveProperty('target');
      expect(body.policies[0]).toMatchObject({ _id: 'a', groupMode: 'shared' });
      expect(db.findUserById).not.toHaveBeenCalledWith('alice-1');
    });

    it('keeps names and e-mail addresses from members who may not see the IAM center', async () => {
      db.listQuotaPolicies.mockResolvedValue(policies as never);
      const res = await app.inject({
        method: 'GET',
        url: '/api/quota/policies?include=targets',
        headers: bare(headers('member-1', 'user')),
      });
      expect(res.statusCode).toBe(403);
      // The plain list (ids only) stays open to whoever could read it before.
      const plain = await app.inject({ method: 'GET', url: '/api/quota/policies', headers: bare(headers('member-1', 'user')) });
      expect(plain.statusCode).toBe(200);
    });

    it('names the group, user, token, agent and project each policy points at with ?include=targets', async () => {
      db.listQuotaPolicies.mockResolvedValue(policies as never);
      // only the referenced tokens are read (a tenant can hold thousands), by id and tenant
      db.iamListTokens.mockResolvedValue({ items: [{ _id: 'tok-1', label: 'CI token' }], hasMore: false } as never);
      db.listProjects.mockResolvedValue([{ _id: 'proj-1', name: 'Retail', key: 'retail' }] as never);
      db.findAgentByKey.mockResolvedValue({ key: 'credit-bot', name: 'Credit assistant' } as never);

      const res = await app.inject({ method: 'GET', url: '/api/quota/policies?include=targets', headers: bare(OWNER) });
      type Row = { _id: string; target?: Record<string, unknown>; projectName?: string; projectKey?: string };
      const rows = parseJsonBody<{ policies: Row[] }>(res.body).policies;
      const byId = Object.fromEntries(rows.map((r) => [r._id, r]));

      expect(byId.a.target).toMatchObject({ type: 'group', label: 'Branch staff', sublabel: 'Retail branches' });
      expect(byId.b.target).toMatchObject({ type: 'user', label: 'Alice', sublabel: 'alice@acme.test' });
      expect(byId.c.target).toMatchObject({ type: 'token', label: 'CI token' });
      expect(db.iamListTokens).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, ids: ['tok-1'] }));
      expect(db.listTenantApiTokens).not.toHaveBeenCalled();
      expect(byId.d.target).toMatchObject({ type: 'agent', label: 'Credit assistant', sublabel: 'credit-bot' });
      expect(byId.e.target).toMatchObject({ type: 'user', label: 'gone', missing: true });
      expect(byId.b).toMatchObject({ projectName: 'Retail', projectKey: 'retail' });
      expect(byId.a.projectName).toBeUndefined();
      // Only the ids the policies reference are read: the tenant's users are never listed.
      expect(db.listUsers).not.toHaveBeenCalled();
    });
  });

  describe('GET ?include=targets across tenants', () => {
    it('never names a user or group that belongs to ANOTHER tenant (where one database serves all, any id resolves)', async () => {
      db.listQuotaPolicies.mockResolvedValue([
        { _id: 'u', tenantId: TENANT, scope: 'user', scopeId: 'victim-1', domain: 'llm', priority: 10, enabled: true, projectId: 'proj-1', limits: rpm(1) },
        { _id: 'g', tenantId: TENANT, scope: 'group', scopeId: 'secret-g', domain: 'llm', priority: 10, enabled: true, limits: rpm(1) },
      ] as never);
      const ownUsers = db.findUserById.getMockImplementation()!;
      db.findUserById.mockImplementation(async (id: string) => (id === 'victim-1'
        ? { _id: id, tenantId: 'another-tenant', name: 'Mallory Victim', email: 'victim@other.test' }
        : ownUsers(id)) as never);
      db.findGroupById.mockImplementation(async (id: string) => ({ _id: id, tenantId: 'another-tenant', name: 'Other tenant secret group', description: 'private' }) as never);
      const res = await app.inject({ method: 'GET', url: '/api/quota/policies?include=targets', headers: bare(OWNER) });
      expect(res.statusCode).toBe(200);
      const rows = parseJsonBody<{ policies: Array<{ _id: string; target?: Record<string, unknown> }> }>(res.body).policies;
      expect(rows.find((r) => r._id === 'u')!.target).toMatchObject({ type: 'user', label: 'victim-1', missing: true });
      expect(rows.find((r) => r._id === 'g')!.target).toMatchObject({ type: 'group', label: 'secret-g', missing: true });
      expect(res.body).not.toMatch(/Mallory|victim@other|Other tenant secret|private/);
    });
  });

  describe('DELETE', () => {
    it('deletes by id and project as it always did', async () => {
      db.deleteQuotaPolicy.mockResolvedValue(true);
      const res = await app.inject({ method: 'DELETE', url: '/api/quota/policies/pol-1?projectId=proj-1', headers: bare(OWNER) });
      expect(res.statusCode).toBe(200);
      expect(db.deleteQuotaPolicy).toHaveBeenCalledWith('pol-1', TENANT, 'proj-1');
    });
  });
});
