/**
 * What a "Test connection" of a SAVED provider runs against when the request carries the form's unsaved values:
 * the stored credentials with the non-blank typed ones laid over them, and the typed settings in place of the stored
 * ones - the same result an update with those values would store. Without credential overrides the stored set is
 * used as it is. Nothing is written, and nothing but the resolved values is returned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: {
    switchToTenant: vi.fn(),
    findProviderById: vi.fn(),
    findProviderByKey: vi.fn(),
    updateProvider: vi.fn(),
  },
}));

vi.mock('@/lib/database', () => ({ getDatabase: async () => hoisted.db }));
// Readable stand-ins for the sealed blob: `enc:<json>`; anything else cannot be opened (a rotated key).
vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn((value: unknown) => `enc:${JSON.stringify(value)}`),
  decryptObject: vi.fn((blob: string) => {
    if (!blob.startsWith('enc:')) throw new Error('Unsupported state or unable to authenticate data');
    return JSON.parse(blob.slice(4));
  }),
}));

import {
  hasProviderTestOverrides,
  ProviderCredentialDecryptError,
  resolveProviderTestTarget,
} from '@/lib/services/providers/providerService';

const STORED_CREDENTIALS = { accessKeyId: 'AKIA-STORED', secretAccessKey: 'stored-secret-value' };
const STORED_SETTINGS = { endpoint: 'https://minio.internal:9000', bucket: 'files', prefix: 'old/prefix' };

const storedRecord = (overrides: Record<string, unknown> = {}) => ({
  _id: 'prov-1',
  tenantId: 'tenant-1',
  key: 'minio-main',
  type: 'file',
  driver: 'some-files-driver',
  label: 'MinIO',
  status: 'active',
  credentialsEnc: `enc:${JSON.stringify(STORED_CREDENTIALS)}`,
  settings: { ...STORED_SETTINGS },
  ...overrides,
});

const resolve = (overrides: Parameters<typeof resolveProviderTestTarget>[2], tenantId = 'tenant-1') =>
  resolveProviderTestTarget('tenant_acme', { id: 'prov-1', tenantId }, overrides);

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.db.findProviderById.mockReset().mockResolvedValue(storedRecord());
});

describe('hasProviderTestOverrides', () => {
  it('is false for a plain re-test: nothing, empty objects, and credentials that are all blank', () => {
    expect(hasProviderTestOverrides({})).toBe(false);
    expect(hasProviderTestOverrides({ credentials: {} })).toBe(false);
    expect(hasProviderTestOverrides({ credentials: { secretAccessKey: '', accessKeyId: null, token: undefined } })).toBe(false);
  });

  it('is true as soon as a setting object is given, even an empty one (the form replaces the stored settings)', () => {
    expect(hasProviderTestOverrides({ settings: {} })).toBe(true);
    expect(hasProviderTestOverrides({ settings: STORED_SETTINGS })).toBe(true);
  });

  it('is true when any credential carries a value; false, 0 and whitespace are values, not blanks', () => {
    expect(hasProviderTestOverrides({ credentials: { secretAccessKey: 'x' } })).toBe(true);
    expect(hasProviderTestOverrides({ credentials: { secretAccessKey: '', other: 'x' } })).toBe(true);
    expect(hasProviderTestOverrides({ credentials: { flag: false } })).toBe(true);
    expect(hasProviderTestOverrides({ credentials: { count: 0 } })).toBe(true);
    // What the form sends is trimmed away already; the server does not second-guess a value that arrived.
    expect(hasProviderTestOverrides({ credentials: { secretAccessKey: '  ' } })).toBe(true);
  });
});

describe('resolveProviderTestTarget', () => {
  it('without credential overrides it uses the stored credentials as they are, and the typed settings', async () => {
    const target = await resolve({ credentials: { secretAccessKey: '' }, settings: { bucket: 'other' } });
    expect(target.credentials).toEqual(STORED_CREDENTIALS);
    expect(target.settings).toEqual({ bucket: 'other' });
    expect(target.record).toMatchObject({ _id: 'prov-1', key: 'minio-main' });
  });

  it('with neither it is the stored connection untouched', async () => {
    const target = await resolve({});
    expect(target.credentials).toEqual(STORED_CREDENTIALS);
    expect(target.settings).toEqual(STORED_SETTINGS);
  });

  it('a typed credential replaces that field only; blank ones keep the stored value', async () => {
    const target = await resolve({ credentials: { secretAccessKey: 'typed-secret', accessKeyId: '' } });
    expect(target.credentials).toEqual({ accessKeyId: 'AKIA-STORED', secretAccessKey: 'typed-secret' });
    // settings were not given: the stored ones stand
    expect(target.settings).toEqual(STORED_SETTINGS);
  });

  it('a credential the record does not hold yet is added', async () => {
    const target = await resolve({ credentials: { sessionToken: 'tok' } });
    expect(target.credentials).toEqual({ ...STORED_CREDENTIALS, sessionToken: 'tok' });
  });

  it('typed settings replace the stored ones wholesale, as an update does', async () => {
    const target = await resolve({ credentials: { secretAccessKey: 'typed-secret' }, settings: { bucket: 'other' } });
    expect(target.settings).toEqual({ bucket: 'other' });
    expect(target.settings).not.toHaveProperty('prefix');
    expect(target.settings).not.toHaveProperty('endpoint');
  });

  it('a record without settings tests with an empty object', async () => {
    hoisted.db.findProviderById.mockResolvedValue(storedRecord({ settings: undefined }));
    expect((await resolve({})).settings).toEqual({});
    expect((await resolve({ credentials: { secretAccessKey: 'typed-secret' } })).settings).toEqual({});
  });

  it('a record that stores no credentials gets only what was typed', async () => {
    hoisted.db.findProviderById.mockResolvedValue(storedRecord({ credentialsEnc: undefined }));
    const typed = await resolve({ credentials: { secretAccessKey: 'typed-secret' } });
    expect(typed.credentials).toEqual({ secretAccessKey: 'typed-secret' });
  });

  it('stored credentials that cannot be opened: typed ones are tried on their own, none is a decrypt error', async () => {
    hoisted.db.findProviderById.mockResolvedValue(storedRecord({ credentialsEnc: 'sealed-with-another-key' }));

    const typed = await resolve({ credentials: { accessKeyId: 'AKIA-TYPED', secretAccessKey: 'typed-secret' } });
    expect(typed.credentials).toEqual({ accessKeyId: 'AKIA-TYPED', secretAccessKey: 'typed-secret' });

    await expect(resolve({ settings: STORED_SETTINGS })).rejects.toBeInstanceOf(ProviderCredentialDecryptError);
    await expect(resolve({})).rejects.toBeInstanceOf(ProviderCredentialDecryptError);
  });

  it('a provider of another workspace, or one that does not exist, is not found - with and without credential overrides', async () => {
    for (const overrides of [{}, { settings: STORED_SETTINGS }, { credentials: { secretAccessKey: 'typed-secret' } }]) {
      await expect(resolve(overrides, 'someone-else')).rejects.toThrow(/not found/i);
    }
    hoisted.db.findProviderById.mockResolvedValue(null);
    for (const overrides of [{}, { credentials: { secretAccessKey: 'typed-secret' } }]) {
      await expect(resolve(overrides)).rejects.toThrow(/not found/i);
    }
  });

  it('writes nothing, and does not alter the stored record it read', async () => {
    const record = storedRecord();
    const snapshot = JSON.stringify(record);
    hoisted.db.findProviderById.mockResolvedValue(record);

    await resolve({ credentials: { secretAccessKey: 'typed-secret' }, settings: { bucket: 'other' } });
    await resolve({ settings: { bucket: 'other' } });

    expect(hoisted.db.updateProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(record)).toBe(snapshot);
  });
});
