/**
 * The provider service runs the driver's own `validateSettings` check (when the contract has one) on create and on
 * update - on what the update will STORE (blank secrets keep the stored ones, settings replace the stored ones) - and
 * before the endpoint guard. A `ProviderSettingsError` reaches the caller unchanged and nothing is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const hoisted = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(),
    findProviderById: vi.fn(),
    findProviderByKey: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
  },
  endpointGuard: vi.fn(async () => undefined),
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => hoisted.db }));
vi.mock('@/lib/services/providers/providerEndpointGuard', () => ({ assertProviderEndpointsAllowed: hoisted.endpointGuard }));
// Readable stand-ins for the sealed blob: `enc:<json>`; anything else cannot be opened (a rotated key).
vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn((value: unknown) => `enc:${JSON.stringify(value)}`),
  decryptObject: vi.fn((blob: string) => {
    if (!blob.startsWith('enc:')) throw new Error('Unsupported state or unable to authenticate data');
    return JSON.parse(blob.slice(4));
  }),
}));

import { providerRegistry } from '@/lib/providers';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import { createProviderConfig, updateProviderConfig } from '@/lib/services/providers/providerService';

const validateSettings = vi.fn();
providerRegistry.register({
  id: 'test-validated-files',
  version: '1.0.0',
  domains: ['file'],
  display: { label: 'Test files (with a check)' },
  form: { sections: [] },
  createRuntime: () => ({}),
  validateSettings,
} as never);
providerRegistry.register({
  id: 'test-plain-files',
  version: '1.0.0',
  domains: ['file'],
  display: { label: 'Test files (no check)' },
  form: { sections: [] },
  createRuntime: () => ({}),
} as never);

const original = getConfigSource();
function deployment(mode: 'saas' | 'onprem') {
  setConfigSource({ get: (k: string) => (k === 'DEPLOYMENT_MODE' ? mode : process.env[k]) } as ConfigSource);
}

const sealed = (value: Record<string, unknown>) => `enc:${JSON.stringify(value)}`;
const STORED_CREDENTIALS = { accessKeyId: 'AKIA-STORED', secretAccessKey: 'stored-secret-value' };
const STORED_SETTINGS = { endpoint: 'https://minio.internal:9000', bucket: 'files', prefix: 'old/prefix' };

function storedRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prov-1',
    tenantId: 'tenant-1',
    key: 'minio-main',
    type: 'file',
    driver: 'test-validated-files',
    label: 'MinIO',
    status: 'active',
    credentialsEnc: sealed(STORED_CREDENTIALS),
    settings: { ...STORED_SETTINGS },
    ...overrides,
  };
}

const createInput = (overrides: Record<string, unknown> = {}) => ({
  key: 'minio-main',
  type: 'file' as const,
  driver: 'test-validated-files',
  label: 'MinIO',
  credentials: { accessKeyId: 'AKIA-NEW', secretAccessKey: 'new-secret-value' },
  settings: { endpoint: 'https://minio.internal:9000', bucket: 'files' },
  createdBy: 'user-1',
  ...overrides,
});

const refusal = () => new ProviderSettingsError('endpoint', 'Endpoint must start with http:// or https://.');

beforeEach(() => {
  vi.clearAllMocks();
  validateSettings.mockReset();
  validateSettings.mockResolvedValue(undefined);
  hoisted.db.findProviderByKey.mockReset().mockResolvedValue(null);
  hoisted.db.findProviderById.mockReset().mockResolvedValue(storedRecord());
  hoisted.db.createProvider.mockReset().mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'prov-1', ...input }));
  hoisted.db.updateProvider.mockReset().mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({ ...storedRecord(), ...updates }));
  deployment('saas');
});

afterEach(() => setConfigSource(original));

describe('createProviderConfig', () => {
  it('hands the driver the credentials and settings it is about to store, and whether this is a self-hosted install', async () => {
    const input = createInput();
    await createProviderConfig('tenant_acme', 'tenant-1', input);
    expect(validateSettings).toHaveBeenCalledTimes(1);
    expect(validateSettings).toHaveBeenCalledWith({
      credentials: input.credentials,
      settings: input.settings,
      isOnPrem: false,
      tenantId: 'tenant-1',
    });
    expect(hoisted.db.createProvider).toHaveBeenCalledTimes(1);

    deployment('onprem');
    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ key: 'minio-2' }));
    expect(validateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ isOnPrem: true }));
  });

  it('settings that were left out are an empty object', async () => {
    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ settings: undefined }));
    expect(validateSettings).toHaveBeenCalledWith(expect.objectContaining({ settings: {} }));
  });

  it('names the organization to the driver and to the endpoint guard, so the networks opened for it apply', async () => {
    const input = createInput();
    await createProviderConfig('tenant_acme', 'tenant-b', input);
    expect(validateSettings).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-b' }));
    expect(hoisted.endpointGuard).toHaveBeenCalledWith('file', { tenantId: 'tenant-b' }, input.credentials, input.settings);
  });

  it('checks before the endpoint guard (a better message wins) and refuses before anything is read or written', async () => {
    await createProviderConfig('tenant_acme', 'tenant-1', createInput());
    expect(validateSettings.mock.invocationCallOrder[0]).toBeLessThan(hoisted.endpointGuard.mock.invocationCallOrder[0]!);

    const error = refusal();
    validateSettings.mockRejectedValueOnce(error);
    hoisted.endpointGuard.mockClear();
    hoisted.db.findProviderByKey.mockClear();
    hoisted.db.createProvider.mockClear();
    vi.mocked(encryptObject).mockClear();
    await expect(createProviderConfig('tenant_acme', 'tenant-1', createInput({ key: 'minio-3' }))).rejects.toBe(error);
    expect(hoisted.endpointGuard).not.toHaveBeenCalled();
    expect(hoisted.db.findProviderByKey).not.toHaveBeenCalled();
    expect(hoisted.db.createProvider).not.toHaveBeenCalled();
    expect(encryptObject).not.toHaveBeenCalled();
  });

  it('a synchronous check is awaited like an asynchronous one', async () => {
    const error = refusal();
    validateSettings.mockImplementationOnce(() => { throw error; });
    await expect(createProviderConfig('tenant_acme', 'tenant-1', createInput())).rejects.toBe(error);
    expect(hoisted.db.createProvider).not.toHaveBeenCalled();
  });

  it('a driver without a check, and a driver nobody registered, are stored as before', async () => {
    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ driver: 'test-plain-files' }));
    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ driver: 'a-driver-nobody-registered', key: 'other' }));
    expect(validateSettings).not.toHaveBeenCalled();
    expect(hoisted.db.createProvider).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['one level up', '..'],
    ['the folder itself', '.'],
    ['nothing', ''],
    ['a path', 'team/a'],
    ['a path that goes up', '../tenant-2/disk'],
    ['a path with a backslash', 'a\\b'],
    ['a NUL', 'a\u0000b'],
    ['a newline', 'a\nb'],
  ])('refuses a key that is %s: the key is a folder name on the disk drivers', async (_label, key) => {
    const error = await createProviderConfig('tenant_acme', 'tenant-1', createInput({ key })).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderSettingsError);
    expect(error).toMatchObject({ field: 'key', code: 'provider_settings_invalid' });
    expect(error.message).toBe('The provider key is used as a folder name: it cannot be empty, "." or "..", and it cannot hold "/", "\\" or a control character.');
    // refused before the driver, the endpoint guard or the database is asked anything
    expect(validateSettings).not.toHaveBeenCalled();
    expect(hoisted.endpointGuard).not.toHaveBeenCalled();
    expect(hoisted.db.findProviderByKey).not.toHaveBeenCalled();
    expect(hoisted.db.createProvider).not.toHaveBeenCalled();
  });

  it('refuses a key that is not text', async () => {
    for (const key of [undefined, null, 7, {}, ['a']]) {
      await expect(createProviderConfig('tenant_acme', 'tenant-1', createInput({ key: key as never })), String(key)).rejects.toMatchObject({ field: 'key' });
    }
    expect(hoisted.db.createProvider).not.toHaveBeenCalled();
  });

  it.each(['minio-main', 'My Provider', 'a.b', '..hidden', '...', 'ünï', 'k:1', 'a_b-c', 'UPPER'])('takes %j as a key', async (key) => {
    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ key }));

    expect(hoisted.db.createProvider).toHaveBeenCalledWith(expect.objectContaining({ key }));
  });

  it('tells the driver whether the caller may name directories of this server - only when the route says so', async () => {
    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ key: 'a' }));
    expect(validateSettings).toHaveBeenLastCalledWith(expect.not.objectContaining({ allowHostPaths: expect.anything() }));

    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ key: 'b', allowHostPaths: false }));
    expect(validateSettings).toHaveBeenLastCalledWith(expect.not.objectContaining({ allowHostPaths: expect.anything() }));

    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ key: 'c', allowHostPaths: true }));
    expect(validateSettings).toHaveBeenLastCalledWith({
      credentials: expect.anything(),
      settings: expect.anything(),
      isOnPrem: false,
      tenantId: 'tenant-1',
      allowHostPaths: true,
    });
  });

  it('does not store what the caller was allowed to do', async () => {
    await createProviderConfig('tenant_acme', 'tenant-1', createInput({ allowHostPaths: true }));

    expect(hoisted.db.createProvider.mock.calls[0]![0]).not.toHaveProperty('allowHostPaths');
    expect(JSON.stringify(hoisted.db.createProvider.mock.calls[0]![0])).not.toContain('allowHostPaths');
  });
});

describe('updateProviderConfig', () => {
  it('checks the MERGED credentials: a blank secret keeps the stored one, a new value replaces it', async () => {
    await updateProviderConfig('tenant_acme', 'prov-1', {
      credentials: { accessKeyId: 'AKIA-ROTATED', secretAccessKey: '', sessionToken: undefined },
    });
    expect(validateSettings).toHaveBeenCalledTimes(1);
    expect(validateSettings).toHaveBeenCalledWith({
      credentials: { accessKeyId: 'AKIA-ROTATED', secretAccessKey: 'stored-secret-value' },
      settings: STORED_SETTINGS,
      isOnPrem: false,
      tenantId: 'tenant-1',
    });
    // ...and the set that is stored is the one that was checked
    expect(encryptObject).toHaveBeenCalledWith({ accessKeyId: 'AKIA-ROTATED', secretAccessKey: 'stored-secret-value' });
  });

  it('checks the settings as they will be stored: they replace the stored ones wholesale', async () => {
    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { endpoint: 'https://other.example.com', bucket: 'other' } });
    expect(validateSettings).toHaveBeenCalledWith({
      credentials: STORED_CREDENTIALS,
      settings: { endpoint: 'https://other.example.com', bucket: 'other' },
      isOnPrem: false,
      tenantId: 'tenant-1',
    });
    expect(hoisted.db.updateProvider.mock.calls[0]![1]).toMatchObject({ settings: { endpoint: 'https://other.example.com', bucket: 'other' } });
    // a settings-only edit does not touch the stored credentials
    expect(encryptObject).not.toHaveBeenCalled();
  });

  it('checks the merged credentials together with the new settings', async () => {
    await updateProviderConfig('tenant_acme', 'prov-1', {
      credentials: { secretAccessKey: 'brand-new-secret' },
      settings: { endpoint: 'minio.internal:9000' },
    }, { projectId: 'proj-1' });
    expect(validateSettings).toHaveBeenCalledWith({
      credentials: { accessKeyId: 'AKIA-STORED', secretAccessKey: 'brand-new-secret' },
      settings: { endpoint: 'minio.internal:9000' },
      isOnPrem: false,
      tenantId: 'tenant-1',
    });
  });

  it('an empty settings object is a replacement too (it is not "no settings")', async () => {
    await updateProviderConfig('tenant_acme', 'prov-1', { settings: {} });
    expect(validateSettings).toHaveBeenCalledWith(expect.objectContaining({ settings: {} }));
  });

  it('tells the driver whether this is a self-hosted install', async () => {
    deployment('onprem');
    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { endpoint: 'http://minio:9000' } });
    expect(validateSettings).toHaveBeenCalledWith(expect.objectContaining({ isOnPrem: true }));
  });

  it('tells the driver whether the caller may name directories of this server - only when the route says so - and does not store it', async () => {
    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { bucket: 'one' } });
    expect(validateSettings).toHaveBeenLastCalledWith(expect.not.objectContaining({ allowHostPaths: expect.anything() }));

    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { bucket: 'two' }, allowHostPaths: false });
    expect(validateSettings).toHaveBeenLastCalledWith(expect.not.objectContaining({ allowHostPaths: expect.anything() }));

    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { bucket: 'three' }, allowHostPaths: true });
    expect(validateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ allowHostPaths: true, settings: { bucket: 'three' } }));
    expect(JSON.stringify(hoisted.db.updateProvider.mock.calls.at(-1))).not.toContain('allowHostPaths');
  });

  it('takes the organization from the stored provider, for the driver and for the endpoint guard', async () => {
    hoisted.db.findProviderById.mockResolvedValue(storedRecord({ tenantId: 'tenant-b' }));
    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { endpoint: 'https://other.example.com', bucket: 'other' } });
    expect(validateSettings).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-b' }));
    expect(hoisted.endpointGuard).toHaveBeenCalledWith('file', { tenantId: 'tenant-b' }, undefined, { endpoint: 'https://other.example.com', bucket: 'other' });
  });

  it('a refusal reaches the caller unchanged, before the endpoint guard, and nothing is written or sealed', async () => {
    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { bucket: 'b' } });
    expect(validateSettings.mock.invocationCallOrder[0]).toBeLessThan(hoisted.endpointGuard.mock.invocationCallOrder[0]!);

    const error = refusal();
    validateSettings.mockRejectedValueOnce(error);
    hoisted.endpointGuard.mockClear();
    hoisted.db.updateProvider.mockClear();
    vi.mocked(encryptObject).mockClear();
    await expect(updateProviderConfig('tenant_acme', 'prov-1', {
      label: 'Renamed',
      credentials: { secretAccessKey: 'new-secret-value' },
      settings: { endpoint: 'ftp://nope' },
    })).rejects.toBe(error);
    expect(hoisted.endpointGuard).not.toHaveBeenCalled();
    expect(hoisted.db.updateProvider).not.toHaveBeenCalled();
    expect(encryptObject).not.toHaveBeenCalled();
  });

  it('an edit that does not touch the connection (label, status, assignment) is neither checked nor decrypted', async () => {
    await updateProviderConfig('tenant_acme', 'prov-1', { label: 'Renamed', description: 'd', status: 'disabled', metadata: { a: 1 } });
    await updateProviderConfig('tenant_acme', 'prov-1', { projectIds: ['p1'] });
    expect(validateSettings).not.toHaveBeenCalled();
    expect(decryptObject).not.toHaveBeenCalled();
    expect(hoisted.db.updateProvider).toHaveBeenCalledTimes(2);
  });

  it('a driver without a check does not even have its credentials opened for a settings-only edit', async () => {
    hoisted.db.findProviderById.mockResolvedValue(storedRecord({ driver: 'test-plain-files' }));
    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { endpoint: 'https://x.example.com' } });
    expect(validateSettings).not.toHaveBeenCalled();
    expect(decryptObject).not.toHaveBeenCalled();
    expect(hoisted.db.updateProvider).toHaveBeenCalledTimes(1);
  });

  it('stored credentials that cannot be opened do not block the edit that repairs them: only the supplied values are checked and stored', async () => {
    hoisted.db.findProviderById.mockResolvedValue(storedRecord({ credentialsEnc: 'sealed-with-another-key' }));
    await updateProviderConfig('tenant_acme', 'prov-1', { credentials: { accessKeyId: 'AKIA-NEW', secretAccessKey: 'new-secret-value', sessionToken: '' } });
    expect(validateSettings).toHaveBeenCalledWith({
      credentials: { accessKeyId: 'AKIA-NEW', secretAccessKey: 'new-secret-value' },
      settings: STORED_SETTINGS,
      isOnPrem: false,
      tenantId: 'tenant-1',
    });
    expect(encryptObject).toHaveBeenCalledWith({ accessKeyId: 'AKIA-NEW', secretAccessKey: 'new-secret-value' });
    expect(hoisted.db.updateProvider).toHaveBeenCalledTimes(1);
  });

  it('a settings-only edit of a record whose credentials cannot be opened is saved without the driver check', async () => {
    hoisted.db.findProviderById.mockResolvedValue(storedRecord({ credentialsEnc: 'sealed-with-another-key' }));
    await updateProviderConfig('tenant_acme', 'prov-1', { settings: { endpoint: 'https://other.example.com' } });
    expect(validateSettings).not.toHaveBeenCalled();
    expect(hoisted.db.updateProvider).toHaveBeenCalledTimes(1);
    expect(hoisted.db.updateProvider.mock.calls[0]![1]).toMatchObject({ settings: { endpoint: 'https://other.example.com' } });
  });

  it('a record that has no credentials yet is checked with the supplied ones', async () => {
    hoisted.db.findProviderById.mockResolvedValue(storedRecord({ credentialsEnc: '' }));
    await updateProviderConfig('tenant_acme', 'prov-1', { credentials: { accessKeyId: 'AKIA-NEW', secretAccessKey: 'new-secret-value' } });
    expect(validateSettings).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { accessKeyId: 'AKIA-NEW', secretAccessKey: 'new-secret-value' },
    }));
  });

  it('a provider that does not exist is not checked (the update answers null as before)', async () => {
    hoisted.db.findProviderById.mockResolvedValue(null);
    hoisted.db.updateProvider.mockResolvedValue(null);
    await expect(updateProviderConfig('tenant_acme', 'gone', { settings: { bucket: 'b' } })).resolves.toBeNull();
    expect(validateSettings).not.toHaveBeenCalled();
  });
});
