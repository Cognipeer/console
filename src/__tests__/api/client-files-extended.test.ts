import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  countFileRecords: vi.fn().mockResolvedValue(0),
  sumFileRecordBytes: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireApiToken: vi.fn(), ApiTokenAuthError };
});

vi.mock('@/lib/services/files', () => ({
  getFileBucket: vi.fn(),
  uploadFile: vi.fn(),
  listFiles: vi.fn(),
  getFileRecord: vi.fn(),
  deleteFile: vi.fn(),
  downloadFile: vi.fn(),
  listFileProviders: vi.fn(),
  createFileProvider: vi.fn(),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {} } }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { GET as bucketGET } from '@/app/api/client/v1/files/buckets/[bucketKey]/route';
import { GET as objectsGET, POST as objectsPOST } from '@/app/api/client/v1/files/buckets/[bucketKey]/objects/route';
import { GET as objectKeyGET, DELETE as objectKeyDELETE } from '@/app/api/client/v1/files/buckets/[bucketKey]/objects/[objectKey]/route';
import { GET as downloadGET } from '@/app/api/client/v1/files/buckets/[bucketKey]/objects/[objectKey]/download/route';
import { GET as fileProvidersGET, POST as fileProvidersPOST } from '@/app/api/client/v1/files/providers/route';

import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  getFileBucket,
  uploadFile,
  listFiles,
  getFileRecord,
  deleteFile,
  downloadFile,
  listFileProviders,
  createFileProvider,
} from '@/lib/services/files';
import { checkRateLimit } from '@/lib/quota/quotaGuard';

const mockRequireApiToken = vi.mocked(requireApiToken);
const mockGetFileBucket = vi.mocked(getFileBucket);
const mockUploadFile = vi.mocked(uploadFile);
const mockListFiles = vi.mocked(listFiles);
const mockGetFileRecord = vi.mocked(getFileRecord);
const mockDeleteFile = vi.mocked(deleteFile);
const mockDownloadFile = vi.mocked(downloadFile);
const mockListFileProviders = vi.mocked(listFileProviders);
const mockCreateFileProvider = vi.mocked(createFileProvider);

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tenant: { licenseType: 'PRO' },
  token: 'tok-1',
  tokenRecord: { _id: 'tr-1', userId: 'user-1' },
  user: { _id: 'user-1', email: 'test@example.com' },
};

const mockBucket = { _id: 'b-1', key: 'docs', name: 'Documents', projectId: 'proj-1' };
const mockFile = { _id: 'f-1', key: 'doc.txt', fileName: 'doc.txt', bucketKey: 'docs' };
const mockFiles = { items: [mockFile], nextCursor: null };
const mockProvider = { _id: 'pv-1', key: 'my-s3', driver: 's3', label: 'My S3' };
const mockProviders = [mockProvider];

const bucketParams = { params: Promise.resolve({ bucketKey: 'docs' }) };
const objectParams = { params: Promise.resolve({ bucketKey: 'docs', objectKey: 'doc.txt' }) };

function makeReq(method: string, path: string, body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Bucket GET ─────────────────────────────────────────────────────────────

describe('GET /api/client/v1/files/buckets/[bucketKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetFileBucket.mockResolvedValue(mockBucket as any);
  });

  it('returns bucket details', async () => {
    const res = await bucketGET(makeReq('GET', '/api/client/v1/files/buckets/docs'), bucketParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bucket.key).toBe('docs');
  });

  it('returns 404 when bucket not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetFileBucket.mockResolvedValueOnce(null as any);
    const res = await bucketGET(makeReq('GET', '/api/client/v1/files/buckets/docs'), bucketParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await bucketGET(makeReq('GET', '/api/client/v1/files/buckets/docs'), bucketParams);
    expect(res.status).toBe(401);
  });
});

// ─── Objects GET ────────────────────────────────────────────────────────────

describe('GET /api/client/v1/files/buckets/[bucketKey]/objects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListFiles.mockResolvedValue(mockFiles as any);
  });

  it('returns file list', async () => {
    const res = await objectsGET(makeReq('GET', '/api/client/v1/files/buckets/docs/objects'), bucketParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toHaveLength(1);
    expect(body.count).toBe(1);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await objectsGET(makeReq('GET', '/api/client/v1/files/buckets/docs/objects'), bucketParams);
    expect(res.status).toBe(401);
  });
});

// ─── Objects POST (upload) ───────────────────────────────────────────────────

describe('POST /api/client/v1/files/buckets/[bucketKey]/objects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUploadFile.mockResolvedValue({ record: mockFile } as any);
  });

  it('uploads a file successfully', async () => {
    const res = await objectsPOST(
      makeReq('POST', '/api/client/v1/files/buckets/docs/objects', {
        fileName: 'doc.txt',
        contentType: 'text/plain',
        data: 'aGVsbG8=',
      }),
      bucketParams,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.file).toBeDefined();
  });

  it('returns 400 when fileName is missing', async () => {
    const res = await objectsPOST(
      makeReq('POST', '/api/client/v1/files/buckets/docs/objects', { data: 'aGVsbG8=' }),
      bucketParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when data is missing', async () => {
    const res = await objectsPOST(
      makeReq('POST', '/api/client/v1/files/buckets/docs/objects', { fileName: 'doc.txt' }),
      bucketParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limit exceeded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, reason: 'Rate limit' } as any);
    const res = await objectsPOST(
      makeReq('POST', '/api/client/v1/files/buckets/docs/objects', { fileName: 'doc.txt', data: 'aGVsbG8=' }),
      bucketParams,
    );
    expect(res.status).toBe(429);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await objectsPOST(
      makeReq('POST', '/api/client/v1/files/buckets/docs/objects', { fileName: 'doc.txt', data: 'x' }),
      bucketParams,
    );
    expect(res.status).toBe(401);
  });
});

// ─── Object GET ─────────────────────────────────────────────────────────────

describe('GET /api/client/v1/files/buckets/[bucketKey]/objects/[objectKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetFileRecord.mockResolvedValue(mockFile as any);
  });

  it('returns file metadata', async () => {
    const res = await objectKeyGET(makeReq('GET', '/api/client/v1/files/buckets/docs/objects/doc.txt'), objectParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.file.fileName).toBe('doc.txt');
  });

  it('returns 404 when file not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetFileRecord.mockResolvedValueOnce(null as any);
    const res = await objectKeyGET(makeReq('GET', '/api/client/v1/files/buckets/docs/objects/doc.txt'), objectParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await objectKeyGET(makeReq('GET', '/api/client/v1/files/buckets/docs/objects/doc.txt'), objectParams);
    expect(res.status).toBe(401);
  });
});

// ─── Object DELETE ──────────────────────────────────────────────────────────

describe('DELETE /api/client/v1/files/buckets/[bucketKey]/objects/[objectKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockDeleteFile.mockResolvedValue(true);
  });

  it('deletes a file', async () => {
    const res = await objectKeyDELETE(makeReq('DELETE', '/api/client/v1/files/buckets/docs/objects/doc.txt'), objectParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bucketKey).toBe('docs');
    expect(body.objectKey).toBe('doc.txt');
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await objectKeyDELETE(makeReq('DELETE', '/api/client/v1/files/buckets/docs/objects/doc.txt'), objectParams);
    expect(res.status).toBe(401);
  });
});

// ─── Download GET ────────────────────────────────────────────────────────────

describe('GET /api/client/v1/files/buckets/[bucketKey]/objects/[objectKey]/download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockDownloadFile.mockResolvedValue({
      data: Buffer.from('hello'),
      contentType: 'text/plain',
      fileName: 'doc.txt',
      size: 5,
      etag: '"abc"',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  it('downloads a file', async () => {
    const res = await downloadGET(makeReq('GET', '/api/client/v1/files/buckets/docs/objects/doc.txt/download'), objectParams);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('doc.txt');
  });

  it('returns 400 for invalid variant', async () => {
    const req = new NextRequest('http://localhost/api/client/v1/files/buckets/docs/objects/doc.txt/download?variant=zip', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    const res = await downloadGET(req, objectParams);
    expect(res.status).toBe(400);
  });

  it('returns 404 when file not found in storage', async () => {
    mockDownloadFile.mockRejectedValueOnce(new Error('File not found'));
    const res = await downloadGET(makeReq('GET', '/api/client/v1/files/buckets/docs/objects/doc.txt/download'), objectParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await downloadGET(makeReq('GET', '/api/client/v1/files/buckets/docs/objects/doc.txt/download'), objectParams);
    expect(res.status).toBe(401);
  });
});

// ─── File Providers GET ──────────────────────────────────────────────────────

describe('GET /api/client/v1/files/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListFileProviders.mockResolvedValue(mockProviders as any);
  });

  it('returns list of file providers', async () => {
    const res = await fileProvidersGET(makeReq('GET', '/api/client/v1/files/providers'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toHaveLength(1);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await fileProvidersGET(makeReq('GET', '/api/client/v1/files/providers'));
    expect(res.status).toBe(401);
  });
});

// ─── File Providers POST ─────────────────────────────────────────────────────

describe('POST /api/client/v1/files/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateFileProvider.mockResolvedValue(mockProvider as any);
  });

  it('creates a file provider', async () => {
    const res = await fileProvidersPOST(
      makeReq('POST', '/api/client/v1/files/providers', {
        key: 'my-s3',
        driver: 's3',
        label: 'My S3',
        credentials: { accessKey: 'x', secretKey: 'y', bucket: 'z' },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider.key).toBe('my-s3');
  });

  it('returns 400 when required field is missing', async () => {
    const res = await fileProvidersPOST(
      makeReq('POST', '/api/client/v1/files/providers', {
        key: 'my-s3',
        driver: 's3',
        // label and credentials missing
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await fileProvidersPOST(
      makeReq('POST', '/api/client/v1/files/providers', { key: 'x', driver: 'x', label: 'x', credentials: {} }),
    );
    expect(res.status).toBe(401);
  });
});
