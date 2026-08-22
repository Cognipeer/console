/**
 * Unit tests — provider record cache
 *
 * The SDK client behind a provider was pooled, but the row describing it was
 * re-read on every call: one Knowledge Engine query (embedding → vector store →
 * reranker) spent three uncached reads before doing any work.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const cacheStore = new Map<string, unknown>();
const config = { providerRuntime: { cacheTtlSeconds: 300, recordCacheTtlSeconds: 60 } };

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/core/config', () => ({ getConfig: () => config }));
vi.mock('@/lib/core/cache', () => ({
  getCache: async () => ({
    get: async (key: string) => cacheStore.get(key),
    set: async (key: string, value: unknown) => { cacheStore.set(key, value); },
    del: async (key: string) => { cacheStore.delete(key); },
  }),
}));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/utils/crypto', () => ({
  decryptObject: (value: string) => JSON.parse(value),
  encryptObject: (value: unknown) => JSON.stringify(value),
}));

import { getDatabase } from '@/lib/database';
import type { IProviderRecord } from '@/lib/database';
import {
  invalidateProviderRecordCache,
  loadProviderRuntimeData,
} from '@/lib/services/providers/providerService';

const TENANT_DB = 'tenant_acme';
const LOOKUP = { tenantId: 'tenant-1', key: 'openai-main', projectId: 'proj-1' };

function providerRow(overrides: Record<string, unknown> = {}): IProviderRecord {
  return {
    _id: 'provider-1',
    tenantId: 'tenant-1',
    key: 'openai-main',
    driver: 'openai',
    type: 'model',
    projectIds: ['proj-1'],
    credentialsEnc: JSON.stringify({ apiKey: 'sk-live' }),
    settings: {},
    label: 'OpenAI (main)',
    status: 'active',
    createdBy: 'user-1',
    ...overrides,
  } as IProviderRecord;
}

describe('provider record cache', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    config.providerRuntime.recordCacheTtlSeconds = 60;
    db = createMockDb();
    db.findProviderByKey.mockResolvedValue(providerRow());
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('reads the row once across repeated calls', async () => {
    await loadProviderRuntimeData(TENANT_DB, LOOKUP);
    await loadProviderRuntimeData(TENANT_DB, LOOKUP);
    await loadProviderRuntimeData(TENANT_DB, LOOKUP);

    expect(db.findProviderByKey).toHaveBeenCalledTimes(1);
  });

  it('caches the sealed row, not the decrypted credentials', async () => {
    const { credentials } = await loadProviderRuntimeData<{ apiKey: string }>(TENANT_DB, LOOKUP);
    expect(credentials.apiKey).toBe('sk-live');

    // What lands in the cache is the row as stored: the sealed blob, and no
    // decrypted `credentials` field alongside it. Decryption stays per call.
    const cached = [...cacheStore.values()][0] as Record<string, unknown>;
    expect(cached).toHaveProperty('credentialsEnc');
    expect(cached).not.toHaveProperty('credentials');
  });

  it('keeps separate entries per project', async () => {
    await loadProviderRuntimeData(TENANT_DB, LOOKUP);
    await loadProviderRuntimeData(TENANT_DB, { ...LOOKUP, projectId: 'proj-2' });

    expect(db.findProviderByKey).toHaveBeenCalledTimes(2);
  });

  it('goes back to the database once the entry is invalidated', async () => {
    await loadProviderRuntimeData(TENANT_DB, LOOKUP);
    await invalidateProviderRecordCache(TENANT_DB, providerRow());
    await loadProviderRuntimeData(TENANT_DB, LOOKUP);

    expect(db.findProviderByKey).toHaveBeenCalledTimes(2);
  });

  it('invalidates every project the provider is assigned to', async () => {
    db.findProviderByKey.mockResolvedValue(providerRow({ projectIds: ['proj-1', 'proj-2'] }));
    await loadProviderRuntimeData(TENANT_DB, LOOKUP);
    await loadProviderRuntimeData(TENANT_DB, { ...LOOKUP, projectId: 'proj-2' });
    expect(db.findProviderByKey).toHaveBeenCalledTimes(2);

    await invalidateProviderRecordCache(
      TENANT_DB,
      providerRow({ projectIds: ['proj-1', 'proj-2'] }),
    );

    await loadProviderRuntimeData(TENANT_DB, LOOKUP);
    await loadProviderRuntimeData(TENANT_DB, { ...LOOKUP, projectId: 'proj-2' });
    expect(db.findProviderByKey).toHaveBeenCalledTimes(4);
  });

  it('reads through on every call when the cache is disabled', async () => {
    config.providerRuntime.recordCacheTtlSeconds = 0;

    await loadProviderRuntimeData(TENANT_DB, LOOKUP);
    await loadProviderRuntimeData(TENANT_DB, LOOKUP);

    expect(db.findProviderByKey).toHaveBeenCalledTimes(2);
  });
});
