/**
 * Unit tests — built-in provider auto-provisioning
 *
 * Verifies that ensureBuiltinProviders idempotently creates the built-in
 * vector/file provider records and the default bucket, extends project
 * assignments on existing records, tolerates concurrent-create races and
 * never throws into the calling read path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = {
  switchToTenant: vi.fn(),
  findProviderByKey: vi.fn(),
  findFileBucketByKey: vi.fn(),
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => mockDb),
}));

vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
}));

vi.mock('@/lib/services/files', () => ({
  createFileBucket: vi.fn(),
}));

import {
  ensureBuiltinProviders,
  BUILTIN_VECTOR_PROVIDER_KEY,
  BUILTIN_FILE_PROVIDER_KEY,
  BUILTIN_FILE_BUCKET_KEY,
} from '@/lib/services/providers/builtinProviders';
import {
  createProviderConfig,
  updateProviderConfig,
} from '@/lib/services/providers/providerService';
import { createFileBucket } from '@/lib/services/files';

const mockCreateProviderConfig = vi.mocked(createProviderConfig);
const mockUpdateProviderConfig = vi.mocked(updateProviderConfig);
const mockCreateFileBucket = vi.mocked(createFileBucket);

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

// ensureBuiltinProviders memoises successful runs per tenantDb/project pair
// for the process lifetime, so every test uses a unique pair.
let testCounter = 0;
function freshScope() {
  testCounter += 1;
  return {
    tenantDbName: `tenant_db_${testCounter}`,
    projectId: `project-${testCounter}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.switchToTenant.mockResolvedValue(undefined);
  mockDb.findProviderByKey.mockResolvedValue(null);
  mockDb.findFileBucketByKey.mockResolvedValue(null);
  mockCreateProviderConfig.mockResolvedValue({} as never);
  mockUpdateProviderConfig.mockResolvedValue({} as never);
  mockCreateFileBucket.mockResolvedValue({} as never);
});

describe('ensureBuiltinProviders', () => {
  it('creates both built-in providers and the default bucket for a fresh tenant', async () => {
    const { tenantDbName, projectId } = freshScope();

    await ensureBuiltinProviders(tenantDbName, TENANT_ID, projectId, USER_ID);

    expect(mockCreateProviderConfig).toHaveBeenCalledTimes(2);
    const createdKeys = mockCreateProviderConfig.mock.calls.map(
      ([, , payload]) => payload.key,
    );
    expect(createdKeys).toContain(BUILTIN_VECTOR_PROVIDER_KEY);
    expect(createdKeys).toContain(BUILTIN_FILE_PROVIDER_KEY);

    const vectorPayload = mockCreateProviderConfig.mock.calls.find(
      ([, , payload]) => payload.key === BUILTIN_VECTOR_PROVIDER_KEY,
    )![2];
    expect(vectorPayload.type).toBe('vector');
    expect(vectorPayload.driver).toBe('sqlite-vector');
    expect(vectorPayload.credentials).toEqual({});
    expect(vectorPayload.projectId).toBe(projectId);

    const filePayload = mockCreateProviderConfig.mock.calls.find(
      ([, , payload]) => payload.key === BUILTIN_FILE_PROVIDER_KEY,
    )![2];
    expect(filePayload.type).toBe('file');
    expect(filePayload.driver).toBe('local-filesystem');

    expect(mockCreateFileBucket).toHaveBeenCalledWith(
      tenantDbName,
      TENANT_ID,
      projectId,
      expect.objectContaining({
        key: BUILTIN_FILE_BUCKET_KEY,
        providerKey: BUILTIN_FILE_PROVIDER_KEY,
        createdBy: USER_ID,
      }),
    );
  });

  it('assigns an existing built-in provider to a new project', async () => {
    const { tenantDbName, projectId } = freshScope();

    mockDb.findProviderByKey.mockResolvedValue({
      _id: 'provider-record-1',
      projectIds: ['some-other-project'],
    });
    mockDb.findFileBucketByKey.mockResolvedValue({ _id: 'bucket-1' });

    await ensureBuiltinProviders(tenantDbName, TENANT_ID, projectId, USER_ID);

    expect(mockCreateProviderConfig).not.toHaveBeenCalled();
    expect(mockUpdateProviderConfig).toHaveBeenCalledTimes(2);
    expect(mockUpdateProviderConfig).toHaveBeenCalledWith(
      tenantDbName,
      'provider-record-1',
      expect.objectContaining({
        projectIds: ['some-other-project', projectId],
      }),
    );
  });

  it('does nothing when providers and bucket already exist for the project', async () => {
    const { tenantDbName, projectId } = freshScope();

    mockDb.findProviderByKey.mockResolvedValue({
      _id: 'provider-record-1',
      projectIds: [projectId],
    });
    mockDb.findFileBucketByKey.mockResolvedValue({ _id: 'bucket-1' });

    await ensureBuiltinProviders(tenantDbName, TENANT_ID, projectId, USER_ID);

    expect(mockCreateProviderConfig).not.toHaveBeenCalled();
    expect(mockUpdateProviderConfig).not.toHaveBeenCalled();
    expect(mockCreateFileBucket).not.toHaveBeenCalled();
  });

  it('tolerates losing a concurrent-create race', async () => {
    const { tenantDbName, projectId } = freshScope();

    mockCreateProviderConfig.mockRejectedValue(
      new Error('Provider with key "builtin-vector" already exists.'),
    );
    mockCreateFileBucket.mockRejectedValue(
      new Error('Bucket with key "builtin-storage" already exists.'),
    );

    await expect(
      ensureBuiltinProviders(tenantDbName, TENANT_ID, projectId, USER_ID),
    ).resolves.toBeUndefined();
  });

  it('swallows unexpected provisioning failures instead of breaking the caller', async () => {
    const { tenantDbName, projectId } = freshScope();

    mockCreateProviderConfig.mockRejectedValue(new Error('disk on fire'));

    await expect(
      ensureBuiltinProviders(tenantDbName, TENANT_ID, projectId, USER_ID),
    ).resolves.toBeUndefined();
  });

  it('memoises successful provisioning per tenant/project pair', async () => {
    const { tenantDbName, projectId } = freshScope();

    await ensureBuiltinProviders(tenantDbName, TENANT_ID, projectId, USER_ID);
    const lookupsAfterFirstRun = mockDb.findProviderByKey.mock.calls.length;
    expect(lookupsAfterFirstRun).toBeGreaterThan(0);

    await ensureBuiltinProviders(tenantDbName, TENANT_ID, projectId, USER_ID);
    expect(mockDb.findProviderByKey.mock.calls.length).toBe(lookupsAfterFirstRun);
  });
});
