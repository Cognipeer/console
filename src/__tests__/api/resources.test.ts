import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));

import { getDatabase, runWithTenantScope } from '@/lib/database';
import { resourcesApiPlugin } from '@/server/api/plugins/resources';
import { clearResourceCache } from '@/lib/resources/service';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const baseHeaders = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'u-admin',
};
const adminHeaders = { ...baseHeaders, 'x-user-role': 'admin' };
const ownerHeaders = { ...baseHeaders, 'x-user-id': 'u-owner', 'x-user-role': 'owner' };
const userHeaders = { ...baseHeaders, 'x-user-id': 'u-user', 'x-user-role': 'user' };
const grantedHeaders = { ...baseHeaders, 'x-user-id': 'u-granted', 'x-user-role': 'user' };
const projectAdminHeaders = { ...baseHeaders, 'x-user-id': 'u-padmin', 'x-user-role': 'project_admin' };

const agentDoc = {
  _id: 'agent-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'sales-ab12cd',
  name: 'Sales agent',
  status: 'active',
  config: {
    modelKey: 'gpt',
    connection: { apiKeyEnc: 'SUPER-SECRET-ENC' },
    sandbox: { secrets: { TOKEN: 'SUPER-SECRET-ENV' } },
  },
  createdBy: 'u-admin',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

describe('resources API', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearResourceCache();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (runWithTenantScope as ReturnType<typeof vi.fn>).mockImplementation(
      async (_name: string, fn: (d: unknown) => unknown) => fn(db),
    );
    db.findUserById.mockImplementation((async (id: string) => {
      const users: Record<string, unknown> = {
        'u-admin': { _id: 'u-admin', role: 'admin', tenantId: 'tenant-1', email: 'admin@acme.io', name: 'Admin' },
        'u-owner': { _id: 'u-owner', role: 'owner', tenantId: 'tenant-1' },
        'u-user': { _id: 'u-user', role: 'user', tenantId: 'tenant-1' },
        'u-padmin': { _id: 'u-padmin', role: 'project_admin', tenantId: 'tenant-1' },
        'u-granted': {
          _id: 'u-granted',
          role: 'user',
          tenantId: 'tenant-1',
          servicePermissions: { resources: 'read' },
        },
      };
      return users[id] ?? null;
    }) as never);
    db.listGroupMembersByUser.mockResolvedValue([] as never);
    db.listAgents.mockResolvedValue([agentDoc] as never);
    db.listTools.mockResolvedValue([
      { _id: 'tool-1', tenantId: 'tenant-1', key: 'crm', name: 'CRM', type: 'openapi', status: 'disabled', actions: [{}, {}], upstreamAuth: { token: 'TOOL-SECRET' }, openApiSpec: '{"secret":1}', createdBy: 'u-admin' },
    ] as never);
    db.listModels.mockResolvedValue([] as never);
    db.listProjects.mockResolvedValue([{ _id: 'proj-1', name: 'Alpha', tenantId: 'tenant-1' }] as never);
    db.listUsers.mockResolvedValue([{ _id: 'u-admin', email: 'admin@acme.io', name: 'Admin' }] as never);
    app = await createFastifyApiTestApp(resourcesApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('authorization', () => {
    it.each([['admin', adminHeaders], ['owner', ownerHeaders]])('%s gets 200', async (_label, headers) => {
      const res = await app.inject({ method: 'GET', url: '/api/resources', headers });
      expect(res.statusCode).toBe(200);
    });

    it.each([['user', userHeaders], ['project_admin', projectAdminHeaders]])('role %s is forbidden by default', async (_label, headers) => {
      const list = await app.inject({ method: 'GET', url: '/api/resources', headers });
      expect(list.statusCode).toBe(403);
      const detail = await app.inject({ method: 'GET', url: '/api/resources/agent/agent-1', headers });
      expect(detail.statusCode).toBe(403);
    });

    it('a user with an explicit tenant resources:read grant gets 200', async () => {
      const list = await app.inject({ method: 'GET', url: '/api/resources', headers: grantedHeaders });
      expect(list.statusCode).toBe(200);
      const detail = await app.inject({ method: 'GET', url: '/api/resources/agent/agent-1', headers: grantedHeaders });
      expect(detail.statusCode).toBe(200);
    });
  });

  describe('GET /api/resources', () => {
    it('returns the documented envelope', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/resources', headers: adminHeaders });
      const body = parseJsonBody<Record<string, any>>(res.body);
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.counts).toMatchObject({ agent: 1, tool: 1, model: 0 });
      expect(body.types.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['agent', 'tool', 'model']));
      expect(body.projects).toEqual([{ id: 'proj-1', name: 'Alpha' }]);
      expect(body.errors).toEqual([]);
      expect(body.truncated).toEqual([]);
      expect(typeof body.generatedAt).toBe('string');
      const agent = body.items.find((i: { type: string }) => i.type === 'agent');
      expect(agent).toMatchObject({
        crn: 'crn:cpr:tenant-1:proj-1:agent/agent-1',
        projectName: 'Alpha',
        statusTone: 'ok',
        createdByLabel: 'admin@acme.io',
      });
      const tool = body.items.find((i: { type: string }) => i.type === 'tool');
      expect(tool).toMatchObject({ projectId: null, crn: 'crn:cpr:tenant-1:-:tool/tool-1', statusTone: 'off' });
    });

    it('never leaks secret fields from the underlying documents', async () => {
      const list = await app.inject({ method: 'GET', url: '/api/resources', headers: adminHeaders });
      const detail = await app.inject({ method: 'GET', url: '/api/resources/tool/tool-1', headers: adminHeaders });
      for (const text of [list.body, detail.body]) {
        expect(text).not.toMatch(/SUPER-SECRET|TOOL-SECRET|apiKeyEnc|upstreamAuth|openApiSpec/);
      }
    });

    it('applies type / q / status / projectId filters and pagination', async () => {
      const get = async (qs: string) =>
        parseJsonBody<{ items: Array<{ id: string }>; total: number }>(
          (await app.inject({ method: 'GET', url: `/api/resources?${qs}`, headers: adminHeaders })).body,
        );
      expect((await get('type=tool')).items.map((i) => i.id)).toEqual(['tool-1']);
      expect((await get('q=sales')).items.map((i) => i.id)).toEqual(['agent-1']);
      expect((await get('status=disabled')).items.map((i) => i.id)).toEqual(['tool-1']);
      expect((await get('projectId=tenant')).items.map((i) => i.id)).toEqual(['tool-1']);
      expect((await get('projectId=proj-1')).items.map((i) => i.id)).toEqual(['agent-1']);
      const page = await get('limit=1&offset=1');
      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(2);
    });

    it('refresh=1 re-reads the providers, otherwise the cache is used', async () => {
      await app.inject({ method: 'GET', url: '/api/resources', headers: adminHeaders });
      await app.inject({ method: 'GET', url: '/api/resources', headers: adminHeaders });
      expect(db.listAgents).toHaveBeenCalledTimes(1);
      // Inside the minimum refresh interval the snapshot is served (rate limit)...
      await app.inject({ method: 'GET', url: '/api/resources?refresh=1', headers: adminHeaders });
      expect(db.listAgents).toHaveBeenCalledTimes(1);
      // ...afterwards refresh=1 re-reads. Only Date is faked so inject() keeps working.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 6_000);
        await app.inject({ method: 'GET', url: '/api/resources?refresh=1', headers: adminHeaders });
      } finally {
        vi.useRealTimers();
      }
      expect(db.listAgents).toHaveBeenCalledTimes(2);
    });

    it('reports a failing provider in errors[] without failing the request', async () => {
      db.listModels.mockRejectedValue(new Error('password=hunter2'));
      const res = await app.inject({ method: 'GET', url: '/api/resources', headers: adminHeaders });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ items: unknown[]; errors: Array<{ type: string; message: string }> }>(res.body);
      expect(body.items).toHaveLength(2);
      expect(body.errors).toEqual([{ type: 'model', message: expect.any(String) }]);
      expect(res.body).not.toContain('hunter2');
    });

    it.each(['limit=0', 'limit=abc', 'limit=-1', 'limit=1.5', 'offset=-1', 'offset=x', 'type=not-a-type'])(
      'returns 400 for %s',
      async (qs) => {
        const res = await app.inject({ method: 'GET', url: `/api/resources?${qs}`, headers: adminHeaders });
        expect(res.statusCode).toBe(400);
      },
    );

    it('clamps an oversized limit instead of rejecting it', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/resources?limit=100000', headers: adminHeaders });
      expect(res.statusCode).toBe(200);
    });

    it('takes the tenant from the session only', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/resources?tenantId=evil&tenantDbName=tenant_evil',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      const scopeCalls = (runWithTenantScope as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(scopeCalls).toEqual(['tenant_acme']);
      expect(res.body).toContain('crn:cpr:tenant-1:');
      expect(res.body).not.toContain('evil');
    });

    it('drops rows that carry another tenant id (isolation guard)', async () => {
      db.listAgents.mockResolvedValue([agentDoc, { ...agentDoc, _id: 'agent-x', tenantId: 'tenant-2' }] as never);
      const res = await app.inject({ method: 'GET', url: '/api/resources?type=agent', headers: adminHeaders });
      const body = parseJsonBody<{ items: Array<{ id: string }> }>(res.body);
      expect(body.items.map((i) => i.id)).toEqual(['agent-1']);
    });
  });

  describe('GET /api/resources/:type/:id', () => {
    it('returns the read-only detail with attributes and detailUrl', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/resources/agent/agent-1', headers: adminHeaders });
      expect(res.statusCode).toBe(200);
      const { resource } = parseJsonBody<{ resource: Record<string, any> }>(res.body);
      expect(resource).toMatchObject({
        type: 'agent',
        id: 'agent-1',
        detailUrl: '/dashboard/agents/agent-1',
        projectName: 'Alpha',
      });
      expect(resource.attributes).toEqual(expect.arrayContaining([{ key: 'kind', value: 'native' }]));
    });

    it('404s for an unknown id and for an unknown type', async () => {
      const a = await app.inject({ method: 'GET', url: '/api/resources/agent/nope', headers: adminHeaders });
      expect(a.statusCode).toBe(404);
      expect(parseJsonBody<{ error: string }>(a.body).error).toBe('Resource not found');
      const b = await app.inject({ method: 'GET', url: '/api/resources/not-a-type/agent-1', headers: adminHeaders });
      expect(b.statusCode).toBe(404);
    });
  });
});
