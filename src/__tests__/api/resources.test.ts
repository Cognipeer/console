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
      // The gate (the caller, the engine's policies) and the listing each open a scope; every one of
      // them is the session's tenant, none is the one the query asked for.
      const scopeCalls = (runWithTenantScope as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(scopeCalls.length).toBeGreaterThan(0);
      expect(new Set(scopeCalls)).toEqual(new Set(['tenant_acme']));
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
  describe('references, health and issues', () => {
    const T = (id: string, key: string, projectId: string | undefined, extra: Record<string, unknown> = {}) => ({
      _id: id, tenantId: 'tenant-1', key, name: `Tool ${id}`, type: 'openapi', status: 'active', actions: [],
      ...(projectId ? { projectId } : {}), upstreamAuth: { token: 'TOOL-SECRET' }, mcpEndpoint: 'https://secret.example/mcp?token=URL-SECRET', ...extra,
    });
    const A = (id: string, projectId: string, bindings: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
      _id: id, tenantId: 'tenant-1', projectId, key: id, name: `Agent ${id}`, status: 'active',
      config: { modelKey: 'gpt', toolBindings: bindings, connection: { apiKeyEnc: 'SUPER-SECRET-ENC' } }, ...extra,
    });
    const bind = (sourceKey: string) => ({ source: 'tool', sourceKey, toolNames: ['x'] });

    beforeEach(() => {
      db.listProjects.mockResolvedValue([
        { _id: 'proj-1', name: 'Corporate', tenantId: 'tenant-1' },
        { _id: 'proj-2', name: 'Retail', tenantId: 'tenant-1' },
      ] as never);
      db.listTools.mockResolvedValue([
        T('tool-retail', 'retail-crm', 'proj-2'),
        T('dup-a', 'dup', 'proj-1'),
        T('dup-b', 'dup', 'proj-1'),
        T('tool-wide', 'shared', undefined),
        T('mcp-tool', 'github', 'proj-1', { type: 'mcp', mcpTransport: 'sse' }),
      ] as never);
      db.listMcpServers.mockResolvedValue([
        { _id: 'srv-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'github', name: 'GitHub MCP', status: 'active', sourceType: 'openapi', tools: [] },
      ] as never);
      db.listModels.mockResolvedValue([
        { _id: 'model-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'gpt', name: 'GPT', category: 'llm', providerKey: 'prov' },
      ] as never);
      db.listProviders.mockResolvedValue([
        { _id: 'prov-1', tenantId: 'tenant-1', key: 'prov', label: 'Provider', type: 'model', driver: 'openai', status: 'active', projectIds: ['proj-1'] },
      ] as never);
      db.listAgents.mockResolvedValue([
        A('agent-corp', 'proj-1', [bind('retail-crm'), bind('shared'), bind('ghost'), bind('dup')]),
        A('agent-clean', 'proj-1', [bind('shared')]),
      ] as never);
    });

    const get = async (url: string, headers = adminHeaders) =>
      app.inject({ method: 'GET', url, headers });

    it('detail carries uses / usedBy / issues for the referrer', async () => {
      const res = await get('/api/resources/agent/agent-corp');
      expect(res.statusCode).toBe(200);
      const { resource } = parseJsonBody<{ resource: Record<string, any> }>(res.body);
      const byField = Object.fromEntries(resource.uses.map((u: any) => [u.field, u]));
      expect(byField['config.modelKey']).toMatchObject({ kind: 'agent.model', status: 'ok', severity: null, other: { id: 'model-1' } });
      expect(byField['config.toolBindings[0].sourceKey']).toMatchObject({
        kind: 'agent.tool', status: 'cross-project', severity: 'warning',
        other: { type: 'tool', id: null, key: 'retail-crm' },
        candidates: [{ id: 'tool-retail', projectName: 'Retail' }],
      });
      // own project has no 'shared', so the tenant-wide row serves it
      expect(byField['config.toolBindings[1].sourceKey']).toMatchObject({ status: 'ok', other: { id: 'tool-wide', projectId: null } });
      expect(byField['config.toolBindings[2].sourceKey']).toMatchObject({ status: 'missing', other: { key: 'ghost', name: null } });
      expect(byField['config.toolBindings[3].sourceKey']).toMatchObject({ status: 'ambiguous' });
      expect(byField['config.toolBindings[3].sourceKey'].candidates).toHaveLength(2);
      expect(resource.issues.map((i: any) => i.kind).sort()).toEqual([
        'ambiguous-reference', 'broken-reference', 'cross-project-reference',
      ]);
      expect(resource).toMatchObject({ issueCount: 3, issueSeverity: 'warning', usedByTruncated: false });
    });

    it('detail of the target shows who uses it, including the cross-project attempt', async () => {
      const wide = parseJsonBody<{ resource: any }>((await get('/api/resources/tool/tool-wide')).body).resource;
      expect(wide.usedBy.map((e: any) => [e.other.id, e.status]).sort()).toEqual([['agent-clean', 'ok'], ['agent-corp', 'ok']]);
      const retail = parseJsonBody<{ resource: any }>((await get('/api/resources/tool/tool-retail')).body).resource;
      expect(retail.usedBy).toHaveLength(1);
      expect(retail.usedBy[0]).toMatchObject({ direction: 'in', status: 'cross-project', other: { id: 'agent-corp' } });
    });

    it('the four seeded problems show up as issues', async () => {
      const res = await get('/api/resources/health');
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<Record<string, any>>(res.body);
      const kinds = new Set(body.issues.map((i: any) => i.kind));
      expect(kinds).toEqual(new Set([
        'broken-reference', 'cross-project-reference', 'ambiguous-reference', 'duplicate-key', 'mcp-dual-registration',
      ]));
      expect(body.summary).toMatchObject({ error: 0, warning: 7 });
      expect(body.summary.byKind).toMatchObject({ 'duplicate-key': 2, 'mcp-dual-registration': 2, 'broken-reference': 1 });
      expect(body.truncated).toBe(false);
      expect(typeof body.generatedAt).toBe('string');
    });

    it('health filters: severity, kind, type, projectId, and 400 on junk', async () => {
      const q = async (qs: string) => parseJsonBody<any>((await get(`/api/resources/health?${qs}`)).body);
      expect((await q('severity=error')).issues).toEqual([]);
      expect((await q('kind=duplicate-key')).issues.map((i: any) => i.resource.id).sort()).toEqual(['dup-a', 'dup-b']);
      // summary describes the scope; kind/severity only narrow the list
      expect((await q('kind=duplicate-key')).summary.warning).toBe(7);
      expect((await q('type=agent')).issues.every((i: any) => i.resource.type === 'agent')).toBe(true);
      expect((await q('projectId=proj-2')).issues).toEqual([]);
      expect((await q('projectId=tenant')).issues).toEqual([]);
      for (const bad of ['severity=fatal', 'kind=nope', 'type=nope']) {
        expect((await get(`/api/resources/health?${bad}`)).statusCode, bad).toBe(400);
      }
    });

    it('health sorts errors first and caps at 1000', async () => {
      db.listAgents.mockResolvedValue([
        A('agent-corp', 'proj-1', [bind('ghost')], { config: { modelKey: 'no-such-model', toolBindings: [bind('ghost')] } }),
      ] as never);
      const body = parseJsonBody<any>((await get('/api/resources/health')).body);
      expect(body.issues[0]).toMatchObject({ severity: 'error', kind: 'broken-reference', edgeKind: 'agent.model', targetKey: 'no-such-model' });

      const many = Array.from({ length: 1100 }, (_, i) => T(`bulk-${i}`, 'same', 'proj-1'));
      db.listTools.mockResolvedValue(many as never);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 40_000);
        const capped = parseJsonBody<any>((await get('/api/resources/health?refresh=1')).body);
        expect(capped.issues).toHaveLength(1000);
        expect(capped.truncated).toBe(true);
        expect(capped.summary.byKind['duplicate-key']).toBe(1100);
      } finally {
        vi.useRealTimers();
      }
    });

    it('list rows carry issueCount / issueSeverity and health=issues keeps only those', async () => {
      const all = parseJsonBody<any>((await get('/api/resources?limit=200')).body);
      const row = (id: string) => all.items.find((i: any) => i.id === id);
      expect(row('agent-corp')).toMatchObject({ issueCount: 3, issueSeverity: 'warning' });
      expect(row('agent-clean')).toMatchObject({ issueCount: 0, issueSeverity: null });
      expect(row('dup-a')).toMatchObject({ issueCount: 1, issueSeverity: 'warning' });

      const only = parseJsonBody<any>((await get('/api/resources?health=issues&limit=200')).body);
      expect(only.items.map((i: any) => i.id).sort()).toEqual(['agent-corp', 'dup-a', 'dup-b', 'mcp-tool', 'srv-1']);
      expect(only.total).toBe(5);
      // facets respect the filter like every other one
      expect(only.counts).toMatchObject({ agent: 1, tool: 3, 'mcp-server': 1, model: 0 });
      expect((await get('/api/resources?health=all')).statusCode).toBe(400);
    });

    it('a missing target counts an error for the referrer and flips the severity', async () => {
      db.listModels.mockResolvedValue([] as never);
      const all = parseJsonBody<any>((await get('/api/resources?type=agent')).body);
      expect(all.items.find((i: any) => i.id === 'agent-clean')).toMatchObject({ issueCount: 1, issueSeverity: 'error' });
    });

    it('detail 404 forces at most one rebuild (rate-limited), then stays 404', async () => {
      await get('/api/resources');
      expect(db.listAgents).toHaveBeenCalledTimes(1);
      expect((await get('/api/resources/agent/nope')).statusCode).toBe(404);
      expect((await get('/api/resources/agent/nope')).statusCode).toBe(404);
      expect(db.listAgents).toHaveBeenCalledTimes(1);
    });

    it('never exposes the internal edges array nor any secret/URL, on any endpoint', async () => {
      const urls = [
        '/api/resources?limit=200',
        '/api/resources?health=issues',
        '/api/resources/health',
        '/api/resources/agent/agent-corp',
        '/api/resources/tool/tool-wide',
        '/api/resources/tool/mcp-tool',
        '/api/resources/mcp-server/srv-1',
      ];
      for (const url of urls) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).not.toMatch(/"edges"|SUPER-SECRET|TOOL-SECRET|URL-SECRET|secret\.example|upstreamAuth|mcpEndpoint|"toType"|"by":/);
      }
    });

    it('health is gated like the rest of the resources API', async () => {
      expect((await get('/api/resources/health', userHeaders)).statusCode).toBe(403);
      expect((await get('/api/resources/health', grantedHeaders)).statusCode).toBe(200);
    });
  });
});
