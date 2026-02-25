/**
 * Unit tests — fileService
 * Tests: listFileBuckets, createFileBucket, getFileBucket,
 *        deleteFileBucket, listFiles
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: vi.fn(),
  getProviderConfigByKey: vi.fn(),
  listProviderConfigs: vi.fn(),
  loadProviderRuntimeData: vi.fn(),
}));

vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    listDescriptors: vi.fn().mockReturnValue([]),
    getContract: vi.fn().mockReturnValue({
      id: 'aws-s3-files',
      capabilities: { upload: true, download: true },
    }),
  },
}));
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: vi.fn().mockResolvedValue('## Markdown'),
}));
import { getDatabase } from '@/lib/database';
import {
  createProviderConfig,
  getProviderConfigByKey,
  listProviderConfigs,
} from '@/lib/services/providers/providerService';
import { createMockDb } from '../helpers/db.mock';
import {
  listFileBuckets,
  createFileBucket,
  getFileBucket,
  deleteFileBucket,
} from '@/lib/services/files/fileService';
import type { IFileBucketRecord } from '@/lib/database';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';
const BUCKET_KEY = 'doc-uploads';

function makeBucket(overrides: Partial<IFileBucketRecord> = {}): IFileBucketRecord {
  return {
    _id: 'bucket-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: BUCKET_KEY,
    name: 'Doc Uploads',
    providerKey: 's3-main',
    description: 'Storage for documents',
    prefix: 'docs/',
    status: 'active',
    createdBy: USER_ID,
    updatedBy: USER_ID,
    ...overrides,
  };
}

function makeProviderView() {
  return {
    id: 'prov-1',
    key: 's3-main',
    type: 'file',
    driver: 'aws-s3-files',
    label: 'S3 Main',
    status: 'active',
    settings: {},
    tenantId: TENANT_ID,
    createdBy: USER_ID,
  };
}

// ── listFileBuckets ───────────────────────────────────────────────────────────

describe('listFileBuckets', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listFileBuckets.mockResolvedValue([makeBucket()]);
    (listProviderConfigs as ReturnType<typeof vi.fn>).mockResolvedValue([makeProviderView()]);
  });

  it('calls switchToTenant', async () => {
    await listFileBuckets(TENANT_DB, TENANT_ID, PROJECT_ID);
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });

  it('returns buckets with serialized id field', async () => {
    const result = await listFileBuckets(TENANT_DB, TENANT_ID, PROJECT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('bucket-1');
    expect((result[0] as unknown as Record<string, unknown>)['_id']).toBeUndefined();
  });

  it('attaches provider info to each bucket', async () => {
    const result = await listFileBuckets(TENANT_DB, TENANT_ID, PROJECT_ID);
    expect(result[0].provider).toBeDefined();
    expect(result[0].provider?.key).toBe('s3-main');
  });

  it('returns empty array when no buckets exist', async () => {
    db.listFileBuckets.mockResolvedValue([]);
    const result = await listFileBuckets(TENANT_DB, TENANT_ID, PROJECT_ID);
    expect(result).toHaveLength(0);
  });
});

// ── createFileBucket ──────────────────────────────────────────────────────────

describe('createFileBucket', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findFileBucketByKey.mockResolvedValue(null); // key not taken
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeProviderView());
    db.createFileBucket.mockResolvedValue(makeBucket());
  });

  it('creates a bucket and returns a view', async () => {
    const result = await createFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, {
      key: BUCKET_KEY,
      name: 'Doc Uploads',
      providerKey: 's3-main',
      createdBy: USER_ID,
    });

    expect(db.createFileBucket).toHaveBeenCalledTimes(1);
    expect(result.key).toBe(BUCKET_KEY);
  });

  it('throws when bucket key already exists', async () => {
    db.findFileBucketByKey.mockResolvedValue(makeBucket());

    await expect(
      createFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, {
        key: BUCKET_KEY,
        name: 'Duplicate',
        providerKey: 's3-main',
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('already exists');
  });

  it('throws when provider is not found', async () => {
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      createFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, {
        key: 'new-bucket',
        name: 'New Bucket',
        providerKey: 'missing-provider',
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('provider not found');
  });

  it('throws when provider is not active', async () => {
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...makeProviderView(),
      status: 'disabled',
    });

    await expect(
      createFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, {
        key: 'new-bucket',
        name: 'New Bucket',
        providerKey: 's3-main',
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('active');
  });
});

// ── getFileBucket ─────────────────────────────────────────────────────────────

describe('getFileBucket', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (getProviderConfigByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeProviderView());
  });

  it('returns bucket when found', async () => {
    db.findFileBucketByKey.mockResolvedValue(makeBucket());
    const result = await getFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, BUCKET_KEY);
    expect(result.key).toBe(BUCKET_KEY);
  });

  it('throws when bucket is not found', async () => {
    db.findFileBucketByKey.mockResolvedValue(null);
    await expect(
      getFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, 'missing'),
    ).rejects.toThrow('File bucket not found');
  });

  it('attaches provider when available', async () => {
    db.findFileBucketByKey.mockResolvedValue(makeBucket());
    const result = await getFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, BUCKET_KEY);
    expect(result.provider).toBeDefined();
  });
});

// ── deleteFileBucket ──────────────────────────────────────────────────────────

describe('deleteFileBucket', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findFileBucketByKey.mockResolvedValue(makeBucket());
    db.listFileRecords.mockResolvedValue({ items: [] });
    db.deleteFileBucket.mockResolvedValue(true);
  });

  it('returns false when bucket is not found', async () => {
    db.findFileBucketByKey.mockResolvedValue(null);
    const result = await deleteFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, 'missing');
    expect(result).toBe(false);
  });

  it('throws when bucket contains files and force is not set', async () => {
    db.listFileRecords.mockResolvedValue({
      items: [{
        _id: 'file-1',
        tenantId: TENANT_ID,
        providerKey: 's3-main',
        bucketKey: BUCKET_KEY,
        key: 'docs/file.pdf',
        name: 'file.pdf',
        size: 1024,
        createdBy: USER_ID,
        markdownStatus: 'pending' as const,
      }],
    });

    await expect(
      deleteFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, BUCKET_KEY),
    ).rejects.toThrow('contains files');
  });

  it('deletes successfully when bucket is empty', async () => {
    const result = await deleteFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, BUCKET_KEY);
    expect(result).toBe(true);
    expect(db.deleteFileBucket).toHaveBeenCalledTimes(1);
  });

  it('deletes successfully with force=true even when files exist', async () => {
    db.listFileRecords.mockResolvedValue({
      items: [{
        _id: 'file-1',
        tenantId: TENANT_ID,
        providerKey: 's3-main',
        bucketKey: BUCKET_KEY,
        key: 'docs/file.pdf',
        name: 'file.pdf',
        size: 1024,
        createdBy: USER_ID,
        markdownStatus: 'pending' as const,
      }],
    });
    db.deleteFileBucket.mockResolvedValue(true);

    const result = await deleteFileBucket(TENANT_DB, TENANT_ID, PROJECT_ID, BUCKET_KEY, {
      force: true,
    });

    expect(result).toBe(true);
  });
});
