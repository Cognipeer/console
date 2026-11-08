/**
 * Managed providers (credentials owned by the operator, calls paid with credits) fail closed everywhere but the
 * metered gateway: the credential-reading doors, provider CRUD/test, and the tenant-facing driver listings.
 * Without a registered host nothing is managed and nothing changes.
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
  createRuntime: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => hoisted.db }));
vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn((value: unknown) => `enc:${JSON.stringify(value)}`),
  decryptObject: vi.fn((blob: string) => JSON.parse(blob.slice(4))),
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: vi.fn() }));
vi.mock('@/lib/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...original,
    providerRegistry: Object.assign(Object.create(original.providerRegistry), {
      createRuntime: hoisted.createRuntime,
    }),
  };
});

import {
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedCreditsHost,
} from '@/enterprise/managed-credits';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import {
  createProviderConfig,
  deleteProviderConfig,
  loadProviderRuntimeData,
  resolveProviderTestTarget,
  updateProviderConfig,
} from '@/lib/services/providers/providerService';
import { ManagedProviderError, ManagedProviderReadOnlyError } from '@/lib/services/providers/managedProviderErrors';
import { testProviderConnection } from '@/lib/services/providers/providerConnectionTest';
import { sendProviderConfigError } from '@/server/api/providerConfigErrors';
import { providerRegistry } from '@/lib/providers';
import { resolveSdkProviderConfig, SdkProviderMappingError } from '@/lib/services/evaluation/sdkInvoker';

const record = (overrides: Record<string, unknown> = {}) => ({
  _id: 'prov-1',
  tenantId: 'tenant-1',
  key: 'managed-chat',
  type: 'model',
  driver: 'openai',
  label: 'Managed',
  status: 'active',
  credentialsEnc: `enc:${JSON.stringify({ apiKey: 'operator-secret' })}`,
  settings: { managed: true },
  ...overrides,
});

const host = (): ManagedCreditsHost => ({
  isManagedProvider: (ref) => ref.settings?.managed === true || ref.driver === 'managed-driver',
  reserve: vi.fn(),
  resolveCredentials: () => ({ apiKey: 'operator-secret' }),
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.db.findProviderById.mockReset().mockResolvedValue(record());
  hoisted.db.findProviderByKey.mockReset().mockResolvedValue(record());
  hoisted.createRuntime.mockReset().mockResolvedValue({ marker: 'runtime' });
});
afterEach(() => resetManagedCreditsHostForTests());

describe('buildModelRuntime', () => {
  it('refuses a managed record without allowManaged, before opening the credentials or creating a runtime', async () => {
    registerManagedCreditsHost(host());
    await expect(buildModelRuntime('db', 'tenant-1', 'managed-chat')).rejects.toMatchObject({
      message: 'This model can only be used through the model gateway.',
      status: 400,
    });
    await expect(buildModelRuntime('db', 'tenant-1', 'managed-chat', undefined, { allowManaged: false })).rejects.toThrow(
      'model gateway',
    );
    expect(hoisted.createRuntime).not.toHaveBeenCalled();
  });

  it('builds it for the metered gateway path (allowManaged: true) and returns the record', async () => {
    registerManagedCreditsHost(host());
    const built = await buildModelRuntime('db', 'tenant-1', 'managed-chat', undefined, { allowManaged: true });
    expect(built.record.key).toBe('managed-chat');
    expect(hoisted.createRuntime).toHaveBeenCalledTimes(1);
  });

  it('is unchanged without a host, and for a record the host does not call managed', async () => {
    await expect(buildModelRuntime('db', 'tenant-1', 'managed-chat')).resolves.toBeDefined();
    registerManagedCreditsHost(host());
    hoisted.db.findProviderByKey.mockResolvedValue(record({ key: 'own', settings: {} }));
    await expect(buildModelRuntime('db', 'tenant-1', 'own')).resolves.toBeDefined();
  });
});

describe('credential-reading doors (loadProviderRuntimeData)', () => {
  it('refuses a managed record by default, by key and by id, without decrypting', async () => {
    registerManagedCreditsHost(host());
    const { decryptObject } = await import('@/lib/utils/crypto');
    await expect(loadProviderRuntimeData('db', { key: 'managed-chat', tenantId: 'tenant-1' })).rejects.toBeInstanceOf(
      ManagedProviderError,
    );
    await expect(loadProviderRuntimeData('db', { id: 'prov-1', tenantId: 'tenant-1' })).rejects.toBeInstanceOf(
      ManagedProviderError,
    );
    expect(decryptObject).not.toHaveBeenCalled();
  });

  it('opens it only for an explicit allowManaged caller', async () => {
    registerManagedCreditsHost(host());
    const loaded = await loadProviderRuntimeData('db', { key: 'managed-chat', tenantId: 'tenant-1' }, { allowManaged: true });
    expect(loaded.credentials).toEqual({ apiKey: 'operator-secret' });
  });

  it('reads as before without a host', async () => {
    const loaded = await loadProviderRuntimeData('db', { key: 'managed-chat', tenantId: 'tenant-1' });
    expect(loaded.record.key).toBe('managed-chat');
  });

  it('evaluation SDK path falls back to the gateway for a managed record', async () => {
    registerManagedCreditsHost(host());
    const model = {
      tenantId: 'tenant-1',
      category: 'llm',
      providerKey: 'managed-chat',
      providerDriver: 'openai',
      modelId: 'm',
      key: 'k',
    } as never;
    await expect(resolveSdkProviderConfig('db', model)).rejects.toBeInstanceOf(SdkProviderMappingError);
  });
});

describe('provider CRUD and test', () => {
  it('refuses update, delete and a credential-override test of a managed record (403)', async () => {
    registerManagedCreditsHost(host());
    await expect(updateProviderConfig('db', 'prov-1', { label: 'x' })).rejects.toBeInstanceOf(ManagedProviderReadOnlyError);
    await expect(deleteProviderConfig('db', 'prov-1')).rejects.toBeInstanceOf(ManagedProviderReadOnlyError);
    await expect(
      resolveProviderTestTarget('db', { id: 'prov-1', tenantId: 'tenant-1' }, { credentials: { apiKey: 'typed' } }),
    ).rejects.toBeInstanceOf(ManagedProviderReadOnlyError);
    await expect(
      resolveProviderTestTarget('db', { id: 'prov-1', tenantId: 'tenant-1' }, {}),
    ).rejects.toBeInstanceOf(ManagedProviderError);
    expect(hoisted.db.updateProvider).not.toHaveBeenCalled();
    expect(hoisted.db.deleteProvider).not.toHaveBeenCalled();
  });

  it('refuses creating a provider with a managed driver, and testing a managed driver', async () => {
    registerManagedCreditsHost(host());
    await expect(
      createProviderConfig('db', 'tenant-1', {
        key: 'mine', type: 'model', driver: 'managed-driver', label: 'x', credentials: {},
      } as never),
    ).rejects.toBeInstanceOf(ManagedProviderReadOnlyError);
    await expect(
      testProviderConnection({ type: 'model', driver: 'managed-driver', credentials: {}, tenantId: 'tenant-1' }),
    ).rejects.toBeInstanceOf(ManagedProviderReadOnlyError);
    expect(hoisted.db.createProvider).not.toHaveBeenCalled();
  });

  it('deletes and updates as before without a host (one record read for the platform-record check)', async () => {
    hoisted.db.deleteProvider.mockResolvedValue(true);
    await expect(deleteProviderConfig('db', 'prov-1')).resolves.toBe(true);
    expect(hoisted.db.findProviderById).toHaveBeenCalledTimes(1);
  });

  it('maps the refusals: read-only is 403 { error }, restricted is 400', () => {
    const send = vi.fn();
    const reply = { code: vi.fn(() => ({ send })) } as never as { code: ReturnType<typeof vi.fn> };
    expect(sendProviderConfigError(reply as never, new ManagedProviderReadOnlyError())).toBe(true);
    expect(reply.code).toHaveBeenLastCalledWith(403);
    expect(send).toHaveBeenLastCalledWith({ error: 'Managed providers are read-only.' });
    expect(sendProviderConfigError(reply as never, new ManagedProviderError())).toBe(true);
    expect(reply.code).toHaveBeenLastCalledWith(400);
  });
});

describe('internal driver descriptors', () => {
  it('listTenantDescriptors hides internal drivers while listDescriptors keeps them', () => {
    const real = providerRegistry.listDescriptors('model');
    expect(real.length).toBeGreaterThan(0);
    const spy = vi.spyOn(providerRegistry, 'listDescriptors').mockReturnValue([
      ...real,
      { ...real[0], id: 'operator-side', internal: true },
    ]);
    expect(providerRegistry.listDescriptors('model').some((d) => d.id === 'operator-side')).toBe(true);
    expect(providerRegistry.listTenantDescriptors('model').some((d) => d.id === 'operator-side')).toBe(false);
    expect(providerRegistry.listTenantDescriptors('model')).toHaveLength(real.length);
    spy.mockRestore();
  });
});
