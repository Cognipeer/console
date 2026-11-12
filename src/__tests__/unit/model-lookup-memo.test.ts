/**
 * Unit tests — the in-process memo in front of the shared cache in `getModelByKey`.
 *
 * An agent turn looks the same model up on every step. The memo answers the repeats from memory for 3 s, is dropped
 * where the shared entries are dropped (`invalidateModelMetaCache`), never keeps a miss, and stays inside its
 * tenant / project / key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  shared: new Map<string, unknown>(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  findModelByKey: vi.fn(),
  scope: vi.fn(),
}));

vi.mock('@/lib/core/cache', () => ({
  getCache: async () => ({ get: hoisted.cacheGet, set: hoisted.cacheSet, del: hoisted.cacheDel }),
}));
vi.mock('@/lib/database', () => ({
  getDatabase: async () => ({ switchToTenant: hoisted.scope, findModelByKey: hoisted.findModelByKey }),
  runWithTenantScope: async (tenant: string, fn: (db: unknown) => unknown) => {
    hoisted.scope(tenant);
    return fn({ findModelByKey: hoisted.findModelByKey });
  },
}));

import {
  clearModelMemoForTests,
  getModelByKey,
  invalidateModelMetaCache,
} from '@/lib/services/models/modelService';

const model = (over: Record<string, unknown> = {}) => ({ _id: 'm1', key: 'gpt', tenantId: 't1', ...over });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearModelMemoForTests();
  hoisted.shared.clear();
  hoisted.cacheGet.mockImplementation(async (key: string) => hoisted.shared.get(key));
  hoisted.cacheSet.mockImplementation(async (key: string, value: unknown) => { hoisted.shared.set(key, value); });
  hoisted.cacheDel.mockImplementation(async (key: string) => { hoisted.shared.delete(key); });
  hoisted.findModelByKey.mockReset().mockResolvedValue(model());
});
afterEach(() => vi.useRealTimers());

describe('getModelByKey memo', () => {
  it('answers a repeat lookup without the shared cache or the database', async () => {
    const first = await getModelByKey('tenant_db', 'gpt', 'p1');
    hoisted.cacheGet.mockClear();
    hoisted.findModelByKey.mockClear();

    const second = await getModelByKey('tenant_db', 'gpt', 'p1');

    expect(second).toBe(first);
    expect(hoisted.cacheGet).not.toHaveBeenCalled();
    expect(hoisted.findModelByKey).not.toHaveBeenCalled();
  });

  it('opens the tenant scope of the lookup on a miss', async () => {
    await getModelByKey('tenant_db', 'gpt', 'p1');
    expect(hoisted.scope).toHaveBeenCalledWith('tenant_db');
  });

  it('also remembers what the shared cache answered', async () => {
    hoisted.shared.set('model-meta:tenant_db:p1:gpt', model({ _id: 'from-shared' }));
    await getModelByKey('tenant_db', 'gpt', 'p1');
    hoisted.cacheGet.mockClear();

    expect(await getModelByKey('tenant_db', 'gpt', 'p1')).toMatchObject({ _id: 'from-shared' });
    expect(hoisted.cacheGet).not.toHaveBeenCalled();
    expect(hoisted.findModelByKey).not.toHaveBeenCalled();
  });

  it('goes back to the shared cache once the 3 s have passed', async () => {
    await getModelByKey('tenant_db', 'gpt', 'p1');
    hoisted.cacheGet.mockClear();

    vi.advanceTimersByTime(2_999);
    await getModelByKey('tenant_db', 'gpt', 'p1');
    expect(hoisted.cacheGet).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    await getModelByKey('tenant_db', 'gpt', 'p1');
    expect(hoisted.cacheGet).toHaveBeenCalledTimes(1);
  });

  it('is dropped where the shared entries are dropped, so an edit shows on the next lookup', async () => {
    await getModelByKey('tenant_db', 'gpt', 'p1');
    hoisted.findModelByKey.mockResolvedValue(model({ _id: 'edited' }));

    await invalidateModelMetaCache('tenant_db', 'p1', ['gpt']);

    expect(await getModelByKey('tenant_db', 'gpt', 'p1')).toMatchObject({ _id: 'edited' });
  });

  it('is dropped even when the shared cache is unreachable', async () => {
    await getModelByKey('tenant_db', 'gpt', 'p1');
    hoisted.cacheDel.mockRejectedValue(new Error('down'));
    hoisted.cacheGet.mockRejectedValue(new Error('down'));
    hoisted.findModelByKey.mockResolvedValue(model({ _id: 'edited' }));

    await invalidateModelMetaCache('tenant_db', 'p1', ['gpt']);

    expect(await getModelByKey('tenant_db', 'gpt', 'p1')).toMatchObject({ _id: 'edited' });
  });

  it('keeps tenants, projects and keys apart', async () => {
    await getModelByKey('tenant_db', 'gpt', 'p1');
    hoisted.findModelByKey.mockClear();

    await getModelByKey('tenant_db', 'gpt', 'p2');
    await getModelByKey('tenant_db', 'other', 'p1');
    await getModelByKey('tenant_other', 'gpt', 'p1');
    expect(hoisted.findModelByKey).toHaveBeenCalledTimes(3);

    // Dropping one entry leaves the others.
    await invalidateModelMetaCache('tenant_db', 'p2', ['gpt']);
    hoisted.findModelByKey.mockClear();
    await getModelByKey('tenant_db', 'gpt', 'p1');
    expect(hoisted.findModelByKey).not.toHaveBeenCalled();
  });

  it('does not remember a miss', async () => {
    hoisted.findModelByKey.mockResolvedValue(null);
    expect(await getModelByKey('tenant_db', 'gpt', 'p1')).toBeNull();

    hoisted.findModelByKey.mockResolvedValue(model());
    expect(await getModelByKey('tenant_db', 'gpt', 'p1')).toMatchObject({ _id: 'm1' });
  });
});
