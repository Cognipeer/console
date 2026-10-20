/**
 * Providers API (Fastify plugin):
 *   POST /api/providers?scope=tenant        forwards + validates projectIds
 *   POST /api/providers/test                connection test of an unsaved provider (nothing persisted)
 *   POST /api/providers/:id/test            connection test of a stored provider (outcome kept on the record)
 *   GET  /api/providers/:id/usage           models and agents per assigned project
 *   GET  /api/providers/:id                 the edit form's read: also names the credential fields that store a value
 * and how those routes are authorized (they ride the `/api/providers` prefix: providers service).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', userRole: 'owner' } as Record<string, string>,
  createProviderConfig: vi.fn(),
  getProviderConfigById: vi.fn(),
  listProviderConfigs: vi.fn(),
  loadProviderRuntimeData: vi.fn(),
  recordProviderTest: vi.fn(),
  resolveTenantProjectIds: vi.fn(),
  testProviderConnection: vi.fn(),
  getProviderUsage: vi.fn(),
  updateProviderConfig: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    // The permission gate is covered by the rbac / route-declaration tests; the handlers are under test here.
    withApiRequestContext: (handler: unknown) => handler,
    requireSessionContext: () => hoisted.session,
    requireProjectContextForRequest: vi.fn(async () => ({ projectId: 'proj-ctx', session: hoisted.session })),
    sendProjectContextError: () => null,
  };
});
vi.mock('@/lib/services/providers/providerService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/providers/providerService')>();
  return {
    ...actual,
    createProviderConfig: hoisted.createProviderConfig,
    getProviderConfigById: hoisted.getProviderConfigById,
    loadProviderRuntimeData: hoisted.loadProviderRuntimeData,
    recordProviderTest: hoisted.recordProviderTest,
    resolveTenantProjectIds: hoisted.resolveTenantProjectIds,
    updateProviderConfig: hoisted.updateProviderConfig,
    listProviderConfigs: hoisted.listProviderConfigs,
  };
});
vi.mock('@/lib/services/providers/providerConnectionTest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/providers/providerConnectionTest')>();
  return { ...actual, testProviderConnection: hoisted.testProviderConnection };
});
vi.mock('@/lib/services/providers/providerUsage', () => ({ getProviderUsage: hoisted.getProviderUsage }));

import { providersApiPlugin } from '@/server/api/plugins/providers';
import { ProviderCredentialDecryptError } from '@/lib/services/providers/providerService';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { getPermissionServiceForPath, getRequiredPermissionLevel } from '@/lib/security/rbac';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

const CREATE_BODY = {
  key: 'azure-eu',
  type: 'model',
  driver: 'openai',
  label: 'Azure EU',
  credentials: { apiKey: 'sk-secret-value-1' },
};

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as never });

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.session.userRole = 'owner';
  hoisted.createProviderConfig.mockResolvedValue({ _id: 'prov-1', key: 'azure-eu', projectIds: ['p1'], hasCredentials: true });
  hoisted.resolveTenantProjectIds.mockImplementation(async (_db: string, _tenant: string, ids: string[]) => ({
    projectIds: [...new Set(ids)].filter((id) => id !== 'ghost'),
    unknown: [...new Set(ids)].filter((id) => id === 'ghost'),
  }));
  hoisted.getProviderConfigById.mockResolvedValue({ _id: 'prov-1', tenantId: 'tenant-1', key: 'azure-eu', projectIds: ['p1'] });
  hoisted.loadProviderRuntimeData.mockResolvedValue({
    record: { _id: 'prov-1', tenantId: 'tenant-1', key: 'azure-eu', type: 'model', driver: 'openai', settings: {} },
    credentials: { apiKey: 'sk-secret-value-1' },
  });
  hoisted.testProviderConnection.mockResolvedValue({ ok: true, latencyMs: 42, message: 'Connected.', details: { models: ['a', 'b'] } });
  hoisted.getProviderUsage.mockResolvedValue({ projects: [{ projectId: 'p1', name: 'Support', assigned: true, models: [], agents: [] }] });
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(providersApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/providers?scope=tenant - projectIds', () => {
  it('forwards the validated, deduped projectIds to the service', async () => {
    const res = await post('/api/providers?scope=tenant', { ...CREATE_BODY, projectIds: ['p1', 'p2', 'p1'] });
    expect(res.statusCode).toBe(201);
    expect(hoisted.resolveTenantProjectIds).toHaveBeenCalledWith('tenant_acme', 'tenant-1', ['p1', 'p2', 'p1']);
    expect(hoisted.createProviderConfig).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      expect.objectContaining({ projectIds: ['p1', 'p2'], key: 'azure-eu' }),
    );
  });

  it('creates an unassigned provider when projectIds is absent', async () => {
    const res = await post('/api/providers?scope=tenant', CREATE_BODY);
    expect(res.statusCode).toBe(201);
    expect(hoisted.resolveTenantProjectIds).not.toHaveBeenCalled();
    expect(hoisted.createProviderConfig.mock.calls[0]![2].projectIds).toBeUndefined();
  });

  it('refuses a project that is not of the tenant (400, names it), creating nothing', async () => {
    const res = await post('/api/providers?scope=tenant', { ...CREATE_BODY, projectIds: ['p1', 'ghost'] });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Unknown project(s): ghost');
    expect(hoisted.createProviderConfig).not.toHaveBeenCalled();
  });

  it('refuses a projectIds that is not a list of ids', async () => {
    for (const bad of ['p1', [1, 2], [''], { a: 1 }]) {
      const res = await post('/api/providers?scope=tenant', { ...CREATE_BODY, projectIds: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toMatch(/projectIds must be an array/);
    }
    expect(hoisted.createProviderConfig).not.toHaveBeenCalled();
  });

  it('is for owners and admins only', async () => {
    hoisted.session.userRole = 'user';
    const res = await post('/api/providers?scope=tenant', { ...CREATE_BODY, projectIds: ['p1'] });
    expect(res.statusCode).toBe(403);
    expect(hoisted.createProviderConfig).not.toHaveBeenCalled();
  });
});

describe('POST /api/providers/test (unsaved provider)', () => {
  const body = { type: 'model', driver: 'openai', credentials: { apiKey: 'sk-secret-value-1' }, settings: {} };

  it('answers the result of the test and persists nothing', async () => {
    const res = await post('/api/providers/test', body);
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({ ok: true, latencyMs: 42, message: 'Connected.', details: { models: ['a', 'b'] } });
    expect(hoisted.testProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      type: 'model', driver: 'openai', tenantId: 'tenant-1', credentials: { apiKey: 'sk-secret-value-1' },
    }));
    expect(hoisted.recordProviderTest).not.toHaveBeenCalled();
    expect(hoisted.createProviderConfig).not.toHaveBeenCalled();
  });

  it('passes through "not supported" (ok:null) and failures (ok:false) as 200s', async () => {
    hoisted.testProviderConnection.mockResolvedValueOnce({ ok: null, latencyMs: 0, message: 'Testing is not supported for this driver.' });
    expect(parseJsonBody<{ ok: unknown }>((await post('/api/providers/test', body)).body).ok).toBeNull();
    hoisted.testProviderConnection.mockResolvedValueOnce({ ok: false, latencyMs: 9, message: 'The provider rejected the credentials (HTTP 401).' });
    const res = await post('/api/providers/test', body);
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ ok: unknown }>(res.body).ok).toBe(false);
  });

  it('refuses a body without type or driver, and an unknown driver (400)', async () => {
    for (const bad of [{ driver: 'openai' }, { type: 'model' }, { ...body, driver: 'no-such-driver' }, { ...body, credentials: 'x' }]) {
      const res = await post('/api/providers/test', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(hoisted.testProviderConnection).not.toHaveBeenCalled();
  });

  it('maps an endpoint the outbound guard refuses to 400 with its code', async () => {
    hoisted.testProviderConnection.mockRejectedValueOnce(new ProviderEndpointError('baseUrl', 'private host'));
    const res = await post('/api/providers/test', body);
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody(res.body)).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'baseUrl' });
  });

  it('is for owners and admins only', async () => {
    hoisted.session.userRole = 'user';
    expect((await post('/api/providers/test', body)).statusCode).toBe(403);
    expect(hoisted.testProviderConnection).not.toHaveBeenCalled();
  });
});

describe('POST /api/providers/:id/test (stored provider)', () => {
  it('tests with the decrypted credentials, keeps the outcome on the record, and never echoes credentials', async () => {
    const res = await post('/api/providers/prov-1/test', {});
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toMatchObject({ ok: true, latencyMs: 42 });
    expect(res.body).not.toContain('sk-secret-value-1');
    expect(hoisted.testProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      driver: 'openai', credentials: { apiKey: 'sk-secret-value-1' }, providerKey: 'azure-eu',
    }));
    expect(hoisted.recordProviderTest).toHaveBeenCalledWith('tenant_acme', 'prov-1', {
      ok: true, at: expect.any(Date), latencyMs: 42, message: 'Connected.', deployments: 2,
    });
  });

  it('keeps ok:false and ok:null outcomes too', async () => {
    hoisted.testProviderConnection.mockResolvedValueOnce({ ok: null, latencyMs: 0, message: 'Testing is not supported for this driver.' });
    await post('/api/providers/prov-1/test', {});
    expect(hoisted.recordProviderTest).toHaveBeenCalledWith('tenant_acme', 'prov-1', expect.objectContaining({ ok: null, latencyMs: 0 }));
    expect(hoisted.recordProviderTest.mock.calls[0]![2]).not.toHaveProperty('deployments');
  });

  it('is 404 for a provider of another tenant or none, 403 for non-admins', async () => {
    hoisted.getProviderConfigById.mockResolvedValueOnce({ _id: 'prov-1', tenantId: 'someone-else' });
    expect((await post('/api/providers/prov-1/test', {})).statusCode).toBe(404);
    hoisted.getProviderConfigById.mockResolvedValueOnce(null);
    expect((await post('/api/providers/nope/test', {})).statusCode).toBe(404);
    hoisted.session.userRole = 'user';
    expect((await post('/api/providers/prov-1/test', {})).statusCode).toBe(403);
    expect(hoisted.testProviderConnection).not.toHaveBeenCalled();
    expect(hoisted.recordProviderTest).not.toHaveBeenCalled();
  });

  it('answers 409 when the stored credentials cannot be opened, and keeps nothing', async () => {
    hoisted.loadProviderRuntimeData.mockRejectedValueOnce(new ProviderCredentialDecryptError('azure-eu', 'openai'));
    const res = await post('/api/providers/prov-1/test', {});
    expect(res.statusCode).toBe(409);
    expect(hoisted.recordProviderTest).not.toHaveBeenCalled();
  });
});

describe('GET /api/providers/:id/usage', () => {
  it('answers the usage of the provider per project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers/prov-1/usage' });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({
      projects: [{ projectId: 'p1', name: 'Support', assigned: true, models: [], agents: [] }],
    });
    expect(hoisted.getProviderUsage).toHaveBeenCalledWith('tenant_acme', 'tenant-1', expect.objectContaining({ key: 'azure-eu' }));
  });

  it('is 404 for another tenant\'s provider and 403 for non-admins', async () => {
    hoisted.getProviderConfigById.mockResolvedValueOnce({ _id: 'prov-1', tenantId: 'someone-else' });
    expect((await app.inject({ method: 'GET', url: '/api/providers/prov-1/usage' })).statusCode).toBe(404);
    hoisted.session.userRole = 'user';
    expect((await app.inject({ method: 'GET', url: '/api/providers/prov-1/usage' })).statusCode).toBe(403);
    expect(hoisted.getProviderUsage).not.toHaveBeenCalled();
  });
});

describe('GET /api/providers/:id - the read an edit form opens from', () => {
  const STORED = { _id: 'prov-1', tenantId: 'tenant-1', key: 'azure-eu', projectIds: ['proj-ctx'], hasCredentials: true, credentialFields: ['accountKey'] };

  it('asks for the names of the credential fields that store a value, in both scopes, and passes the answer on', async () => {
    hoisted.getProviderConfigById.mockResolvedValue(STORED);

    const tenant = await app.inject({ method: 'GET', url: '/api/providers/prov-1?scope=tenant' });
    expect(tenant.statusCode).toBe(200);
    expect(parseJsonBody<{ provider: typeof STORED }>(tenant.body).provider.credentialFields).toEqual(['accountKey']);
    expect(hoisted.getProviderConfigById).toHaveBeenLastCalledWith('tenant_acme', 'prov-1', { credentialFields: true });

    const project = await app.inject({ method: 'GET', url: '/api/providers/prov-1' });
    expect(project.statusCode).toBe(200);
    expect(parseJsonBody<{ provider: typeof STORED }>(project.body).provider.credentialFields).toEqual(['accountKey']);
    expect(hoisted.getProviderConfigById).toHaveBeenLastCalledWith('tenant_acme', 'prov-1', { credentialFields: true });
  });

  it('keeps its refusals: another tenant\'s provider and a project it is not assigned to are 404, a non-admin tenant read is 403', async () => {
    hoisted.getProviderConfigById.mockResolvedValueOnce({ ...STORED, tenantId: 'someone-else' });
    expect((await app.inject({ method: 'GET', url: '/api/providers/prov-1?scope=tenant' })).statusCode).toBe(404);
    hoisted.getProviderConfigById.mockResolvedValueOnce({ ...STORED, projectIds: ['another-project'] });
    expect((await app.inject({ method: 'GET', url: '/api/providers/prov-1' })).statusCode).toBe(404);
    hoisted.session.userRole = 'user';
    expect((await app.inject({ method: 'GET', url: '/api/providers/prov-1?scope=tenant' })).statusCode).toBe(403);
  });
});

describe('GET /api/providers - the list', () => {
  it('does not open the stored credentials of every provider: the names are for the edit form\'s own read', async () => {
    hoisted.listProviderConfigs.mockResolvedValue([{ _id: 'prov-1', key: 'azure-eu', hasCredentials: true }]);

    const tenant = await app.inject({ method: 'GET', url: '/api/providers?scope=tenant&type=model' });
    expect(tenant.statusCode).toBe(200);
    const project = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(project.statusCode).toBe(200);

    expect(hoisted.listProviderConfigs).toHaveBeenCalledTimes(2);
    for (const call of hoisted.listProviderConfigs.mock.calls) expect(call).toHaveLength(3);
  });
});

describe('PATCH /api/providers/:id?scope=tenant - projectIds', () => {
  const patch = (payload: unknown) =>
    app.inject({ method: 'PATCH', url: '/api/providers/prov-1?scope=tenant', payload: payload as never });

  it('applies a validated, deduped assignment', async () => {
    hoisted.updateProviderConfig.mockResolvedValue({ _id: 'prov-1', projectIds: ['p1', 'p2'] });
    const res = await patch({ projectIds: ['p1', 'p2', 'p1'] });
    expect(res.statusCode).toBe(200);
    expect(hoisted.resolveTenantProjectIds).toHaveBeenCalledWith('tenant_acme', 'tenant-1', ['p1', 'p2', 'p1']);
    expect(hoisted.updateProviderConfig).toHaveBeenCalledWith(
      'tenant_acme',
      'prov-1',
      expect.objectContaining({ projectIds: ['p1', 'p2'] }),
    );
  });

  it('refuses a project that is not of the tenant and changes nothing', async () => {
    const res = await patch({ projectIds: ['p1', 'ghost'] });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Unknown project(s): ghost');
    expect(hoisted.updateProviderConfig).not.toHaveBeenCalled();
  });

  it('leaves the assignment alone when projectIds is absent', async () => {
    hoisted.updateProviderConfig.mockResolvedValue({ _id: 'prov-1' });
    const res = await patch({ label: 'Renamed' });
    expect(res.statusCode).toBe(200);
    expect(hoisted.resolveTenantProjectIds).not.toHaveBeenCalled();
  });
});

describe('authorization of the new routes', () => {
  it('maps them to the providers service through the /api/providers prefix', () => {
    for (const path of ['/api/providers/test', '/api/providers/prov-1/test', '/api/providers/prov-1/usage']) {
      expect(getPermissionServiceForPath(path), path).toBe('providers');
    }
  });

  it('requires admin for the test routes and read for the usage route', () => {
    expect(getRequiredPermissionLevel('POST', 'providers')).toBe('admin');
    expect(getRequiredPermissionLevel('GET', 'providers')).toBe('read');
  });
});
