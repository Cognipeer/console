/**
 * A driver whose contract is internal (operator-side) cannot be created by a tenant on any create path, cannot be set
 * by an update, and its form schema answers like an unknown driver. Unknown drivers keep their old behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(),
    findProviderById: vi.fn(),
    findProviderByKey: vi.fn(),
    updateProvider: vi.fn(),
    createProvider: vi.fn(),
  },
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => hoisted.db }));
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

import { providerRegistry, registerProvider } from '@/lib/providers';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { createProviderConfig, updateProviderConfig } from '@/lib/services/providers/providerService';
import { createModelProvider } from '@/lib/services/models/modelService';
import { sendProviderConfigError } from '@/server/api/providerConfigErrors';

const INTERNAL = 'internal-test-driver';

registerProvider({
  id: INTERNAL,
  version: '1.0.0',
  domains: ['model', 'websearch'],
  display: { label: 'Internal' },
  form: { sections: [] },
  internal: true,
  createRuntime: () => ({}),
});

const input = (overrides: Record<string, unknown> = {}) => ({
  key: 'k1',
  type: 'model' as const,
  driver: INTERNAL,
  label: 'L',
  credentials: {},
  createdBy: 'user-1',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.db.findProviderByKey.mockReset().mockResolvedValue(null);
  hoisted.db.createProvider.mockReset().mockImplementation(async (p: object) => ({ ...p, _id: 'new' }));
  hoisted.db.findProviderById.mockReset().mockResolvedValue({
    _id: 'prov-1', tenantId: 'tenant-1', key: 'own', type: 'model', driver: 'openai', label: 'Own',
    status: 'active', credentialsEnc: 'enc:{}', settings: {},
  });
  hoisted.db.updateProvider.mockReset().mockImplementation(async (_id: string, d: object) => ({ _id: 'prov-1', ...d }));
});

describe('internal drivers on the create paths', () => {
  it.each(['model', 'websearch', 'embedding'] as const)('createProviderConfig refuses an internal driver (%s)', async (type) => {
    const error = await createProviderConfig('db', 'tenant-1', input({ type })).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderSettingsError);
    expect(error.field).toBe('driver');
    expect(error.message).toBe('This provider type cannot be created.');
    expect(hoisted.db.createProvider).not.toHaveBeenCalled();
  });

  it('createModelProvider refuses it too', async () => {
    await expect(
      createModelProvider('db', 'tenant-1', 'p1', { key: 'k1', driver: INTERNAL, label: 'L', credentials: {}, createdBy: 'user-1' }),
    ).rejects.toBeInstanceOf(ProviderSettingsError);
    expect(hoisted.db.createProvider).not.toHaveBeenCalled();
  });

  it('answers 400 through the shared route mapping', async () => {
    const send = vi.fn();
    const reply = { code: vi.fn(() => ({ send })) };
    const error = await createProviderConfig('db', 'tenant-1', input()).catch((e) => e);
    expect(sendProviderConfigError(reply as never, error)).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: 'This provider type cannot be created.', field: 'driver' }));
  });

  it('keeps creating records for a public driver and for one the registry does not know', async () => {
    await expect(createProviderConfig('db', 'tenant-1', input({ driver: 'openai' }))).resolves.toBeTruthy();
    await expect(createProviderConfig('db', 'tenant-1', input({ key: 'k2', driver: 'unknown-driver-xyz' }))).resolves.toBeTruthy();
    expect(hoisted.db.createProvider).toHaveBeenCalledTimes(2);
  });
});

describe('internal drivers on the update path', () => {
  it('never takes a driver from an update payload', async () => {
    await updateProviderConfig('db', 'prov-1', { label: 'New', driver: INTERNAL } as never);
    const [, changes] = hoisted.db.updateProvider.mock.calls[0];
    expect(changes).not.toHaveProperty('driver');
  });
});

describe('internal drivers in the registry', () => {
  it('answers a form request like an unknown driver', () => {
    expect(providerRegistry.isInternal(INTERNAL)).toBe(true);
    expect(() => providerRegistry.getFormSchema(INTERNAL)).toThrow(/not found/);
    expect(() => providerRegistry.getFormSchema('unknown-driver-xyz')).toThrow(/not found/);
  });

  it('still serves the form of a public driver', () => {
    expect(providerRegistry.isInternal('openai')).toBe(false);
    expect(providerRegistry.getFormSchema('openai')).toBeTruthy();
  });
});
