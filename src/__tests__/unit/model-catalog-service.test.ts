/**
 * The provider model catalog service: the provider is looked up in the caller's tenant and project (anything else is
 * "not found"), a disabled provider is refused, credentials that cannot be opened are an error in the catalog rather
 * than a failure, the driver's categories bound the listing, and models the project already has are marked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const mocks = vi.hoisted(() => {
  class ProviderCredentialDecryptError extends Error {
    constructor(key: string) {
      super(`Stored credentials for provider "${key}" could not be decrypted. Check PROVIDER_ENCRYPTION_SECRET.`);
      this.name = 'ProviderCredentialDecryptError';
    }
  }
  return {
    getProviderConfigByKey: vi.fn(),
    loadProviderRuntimeData: vi.fn(),
    listModels: vi.fn(),
    ProviderCredentialDecryptError,
  };
});

vi.mock('@/lib/services/providers/providerService', () => ({
  getProviderConfigByKey: mocks.getProviderConfigByKey,
  loadProviderRuntimeData: mocks.loadProviderRuntimeData,
  ProviderCredentialDecryptError: mocks.ProviderCredentialDecryptError,
}));
vi.mock('@/lib/services/models/modelService', () => ({ listModels: mocks.listModels }));

import {
  getProviderCatalog,
  getProviderModelCatalog,
  ProviderCatalogDisabledError,
  ProviderCatalogNotFoundError,
  type DiscoveryDeps,
} from '@/lib/services/models/catalog';

const SECRET = 'sk-live-secret-1234';
const NOW = new Date('2026-11-05T12:00:00Z');
const PARAMS = { tenantDbName: 'tenant_acme', tenantId: 't1', projectId: 'p1', providerKey: 'together-main' };

const original = getConfigSource();
beforeEach(() => {
  setConfigSource({ get: (k: string) => ({ DEPLOYMENT_MODE: 'saas' } as Record<string, string>)[k] ?? process.env[k] } as ConfigSource);
  mocks.getProviderConfigByKey.mockReset();
  mocks.loadProviderRuntimeData.mockReset();
  mocks.listModels.mockReset();
  mocks.listModels.mockResolvedValue([]);
});
afterEach(() => setConfigSource(original));

const record = (overrides: Record<string, unknown> = {}) => ({
  _id: 'prov-1',
  tenantId: 't1',
  projectIds: ['p1'],
  key: 'together-main',
  type: 'model',
  driver: 'together',
  label: 'Together (main)',
  status: 'active',
  settings: {},
  credentialsEnc: 'sealed',
  createdBy: 'u1',
  ...overrides,
});

/** The store answers only for the provider's own tenant and project, as the project-scoped lookup does. */
function storeHolds(provider: ReturnType<typeof record>) {
  mocks.getProviderConfigByKey.mockImplementation(async (_db: string, tenantId: string, key: string, projectId?: string) => {
    if (tenantId !== provider.tenantId || key !== provider.key || !provider.projectIds.includes(projectId ?? '')) return null;
    // The view a lookup returns never carries the sealed credentials.
    const view: Record<string, unknown> = { ...provider, hasCredentials: true };
    delete view.credentialsEnc;
    return view;
  });
  mocks.loadProviderRuntimeData.mockResolvedValue({ record: provider, credentials: { apiKey: SECRET } });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function deps(body: unknown = []): DiscoveryDeps & { fetchImpl: ReturnType<typeof vi.fn> } {
  return {
    fetchImpl: vi.fn(async () => json(200, body)) as never,
    referenceEntries: async () => [],
    now: () => NOW,
  } as DiscoveryDeps & { fetchImpl: ReturnType<typeof vi.fn> };
}

describe('getProviderModelCatalog', () => {
  it('lists the provider of the project, bounded by its driver\'s categories, with the provider summary', async () => {
    storeHolds(record());
    const d = deps([
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat' },
      { id: 'Salesforce/Llama-Rank-V1', type: 'rerank' },
    ]);
    const catalog = await getProviderModelCatalog(PARAMS, d);

    expect(mocks.getProviderConfigByKey).toHaveBeenCalledWith('tenant_acme', 't1', 'together-main', 'p1');
    expect(mocks.loadProviderRuntimeData).toHaveBeenCalledWith('tenant_acme', { key: 'together-main', tenantId: 't1', projectId: 'p1' });
    expect(catalog.provider).toEqual({ key: 'together-main', label: 'Together (main)', driver: 'together', status: 'active' });
    expect(catalog).toMatchObject({ source: 'live', supported: true, fetchedAt: NOW.toISOString() });
    // Together serves chat and embedding models only.
    expect(catalog.models.map((m) => m.id)).toEqual(['meta-llama/Llama-3.3-70B-Instruct-Turbo']);
    expect(catalog.notices).toContainEqual({ code: 'excluded_unsupported', count: 1 });
    expect(JSON.stringify(catalog)).not.toContain(SECRET);
  });

  it('marks the ids the project already serves from this provider with the model keys', async () => {
    storeHolds(record());
    mocks.listModels.mockResolvedValue([
      { key: 'llama-prod', modelId: ' meta-llama/Llama-3.3-70B-Instruct-Turbo ', providerKey: 'together-main' },
      { key: 'llama-cheap', modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', providerKey: 'together-main' },
      { key: 'other-provider', modelId: 'BAAI/bge-large-en-v1.5', providerKey: 'another' },
    ]);
    const catalog = await getProviderModelCatalog(PARAMS, deps([
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat' },
      { id: 'BAAI/bge-large-en-v1.5', type: 'embedding' },
    ]));
    expect(mocks.listModels).toHaveBeenCalledWith('tenant_acme', 'p1', { providerKey: 'together-main' });
    const byId = Object.fromEntries(catalog.models.map((m) => [m.id, m]));
    expect(byId['meta-llama/Llama-3.3-70B-Instruct-Turbo'].registeredModelKeys).toEqual(['llama-prod', 'llama-cheap']);
    expect(byId['BAAI/bge-large-en-v1.5'].registeredModelKeys).toBeUndefined();
  });

  it('a failed read of the project models leaves the catalog unmarked', async () => {
    storeHolds(record());
    mocks.listModels.mockRejectedValue(new Error('db down'));
    const catalog = await getProviderModelCatalog(PARAMS, deps([{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat' }]));
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0].registeredModelKeys).toBeUndefined();
  });

  it('a provider that does not exist is not found', async () => {
    mocks.getProviderConfigByKey.mockResolvedValue(null);
    await expect(getProviderModelCatalog(PARAMS, deps())).rejects.toBeInstanceOf(ProviderCatalogNotFoundError);
    expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
  });

  it('a provider of another project is not found, and its credentials are never opened', async () => {
    storeHolds(record({ projectIds: ['p2'] }));
    await expect(getProviderModelCatalog(PARAMS, deps())).rejects.toBeInstanceOf(ProviderCatalogNotFoundError);
    expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
  });

  it('a provider of another tenant is not found', async () => {
    mocks.getProviderConfigByKey.mockResolvedValue({ ...record({ tenantId: 't2' }), hasCredentials: true });
    await expect(getProviderModelCatalog(PARAMS, deps())).rejects.toBeInstanceOf(ProviderCatalogNotFoundError);
  });

  it('a provider of a domain that cannot back a model is not found', async () => {
    storeHolds(record({ type: 'vector', driver: 'orama' }));
    await expect(getProviderModelCatalog(PARAMS, deps())).rejects.toBeInstanceOf(ProviderCatalogNotFoundError);
  });

  it('a disabled provider is refused before anything is opened or dialled', async () => {
    storeHolds(record({ status: 'disabled' }));
    const d = deps();
    const error = await getProviderModelCatalog(PARAMS, d).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderCatalogDisabledError);
    expect((error as ProviderCatalogDisabledError).code).toBe('provider_disabled');
    expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('an errored provider (a failed connection test) is still listed', async () => {
    storeHolds(record({ status: 'errored' }));
    const catalog = await getProviderModelCatalog(PARAMS, deps([{ id: 'x/y', type: 'chat' }]));
    expect(catalog.provider.status).toBe('errored');
    expect(catalog.models).toHaveLength(1);
  });

  it('credentials that cannot be opened are the catalog\'s error, not a failure, and name no configuration', async () => {
    storeHolds(record());
    mocks.loadProviderRuntimeData.mockRejectedValue(new mocks.ProviderCredentialDecryptError('together-main'));
    const d = deps();
    const catalog = await getProviderModelCatalog(PARAMS, d);
    expect(catalog.error?.code).toBe('credentials_unavailable');
    expect(catalog.error?.message).not.toContain('PROVIDER_ENCRYPTION_SECRET');
    expect(catalog.models).toEqual([]);
    expect(catalog.provider.key).toBe('together-main');
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('any other failure to load the provider is thrown', async () => {
    storeHolds(record());
    mocks.loadProviderRuntimeData.mockRejectedValue(new Error('db down'));
    await expect(getProviderModelCatalog(PARAMS, deps())).rejects.toThrow('db down');
  });

  it('an OCR-domain provider lists its driver\'s OCR models', async () => {
    storeHolds(record({ key: 'textract', type: 'ocr', driver: 'aws-textract', label: 'Textract' }));
    const catalog = await getProviderModelCatalog({ ...PARAMS, providerKey: 'textract' }, deps());
    expect(catalog).toMatchObject({ source: 'static', provider: { driver: 'aws-textract' } });
    expect(catalog.models.map((m) => [m.id, m.category])).toEqual([['analyze-document', 'ocr'], ['detect-document-text', 'ocr']]);
  });
});

describe('getProviderCatalog for a platform provider', () => {
  const platformRecord = (overrides: Record<string, unknown> = {}) => record({
    key: 'plat', platform: true, projectIds: ['p2'], settings: {}, ...overrides,
  });
  const lookupTenantWide = (provider: Record<string, unknown>) => {
    // Tenant-wide lookup (no project) finds it; the project-scoped one only when assigned.
    mocks.getProviderConfigByKey.mockImplementation(async (_db: string, _t: string, key: string, projectId?: string) => {
      if (key !== provider.key) return null;
      if (projectId && !(provider.projectIds as string[]).includes(projectId)) return null;
      return { ...provider, hasCredentials: true };
    });
  };
  const rows = [
    {
      key: 'pm-1', name: 'PM 1', category: 'llm', description: 'd', providerKey: 'plat', platform: true, projectIds: ['p2'],
      isMultimodal: true,
      metadata: {
        secretNote: 'must not be exposed',
        capabilities: { contextWindow: 128000, maxOutputTokens: 4096, supportsToolCalls: true, supportsReasoning: false, hidden: 1 },
        credits: { perCall: 1, perMillionTokens: 2, internal: 'x' },
      },
    },
    { key: 'pm-2', name: 'PM 2', category: 'embedding', providerKey: 'plat', platform: true, metadata: { inactive: true } },
    { key: 'other', name: 'O', category: 'llm', providerKey: 'plat', metadata: {} },
  ];

  it('answers from the platform model rows with no discovery and no credentials opened, assigned or not', async () => {
    lookupTenantWide(platformRecord());
    mocks.listModels.mockResolvedValue(rows);
    const fetchImpl = vi.fn();
    const notAssigned = await getProviderCatalog(
      { ...PARAMS, providerKey: 'plat', projectId: 'p1' }, { fetch: fetchImpl } as unknown as DiscoveryDeps,
    );
    expect(notAssigned).toEqual({
      platform: true,
      assigned: false,
      models: [
        {
          key: 'pm-1', name: 'PM 1', category: 'llm', description: 'd', unavailable: false, added: false, isMultimodal: true,
          capabilities: { contextWindow: 128000, maxOutputTokens: 4096, supportsToolCalls: true, supportsReasoning: false },
          credits: { perCall: 1, perMillionTokens: 2 },
        },
        { key: 'pm-2', name: 'PM 2', category: 'embedding', description: undefined, unavailable: true, added: false },
      ],
    });
    expect(JSON.stringify(notAssigned)).not.toContain('must not be exposed');
    const assigned = await getProviderCatalog({ ...PARAMS, providerKey: 'plat', projectId: 'p2' });
    expect(assigned).toMatchObject({ platform: true, assigned: true });
    // `added` follows the model's own project list, not the provider's assignment.
    expect((assigned as { models: Array<{ key: string; added: boolean }> }).models.map((m) => [m.key, m.added])).toEqual([
      ['pm-1', true],
      ['pm-2', false],
    ]);
    expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.listModels).toHaveBeenCalledWith('tenant_acme', '', { providerKey: 'plat' });
  });

  it('getProviderModelCatalog itself never opens a platform provider', async () => {
    lookupTenantWide(platformRecord({ projectIds: ['p1'] }));
    await expect(getProviderModelCatalog({ ...PARAMS, providerKey: 'plat' })).rejects.toBeInstanceOf(ProviderCatalogNotFoundError);
    expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
  });

  it('an ordinary provider still takes the discovery path', async () => {
    storeHolds(record());
    const out = await getProviderCatalog(PARAMS, { fetch: vi.fn(async () => json(200, { data: [] })) } as unknown as DiscoveryDeps);
    expect(out).not.toHaveProperty('platform');
    expect(mocks.loadProviderRuntimeData).toHaveBeenCalled();
  });
});
