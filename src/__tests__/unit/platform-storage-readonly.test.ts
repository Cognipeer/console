/**
 * The read-only rules of platform records hold for the `file` and `vector` types too: no edit, delete or test, a
 * tenant-scope change of `projectIds` only, and the virtual driver cannot be created by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(),
    findProviderById: vi.fn(),
    findProviderByKey: vi.fn(),
    listProviders: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    createProvider: vi.fn(),
    listModels: vi.fn(),
  },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: async () => hoisted.db,
  runWithTenantScope: async (_tenant: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn((value: unknown) => `enc:${JSON.stringify(value)}`),
  decryptObject: vi.fn((blob: string) => JSON.parse(blob.slice(4))),
}));
vi.mock('@/lib/core/cache', () => ({ getCache: async () => ({ del: vi.fn(), get: vi.fn(), set: vi.fn() }) }));
vi.mock('@/lib/services/providers/providerEndpointGuard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProviderEndpointsAllowed: vi.fn(),
}));
vi.mock('@/lib/services/providers/providerSettingsValidation', () => ({
  settingsValidatorOf: vi.fn(),
  validateProviderSettings: vi.fn(),
}));

import { registerManagedCreditsHost, resetManagedCreditsHostForTests } from '@/enterprise/managed-credits';
import {
  createProviderConfig,
  deleteProviderConfig,
  recordProviderTest,
  resolveProviderTestTarget,
  updateProviderConfig,
} from '@/lib/services/providers/providerService';
import { ManagedProviderReadOnlyError, PlatformRecordReadOnlyError } from '@/lib/services/providers/managedProviderErrors';

const platformRecord = (type: 'file' | 'vector') => ({
  _id: `id-${type}`, tenantId: 'tenant-1', key: `platform-${type}`, type, driver: 'platform-virtual', label: 'Platform',
  status: 'active', credentialsEnc: 'enc:{}', settings: {}, platform: true, projectIds: ['p1'],
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.db.createProvider.mockReset().mockImplementation(async (p: object) => ({ ...p, _id: 'new' }));
  hoisted.db.findProviderByKey.mockReset().mockResolvedValue(null);
  hoisted.db.updateProvider.mockReset().mockImplementation(async (_id: string, data: object) => ({ ...platformRecord('file'), ...data }));
});
afterEach(() => resetManagedCreditsHostForTests());

describe.each(['file', 'vector'] as const)('a platform %s provider', (type) => {
  beforeEach(() => hoisted.db.findProviderById.mockResolvedValue(platformRecord(type)));

  it('cannot be edited, deleted or tested by a tenant', async () => {
    for (const payload of [
      { label: 'x' }, { status: 'disabled' as const }, { credentials: { a: 'b' } }, { settings: { basePath: '/x' } },
      { projectIds: ['p1'], label: 'x' },
    ]) {
      await expect(updateProviderConfig('db', `id-${type}`, payload)).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    }
    // Even an assignment change is refused without the tenant-scope allowance.
    await expect(updateProviderConfig('db', `id-${type}`, { projectIds: ['p2'] })).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(deleteProviderConfig('db', `id-${type}`)).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(resolveProviderTestTarget('db', { id: `id-${type}`, tenantId: 'tenant-1' }, {})).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(recordProviderTest('db', `id-${type}`, { ok: true } as never)).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    expect(hoisted.db.deleteProvider).not.toHaveBeenCalled();
  });

  it('lets a tenant admin change which projects use it, and nothing else', async () => {
    await expect(
      updateProviderConfig('db', `id-${type}`, { projectIds: ['p1', 'p2'], updatedBy: 'u1' }, { allowPlatformAssignment: true }),
    ).resolves.toBeTruthy();
    expect(hoisted.db.updateProvider).toHaveBeenCalledTimes(1);
    expect(Object.keys(hoisted.db.updateProvider.mock.calls[0][1] as object).sort()).toEqual(['projectIds', 'updatedBy']);
    await expect(
      updateProviderConfig('db', `id-${type}`, { projectIds: ['p1'], label: 'x' }, { allowPlatformAssignment: true }),
    ).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
    await expect(
      updateProviderConfig('db', `id-${type}`, { projectIds: ['p1'], settings: { basePath: '/x' } }, { allowPlatformAssignment: true }),
    ).rejects.toBeInstanceOf(PlatformRecordReadOnlyError);
  });
});

describe.each(['file', 'vector'] as const)('creating a %s provider by hand', (type) => {
  it('cannot take the platform flag from a payload', async () => {
    await createProviderConfig('db', 'tenant-1', {
      key: 'mine', driver: 'local-filesystem', label: 'Mine', type, credentials: {}, settings: {}, platform: true,
    } as never);
    expect(hoisted.db.createProvider.mock.calls[0][0].platform).not.toBe(true);
  });

  it('cannot use the key or driver the host calls managed (the virtual driver)', async () => {
    registerManagedCreditsHost({
      isManagedProvider: (ref) => ref.driver === 'platform-virtual' || ref.key === `platform-${type}`,
      reserve: vi.fn(),
    });
    await expect(createProviderConfig('db', 'tenant-1', {
      key: 'mine', driver: 'platform-virtual', label: 'Mine', type, credentials: {}, settings: {}, createdBy: 'u1',
    })).rejects.toBeInstanceOf(ManagedProviderReadOnlyError);
    await expect(createProviderConfig('db', 'tenant-1', {
      key: `platform-${type}`, driver: 'local-filesystem', label: 'Mine', type, credentials: {}, settings: {}, createdBy: 'u1',
    })).rejects.toBeInstanceOf(ManagedProviderReadOnlyError);
    expect(hoisted.db.createProvider).not.toHaveBeenCalled();
  });
});
