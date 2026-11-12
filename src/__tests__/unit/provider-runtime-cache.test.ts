/**
 * Unit tests — the in-process copy of a provider's record and opened credentials.
 *
 * A model call (every step of an agent turn) loads the provider record and decrypts its credentials. The copy removes
 * both from the repeat calls, lives 10 seconds, holds at most 500 entries, never holds a managed record, and is dropped
 * by every provider write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(),
    findProviderById: vi.fn(),
    findProviderByKey: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    createProvider: vi.fn(),
  },
  decrypt: vi.fn(),
  resolveConnection: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: async () => hoisted.db,
  runWithTenantScope: async (_tenant: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn((value: unknown) => `enc:${JSON.stringify(value)}`),
  decryptObject: (blob: string) => hoisted.decrypt(blob),
}));
vi.mock('@/lib/services/providers/providerEndpointGuard', () => ({
  assertProviderEndpointsAllowed: vi.fn(async () => undefined),
}));

import {
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
} from '@/enterprise/managed-credits';
import {
  clearProviderRuntimeCacheForTests,
  deleteProviderConfig,
  loadProviderRuntimeData,
  recordProviderTest,
  updateProviderConfig,
} from '@/lib/services/providers/providerService';
import {
  PROVIDER_RUNTIME_MAX_ENTRIES,
  PROVIDER_RUNTIME_TTL_MS,
  invalidateProviderRuntimeCache,
  providerRuntimeCacheSize,
} from '@/lib/services/providers/providerRuntimeCache';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';

const record = (overrides: Record<string, unknown> = {}) => ({
  _id: 'prov-1',
  tenantId: TENANT_ID,
  key: 'main',
  type: 'model',
  driver: 'openai',
  label: 'Main',
  status: 'active',
  credentialsEnc: 'enc:{"apiKey":"sk-1"}',
  settings: {},
  ...overrides,
});

const load = (options: Record<string, unknown> = { reuse: true }, projectId: string | undefined = 'p1', key = 'main') =>
  loadProviderRuntimeData(TENANT_DB, { tenantId: TENANT_ID, key, projectId }, options);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearProviderRuntimeCacheForTests();
  hoisted.db.findProviderByKey.mockReset().mockResolvedValue(record());
  hoisted.db.findProviderById.mockReset().mockResolvedValue(record());
  hoisted.db.updateProvider.mockReset().mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
    ...record(),
    ...updates,
  }));
  hoisted.db.deleteProvider.mockReset().mockResolvedValue(true);
  hoisted.decrypt.mockReset().mockImplementation((blob: string) => JSON.parse(blob.slice(4)));
});
afterEach(() => {
  resetManagedCreditsHostForTests();
  vi.useRealTimers();
});

describe('loadProviderRuntimeData with reuse', () => {
  it('serves the second call without a database read or a decrypt, and hands out the same object', async () => {
    const first = await load();
    const second = await load();

    expect(second).toBe(first);
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(1);
    expect(hoisted.decrypt).toHaveBeenCalledTimes(1);
    expect(second.credentials).toEqual({ apiKey: 'sk-1' });
  });

  it('keeps entries apart by project, provider key and managed connection id', async () => {
    await load({ reuse: true }, 'p1');
    await load({ reuse: true }, 'p2');
    await load({ reuse: true }, 'p1', 'other');
    await load({ reuse: true, managedConnectionId: 'conn-1' }, 'p1');
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(4);
  });

  it('does not reuse anything unless the caller asks for it', async () => {
    await load({});
    await load({});
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(2);
    expect(hoisted.decrypt).toHaveBeenCalledTimes(2);
    expect(providerRuntimeCacheSize()).toBe(0);
  });

  it('does not reuse a lookup by id', async () => {
    await loadProviderRuntimeData(TENANT_DB, { tenantId: TENANT_ID, id: 'prov-1' }, { reuse: true });
    await loadProviderRuntimeData(TENANT_DB, { tenantId: TENANT_ID, id: 'prov-1' }, { reuse: true });
    expect(hoisted.db.findProviderById).toHaveBeenCalledTimes(2);
  });

  it('reads the database again once the 10 s have passed', async () => {
    await load();
    vi.advanceTimersByTime(PROVIDER_RUNTIME_TTL_MS - 1);
    await load();
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    await load();
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(2);
  });

  it('never keeps a managed record: its connection is resolved on every call', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(record({ settings: { managed: true } }));
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref.settings?.managed === true,
      reserve: vi.fn(),
      resolveConnection: hoisted.resolveConnection.mockReturnValue({
        driver: 'openai',
        settings: {},
        credentials: { apiKey: 'operator' },
      }),
    });

    const options = { reuse: true, allowManaged: true, managedConnectionId: 'conn-1' };
    await load(options);
    await load(options);

    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(2);
    expect(hoisted.resolveConnection).toHaveBeenCalledTimes(2);
    expect(providerRuntimeCacheSize()).toBe(0);
  });

  it('does not keep a failed lookup', async () => {
    hoisted.db.findProviderByKey.mockResolvedValue(null);
    await expect(load()).rejects.toThrow('not found');
    hoisted.db.findProviderByKey.mockResolvedValue(record());
    await expect(load()).resolves.toMatchObject({ credentials: { apiKey: 'sk-1' } });
  });

  it('holds at most 500 entries and evicts the oldest first', async () => {
    for (let i = 0; i < PROVIDER_RUNTIME_MAX_ENTRIES + 1; i += 1) {
      await load({ reuse: true }, `project-${i}`);
    }
    expect(providerRuntimeCacheSize()).toBe(PROVIDER_RUNTIME_MAX_ENTRIES);

    hoisted.db.findProviderByKey.mockClear();
    await load({ reuse: true }, 'project-0'); // the oldest: gone
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(1);
    await load({ reuse: true }, `project-${PROVIDER_RUNTIME_MAX_ENTRIES}`); // the newest: kept
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(1);
  });

  it('does not store what a load read before an edit landed', async () => {
    let release: (value: unknown) => void = () => undefined;
    hoisted.db.findProviderByKey.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const slow = load();
    await Promise.resolve();

    invalidateProviderRuntimeCache(TENANT_DB); // the edit
    release(record({ credentialsEnc: 'enc:{"apiKey":"old"}' }));
    await slow;

    hoisted.db.findProviderByKey.mockResolvedValue(record({ credentialsEnc: 'enc:{"apiKey":"new"}' }));
    expect((await load()).credentials).toEqual({ apiKey: 'new' });
  });
});

describe('every provider write drops the copy', () => {
  it('an edit is seen by the next call, within the TTL', async () => {
    expect((await load()).credentials).toEqual({ apiKey: 'sk-1' });

    hoisted.db.findProviderByKey.mockResolvedValue(record({ credentialsEnc: 'enc:{"apiKey":"sk-2"}' }));
    // Still inside the TTL and nothing was invalidated: the old copy.
    expect((await load()).credentials).toEqual({ apiKey: 'sk-1' });

    await updateProviderConfig(TENANT_DB, 'prov-1', { label: 'Renamed' });
    vi.advanceTimersByTime(1_000);
    expect((await load()).credentials).toEqual({ apiKey: 'sk-2' });
  });

  it('a status change (disable) reaches the next call', async () => {
    await load();
    hoisted.db.findProviderByKey.mockResolvedValue(record({ status: 'disabled' }));
    await updateProviderConfig(TENANT_DB, 'prov-1', { status: 'disabled' });
    expect((await load()).record.status).toBe('disabled');
  });

  it('an assignment change reaches the next call', async () => {
    await load();
    hoisted.db.findProviderByKey.mockResolvedValue(record({ projectIds: ['p9'] }));
    await updateProviderConfig(TENANT_DB, 'prov-1', { projectIds: ['p9'] });
    expect((await load()).record).toMatchObject({ projectIds: ['p9'] });
  });

  it('a delete reaches the next call', async () => {
    await load();
    await deleteProviderConfig(TENANT_DB, 'prov-1');
    hoisted.db.findProviderByKey.mockResolvedValue(null);
    await expect(load()).rejects.toThrow('not found');
  });

  it('a recorded connection test drops it too', async () => {
    await load();
    await recordProviderTest(TENANT_DB, 'prov-1', { status: 'ok' } as never);
    await load();
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(2);
  });

  it('only the edited tenant loses its entries', async () => {
    await load();
    await loadProviderRuntimeData('tenant_other', { tenantId: 't2', key: 'main', projectId: 'p1' }, { reuse: true });
    hoisted.db.findProviderByKey.mockClear();

    await updateProviderConfig(TENANT_DB, 'prov-1', { label: 'Renamed' });

    await loadProviderRuntimeData('tenant_other', { tenantId: 't2', key: 'main', projectId: 'p1' }, { reuse: true });
    expect(hoisted.db.findProviderByKey).not.toHaveBeenCalled();
    await load();
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(1);
  });

  it('a record healed from legacy plaintext credentials is read again, from the re-encrypted row', async () => {
    hoisted.decrypt.mockImplementationOnce(() => { throw new Error('Unsupported state or unable to authenticate data'); });
    hoisted.db.findProviderByKey.mockResolvedValue(record({ credentialsEnc: '{"apiKey":"plain"}' }));

    expect((await load()).credentials).toEqual({ apiKey: 'plain' });
    expect(hoisted.db.updateProvider).toHaveBeenCalledTimes(1);

    await load();
    expect(hoisted.db.findProviderByKey).toHaveBeenCalledTimes(2);
  });
});
