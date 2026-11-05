/**
 * GET /api/models/providers/:providerKey/catalog: the provider model catalog the "Add model" flow opens with.
 *
 * The discovery service is mocked; what is checked here is the route itself: the tenant and project scope it hands
 * the service, the status of each refusal, that an unexpected failure's message stays on the server, that it does
 * not shadow the model routes next to it, and that it needs models WRITE although it is a GET (it spends the
 * provider's stored credentials on an upstream call).
 */
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/services/models/catalog', () => {
  class ProviderCatalogNotFoundError extends Error {
    readonly providerKey: string;
    constructor(providerKey: string) {
      super(`Model provider "${providerKey}" is not available in this project.`);
      this.name = 'ProviderCatalogNotFoundError';
      this.providerKey = providerKey;
    }
  }
  class ProviderCatalogDisabledError extends Error {
    readonly code = 'provider_disabled';
    readonly providerKey: string;
    constructor(providerKey: string) {
      super(`Model provider "${providerKey}" is disabled.`);
      this.name = 'ProviderCatalogDisabledError';
      this.providerKey = providerKey;
    }
  }
  return { getProviderModelCatalog: vi.fn(), ProviderCatalogNotFoundError, ProviderCatalogDisabledError };
});

vi.mock('@/lib/services/models/modelService', () => ({
  getModelById: vi.fn(),
  listModelProviders: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return { resolveProjectContext: vi.fn(), ProjectContextError };
});

import {
  getProviderModelCatalog,
  ProviderCatalogDisabledError,
  ProviderCatalogNotFoundError,
  type ProviderModelCatalog,
} from '@/lib/services/models/catalog';
import { getModelById, listModelProviders } from '@/lib/services/models/modelService';
import { resolveProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import { createFastifyInstance } from '@/server/app';
import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockContext = {
  projectId: 'project-1',
  project: { _id: 'project-1', name: 'Default' },
  user: { _id: 'user-1', role: 'owner', projectIds: ['project-1'] },
};

const HEADERS = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

/** A member who may read the Model Hub but not change it. */
const READER_HEADERS = { ...HEADERS, 'x-user-id': 'user-reader', 'x-user-role': 'user' };
/** A member who may create models. */
const WRITER_HEADERS = { ...HEADERS, 'x-user-id': 'user-writer', 'x-user-role': 'user' };

const USERS: Record<string, unknown> = {
  'user-1': { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
  'user-reader': { _id: 'user-reader', role: 'user', tenantId: 'tenant-1', servicePermissions: { models: 'read' } },
  'user-writer': { _id: 'user-writer', role: 'user', tenantId: 'tenant-1', servicePermissions: { models: 'write' } },
};

const CATALOG: ProviderModelCatalog = {
  provider: { key: 'openai-1', label: 'OpenAI Main', driver: 'openai', status: 'active' },
  source: 'live',
  supported: true,
  models: [
    {
      id: 'gpt-4o-mini',
      name: 'gpt-4o-mini',
      category: 'llm',
      source: 'live',
      contextWindow: 128000,
      pricing: { currency: 'USD', inputTokenPer1M: 0.15, outputTokenPer1M: 0.6, source: 'reference', confidence: 'exact', catalogKey: 'gpt-4o-mini' },
      registeredModelKeys: ['gpt-4o-mini'],
    },
    { id: 'text-embedding-3-small', name: 'text-embedding-3-small', category: 'embedding', source: 'live' },
  ],
  fetchedAt: '2026-11-05T12:00:00.000Z',
  latencyMs: 412,
  notices: [{ code: 'excluded_unsupported', count: 3 }],
};

const catalogUrl = (key: string) => `/api/models/providers/${key}/catalog`;
const catalogMock = getProviderModelCatalog as ReturnType<typeof vi.fn>;

describe('GET /api/models/providers/:providerKey/catalog', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(mockContext);
    catalogMock.mockResolvedValue(CATALOG);
    // The route runs the real permission gate on a mock store: the caller is read from it per request.
    const rbacDb = createMockDb();
    rbacDb.findUserById.mockImplementation((async (id: string) => USERS[id] ?? null) as never);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(rbacDb);
    app = await createFastifyApiTestApp(modelsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the catalog as the service built it, scoped to the tenant and the active project', async () => {
    const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1'), headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<ProviderModelCatalog>(res.body)).toEqual(CATALOG);
    expect(catalogMock).toHaveBeenCalledTimes(1);
    expect(catalogMock).toHaveBeenCalledWith({
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      providerKey: 'openai-1',
    });
  });

  it('is never cached: the listing is live and per caller', async () => {
    const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1'), headers: HEADERS });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers a listing the provider refused with 200 and the reason in the catalog, so the dashboard can offer custom entry', async () => {
    const refused: ProviderModelCatalog = {
      ...CATALOG,
      models: [],
      notices: undefined,
      error: { code: 'auth_failed', message: 'The provider rejected the stored credentials (HTTP 401).', status: 401 },
    };
    catalogMock.mockResolvedValue(refused);

    const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1'), headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<ProviderModelCatalog>(res.body).error).toEqual(refused.error);
  });

  it('hands the service the decoded key the dashboard encoded', async () => {
    const res = await app.inject({
      method: 'GET',
      url: catalogUrl(encodeURIComponent('team a/openai')),
      headers: HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(catalogMock).toHaveBeenCalledWith(expect.objectContaining({ providerKey: 'team a/openai' }));
  });

  it('returns 404 for a provider that is not available in the project', async () => {
    const NotFound = ProviderCatalogNotFoundError as unknown as new (providerKey: string) => Error;
    catalogMock.mockRejectedValue(new NotFound('other-project-provider'));

    const res = await app.inject({ method: 'GET', url: catalogUrl('other-project-provider'), headers: HEADERS });

    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe(
      'Model provider "other-project-provider" is not available in this project.',
    );
  });

  it('returns 409 with the provider_disabled code for a disabled provider', async () => {
    const Disabled = ProviderCatalogDisabledError as unknown as new (providerKey: string) => Error;
    catalogMock.mockRejectedValue(new Disabled('openai-1'));

    const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1'), headers: HEADERS });

    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: string; code: string }>(res.body)).toEqual({
      error: 'Model provider "openai-1" is disabled.',
      code: 'provider_disabled',
    });
  });

  it('returns 401 without a session and never reaches the provider', async () => {
    const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1') });

    expect(res.statusCode).toBe(401);
    expect(catalogMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a control character', encodeURIComponent('openai\u0000-1')],
    ['a line break', encodeURIComponent('openai\n1')],
    ['only spaces', encodeURIComponent('   ')],
  ])('returns 400 for a key with %s and never reaches the provider', async (_label, key) => {
    const res = await app.inject({ method: 'GET', url: catalogUrl(key), headers: HEADERS });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Invalid provider key');
    expect(catalogMock).not.toHaveBeenCalled();
  });

  describe('key length, on the router the server builds', () => {
    // Fastify's default router refuses a parameter over 100 characters (414) before any handler runs; the server's
    // takes far longer ones (MAX_URL_PARAM_LENGTH), so there the route itself has to bound the key.
    let serverApp: FastifyInstance;

    beforeEach(async () => {
      serverApp = createFastifyInstance();
      await serverApp.register(cookie);
      serverApp.addHook('onRequest', async (request) => {
        request.apiRequestId = 'test-request';
        request.apiContextHeaders = { 'x-request-id': 'test-request', ...HEADERS };
      });
      await serverApp.register(modelsApiPlugin, { prefix: '/api' });
      await serverApp.ready();
    });

    afterEach(async () => {
      await serverApp.close();
    });

    it('returns 400 for a key over 200 characters and never reaches the provider', async () => {
      const res = await serverApp.inject({ method: 'GET', url: catalogUrl('k'.repeat(201)), headers: HEADERS });

      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Invalid provider key');
      expect(catalogMock).not.toHaveBeenCalled();
    });

    it('accepts a key of exactly 200 characters', async () => {
      const key = 'k'.repeat(200);
      const res = await serverApp.inject({ method: 'GET', url: catalogUrl(key), headers: HEADERS });

      expect(res.statusCode).toBe(200);
      expect(catalogMock).toHaveBeenCalledWith(expect.objectContaining({ providerKey: key }));
    });
  });

  it('passes a project context error through with its status', async () => {
    const ProjectError = ProjectContextError as unknown as new (message: string, status: number) => Error;
    (resolveProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(new ProjectError('No project', 400));

    const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1'), headers: HEADERS });

    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('No project');
    expect(catalogMock).not.toHaveBeenCalled();
  });

  it('answers an unexpected failure with 500 and keeps its message on the server', async () => {
    catalogMock.mockRejectedValue(new Error('connection to mongodb://db-internal:27017/tenant_acme refused'));

    const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1'), headers: HEADERS });

    expect(res.statusCode).toBe(500);
    expect(parseJsonBody<{ error: string }>(res.body)).toEqual({ error: 'Internal server error' });
    expect(res.body).not.toContain('db-internal');
  });

  describe('next to the other model routes', () => {
    it('does not take over GET /api/models/:id', async () => {
      (getModelById as ReturnType<typeof vi.fn>).mockResolvedValue({
        _id: 'model-1', key: 'gpt-4o-mini', modelId: 'gpt-4o-mini', category: 'llm', settings: {},
      });

      const res = await app.inject({ method: 'GET', url: '/api/models/model-1', headers: HEADERS });

      expect(res.statusCode).toBe(200);
      expect(getModelById).toHaveBeenCalledWith('tenant_acme', 'model-1', 'project-1');
      expect(catalogMock).not.toHaveBeenCalled();
    });

    it('does not take over GET /api/models/providers', async () => {
      (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/api/models/providers', headers: HEADERS });

      expect(res.statusCode).toBe(200);
      expect(listModelProviders).toHaveBeenCalledTimes(1);
      expect(catalogMock).not.toHaveBeenCalled();
    });

    it('still reaches the catalog of a provider whose key is "drivers" (a static segment of the driver routes)', async () => {
      const res = await app.inject({ method: 'GET', url: catalogUrl('drivers'), headers: HEADERS });

      expect(res.statusCode).toBe(200);
      expect(catalogMock).toHaveBeenCalledWith(expect.objectContaining({ providerKey: 'drivers' }));
    });
  });

  describe('permissions', () => {
    it('refuses a member with only read on models: listing spends the provider credentials', async () => {
      const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1'), headers: READER_HEADERS });

      expect(res.statusCode).toBe(403);
      expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ service: 'models', required: 'write' });
      expect(catalogMock).not.toHaveBeenCalled();
    });

    it('lets the same reader list the providers, so the refusal is the route\'s write level', async () => {
      (listModelProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/api/models/providers', headers: READER_HEADERS });

      expect(res.statusCode).toBe(200);
    });

    it('lets a member with write on models list the catalog', async () => {
      const res = await app.inject({ method: 'GET', url: catalogUrl('openai-1'), headers: WRITER_HEADERS });

      expect(res.statusCode).toBe(200);
      expect(catalogMock).toHaveBeenCalledTimes(1);
    });
  });
});
