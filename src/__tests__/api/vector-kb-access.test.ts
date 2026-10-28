/**
 * A direct query on a vector index - the dashboard's `POST /vector/indexes/:externalId/query` and the client API's
 * `POST /client/v1/vector/providers/:providerKey/indexes/:externalId/query` - and the knowledge bases that keep their
 * vectors in that index.
 *
 * With access control on for a knowledge base its documents are read through the knowledge base, where each one is
 * checked; a query on the index itself would skip that. So the query is answered 403 `kb_access_controlled` unless the
 * caller administers every knowledge base that uses the index (each with the admin exception on). An API token never
 * does. Any other index is queried as before.
 *
 * Who skips the checks is `ragAccessForRequest`'s answer (its own tests have the engine behind it); here it is one the
 * test chooses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', userRole: 'owner' } as Record<string, string>,
  auth: {
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: 'user-1' },
    tenant: { licenseType: 'STARTER' },
    tenantId: 'tenant-1',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'owner' },
  },
  db: { listRagModules: vi.fn(), listVectorIndexes: vi.fn() },
  ragAccessForRequest: vi.fn(),
  queryVectorIndex: vi.fn(),
  createVectorMigration: vi.fn(),
  getVectorMigration: vi.fn(),
  startVectorMigration: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    // The permission and token gates are covered by the rbac / route-declaration tests; the handlers are under test here.
    withApiRequestContext: (handler: unknown) => handler,
    withClientApiRequestContext: (handler: (...args: unknown[]) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth),
    getApiTokenContextForRequest: async () => hoisted.auth,
    requireProjectContextForRequest: vi.fn(async () => ({ projectId: 'proj-1', session: hoisted.session })),
    sendProjectContextError: () => null,
  };
});
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn(async () => ({ allowed: true, effectiveLimits: {} })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  checkResourceQuota: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/services/vector', () => ({
  queryVectorIndex: hoisted.queryVectorIndex,
  createVectorMigration: hoisted.createVectorMigration,
  getVectorMigration: hoisted.getVectorMigration,
  startVectorMigration: hoisted.startVectorMigration,
  VectorAttachRequiresDetailsError: class extends Error {},
  VectorAttachNotFoundError: class extends Error {},
}));
vi.mock('@/server/api/ragAccessRequest', () => ({ ragAccessForRequest: hoisted.ragAccessForRequest }));

import type { FastifyPluginAsync } from 'fastify';
import { checkPerRequestLimits, checkRateLimit } from '@/lib/quota/quotaGuard';
import { clientVectorApiPlugin } from '@/server/api/plugins/client-vector';
import { vectorApiPlugin } from '@/server/api/plugins/vector';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);

const RESULT = { matches: [{ id: 'v1', score: 0.9 }] };
const BODY = { query: { vector: [0.1, 0.2], topK: 3 } };

/** What `ragAccessForRequest` answers for a module: no scope for a module that is not there. */
type Scope = { enabled: boolean; manage: boolean; bypass: boolean };
const KEPT_OUT: Scope = { enabled: true, manage: false, bypass: false };
const ADMINISTRATOR: Scope = { enabled: true, manage: true, bypass: true };
/** The module turned the admin exception off: an administrator is checked like everyone else. */
const ADMINISTRATOR_WITHOUT_EXCEPTION: Scope = { enabled: true, manage: true, bypass: false };
const scopes = new Map<string, Scope>();

/** A knowledge base that keeps its vectors in the index `kb-index` of the provider `vec`, access control on. */
const ragModule = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  name: key,
  vectorProviderKey: 'vec',
  vectorIndexKey: 'kb-index',
  access: { enabled: true },
  ...over,
});
const modules = (...list: unknown[]) => mockFn(hoisted.db.listRagModules).mockResolvedValue(list);

const dashboardUrl = (providerKey: string, indexKey: string) =>
  `/api/vector/indexes/${encodeURIComponent(indexKey)}/query?providerKey=${encodeURIComponent(providerKey)}`;
const clientUrl = (providerKey: string, indexKey: string) =>
  `/api/client/v1/vector/providers/${encodeURIComponent(providerKey)}/indexes/${encodeURIComponent(indexKey)}/query`;

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
const mount = async (plugin: FastifyPluginAsync) => {
  // The production JSON parser: the body stays the raw string.
  app = await createFastifyApiTestApp(plugin, { rawJsonBody: true });
};
const post = (url: string, body: unknown = BODY) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  scopes.clear();
  mockFn(hoisted.ragAccessForRequest).mockImplementation(async (_request: unknown, input: { ragModuleKey: string }) => ({
    module: null,
    caller: { kind: 'person', userId: 'user-1' },
    scope: scopes.get(input.ragModuleKey),
  }));
  mockFn(hoisted.db.listRagModules).mockResolvedValue([]);
  mockFn(hoisted.db.listVectorIndexes).mockResolvedValue([]);
  mockFn(hoisted.queryVectorIndex).mockResolvedValue(RESULT);
});

afterEach(async () => {
  await app.close();
});

const surfaces = [
  { label: 'dashboard', plugin: vectorApiPlugin, url: dashboardUrl },
  { label: 'client API', plugin: clientVectorApiPlugin, url: clientUrl },
];

describe.each(surfaces)('a direct query on a vector index: $label', ({ plugin, url }) => {
  beforeEach(() => mount(plugin));

  it('is refused with 403 kb_access_controlled when a knowledge base with access control keeps its vectors in the index', async () => {
    modules(ragModule('payroll'));
    scopes.set('payroll', KEPT_OUT);

    const res = await post(url('vec', 'kb-index'));

    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: expect.any(String), code: 'kb_access_controlled' });
    // The answer does not name the knowledge base.
    expect(res.body).not.toContain('payroll');
    expect(hoisted.queryVectorIndex).not.toHaveBeenCalled();
    // One read of the project's modules, and the access question for the module found.
    expect(hoisted.db.listRagModules).toHaveBeenCalledTimes(1);
    expect(hoisted.db.listRagModules).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.ragAccessForRequest).toHaveBeenCalledWith(expect.anything(), {
      tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', ragModuleKey: 'payroll',
    });
  });

  it('queries the index as before when no knowledge base has access control: one read of the modules, no question', async () => {
    modules(ragModule('open', { access: undefined }), ragModule('off', { access: { enabled: false } }));

    const res = await post(url('vec', 'kb-index'));

    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ result: RESULT });
    expect(hoisted.queryVectorIndex).toHaveBeenCalledTimes(1);
    expect(hoisted.db.listRagModules).toHaveBeenCalledTimes(1);
    expect(hoisted.db.listVectorIndexes).not.toHaveBeenCalled();
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });

  it('queries another index of the same provider as before', async () => {
    modules(ragModule('hr', { vectorIndexKey: 'hr-index' }));
    scopes.set('hr', KEPT_OUT);
    mockFn(hoisted.db.listVectorIndexes).mockResolvedValue([
      { key: 'kb-index', externalId: 'ext-1' },
      { key: 'hr-index', externalId: 'ext-2' },
    ]);

    const res = await post(url('vec', 'kb-index'));

    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ result: RESULT });
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });

  it('queries an index of the same key under another provider as before', async () => {
    modules(ragModule('ops', { vectorProviderKey: 'vec-2' }));
    scopes.set('ops', KEPT_OUT);

    const res = await post(url('vec', 'kb-index'));

    expect(res.statusCode).toBe(200);
    expect(hoisted.db.listVectorIndexes).not.toHaveBeenCalled();
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });

  it('refuses an index registered a second time for the index of such a knowledge base', async () => {
    modules(ragModule('hr'));
    scopes.set('hr', KEPT_OUT);
    mockFn(hoisted.db.listVectorIndexes).mockResolvedValue([
      { key: 'kb-index', externalId: 'ext-1' },
      { key: 'attached', externalId: 'ext-1' },
    ]);

    const res = await post(url('vec', 'attached'));

    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'kb_access_controlled' });
    expect(hoisted.db.listVectorIndexes).toHaveBeenCalledWith({ providerKey: 'vec', projectId: 'proj-1' });
    expect(hoisted.queryVectorIndex).not.toHaveBeenCalled();
  });

  it('does not query when it cannot tell whether a knowledge base uses the index', async () => {
    mockFn(hoisted.db.listRagModules).mockRejectedValue(new Error('the database is unreachable'));

    const res = await post(url('vec', 'kb-index'));

    expect(res.statusCode).toBe(500);
    expect(hoisted.queryVectorIndex).not.toHaveBeenCalled();
  });

  it('does not query when the access of the knowledge base cannot be read', async () => {
    modules(ragModule('hr'));
    mockFn(hoisted.ragAccessForRequest).mockRejectedValue(new Error('the engine is down'));

    const res = await post(url('vec', 'kb-index'));

    expect(res.statusCode).toBe(500);
    expect(hoisted.queryVectorIndex).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a body with no vector', body: { query: { topK: 3 } }, error: 'query.vector array is required' },
    { label: 'a topK that is not a positive number', body: { query: { vector: [0.1], topK: 0 } }, error: 'query.topK must be a positive number' },
  ])('answers $label as before, ahead of any read of the modules', async ({ body, error }) => {
    modules(ragModule('hr'));
    scopes.set('hr', KEPT_OUT);

    const res = await post(url('vec', 'kb-index'), body);

    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error });
    expect(hoisted.db.listRagModules).not.toHaveBeenCalled();
    expect(hoisted.queryVectorIndex).not.toHaveBeenCalled();
  });
});

describe('the dashboard: who may query the index of a knowledge base', () => {
  beforeEach(() => mount(vectorApiPlugin));

  it('queries the index for a caller who administers the knowledge base', async () => {
    modules(ragModule('hr'));
    scopes.set('hr', ADMINISTRATOR);

    const res = await post(dashboardUrl('vec', 'kb-index'));

    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ result: RESULT });
    expect(hoisted.queryVectorIndex).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', {
      indexKey: 'kb-index',
      providerKey: 'vec',
      query: { filter: undefined, topK: 3, vector: [0.1, 0.2] },
    });
  });

  it('refuses an administrator whose knowledge base turned the admin exception off', async () => {
    modules(ragModule('hr'));
    scopes.set('hr', ADMINISTRATOR_WITHOUT_EXCEPTION);

    const res = await post(dashboardUrl('vec', 'kb-index'));

    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'kb_access_controlled' });
    expect(hoisted.queryVectorIndex).not.toHaveBeenCalled();
  });

  it('needs every knowledge base on the index: one the caller does not administer is enough to refuse', async () => {
    modules(ragModule('hr'), ragModule('finance'));
    scopes.set('hr', ADMINISTRATOR);
    scopes.set('finance', KEPT_OUT);

    const refused = await post(dashboardUrl('vec', 'kb-index'));
    expect(refused.statusCode).toBe(403);
    expect(hoisted.queryVectorIndex).not.toHaveBeenCalled();

    scopes.set('finance', ADMINISTRATOR);
    const served = await post(dashboardUrl('vec', 'kb-index'));
    expect(served.statusCode).toBe(200);
    expect(hoisted.queryVectorIndex).toHaveBeenCalledTimes(1);
  });
});

describe('the client API: a token does not administer a knowledge base', () => {
  beforeEach(() => mount(clientVectorApiPlugin));

  it('is refused before any quota or rate limit is spent', async () => {
    modules(ragModule('hr'));
    scopes.set('hr', KEPT_OUT);

    const res = await post(clientUrl('vec', 'kb-index'));

    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: expect.any(String), code: 'kb_access_controlled' });
    expect(checkPerRequestLimits).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(hoisted.queryVectorIndex).not.toHaveBeenCalled();
  });

  it('is otherwise the query it was: the quotas of the index asked, then the index queried', async () => {
    modules(ragModule('hr', { vectorIndexKey: 'hr-index' }));
    scopes.set('hr', KEPT_OUT);
    mockFn(hoisted.db.listVectorIndexes).mockResolvedValue([{ key: 'kb-index', externalId: 'ext-1' }]);

    const res = await post(clientUrl('vec', 'kb-index'));

    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ result: RESULT });
    const expected = expect.objectContaining({
      domain: 'vector', providerKey: 'vec', resourceKey: 'kb-index', projectId: 'proj-1', tenantId: 'tenant-1', tokenId: 'tok-1',
    });
    expect(checkPerRequestLimits).toHaveBeenCalledWith(expected, { queryResults: 3, vectorDimensions: 2 });
    expect(checkRateLimit).toHaveBeenCalledWith(expected, { requests: 1 });
    expect(hoisted.queryVectorIndex).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', {
      indexKey: 'kb-index',
      providerKey: 'vec',
      query: { filter: undefined, topK: 3, vector: [0.1, 0.2] },
    });
  });
});

describe('a vector migration that copies the index of a knowledge base with access control', () => {
  const MIGRATION = {
    name: 'Copy',
    sourceProviderKey: 'vec',
    sourceIndexKey: 'kb-index',
    destinationProviderKey: 'vec-2',
    destinationIndexKey: 'open-index',
  };
  const create = (body: Record<string, unknown> = MIGRATION) => post('/api/vector/migrations', body);
  const start = (key = 'mig-1') => app.inject({ method: 'POST', url: `/api/vector/migrations/${key}/start` });

  beforeEach(async () => {
    await mount(vectorApiPlugin);
    mockFn(hoisted.createVectorMigration).mockResolvedValue({ key: 'mig-1' });
    mockFn(hoisted.startVectorMigration).mockResolvedValue({ key: 'mig-1', status: 'running' });
    mockFn(hoisted.getVectorMigration).mockResolvedValue({ key: 'mig-1', ...MIGRATION });
  });

  it('is neither made nor started for a caller the knowledge base keeps out: the copy could be queried outside it', async () => {
    modules(ragModule('payroll'));
    scopes.set('payroll', KEPT_OUT);

    const made = await create();
    expect(made.statusCode).toBe(403);
    expect(json(made)).toEqual({ error: expect.stringContaining('not copied'), code: 'kb_access_controlled' });
    expect(hoisted.createVectorMigration).not.toHaveBeenCalled();

    // A migration made before access control was switched on is checked again when it starts.
    const started = await start();
    expect(started.statusCode).toBe(403);
    expect(json(started).code).toBe('kb_access_controlled');
    expect(hoisted.startVectorMigration).not.toHaveBeenCalled();
  });

  it('is refused for an administrator whose knowledge base turned the admin exception off', async () => {
    modules(ragModule('payroll'));
    scopes.set('payroll', ADMINISTRATOR_WITHOUT_EXCEPTION);

    expect((await create()).statusCode).toBe(403);
    expect((await start()).statusCode).toBe(403);
  });

  it('goes on for an administrator of the knowledge base, and for an index no such knowledge base uses', async () => {
    modules(ragModule('payroll'));
    scopes.set('payroll', ADMINISTRATOR);
    expect((await create()).statusCode).toBe(201);
    expect((await start()).statusCode).toBe(200);

    scopes.set('payroll', KEPT_OUT);
    const other = { ...MIGRATION, sourceIndexKey: 'other-index' };
    mockFn(hoisted.getVectorMigration).mockResolvedValue({ key: 'mig-2', ...other });
    expect((await create(other)).statusCode).toBe(201);
    expect((await start('mig-2')).statusCode).toBe(200);
    expect(hoisted.createVectorMigration).toHaveBeenCalledTimes(2);
    expect(hoisted.startVectorMigration).toHaveBeenCalledTimes(2);
  });

  it('leaves a migration that is not there to the 404 of the start, asking nothing', async () => {
    mockFn(hoisted.getVectorMigration).mockResolvedValue(null);
    mockFn(hoisted.startVectorMigration).mockRejectedValue(new Error('Migration not found'));

    expect((await start('missing')).statusCode).toBe(404);
    expect(hoisted.ragAccessForRequest).not.toHaveBeenCalled();
  });
});
