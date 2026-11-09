/**
 * API tests - Web Search instance routes, the compatible provider routes and the client routes.
 * Mocks the service layer; verifies routing, permissions, error mapping and reply shapes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  const getDatabase = vi.fn();
  return {
    ...actual,
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/services/webSearch', () => ({
  listWebSearchProviders: vi.fn(),
  listWebSearchRunLogs: vi.fn(),
  runWebSearch: vi.fn(),
}));

vi.mock('@/lib/services/webSearch/webSearchInstanceService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/webSearch/webSearchInstanceService')>(
    '@/lib/services/webSearch/webSearchInstanceService',
  );
  return {
    ...actual,
    createWebSearchInstance: vi.fn(),
    updateWebSearchInstance: vi.fn(),
    deleteWebSearchInstance: vi.fn(),
    getWebSearchInstance: vi.fn(),
    listWebSearchInstances: vi.fn(),
  };
});

vi.mock('@/lib/services/providers/providerService', () => ({
  getProviderConfigByKey: vi.fn(),
  redactPlatformProvider: (view: unknown) => view,
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return {
    ProjectContextError,
    resolveProjectContext: vi.fn().mockResolvedValue({
      projectId: 'proj-1',
      project: { _id: 'proj-1', key: 'default', name: 'Default' },
      userProject: null,
    }),
  };
});

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

import { websearchApiPlugin } from '@/server/api/plugins/websearch';
import { clientWebSearchApiPlugin } from '@/server/api/plugins/client-websearch';
import { listWebSearchProviders, listWebSearchRunLogs, runWebSearch } from '@/lib/services/webSearch';
import { getProviderConfigByKey } from '@/lib/services/providers/providerService';
import {
  createWebSearchInstance,
  deleteWebSearchInstance,
  getWebSearchInstance,
  listWebSearchInstances,
  updateWebSearchInstance,
  WebSearchInstanceKeyExistsError,
  WebSearchInstanceNotFoundError,
} from '@/lib/services/webSearch/webSearchInstanceService';
import { ProviderSettingsError } from '@/lib/providers/errors';
import {
  ManagedProviderReadOnlyError,
  PlatformRecordReadOnlyError,
} from '@/lib/services/providers/managedProviderErrors';
import { WebSearchCacheConfigError } from '@/lib/services/webSearch/cacheSettings';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-email': 'a@b.com',
  'x-user-role': 'admin',
  'x-license-type': 'PROFESSIONAL',
};
const JSON_HEADERS = { ...HEADERS, 'content-type': 'application/json' };
const CLIENT_HEADERS = { authorization: 'Bearer tok_abc', 'content-type': 'application/json' };

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'PROFESSIONAL' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1', servicePermissions: {} },
};

const PROVIDER = {
  _id: 'prov-1',
  key: 'brave-conn',
  type: 'websearch',
  driver: 'brave-search',
  label: 'Brave',
  status: 'active',
  settings: { baseUrl: 'https://internal.example' },
  hasCredentials: true,
  credentialFields: ['apiKey'],
};

const INSTANCE = {
  _id: 'inst-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'brave-main',
  name: 'Brave deep',
  providerKey: 'brave-conn',
  status: 'active',
  settings: { aiAnswer: { enabled: true } },
  createdBy: 'user-1',
};

const fn = (mock: unknown) => mock as ReturnType<typeof vi.fn>;

function signInAs(role: string) {
  const db = createMockDb();
  db.findUserById.mockResolvedValue({
    _id: 'user-1',
    email: 'a@b.com',
    role,
    tenantId: 'tenant-1',
    servicePermissions: { websearch: 'write' },
  } as never);
  fn(getDatabase).mockResolvedValue(db);
}

beforeEach(() => {
  vi.clearAllMocks();
  signInAs('owner');
  fn(listWebSearchProviders).mockResolvedValue([PROVIDER]);
  fn(listWebSearchRunLogs).mockResolvedValue([]);
  fn(runWebSearch).mockResolvedValue({
    providerKey: 'brave-main', driver: 'brave-search', query: 'q', results: [], latencyMs: 1,
  });
  fn(getProviderConfigByKey).mockResolvedValue(PROVIDER);
  fn(listWebSearchInstances).mockResolvedValue([INSTANCE]);
  fn(getWebSearchInstance).mockResolvedValue(INSTANCE);
  fn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
});

describe('instance routes (dashboard)', () => {
  it('lists the visible instances with a provider summary and no connection data', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/websearch/instances', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const { instances } = parseJsonBody<{ instances: Array<Record<string, unknown>> }>(res.body);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      key: 'brave-main',
      providerKey: 'brave-conn',
      platform: false,
      tenantWide: false,
      provider: { key: 'brave-conn', label: 'Brave', driver: 'brave-search', status: 'active', platform: false },
    });
    expect(JSON.stringify(instances)).not.toContain('internal.example');
    expect(JSON.stringify(instances)).not.toContain('apiKey');
    expect(listWebSearchInstances).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1');
  });

  it('hides the behavior of a platform instance', async () => {
    fn(listWebSearchInstances).mockResolvedValue([
      { ...INSTANCE, platform: true, description: 'internal note', settings: { depth: 'x' }, metadata: { a: 1 } },
    ]);
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/websearch/instances', headers: HEADERS });
    const { instances } = parseJsonBody<{ instances: Array<Record<string, unknown>> }>(res.body);
    expect(instances[0]).toMatchObject({ platform: true, settings: {} });
    expect(instances[0]).not.toHaveProperty('description');
    expect(instances[0]).not.toHaveProperty('metadata');
  });

  it('creates an instance owned by the active project and ignores `platform` in the body', async () => {
    fn(createWebSearchInstance).mockResolvedValue(INSTANCE);
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/websearch/instances',
      headers: JSON_HEADERS,
      payload: JSON.stringify({
        key: 'brave-main', name: 'Brave deep', providerKey: 'brave-conn', settings: { a: 1 }, platform: true,
      }),
    });
    expect(res.statusCode).toBe(201);
    const input = fn(createWebSearchInstance).mock.calls[0]![2];
    expect(input).toMatchObject({
      key: 'brave-main', name: 'Brave deep', providerKey: 'brave-conn', projectId: 'proj-1', createdBy: 'user-1',
    });
    expect(input).not.toHaveProperty('platform');
    expect(parseJsonBody<{ instance: { key: string } }>(res.body).instance.key).toBe('brave-main');
  });

  it('creates a tenant-wide instance only for owners and admins', async () => {
    fn(createWebSearchInstance).mockResolvedValue({ ...INSTANCE, projectId: null });
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const payload = JSON.stringify({ key: 'k', name: 'N', providerKey: 'brave-conn', tenantWide: true });
    const ok = await app.inject({ method: 'POST', url: '/api/websearch/instances', headers: JSON_HEADERS, payload });
    expect(ok.statusCode).toBe(201);
    expect(fn(createWebSearchInstance).mock.calls[0]![2].projectId).toBeNull();

    signInAs('member');
    fn(createWebSearchInstance).mockClear();
    const denied = await app.inject({
      method: 'POST', url: '/api/websearch/instances', headers: { ...JSON_HEADERS, 'x-user-role': 'member' }, payload,
    });
    expect(denied.statusCode).toBe(403);
    expect(createWebSearchInstance).not.toHaveBeenCalled();
  });

  it('requires key, name and providerKey', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'POST', url: '/api/websearch/instances', headers: JSON_HEADERS, payload: JSON.stringify({ key: 'k' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    ['key exists', () => new WebSearchInstanceKeyExistsError('k'), 409],
    ['not found', () => new WebSearchInstanceNotFoundError('k'), 404],
    ['platform read-only', () => new PlatformRecordReadOnlyError(), 403],
    ['managed read-only', () => new ManagedProviderReadOnlyError(), 403],
    ['settings invalid', () => new ProviderSettingsError('settings', 'bad'), 400],
    ['cache invalid', () => new WebSearchCacheConfigError('bad cache'), 400],
  ])('maps %s on create to the expected status', async (_name, makeError, status) => {
    fn(createWebSearchInstance).mockRejectedValue(makeError());
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/websearch/instances',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ key: 'k', name: 'N', providerKey: 'brave-conn' }),
    });
    expect(res.statusCode).toBe(status);
  });

  it('gets one instance and 404s for an unknown one', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/websearch/instances/brave-main', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ instance: { provider: { key: string } } }>(res.body).instance.provider.key).toBe('brave-conn');

    fn(getWebSearchInstance).mockResolvedValue(null);
    const missing = await app.inject({ method: 'GET', url: '/api/websearch/instances/nope', headers: HEADERS });
    expect(missing.statusCode).toBe(404);
  });

  it('updates an instance and refuses a key change', async () => {
    fn(updateWebSearchInstance).mockResolvedValue({ ...INSTANCE, name: 'New' });
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/websearch/instances/brave-main',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: 'New', status: 'disabled', settings: { a: 1 } }),
    });
    expect(res.statusCode).toBe(200);
    expect(updateWebSearchInstance).toHaveBeenCalledWith(
      'tenant_acme', 'tenant-1', 'brave-main',
      expect.objectContaining({ name: 'New', status: 'disabled', settings: { a: 1 }, updatedBy: 'user-1' }),
    );
    const renamed = await app.inject({
      method: 'PATCH', url: '/api/websearch/instances/brave-main', headers: JSON_HEADERS,
      payload: JSON.stringify({ key: 'other' }),
    });
    expect(renamed.statusCode).toBe(400);
  });

  it('answers 403 when a platform instance is updated or deleted', async () => {
    fn(updateWebSearchInstance).mockRejectedValue(new PlatformRecordReadOnlyError());
    fn(deleteWebSearchInstance).mockRejectedValue(new PlatformRecordReadOnlyError());
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const patch = await app.inject({
      method: 'PATCH', url: '/api/websearch/instances/brave-main', headers: JSON_HEADERS,
      payload: JSON.stringify({ name: 'x' }),
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/websearch/instances/brave-main', headers: HEADERS });
    expect(patch.statusCode).toBe(403);
    expect(del.statusCode).toBe(403);
  });

  it('deletes an instance; unknown is 404; members are refused', async () => {
    fn(deleteWebSearchInstance).mockResolvedValue(true);
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'DELETE', url: '/api/websearch/instances/brave-main', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(deleteWebSearchInstance).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'brave-main');

    fn(getWebSearchInstance).mockResolvedValue(null);
    const missing = await app.inject({ method: 'DELETE', url: '/api/websearch/instances/nope', headers: HEADERS });
    expect(missing.statusCode).toBe(404);

    signInAs('member');
    const denied = await app.inject({
      method: 'DELETE', url: '/api/websearch/instances/brave-main', headers: { ...HEADERS, 'x-user-role': 'member' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('returns run logs by instance key', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({
      method: 'GET', url: '/api/websearch/instances/brave-main/logs?limit=5', headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(listWebSearchRunLogs).toHaveBeenCalledWith('tenant_acme', 'brave-main', { limit: 5, skip: 0 });

    fn(getWebSearchInstance).mockResolvedValue(null);
    const missing = await app.inject({ method: 'GET', url: '/api/websearch/instances/nope/logs', headers: HEADERS });
    expect(missing.statusCode).toBe(404);
  });
});

describe('compatible provider routes (dashboard)', () => {
  const LEGACY = { ...PROVIDER, key: 'tavily-old', driver: 'tavily', label: 'Tavily' };

  it('lists instances in the provider row shape plus providers without an instance, with no duplicate keys', async () => {
    // One instance keeps the key of its provider (a migrated row), one points at another provider.
    fn(listWebSearchInstances).mockResolvedValue([
      { ...INSTANCE, key: 'brave-conn' },
      { ...INSTANCE, key: 'brave-main' },
    ]);
    fn(listWebSearchProviders).mockResolvedValue([PROVIDER, LEGACY]);
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/websearch/providers', headers: HEADERS });
    const { providers } = parseJsonBody<{ providers: Array<Record<string, unknown>> }>(res.body);
    const keys = providers.map((p) => p.key);
    expect(keys).toEqual(['brave-conn', 'brave-main', 'tavily-old']);
    expect(new Set(keys).size).toBe(keys.length);
    expect(providers[1]).toMatchObject({
      kind: 'instance', label: 'Brave deep', driver: 'brave-search', status: 'active', type: 'websearch',
      providerKey: 'brave-conn', hasCredentials: true, platform: false,
    });
    expect(providers[2]).toMatchObject({ kind: 'provider', legacy: true });
    expect(providers[0]).not.toHaveProperty('legacy');
  });

  it('resolves /providers/:key to an instance first, then to the provider', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const first = await app.inject({ method: 'GET', url: '/api/websearch/providers/brave-main', headers: HEADERS });
    expect(parseJsonBody<Record<string, Record<string, unknown>>>(first.body)).toMatchObject({
      provider: { kind: 'instance' }, instance: { key: 'brave-main' },
    });

    fn(getWebSearchInstance).mockResolvedValue(null);
    const second = await app.inject({ method: 'GET', url: '/api/websearch/providers/brave-conn', headers: HEADERS });
    expect(parseJsonBody<{ provider: Record<string, unknown> }>(second.body).provider).toMatchObject({
      kind: 'provider', legacy: true,
    });
  });

  it('resolves /providers/:key/logs through an instance or a provider, else 404', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    fn(getProviderConfigByKey).mockResolvedValue(null);
    const viaInstance = await app.inject({
      method: 'GET', url: '/api/websearch/providers/brave-main/logs', headers: HEADERS,
    });
    expect(viaInstance.statusCode).toBe(200);

    fn(getWebSearchInstance).mockResolvedValue(null);
    const missing = await app.inject({
      method: 'GET', url: '/api/websearch/providers/brave-main/logs', headers: HEADERS,
    });
    expect(missing.statusCode).toBe(404);

    fn(getProviderConfigByKey).mockResolvedValue(PROVIDER);
    const viaProvider = await app.inject({
      method: 'GET', url: '/api/websearch/providers/brave-conn/logs', headers: HEADERS,
    });
    expect(viaProvider.statusCode).toBe(200);
  });

  it('searches with `instance`, with `provider` as an alias, and prefers `instance`', async () => {
    const app = await createFastifyApiTestApp(websearchApiPlugin);
    const post = (payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: '/api/websearch/search', headers: JSON_HEADERS, payload: JSON.stringify({ query: 'q', ...payload }),
    });
    await post({ instance: 'inst-a' });
    await post({ provider: 'prov-b' });
    await post({ instance: 'inst-a', provider: 'prov-b' });
    const keys = fn(runWebSearch).mock.calls.map((c) => c[3].providerKey);
    expect(keys).toEqual(['inst-a', 'prov-b', 'inst-a']);
  });
});

describe('client routes', () => {
  it('lists the same content on /instances and /providers', async () => {
    fn(listWebSearchProviders).mockResolvedValue([PROVIDER, { ...PROVIDER, key: 'old', label: 'Old' }]);
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const a = await app.inject({ method: 'GET', url: '/api/client/v1/websearch/instances', headers: CLIENT_HEADERS });
    const b = await app.inject({ method: 'GET', url: '/api/client/v1/websearch/providers', headers: CLIENT_HEADERS });
    const rows = parseJsonBody<{ instances: unknown[] }>(a.body).instances;
    expect(rows).toEqual(parseJsonBody<{ providers: unknown[] }>(b.body).providers);
    expect(rows).toEqual([
      { key: 'brave-main', driver: 'brave-search', label: 'Brave deep', status: 'active', aiAnswer: true, kind: 'instance', providerKey: 'brave-conn' },
      { key: 'brave-conn', driver: 'brave-search', label: 'Brave', status: 'active', aiAnswer: false, kind: 'provider' },
      { key: 'old', driver: 'brave-search', label: 'Old', status: 'active', aiAnswer: false, kind: 'provider' },
    ]);
  });

  it('searches with `instance`, `provider` and the :key route, handing the key to the resolver', async () => {
    const app = await createFastifyApiTestApp(clientWebSearchApiPlugin);
    const post = (url: string, payload: Record<string, unknown>) => app.inject({
      method: 'POST', url, headers: CLIENT_HEADERS, payload: JSON.stringify({ query: 'q', ...payload }),
    });
    await post('/api/client/v1/websearch/search', { instance: 'i1' });
    await post('/api/client/v1/websearch/search', { provider: 'p1' });
    await post('/api/client/v1/websearch/k1/search', { instance: 'i1' });
    const keys = fn(runWebSearch).mock.calls.map((c) => c[3].providerKey);
    expect(keys).toEqual(['i1', 'p1', 'k1']);
  });
});
