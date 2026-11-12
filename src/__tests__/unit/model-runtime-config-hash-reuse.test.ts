/**
 * Unit tests — `buildModelRuntime` asks for the in-process provider copy and hashes a copy's config once.
 *
 * `loadProviderRuntimeData` hands the same object to every call it serves from its copy; the runtime config hash (a
 * sorted JSON.stringify plus sha256) is then computed once for that object. A load built afresh (a managed call, or
 * a copy that was dropped by an edit) is hashed again, so an edit still rebuilds the pooled runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadProviderRuntimeData: vi.fn(),
  createRuntime: vi.fn(),
  hash: vi.fn(),
}));

vi.mock('@/lib/providers', () => ({ providerRegistry: { createRuntime: mocks.createRuntime } }));
vi.mock('@/lib/services/providers/providerService', () => ({
  assertProviderEnabled: vi.fn(),
  loadProviderRuntimeData: mocks.loadProviderRuntimeData,
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  assertServiceEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/core/runtimePool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/runtimePool')>();
  mocks.hash.mockImplementation(actual.hashRuntimeConfig);
  return { ...actual, hashRuntimeConfig: mocks.hash };
});

import { runtimePool } from '@/lib/core/runtimePool';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';

const TENANT_DB = 'tenant_hash_reuse';

const loadOf = (apiKey: string) => ({
  record: { key: 'main', type: 'model', status: 'active', driver: 'openai', settings: {}, metadata: {} },
  credentials: { apiKey },
});

beforeEach(() => {
  mocks.hash.mockClear();
  mocks.loadProviderRuntimeData.mockReset();
  mocks.createRuntime.mockReset().mockImplementation(async () => ({ close: vi.fn() }));
});
afterEach(() => runtimePool.invalidateByPrefix('model:'));

describe('buildModelRuntime', () => {
  it('asks for the in-process copy of the provider', async () => {
    mocks.loadProviderRuntimeData.mockResolvedValue(loadOf('sk-1'));
    await buildModelRuntime(TENANT_DB, 'tenant-1', 'main', 'p1');
    expect(mocks.loadProviderRuntimeData).toHaveBeenCalledWith(
      TENANT_DB,
      { tenantId: 'tenant-1', key: 'main', projectId: 'p1' },
      expect.objectContaining({ reuse: true }),
    );
  });

  it('hashes the config of a shared copy once, however many calls it serves', async () => {
    const shared = loadOf('sk-1');
    mocks.loadProviderRuntimeData.mockResolvedValue(shared);

    const first = await buildModelRuntime(TENANT_DB, 'tenant-1', 'main', 'p1');
    const second = await buildModelRuntime(TENANT_DB, 'tenant-1', 'main', 'p1');
    const third = await buildModelRuntime(TENANT_DB, 'tenant-1', 'main', 'p1');

    expect(mocks.hash).toHaveBeenCalledTimes(1);
    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    expect(second.runtime).toBe(first.runtime);
    expect(third.runtime).toBe(first.runtime);
  });

  it('hashes a load built afresh, so an edited credential still rebuilds the pooled runtime', async () => {
    mocks.loadProviderRuntimeData.mockResolvedValueOnce(loadOf('sk-1'));
    const before = await buildModelRuntime(TENANT_DB, 'tenant-1', 'main', 'p1');

    mocks.loadProviderRuntimeData.mockResolvedValueOnce(loadOf('sk-2'));
    const after = await buildModelRuntime(TENANT_DB, 'tenant-1', 'main', 'p1');

    expect(mocks.hash).toHaveBeenCalledTimes(2);
    expect(mocks.createRuntime).toHaveBeenCalledTimes(2);
    expect(after.runtime).not.toBe(before.runtime);
  });
});
