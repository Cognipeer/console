/**
 * Unit tests — Web Search cache settings: shape validation, reference
 * validation against the project, and enforcement on the provider persist path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn().mockReturnValue('encrypted-blob'),
  decryptObject: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/services/vector/vectorService', () => ({ getVectorIndex: vi.fn() }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { getVectorIndex } from '@/lib/services/vector/vectorService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { createMockDb } from '../helpers/db.mock';
import {
  DEFAULT_CACHE_SIMILARITY_THRESHOLD,
  WebSearchCacheConfigError,
  normalizeWebSearchCacheSettings,
  normalizeWebSearchProviderSettings,
  resolveWebSearchCacheSettings,
} from '@/lib/services/webSearch/cacheSettings';
import { validateWebSearchProviderSettings } from '@/lib/services/webSearch/cacheValidation';
import { createProviderConfig, updateProviderConfig } from '@/lib/services/providers/providerService';

const VALID = {
  enabled: true,
  vectorProviderKey: 'vec',
  vectorIndexKey: 'idx',
  embeddingModelKey: 'embed',
  similarityThreshold: 0.9,
};

describe('normalizeWebSearchCacheSettings', () => {
  it('returns undefined when there are no cache settings', () => {
    expect(normalizeWebSearchCacheSettings(undefined)).toBeUndefined();
    expect(normalizeWebSearchCacheSettings(null)).toBeUndefined();
  });

  it('defaults the threshold to 0.8', () => {
    expect(DEFAULT_CACHE_SIMILARITY_THRESHOLD).toBe(0.8);
    const { similarityThreshold: _omit, ...rest } = VALID;
    void _omit;
    expect(normalizeWebSearchCacheSettings(rest)?.similarityThreshold).toBe(0.8);
  });

  it('trims keys and keeps valid values', () => {
    expect(normalizeWebSearchCacheSettings({ ...VALID, vectorProviderKey: ' vec ' })).toEqual(VALID);
  });

  it.each([0, 0.5, 1])('accepts threshold %s', (value) => {
    expect(normalizeWebSearchCacheSettings({ ...VALID, similarityThreshold: value })?.similarityThreshold).toBe(value);
  });

  it.each([-0.01, 1.01, Number.NaN, Infinity, '0.8', true])('rejects threshold %s', (value) => {
    expect(() => normalizeWebSearchCacheSettings({ ...VALID, similarityThreshold: value }))
      .toThrow(WebSearchCacheConfigError);
  });

  it.each(['vectorProviderKey', 'vectorIndexKey', 'embeddingModelKey'])('requires %s when enabled', (field) => {
    expect(() => normalizeWebSearchCacheSettings({ ...VALID, [field]: '' })).toThrow(WebSearchCacheConfigError);
    expect(() => normalizeWebSearchCacheSettings({ ...VALID, [field]: undefined })).toThrow(WebSearchCacheConfigError);
  });

  it('keeps selections while disabled without requiring them', () => {
    expect(normalizeWebSearchCacheSettings({ enabled: false })).toMatchObject({ enabled: false, similarityThreshold: 0.8 });
    expect(normalizeWebSearchCacheSettings({ ...VALID, enabled: false })).toEqual({ ...VALID, enabled: false });
  });

  it('still rejects a bad threshold while disabled', () => {
    expect(() => normalizeWebSearchCacheSettings({ enabled: false, similarityThreshold: 2 }))
      .toThrow(WebSearchCacheConfigError);
  });

  it.each(['yes', 1, [], { enabled: 'true' }])('rejects malformed cache value %j', (value) => {
    expect(() => normalizeWebSearchCacheSettings(value)).toThrow(WebSearchCacheConfigError);
  });
});

describe('normalizeWebSearchProviderSettings / resolveWebSearchCacheSettings', () => {
  it('leaves settings without cache untouched', () => {
    const settings = { country: 'US' };
    expect(normalizeWebSearchProviderSettings(settings)).toBe(settings);
    expect(normalizeWebSearchProviderSettings(undefined)).toBeUndefined();
  });

  it('persists the normalised cache alongside other settings', () => {
    const { similarityThreshold: _omit, ...rest } = VALID;
    void _omit;
    expect(normalizeWebSearchProviderSettings({ country: 'US', cache: rest })).toEqual({
      country: 'US',
      cache: { ...rest, similarityThreshold: 0.8 },
    });
  });

  it('resolves to null when caching is off or absent', () => {
    expect(resolveWebSearchCacheSettings(undefined)).toBeNull();
    expect(resolveWebSearchCacheSettings({})).toBeNull();
    expect(resolveWebSearchCacheSettings({ cache: { ...VALID, enabled: false } })).toBeNull();
  });

  it('resolves enabled settings and throws for an invalid enabled config', () => {
    expect(resolveWebSearchCacheSettings({ cache: VALID })).toEqual(VALID);
    expect(() => resolveWebSearchCacheSettings({ cache: { ...VALID, vectorIndexKey: '' } }))
      .toThrow(WebSearchCacheConfigError);
  });
});

describe('validateWebSearchProviderSettings (references)', () => {
  const params = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVectorIndex).mockResolvedValue({
      index: {},
      provider: { type: 'vector', status: 'active', driver: 'sqlite-vector' },
    } as never);
    vi.mocked(getModelByKey).mockResolvedValue({ category: 'embedding' } as never);
  });

  it('accepts valid references, resolving them in the calling project', async () => {
    const result = await validateWebSearchProviderSettings({ ...params, settings: { cache: VALID } });
    expect(result).toEqual({ cache: VALID });
    expect(getVectorIndex).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'vec', 'idx');
    expect(getModelByKey).toHaveBeenCalledWith('tenant_acme', 'embed', 'proj-1');
  });

  it('does not touch references when the cache is disabled or there is no project', async () => {
    await validateWebSearchProviderSettings({ ...params, settings: { cache: { ...VALID, enabled: false } } });
    await validateWebSearchProviderSettings({ ...params, projectId: undefined, settings: { cache: VALID } });
    expect(getVectorIndex).not.toHaveBeenCalled();
    expect(getModelByKey).not.toHaveBeenCalled();
  });

  it('rejects an unknown vector provider / index', async () => {
    vi.mocked(getVectorIndex).mockRejectedValue(new Error('Vector index record not found.'));
    await expect(validateWebSearchProviderSettings({ ...params, settings: { cache: VALID } }))
      .rejects.toThrow(/vector provider or index was not found/);
  });

  it('rejects a provider that is not an active vector provider', async () => {
    vi.mocked(getVectorIndex).mockResolvedValue({
      index: {},
      provider: { type: 'vector', status: 'disabled', driver: 'sqlite-vector' },
    } as never);
    await expect(validateWebSearchProviderSettings({ ...params, settings: { cache: VALID } }))
      .rejects.toThrow(/not an active vector provider/);
  });

  it('rejects a vector driver that cannot filter on metadata', async () => {
    vi.mocked(getVectorIndex).mockResolvedValue({
      index: {},
      provider: { type: 'vector', status: 'active', driver: 'orama' },
    } as never);
    await expect(validateWebSearchProviderSettings({ ...params, settings: { cache: VALID } }))
      .rejects.toThrow(/cannot filter by metadata/);
  });

  it('rejects an unknown or non-embedding model', async () => {
    vi.mocked(getModelByKey).mockResolvedValueOnce(null);
    await expect(validateWebSearchProviderSettings({ ...params, settings: { cache: VALID } }))
      .rejects.toThrow(/embedding model was not found/);
    vi.mocked(getModelByKey).mockResolvedValueOnce({ category: 'llm' } as never);
    await expect(validateWebSearchProviderSettings({ ...params, settings: { cache: VALID } }))
      .rejects.toThrow(/not an embedding model/);
  });
});

describe('provider persistence enforces cache settings', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    vi.mocked(getVectorIndex).mockResolvedValue({
      index: {},
      provider: { type: 'vector', status: 'active', driver: 'sqlite-vector' },
    } as never);
    vi.mocked(getModelByKey).mockResolvedValue({ category: 'embedding' } as never);
  });

  const createPayload = (settings: Record<string, unknown>, type = 'websearch') => ({
    key: 'ws',
    type: type as 'websearch',
    driver: 'brave-search',
    label: 'Brave',
    credentials: { apiKey: 'k' },
    settings,
    createdBy: 'user-1',
    projectId: 'proj-1',
  });

  it('create: rejects an invalid cache and never writes', async () => {
    await expect(createProviderConfig('tenant_acme', 'tenant-1', createPayload({ cache: { ...VALID, similarityThreshold: 2 } })))
      .rejects.toThrow(WebSearchCacheConfigError);
    expect(db.createProvider).not.toHaveBeenCalled();
  });

  it('create: persists the normalised cache settings (default threshold)', async () => {
    db.findProviderByKey.mockResolvedValue(null);
    db.createProvider.mockResolvedValue({ _id: 'p1', tenantId: 'tenant-1', type: 'websearch' } as never);
    const { similarityThreshold: _omit, ...rest } = VALID;
    void _omit;

    await createProviderConfig('tenant_acme', 'tenant-1', createPayload({ cache: rest }));

    expect(db.createProvider.mock.calls[0][0].settings).toEqual({ cache: { ...rest, similarityThreshold: 0.8 } });
  });

  it('create: does not validate cache for other provider types', async () => {
    db.findProviderByKey.mockResolvedValue(null);
    db.createProvider.mockResolvedValue({ _id: 'p1', tenantId: 'tenant-1', type: 'model' } as never);
    await createProviderConfig('tenant_acme', 'tenant-1', createPayload({ cache: 'anything' }, 'model'));
    expect(db.createProvider.mock.calls[0][0].settings).toEqual({ cache: 'anything' });
  });

  it('update: rejects an invalid cache and never writes', async () => {
    db.findProviderById.mockResolvedValue({ _id: 'p1', tenantId: 'tenant-1', type: 'websearch' } as never);
    await expect(updateProviderConfig('tenant_acme', 'p1', { settings: { cache: { enabled: true } } }, { projectId: 'proj-1' }))
      .rejects.toThrow(WebSearchCacheConfigError);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });

  it('update: validates references in the calling project and stores normalised settings', async () => {
    db.findProviderById.mockResolvedValue({ _id: 'p1', tenantId: 'tenant-1', type: 'websearch' } as never);
    db.updateProvider.mockResolvedValue({ _id: 'p1', tenantId: 'tenant-1', type: 'websearch' } as never);

    await updateProviderConfig('tenant_acme', 'p1', { settings: { cache: VALID } }, { projectId: 'proj-1' });

    expect(getVectorIndex).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'vec', 'idx');
    expect(db.updateProvider).toHaveBeenCalledWith('p1', { settings: { cache: VALID } });
  });

  it('update: rejects a model that is not an embedding model', async () => {
    db.findProviderById.mockResolvedValue({ _id: 'p1', tenantId: 'tenant-1', type: 'websearch' } as never);
    vi.mocked(getModelByKey).mockResolvedValue({ category: 'llm' } as never);
    await expect(updateProviderConfig('tenant_acme', 'p1', { settings: { cache: VALID } }, { projectId: 'proj-1' }))
      .rejects.toThrow(/not an embedding model/);
    expect(db.updateProvider).not.toHaveBeenCalled();
  });
});
