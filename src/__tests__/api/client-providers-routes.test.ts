/**
 * Client providers API: the create input the route hands the service, the status of each refusal, and the 404s of the
 * by-id routes (another tenant's provider, a project the token is not in).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  createProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
  getProviderConfigById: vi.fn(),
  updateProviderConfig: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    // Token authentication and the permission gate are covered elsewhere; the handlers are under test here.
    withClientApiRequestContext: (handler: (request: unknown, reply: unknown, auth: unknown) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth),
  };
});
vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: hoisted.createProviderConfig,
  deleteProviderConfig: hoisted.deleteProviderConfig,
  getProviderConfigById: hoisted.getProviderConfigById,
  listProviderConfigs: vi.fn().mockResolvedValue([]),
  redactPlatformProvider: (view: unknown) => view,
  updateProviderConfig: hoisted.updateProviderConfig,
}));

import { ProviderKeyExistsError } from '@/lib/providers/errors';
import { clientProvidersApiPlugin } from '@/server/api/plugins/client-providers';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const headers = { authorization: 'Bearer tok_test', 'content-type': 'application/json' };
const BODY = {
  key: 'azure-eu',
  type: 'model',
  driver: 'openai',
  label: 'Azure EU',
  credentials: { apiKey: 'sk-1' },
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

function setCaller(role: string, projectId: string | undefined = 'p1') {
  hoisted.auth = {
    projectId,
    tenantDbName: 'tenant_acme',
    tenantId: 'tenant-1',
    tokenRecord: { _id: 'token-1', servicePermissions: null, userId: 'owner-1' },
    user: { _id: 'owner-1', role },
  };
}

const create = (query = '', payload: unknown = BODY) =>
  app.inject({ method: 'POST', url: `/api/client/v1/providers${query}`, headers, payload: JSON.stringify(payload) });

beforeEach(async () => {
  vi.clearAllMocks();
  setCaller('owner');
  hoisted.createProviderConfig.mockResolvedValue({ _id: 'prov-new' });
  hoisted.deleteProviderConfig.mockResolvedValue(true);
  hoisted.updateProviderConfig.mockResolvedValue({ _id: 'prov-1' });
  app = await createFastifyApiTestApp(clientProvidersApiPlugin);
});

afterEach(async () => {
  await app.close();
});

describe('POST /client/v1/providers', () => {
  it('project scope creates in the token project; createdBy is the token owner and host paths follow the role', async () => {
    const res = await create('', { ...BODY, createdBy: 'spoofed', description: 'About' });
    expect(res.statusCode).toBe(201);
    const input = hoisted.createProviderConfig.mock.calls[0]![2];
    expect(input).toMatchObject({
      createdBy: 'owner-1',
      projectId: 'p1',
      allowHostPaths: true,
      key: 'azure-eu',
      description: 'About',
    });
    expect('projectIds' in input).toBe(false);

    setCaller('user');
    await create('');
    expect(hoisted.createProviderConfig.mock.calls[1]![2].allowHostPaths).toBe(false);
  });

  it('tenant scope sets no project for an admin', async () => {
    const res = await create('?scope=tenant');
    expect(res.statusCode).toBe(201);
    const input = hoisted.createProviderConfig.mock.calls[0]![2];
    expect('projectId' in input).toBe(false);
    expect('projectIds' in input).toBe(false);
  });

  it('tenant scope is 403 for a caller who is not an owner or admin', async () => {
    setCaller('user');
    expect((await create('?scope=tenant')).statusCode).toBe(403);
    expect(hoisted.createProviderConfig).not.toHaveBeenCalled();
  });

  it('names the missing required field with 400', async () => {
    for (const field of ['key', 'type', 'driver', 'label', 'credentials']) {
      const body: Record<string, unknown> = { ...BODY };
      delete body[field];
      const res = await create('', body);
      expect(res.statusCode, field).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toBe(`${field} is required`);
    }
    expect(hoisted.createProviderConfig).not.toHaveBeenCalled();
  });

  it('answers 409 for a key that exists, with its code', async () => {
    hoisted.createProviderConfig.mockRejectedValueOnce(new ProviderKeyExistsError('azure-eu'));
    const res = await create();
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ code: string }>(res.body).code).toBe('duplicate_key');

    hoisted.createProviderConfig.mockRejectedValueOnce(new Error('Provider with this key already exists'));
    expect((await create()).statusCode).toBe(409);
  });

  it('answers a generic error with 500 and no detail', async () => {
    hoisted.createProviderConfig.mockRejectedValueOnce(new Error('boom'));
    const res = await create();
    expect(res.statusCode).toBe(500);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Internal server error');
  });
});

describe('by-id routes', () => {
  const call = (method: 'GET' | 'PATCH' | 'DELETE', query = '') =>
    app.inject({
      method,
      url: `/api/client/v1/providers/prov-1${query}`,
      // A JSON content type without a body is a 400 of the parser, so only the PATCH carries it.
      headers: method === 'PATCH' ? headers : { authorization: headers.authorization },
      ...(method === 'PATCH' ? { payload: JSON.stringify({ label: 'x' }) } : {}),
    });

  it.each(['GET', 'PATCH', 'DELETE'] as const)('%s is 404 for another tenant\'s provider, an unassigned project and no provider', async (method) => {
    hoisted.getProviderConfigById.mockResolvedValueOnce({ _id: 'prov-1', tenantId: 'tenant-2', projectId: 'p1' });
    expect((await call(method)).statusCode).toBe(404);
    hoisted.getProviderConfigById.mockResolvedValueOnce({ _id: 'prov-1', tenantId: 'tenant-1', projectId: 'p2', projectIds: ['p3'] });
    expect((await call(method)).statusCode).toBe(404);
    hoisted.getProviderConfigById.mockResolvedValueOnce(null);
    const missing = await call(method);
    expect(missing.statusCode).toBe(404);
    expect(parseJsonBody<{ error: string }>(missing.body).error).toBe('Not found');
    expect(hoisted.updateProviderConfig).not.toHaveBeenCalled();
    expect(hoisted.deleteProviderConfig).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PATCH', 'DELETE'] as const)('%s is 404 for a token without a project, and tenant scope ignores assignment', async (method) => {
    setCaller('owner', undefined);
    hoisted.getProviderConfigById.mockResolvedValue({ _id: 'prov-1', tenantId: 'tenant-1', projectId: 'p9' });
    expect((await call(method)).statusCode).toBe(404);
    expect((await call(method, '?scope=tenant')).statusCode).toBe(200);
  });

  it('opens a provider assigned through projectIds', async () => {
    hoisted.getProviderConfigById.mockResolvedValue({ _id: 'prov-1', tenantId: 'tenant-1', projectIds: ['p1'] });
    expect((await call('GET')).statusCode).toBe(200);
  });
});
