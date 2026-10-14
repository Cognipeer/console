import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));

import { getDatabase, runWithTenantScope } from '@/lib/database';
import { resourcesApiPlugin } from '@/server/api/plugins/resources';
import { clearResourceCache } from '@/lib/resources/service';
import { resetPathServiceResolversForTests } from '@/lib/security/rbac';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const baseHeaders = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
};
const as = (id: string, role: string) => ({ ...baseHeaders, 'x-user-id': id, 'x-user-role': role });

const agent = (id: string, key: string, projectId: string, toolKey: string) => ({
  _id: id,
  tenantId: 'tenant-1',
  projectId,
  key,
  name: key,
  status: 'active',
  config: { toolBindings: [{ source: 'tool', sourceKey: toolKey }] },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
});

const tool = (id: string, key: string, projectId?: string) => ({
  _id: id,
  tenantId: 'tenant-1',
  key,
  name: key,
  type: 'openapi',
  status: 'active',
  actions: [],
  ...(projectId ? { projectId } : {}),
});

interface UsageBody {
  resource: { type: string; id: string; key: string };
  uses: unknown[];
  usedBy: Array<{ other: { name: string; type: string }; impact: string | null }>;
  hiddenUsedByCount: number;
  hiddenByType: Record<string, number>;
  summary: { error: number; warning: number };
  usedByTruncated: boolean;
}

describe('GET /api/resource-usage/:type/:id', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  let users: Record<string, Record<string, unknown>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearResourceCache();
    resetPathServiceResolversForTests();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (runWithTenantScope as ReturnType<typeof vi.fn>).mockImplementation(
      async (_name: string, fn: (d: unknown) => unknown) => fn(db),
    );
    users = {
      'u-admin': { _id: 'u-admin', role: 'admin', tenantId: 'tenant-1' },
      'u-owner': { _id: 'u-owner', role: 'owner', tenantId: 'tenant-1' },
      'u-retail': { _id: 'u-retail', role: 'user', tenantId: 'tenant-1' },
      'u-nogrant': { _id: 'u-nogrant', role: 'user', tenantId: 'tenant-1', servicePermissions: { tools: 'none' } },
      'u-grouped': { _id: 'u-grouped', role: 'user', tenantId: 'tenant-1' },
      'u-resources': { _id: 'u-resources', role: 'user', tenantId: 'tenant-1', servicePermissions: { resources: 'read' } },
    };
    db.findUserById.mockImplementation((async (id: string) => users[id] ?? null) as never);
    db.listUserProjectsByUser.mockImplementation((async (id: string) =>
      id === 'u-retail' ? [{ userId: id, projectId: 'p-retail', role: 'member' }] : []) as never);
    db.listGroupMembersByUser.mockImplementation((async (id: string) =>
      id === 'u-grouped' ? [{ groupId: 'g-1', userId: id }] : []) as never);
    db.listGroupProjectsByGroup.mockImplementation((async (groupId: string) =>
      groupId === 'g-1' ? [{ groupId, projectId: 'p-corp', role: 'member' }] : []) as never);
    db.findGroupById.mockResolvedValue(null as never);
    db.listProjects.mockResolvedValue([
      { _id: 'p-retail', name: 'Retail', tenantId: 'tenant-1' },
      { _id: 'p-corp', name: 'Corporate', tenantId: 'tenant-1' },
    ] as never);
    db.listAgents.mockResolvedValue([
      agent('a-retail', 'retail-bot', 'p-retail', 'crm'),
      agent('a-corp-1', 'corp-bot', 'p-corp', 'crm'),
      agent('a-corp-2', 'corp-bot-2', 'p-corp', 'crm'),
    ] as never);
    db.listTools.mockResolvedValue([
      tool('t-crm', 'crm'),
      tool('t-corp', 'corp-only', 'p-corp'),
      tool('t-retail', 'retail-only', 'p-retail'),
    ] as never);
    db.listModels.mockResolvedValue([] as never);
    db.listUsers.mockResolvedValue([] as never);
    app = await createFastifyApiTestApp(resourcesApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

  it('admin sees every referrer and no hidden count', async () => {
    const res = await get('/api/resource-usage/tool/t-crm', as('u-admin', 'admin'));
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<UsageBody>(res.body);
    expect(body.resource).toMatchObject({ type: 'tool', id: 't-crm', key: 'crm' });
    expect(body.usedBy.map((e) => e.other.name).sort()).toEqual(['corp-bot', 'corp-bot-2', 'retail-bot']);
    expect(body.hiddenUsedByCount).toBe(0);
    expect(body.hiddenByType).toEqual({});
    // agent.tool is a "reduced capability" reference.
    expect(body.summary).toEqual({ error: 0, warning: 3 });
    expect(body.usedBy.every((e) => e.impact === 'warning')).toBe(true);
    expect(body.usedByTruncated).toBe(false);
  });

  it('owner sees everything too', async () => {
    const res = await get('/api/resource-usage/tool/t-crm', as('u-owner', 'owner'));
    expect(parseJsonBody<UsageBody>(res.body).usedBy).toHaveLength(3);
  });

  it('a tools:read user can read tool usage; Retail member sees Retail referrers and a hidden count for Corporate', async () => {
    const res = await get('/api/resource-usage/tool/t-crm', as('u-retail', 'user'));
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<UsageBody>(res.body);
    expect(body.usedBy.map((e) => e.other.name)).toEqual(['retail-bot']);
    expect(body.hiddenUsedByCount).toBe(2);
    expect(body.hiddenByType).toEqual({ agent: 2 });
    // The hidden referrers still count toward the delete severity.
    expect(body.summary).toEqual({ error: 0, warning: 3 });
    // No name of a Corporate resource anywhere in the payload.
    expect(res.body).not.toMatch(/corp-bot/);
  });

  it('group project assignments grant visibility', async () => {
    const res = await get('/api/resource-usage/tool/t-crm', as('u-grouped', 'user'));
    const body = parseJsonBody<UsageBody>(res.body);
    expect(body.usedBy.map((e) => e.other.name).sort()).toEqual(['corp-bot', 'corp-bot-2']);
    expect(body.hiddenUsedByCount).toBe(1);
    expect(body.hiddenByType).toEqual({ agent: 1 });
  });

  it('a resource in a project the caller cannot access is a 404, not a 403', async () => {
    const res = await get('/api/resource-usage/tool/t-corp', as('u-retail', 'user'));
    expect(res.statusCode).toBe(404);
    const own = await get('/api/resource-usage/tool/t-retail', as('u-retail', 'user'));
    expect(own.statusCode).toBe(200);
  });

  it('404 for a resource that does not exist', async () => {
    const res = await get('/api/resource-usage/tool/nope', as('u-admin', 'admin'));
    expect(res.statusCode).toBe(404);
  });

  it('a user without the type\'s service permission is forbidden', async () => {
    const res = await get('/api/resource-usage/tool/t-crm', as('u-nogrant', 'user'));
    expect(res.statusCode).toBe(403);
  });

  it('an unknown type is admin-only', async () => {
    expect((await get('/api/resource-usage/bogus/x', as('u-retail', 'user'))).statusCode).toBe(403);
    expect((await get('/api/resource-usage/bogus/x', as('u-admin', 'admin'))).statusCode).toBe(404);
    // an explicit tenant resources:read grant also opens it (the inventory service)
    expect((await get('/api/resource-usage/bogus/x', as('u-resources', 'user'))).statusCode).toBe(404);
  });

  it('the type segment cannot be used to borrow a different service', async () => {
    // A tools-only grant must not read agent usage.
    users['u-tools-only'] = { _id: 'u-tools-only', role: 'user', tenantId: 'tenant-1', servicePermissions: { agents: 'none', tools: 'read' } };
    expect((await get('/api/resource-usage/agent/a-retail', as('u-tools-only', 'user'))).statusCode).toBe(403);
    expect((await get('/api/resource-usage/tool/t-crm', as('u-tools-only', 'user'))).statusCode).toBe(200);
  });

  it('percent-encoded spellings of the path do not walk around the service gate', async () => {
    for (const url of [
      '/api/resource%2Dusage/tool/t-crm',
      '/api/resource-usage/to%6Fl/t-crm',
      '/api//resource-usage/tool/t-crm',
    ]) {
      const res = await get(url, as('u-nogrant', 'user'));
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body).not.toMatch(/retail-bot/);
    }
    expect((await get('/api/resource%2Dusage/tool/t-crm', as('u-nogrant', 'user'))).statusCode).toBe(403);
    // the plain spelling still works for a user who may read tools
    expect((await get('/api/resource%2Dusage/tool/t-crm', as('u-retail', 'user'))).statusCode).toBe(200);
  });

  it('the handler asks the engine about the service that owns the decoded type, and an unknown type needs the inventory', async () => {
    // The route gate works on the request path; the handler re-checks against the decoded
    // `:type` param, through the same engine (authorizeServiceForRequest).
    const { resourceTypeService } = await import('@/lib/resources/usageAccess');
    expect(resourceTypeService('tool')).toBe('tools');
    expect(resourceTypeService('bogus')).toBe('resources');
    users['u-tools-none'] = { _id: 'u-tools-none', role: 'user', tenantId: 'tenant-1', servicePermissions: { tools: 'none' } };
    expect((await get('/api/resource-usage/tool/t-crm', as('u-tools-none', 'user'))).statusCode).toBe(403);
    // a plain member has no grant on the inventory, so a type nobody registered is refused
    expect((await get('/api/resource-usage/bogus/x-1', as('u-retail', 'user'))).statusCode).toBe(403);
    expect((await get('/api/resource-usage/tool/t-crm', as('u-retail', 'user'))).statusCode).toBe(200);
  });

  it('referrers of a type the caller cannot read are counted, not listed', async () => {
    users['u-tools-only'] = { _id: 'u-tools-only', role: 'user', tenantId: 'tenant-1', servicePermissions: { agents: 'none', tools: 'read' } };
    db.listUserProjectsByUser.mockImplementation((async (id: string) =>
      id === 'u-tools-only' ? [{ userId: id, projectId: 'p-retail', role: 'member' }, { userId: id, projectId: 'p-corp', role: 'member' }] : []) as never);
    const res = await get('/api/resource-usage/tool/t-crm', as('u-tools-only', 'user'));
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<UsageBody>(res.body);
    expect(body.usedBy).toEqual([]);
    expect(body.hiddenUsedByCount).toBe(3);
    expect(body.hiddenByType).toEqual({ agent: 3 });
    expect(body.summary).toEqual({ error: 0, warning: 3 });
    expect(res.body).not.toMatch(/retail-bot|corp-bot/);
    // an admin still sees everything
    const admin = await get('/api/resource-usage/tool/t-crm', as('u-admin', 'admin'));
    expect(parseJsonBody<UsageBody>(admin.body).usedBy).toHaveLength(3);
  });

  it('a multi-project row does not reveal the projects the caller cannot access', async () => {
    users['u-prov'] = { _id: 'u-prov', role: 'user', tenantId: 'tenant-1', servicePermissions: { providers: 'read', models: 'read' } };
    db.listUserProjectsByUser.mockImplementation((async (id: string) =>
      id === 'u-prov' ? [{ userId: id, projectId: 'p-retail', role: 'member' }] : []) as never);
    (db as unknown as { listProviders: ReturnType<typeof vi.fn> }).listProviders.mockResolvedValue([
      { _id: 'prov-1', tenantId: 'tenant-1', key: 'openai', label: 'OpenAI', type: 'model', driver: 'openai', status: 'active', projectIds: ['p-corp', 'p-retail'] },
    ] as never);
    db.listModels.mockResolvedValue([
      { _id: 'm-1', tenantId: 'tenant-1', projectId: 'p-retail', key: 'embed', name: 'embed', category: 'embedding', providerKey: 'openai', modelId: 'x', status: 'active' },
    ] as never);
    const res = await get('/api/resource-usage/provider/prov-1', as('u-prov', 'user'));
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<UsageBody & { resource: { projectId: string | null; projectName: string | null; crn: string | null; projectDisplay: { kind: string; projectId?: string } } }>(res.body);
    expect(body.resource.projectDisplay).toMatchObject({ kind: 'project', projectId: 'p-retail' });
    expect(body.resource.projectId).toBe('p-retail');
    expect(body.resource.crn).toContain(':p-retail:');
    expect(res.body).not.toMatch(/p-corp|Corporate/);
    // admin still sees both projects
    const admin = await get('/api/resource-usage/provider/prov-1', as('u-admin', 'admin'));
    expect(admin.body).toMatch(/Corporate/);
  });

  it('an outgoing reference whose only candidates are out of sight reads as a plain missing reference', async () => {
    db.listAgents.mockResolvedValue([agent('a-x', 'retail-x', 'p-retail', 'corp-only')] as never);
    const res = await get('/api/resource-usage/agent/a-x', as('u-retail', 'user'));
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ uses: Array<{ status: string; candidates?: unknown[] }> }>(res.body);
    expect(body.uses).toHaveLength(1);
    expect(body.uses[0].status).toBe('missing');
    expect(body.uses[0].candidates).toBeUndefined();
    expect(res.body).not.toMatch(/Corporate|p-corp|t-corp/);
  });

  it('is not reachable with a write method', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/resource-usage/tool/t-crm', headers: as('u-admin', 'admin') });
    expect(res.statusCode).toBe(404);
  });
});
