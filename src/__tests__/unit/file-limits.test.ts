/**
 * Unit tests - what an upload may be (services/files/uploadLimits.ts) and what the upload dialog shows before a
 * byte is sent (services/files/fileLimits.ts, behind GET /files/limits).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  resolveEffectiveLimits: vi.fn(),
  // None of these may be called by a read of the limits: they spend rate-limit counters.
  checkRateLimit: vi.fn(),
  checkPerRequestLimits: vi.fn(),
  checkResourceQuota: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota, resolveEffectiveLimits } from '@/lib/quota/quotaGuard';
import { getFileLimits } from '@/lib/services/files/fileLimits';
import {
  UPLOAD_BODY_OVERHEAD_BYTES,
  fileBytesFitting,
  fileTooLargeBody,
  uploadBodyLimit,
  uploadMaxBytes,
  uploadMaxMb,
} from '@/lib/services/files/uploadLimits';
import { createMockDb } from '../helpers/db.mock';

const MIB = 1024 * 1024;
const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const original = getConfigSource();
function configure(overrides: Record<string, string> = {}) {
  setConfigSource({ get: (key: string) => overrides[key] ?? process.env[key] } as ConfigSource);
}

beforeEach(() => {
  vi.clearAllMocks();
  configure({ FILE_UPLOAD_MAX_MB: '50', FILE_UPLOAD_ALLOWED_MIME_TYPES: '' });
});

afterEach(() => {
  setConfigSource(original);
});

describe('the upload size the server accepts', () => {
  it('reads the configured file limit', () => {
    configure({ FILE_UPLOAD_MAX_MB: '20' });
    expect(uploadMaxMb()).toBe(20);
    expect(uploadMaxBytes()).toBe(20 * MIB);
  });

  it('is at least 1 MB, whatever is configured', () => {
    configure({ FILE_UPLOAD_MAX_MB: '0' });
    expect(uploadMaxMb()).toBe(1);
    expect(uploadMaxBytes()).toBe(MIB);
  });

  it('lets the request body carry the file as base64 plus the JSON around it', () => {
    configure({ FILE_UPLOAD_MAX_MB: '30' });
    const limit = uploadBodyLimit();
    expect(limit).toBe(Math.ceil(30 * MIB * (4 / 3)) + UPLOAD_BODY_OVERHEAD_BYTES);
    // A file at the limit, base64-encoded, fits the body (with a little room for the JSON).
    const encodedLength = Math.ceil((30 * MIB) / 3) * 4;
    expect(encodedLength + 1024).toBeLessThanOrEqual(limit);
  });

  it('turns a body limit back into the file size it can carry (it never promises more than fits)', () => {
    for (const mb of [1, 5, 50, 100]) {
      configure({ FILE_UPLOAD_MAX_MB: String(mb) });
      const fits = fileBytesFitting(uploadBodyLimit());
      expect(fits).toBeLessThanOrEqual(mb * MIB);
      expect(mb * MIB - fits).toBeLessThanOrEqual(1);
      const encoded = Math.ceil(fits / 3) * 4;
      expect(encoded + UPLOAD_BODY_OVERHEAD_BYTES).toBeLessThanOrEqual(uploadBodyLimit() + 4);
    }
    expect(fileBytesFitting(10)).toBe(0);
  });

  it('answers a body past the limit with the limit in the configured megabytes', () => {
    configure({ FILE_UPLOAD_MAX_MB: '12' });
    expect(fileTooLargeBody()).toEqual({ error: 'File is larger than the 12 MB upload limit.', code: 'file_too_large' });
  });
});

describe('getFileLimits', () => {
  let db: ReturnType<typeof createMockDb>;
  const input = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'user-1' };

  beforeEach(() => {
    db = createMockDb();
    mockFn(getDatabase).mockResolvedValue(db);
    db.sumFileRecordBytes.mockResolvedValue(1_500);
    db.countFileRecords.mockResolvedValue(3);
    mockFn(resolveEffectiveLimits).mockResolvedValue({});
  });

  it('describes an install with no quota and no allowlist', async () => {
    const limits = await getFileLimits(input);
    expect(limits).toEqual({
      maxFileBytes: 50 * MIB,
      maxRequestBytes: uploadBodyLimit(),
      allowedMimeTypes: null,
      quota: { usedBytes: 1_500, limitBytes: null, filesUsed: 3, filesLimit: null },
    });
  });

  it('counts the files of the project, not of the bucket or the tenant', async () => {
    await getFileLimits(input);
    expect(db.sumFileRecordBytes).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(db.countFileRecords).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(db.switchToTenant).toHaveBeenCalledWith('tenant_acme');
  });

  it('follows the configured file limit', async () => {
    configure({ FILE_UPLOAD_MAX_MB: '8' });
    const limits = await getFileLimits(input);
    expect(limits.maxFileBytes).toBe(8 * MIB);
    expect(limits.maxRequestBytes).toBe(uploadBodyLimit());
  });

  it('is lowered by a per-request file size quota, never raised by one', async () => {
    mockFn(resolveEffectiveLimits).mockResolvedValue({ perRequest: { maxFileSize: 2 * MIB } });
    expect((await getFileLimits(input)).maxFileBytes).toBe(2 * MIB);

    mockFn(resolveEffectiveLimits).mockResolvedValue({ perRequest: { maxFileSize: 500 * MIB } });
    expect((await getFileLimits(input)).maxFileBytes).toBe(50 * MIB);

    mockFn(resolveEffectiveLimits).mockResolvedValue({ perRequest: { maxFileSize: -1 } });
    expect((await getFileLimits(input)).maxFileBytes).toBe(50 * MIB);
  });

  it('reports the storage and file-count quotas, with unlimited as null', async () => {
    mockFn(resolveEffectiveLimits).mockResolvedValue({ quotas: { maxStorageBytes: 10_000, maxFilesTotal: 25 } });
    expect((await getFileLimits(input)).quota).toEqual({ usedBytes: 1_500, limitBytes: 10_000, filesUsed: 3, filesLimit: 25 });

    mockFn(resolveEffectiveLimits).mockResolvedValue({ quotas: { maxStorageBytes: -1, maxFilesTotal: -1 } });
    expect((await getFileLimits(input)).quota).toEqual({ usedBytes: 1_500, limitBytes: null, filesUsed: 3, filesLimit: null });
  });

  it('keeps a quota of zero as zero (nothing may be stored), not as unlimited', async () => {
    mockFn(resolveEffectiveLimits).mockResolvedValue({ quotas: { maxStorageBytes: 0, maxFilesTotal: 0 } });
    expect((await getFileLimits(input)).quota).toMatchObject({ limitBytes: 0, filesLimit: 0 });
  });

  it('lists the content types an allowlist limits uploads to', async () => {
    configure({ FILE_UPLOAD_ALLOWED_MIME_TYPES: 'application/pdf, image/*' });
    expect((await getFileLimits(input)).allowedMimeTypes).toEqual(['application/pdf', 'image/*']);
  });

  it('resolves the quota of the project, and of the bucket and its provider when a bucket is named', async () => {
    db.findFileBucketByKey.mockResolvedValue({ _id: 'b1', key: 'docs', providerKey: 's3-main', status: 'active' } as never);
    await getFileLimits({ ...input, bucketKey: 'docs' });
    expect(resolveEffectiveLimits).toHaveBeenCalledWith({
      domain: 'file',
      projectId: 'proj-1',
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      userId: 'user-1',
      providerKey: 's3-main',
      resourceKey: 'docs',
    });
    expect(db.findFileBucketByKey).toHaveBeenCalledWith('tenant-1', 'docs', 'proj-1');

    mockFn(resolveEffectiveLimits).mockClear();
    await getFileLimits(input);
    expect(resolveEffectiveLimits).toHaveBeenCalledWith({
      domain: 'file',
      projectId: 'proj-1',
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
  });

  it('describes a switched-off bucket too: its quota is still the one to show', async () => {
    db.findFileBucketByKey.mockResolvedValue({ _id: 'b1', key: 'docs', providerKey: 's3-main', status: 'disabled' } as never);
    await expect(getFileLimits({ ...input, bucketKey: 'docs' })).resolves.toMatchObject({ quota: { usedBytes: 1_500 } });
  });

  it('refuses a bucket that does not exist (404 bucket_not_found)', async () => {
    db.findFileBucketByKey.mockResolvedValue(null);
    await expect(getFileLimits({ ...input, bucketKey: 'gone' })).rejects.toMatchObject({ code: 'bucket_not_found', status: 404 });
  });

  it('only reads: no rate-limit counter, per-request check or quota check is spent', async () => {
    await getFileLimits(input);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(checkPerRequestLimits).not.toHaveBeenCalled();
    expect(checkResourceQuota).not.toHaveBeenCalled();
  });
});
