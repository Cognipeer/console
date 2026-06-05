/**
 * Unit tests — ProviderService
 * Tests: createProviderConfig, updateProviderConfig, listProviderConfigs,
 *        getProviderConfigByKey, getProviderConfigById, deleteProviderConfig,
 *        loadProviderRuntimeData
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/utils/crypto', () => ({
  encryptObject: vi.fn().mockReturnValue('encrypted-blob'),
  decryptObject: vi.fn().mockReturnValue({ apiKey: 'secret-key-123' }),
}));

import { getDatabase } from '@/lib/database';
import { encryptObject, decryptObject } from '@/lib/utils/crypto';
import { createMockDb } from '../helpers/db.mock';
import {
  createProviderConfig,
  updateProviderConfig,
  listProviderConfigs,
  getProviderConfigByKey,
  getProviderConfigById,
  deleteProviderConfig,
  loadProviderRuntimeData,
} from '@/lib/services/providers/providerService';
import type { IProviderRecord } from '@/lib/database/provider.interface';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

function makeProviderRecord(overrides: Partial<IProviderRecord> = {}): IProviderRecord {
  return {
    _id: 'prov-1',
    tenantId: TENANT_ID,
    key: 'openai-main',
    type: 'model',
    driver: 'openai',
    label: 'OpenAI Main',
    status: 'active',
    credentialsEnc: 'encrypted-blob',
    settings: {},
    createdBy: USER_ID,
    ...overrides,
  };
}

// ── createProviderConfig ──────────────────────────────────────────────────────

describe('createProviderConfig', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('creates provider config and returns sanitized view', async () => {
    db.findProviderByKey.mockResolvedValue(null);
    db.createProvider.mockResolvedValue(makeProviderRecord());

    const result = await createProviderConfig(TENANT_DB, TENANT_ID, {
      key: 'openai-main',
      type: 'model',
      driver: 'openai',
      label: 'OpenAI Main',
      credentials: { apiKey: 'secret-key' },
      createdBy: USER_ID,
    });

    expect(db.createProvider).toHaveBeenCalledTimes(1);
    expect(result.key).toBe('openai-main');
    expect(result.hasCredentials).toBe(true);
    expect((result as unknown as Record<string, unknown>)['credentialsEnc']).toBeUndefined();
  });

  it('encrypts credentials before storing', async () => {
    db.findProviderByKey.mockResolvedValue(null);
    db.createProvider.mockResolvedValue(makeProviderRecord());

    await createProviderConfig(TENANT_DB, TENANT_ID, {
      key: 'openai-main',
      type: 'model',
      driver: 'openai',
      label: 'OpenAI',
      credentials: { apiKey: 'my-key' },
      createdBy: USER_ID,
    });

    expect(encryptObject).toHaveBeenCalledWith({ apiKey: 'my-key' });
    const call = db.createProvider.mock.calls[0][0];
    expect(call.credentialsEnc).toBe('encrypted-blob');
  });

  it('throws when provider key already exists', async () => {
    db.findProviderByKey.mockResolvedValue(makeProviderRecord());

    await expect(
      createProviderConfig(TENANT_DB, TENANT_ID, {
        key: 'openai-main',
        type: 'model',
        driver: 'openai',
        label: 'OpenAI',
        credentials: {},
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('Provider with key "openai-main" already exists.');
  });

  it('defaults status to active when not provided', async () => {
    db.findProviderByKey.mockResolvedValue(null);
    db.createProvider.mockResolvedValue(makeProviderRecord());

    await createProviderConfig(TENANT_DB, TENANT_ID, {
      key: 'my-provider',
      type: 'vector',
      driver: 'pinecone',
      label: 'Pinecone',
      credentials: {},
      createdBy: USER_ID,
    });

    const call = db.createProvider.mock.calls[0][0];
    expect(call.status).toBe('active');
  });
});

// ── updateProviderConfig ──────────────────────────────────────────────────────

describe('updateProviderConfig', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns updated sanitized view when provider exists', async () => {
    const updated = makeProviderRecord({ label: 'OpenAI Updated' });
    db.updateProvider.mockResolvedValue(updated);

    const result = await updateProviderConfig(TENANT_DB, 'prov-1', {
      label: 'OpenAI Updated',
    });

    expect(result).not.toBeNull();
    expect(result!.label).toBe('OpenAI Updated');
    expect((result as unknown as Record<string, unknown>)['credentialsEnc']).toBeUndefined();
  });

  it('returns null when provider not found', async () => {
    db.updateProvider.mockResolvedValue(null);

    const result = await updateProviderConfig(TENANT_DB, 'nonexistent', {
      label: 'X',
    });

    expect(result).toBeNull();
  });

  it('encrypts credentials when updating them', async () => {
    db.updateProvider.mockResolvedValue(makeProviderRecord());

    await updateProviderConfig(TENANT_DB, 'prov-1', {
      credentials: { newKey: 'abc' },
    });

    expect(encryptObject).toHaveBeenCalledWith({ newKey: 'abc' });
  });

  it('does not encrypt credentials when they are not in the update', async () => {
    db.updateProvider.mockResolvedValue(makeProviderRecord());

    await updateProviderConfig(TENANT_DB, 'prov-1', {
      label: 'Just a label update',
    });

    expect(encryptObject).not.toHaveBeenCalled();
  });

  it('updates status when provided', async () => {
    db.updateProvider.mockResolvedValue(makeProviderRecord({ status: 'disabled' }));

    await updateProviderConfig(TENANT_DB, 'prov-1', { status: 'disabled' });

    const call = db.updateProvider.mock.calls[0][1];
    expect(call.status).toBe('disabled');
  });
});

// ── listProviderConfigs ───────────────────────────────────────────────────────

describe('listProviderConfigs', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listProviders.mockResolvedValue([makeProviderRecord()]);
  });

  it('returns sanitized provider views', async () => {
    const result = await listProviderConfigs(TENANT_DB, TENANT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].hasCredentials).toBe(true);
    expect((result[0] as unknown as Record<string, unknown>)['credentialsEnc']).toBeUndefined();
  });

  it('returns empty array when no providers exist', async () => {
    db.listProviders.mockResolvedValue([]);
    const result = await listProviderConfigs(TENANT_DB, TENANT_ID);
    expect(result).toHaveLength(0);
  });

  it('passes filter options to db.listProviders', async () => {
    await listProviderConfigs(TENANT_DB, TENANT_ID, { type: 'vector', status: 'active' });
    expect(db.listProviders).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ type: 'vector', status: 'active' }),
    );
  });

  it('marks hasCredentials as false when credentialsEnc is empty', async () => {
    db.listProviders.mockResolvedValue([makeProviderRecord({ credentialsEnc: '' })]);
    const result = await listProviderConfigs(TENANT_DB, TENANT_ID);
    expect(result[0].hasCredentials).toBe(false);
  });
});

// ── getProviderConfigByKey ────────────────────────────────────────────────────

describe('getProviderConfigByKey', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns sanitized view when found', async () => {
    db.findProviderByKey.mockResolvedValue(makeProviderRecord());
    const result = await getProviderConfigByKey(TENANT_DB, TENANT_ID, 'openai-main');
    expect(result).not.toBeNull();
    expect(result!.key).toBe('openai-main');
    expect((result as unknown as Record<string, unknown>)['credentialsEnc']).toBeUndefined();
  });

  it('returns null when not found', async () => {
    db.findProviderByKey.mockResolvedValue(null);
    const result = await getProviderConfigByKey(TENANT_DB, TENANT_ID, 'missing');
    expect(result).toBeNull();
  });
});

// ── getProviderConfigById ─────────────────────────────────────────────────────

describe('getProviderConfigById', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns sanitized view when found', async () => {
    db.findProviderById.mockResolvedValue(makeProviderRecord());
    const result = await getProviderConfigById(TENANT_DB, 'prov-1');
    expect(result).not.toBeNull();
    expect(result!.key).toBe('openai-main');
  });

  it('returns null when not found', async () => {
    db.findProviderById.mockResolvedValue(null);
    const result = await getProviderConfigById(TENANT_DB, 'not-found');
    expect(result).toBeNull();
  });
});

// ── deleteProviderConfig ──────────────────────────────────────────────────────

describe('deleteProviderConfig', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns true when deleted successfully', async () => {
    db.deleteProvider.mockResolvedValue(true);
    const result = await deleteProviderConfig(TENANT_DB, 'prov-1');
    expect(result).toBe(true);
  });

  it('returns false when provider not found', async () => {
    db.deleteProvider.mockResolvedValue(false);
    const result = await deleteProviderConfig(TENANT_DB, 'missing');
    expect(result).toBe(false);
  });
});

// ── loadProviderRuntimeData ───────────────────────────────────────────────────

describe('loadProviderRuntimeData', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('loads by id and decrypts credentials', async () => {
    const record = makeProviderRecord();
    db.findProviderById.mockResolvedValue(record);

    const result = await loadProviderRuntimeData(TENANT_DB, {
      id: 'prov-1',
      tenantId: TENANT_ID,
    });

    expect(db.findProviderById).toHaveBeenCalledWith('prov-1');
    expect(decryptObject).toHaveBeenCalledWith('encrypted-blob');
    expect(result.record).toBe(record);
    expect(result.credentials).toEqual({ apiKey: 'secret-key-123' });
  });

  it('loads by key and decrypts credentials', async () => {
    const record = makeProviderRecord();
    db.findProviderByKey.mockResolvedValue(record);

    const result = await loadProviderRuntimeData(TENANT_DB, {
      key: 'openai-main',
      tenantId: TENANT_ID,
    });

    expect(db.findProviderByKey).toHaveBeenCalledWith(TENANT_ID, 'openai-main', undefined);
    expect(result.credentials).toEqual({ apiKey: 'secret-key-123' });
  });

  it('throws when provider is not found by id', async () => {
    db.findProviderById.mockResolvedValue(null);

    await expect(
      loadProviderRuntimeData(TENANT_DB, { id: 'missing', tenantId: TENANT_ID }),
    ).rejects.toThrow('Provider configuration not found.');
  });

  it('throws when provider is not found by key', async () => {
    db.findProviderByKey.mockResolvedValue(null);

    await expect(
      loadProviderRuntimeData(TENANT_DB, { key: 'missing-key', tenantId: TENANT_ID }),
    ).rejects.toThrow('Provider configuration not found.');
  });

  it('passes optional projectId when loading by key', async () => {
    db.findProviderByKey.mockResolvedValue(makeProviderRecord());

    await loadProviderRuntimeData(TENANT_DB, {
      key: 'openai-main',
      tenantId: TENANT_ID,
      projectId: 'proj-1',
    });

    expect(db.findProviderByKey).toHaveBeenCalledWith(TENANT_ID, 'openai-main', 'proj-1');
  });
});
