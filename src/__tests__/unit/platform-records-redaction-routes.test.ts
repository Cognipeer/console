/**
 * A platform-provided provider record keeps its identity and capability fields only on the model-provider, web search
 * and client model-provider endpoints; the form route of an internal driver answers 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/quota', () => ({ checkResourceQuota: vi.fn() }));
vi.mock('@/lib/services/models/modelService', () => ({
  listModels: vi.fn(),
  listModelProviders: vi.fn(),
  createModelProvider: vi.fn(),
  createModel: vi.fn(),
  createDynamicModel: vi.fn(),
  getModelById: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
}));
vi.mock('@/lib/services/webSearch', () => ({
  listWebSearchProviders: vi.fn(),
  listWebSearchRunLogs: vi.fn(),
  runWebSearch: vi.fn(),
}));
vi.mock('@/lib/services/providers/providerService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProviderConfigByKey: vi.fn(),
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
      user: { _id: 'user-1', role: 'owner', projectIds: ['proj-1'] },
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

import { providerRegistry, registerProvider } from '@/lib/providers';
import { listModelProviders } from '@/lib/services/models/modelService';
import { listWebSearchProviders } from '@/lib/services/webSearch';
import { getProviderConfigByKey } from '@/lib/services/providers/providerService';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import { clientModelsApiPlugin } from '@/server/api/plugins/client-models';
import { websearchApiPlugin } from '@/server/api/plugins/websearch';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const HEADERS = {
  'x-license-type': 'PROFESSIONAL',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'user-1',
  'x-user-email': 'a@b.com',
  'x-user-role': 'owner',
};

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'PROFESSIONAL' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
};

const INTERNAL = 'internal-route-driver';
registerProvider({
  id: INTERNAL,
  version: '1.0.0',
  domains: ['model', 'websearch'],
  display: { label: 'Internal' },
  form: { sections: [{ fields: [] }] },
  internal: true,
  createRuntime: () => ({}),
});

const platformRecord = (type: 'model' | 'websearch') => ({
  _id: 'prov-wide',
  tenantId: 'tenant-1',
  key: 'managed',
  type,
  driver: INTERNAL,
  label: 'Managed',
  description: 'operator note',
  status: 'active',
  platform: true,
  hasCredentials: true,
  credentialFields: ['apiKey'],
  settings: { baseUrl: 'https://upstream.invalid', route: 'route-a' },
  metadata: { platform: true, connection: 'conn-a' },
  driverCapabilities: { upstream: true },
  createdBy: 'operator',
});
const ownRecord = (type: 'model' | 'websearch') => ({
  _id: 'prov-own',
  tenantId: 'tenant-1',
  key: 'own',
  type,
  driver: 'openai',
  label: 'Own',
  status: 'active',
  hasCredentials: true,
  settings: { baseUrl: 'https://tenant.example' },
});

function expectRedacted(record: Record<string, unknown>) {
  expect(record.key).toBe('managed');
  expect(record.settings).toEqual({});
  expect(record.createdBy).toBe('');
  for (const hidden of ['description', 'metadata', 'credentialFields', 'driverCapabilities']) {
    expect(record).not.toHaveProperty(hidden);
  }
  expect(JSON.stringify(record)).not.toMatch(/upstream\.invalid|route-a|conn-a|operator/);
}

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(() => {
  vi.clearAllMocks();
  const db = createMockDb();
  db.findUserById.mockResolvedValue({ _id: 'user-1', email: 'a@b.com', role: 'owner', tenantId: 'tenant-1', servicePermissions: {} } as never);
  mockFn(getDatabase).mockResolvedValue(db);
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
});
afterEach(async () => {
  await app.close();
});

describe('GET /api/models/providers', () => {
  it('redacts a platform provider and leaves a tenant one whole', async () => {
    mockFn(listModelProviders).mockResolvedValue([platformRecord('model'), ownRecord('model')]);
    app = await createFastifyApiTestApp(modelsApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/models/providers', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const [wide, own] = parseJsonBody<{ providers: Array<Record<string, unknown>> }>(res.body).providers;
    expectRedacted(wide);
    expect(own.settings).toEqual({ baseUrl: 'https://tenant.example' });
  });
});

describe('GET /api/models/providers/drivers/:driverId/form', () => {
  it('answers 404 for an internal driver', async () => {
    app = await createFastifyApiTestApp(modelsApiPlugin);
    const res = await app.inject({ method: 'GET', url: `/api/models/providers/drivers/${INTERNAL}/form`, headers: HEADERS });
    expect(res.statusCode).toBe(404);
    expect(providerRegistry.isInternal(INTERNAL)).toBe(true);
  });
});

describe('GET /api/client/v1/models/providers', () => {
  it('redacts a platform provider', async () => {
    mockFn(listModelProviders).mockResolvedValue([platformRecord('model'), ownRecord('model')]);
    app = await createFastifyApiTestApp(clientModelsApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/models/providers', headers: { authorization: 'Bearer tok_abc' } });
    expect(res.statusCode).toBe(200);
    const [wide, own] = parseJsonBody<{ providers: Array<Record<string, unknown>> }>(res.body).providers;
    expectRedacted(wide);
    expect(own.settings).toEqual({ baseUrl: 'https://tenant.example' });
  });
});

describe('web search provider endpoints', () => {
  it('redacts a platform provider in the list', async () => {
    mockFn(listWebSearchProviders).mockResolvedValue([platformRecord('websearch'), ownRecord('websearch')]);
    app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/websearch/providers', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    const [wide, own] = parseJsonBody<{ providers: Array<Record<string, unknown>> }>(res.body).providers;
    expectRedacted(wide);
    expect(own.settings).toEqual({ baseUrl: 'https://tenant.example' });
  });

  it('redacts a platform provider fetched by key', async () => {
    mockFn(getProviderConfigByKey).mockResolvedValue(platformRecord('websearch'));
    app = await createFastifyApiTestApp(websearchApiPlugin);
    const res = await app.inject({ method: 'GET', url: '/api/websearch/providers/managed', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expectRedacted(parseJsonBody<{ provider: Record<string, unknown> }>(res.body).provider);
  });
});
