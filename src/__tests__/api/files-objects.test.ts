import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  countFileRecords: vi.fn(),
  sumFileRecordBytes: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/services/files', () => ({
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return { requireProjectContext: vi.fn(), ProjectContextError };
});

vi.mock('@/lib/quota/quotaGuard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {} } } as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true } as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true } as any),
}));

import { GET, POST } from '@/server/api/routes/files/buckets/[bucketKey]/objects/route';
import { listFiles, uploadFile } from '@/lib/services/files';
import { requireProjectContext } from '@/lib/services/projects/projectContext';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';

const mockListFiles = vi.mocked(listFiles);
const mockUploadFile = vi.mocked(uploadFile);
const mockRequireProjectContext = vi.mocked(requireProjectContext);
const mockCheckPerRequestLimits = vi.mocked(checkPerRequestLimits);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockCheckResourceQuota = vi.mocked(checkResourceQuota);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockParams = { params: Promise.resolve({ bucketKey: 'bucket-1' }) };

function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>, headers: Record<string, string> = {}, search = '') {
  return new NextRequest(`http://localhost/api/files/buckets/bucket-1/objects${search}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      'x-license-type': 'PRO',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/files/buckets/[bucketKey]/objects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    mockListFiles.mockResolvedValue({ items: [{ key: 'file-1.txt', size: 100 }], nextCursor: null } as never);
  });

  it('returns file list', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
  });

  it('calls listFiles with bucket key', async () => {
    await GET(makeRequest('GET'), mockParams);
    expect(mockListFiles).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      expect.objectContaining({ bucketKey: 'bucket-1' }),
    );
  });

  it('passes limit param', async () => {
    await GET(makeRequest('GET', undefined, {}, '?limit=10'), mockParams);
    expect(mockListFiles).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ limit: 10 }),
    );
  });

  it('returns 401 when headers missing', async () => {
    const res = await GET(makeRequest('GET', undefined, { 'x-user-id': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 on "File bucket not found." error', async () => {
    mockListFiles.mockRejectedValueOnce(new Error('File bucket not found.'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockListFiles.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

const uploadBody = {
  fileName: 'test.txt',
  data: 'SGVsbG8gV29ybGQ=', // base64 "Hello World"
  contentType: 'text/plain',
};

describe('POST /api/files/buckets/[bucketKey]/objects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    mockUploadFile.mockResolvedValue({ record: { key: 'test.txt', size: 11 } } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckPerRequestLimits.mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {} } } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckRateLimit.mockResolvedValue({ allowed: true } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckResourceQuota.mockResolvedValue({ allowed: true } as any);
    mockDb.switchToTenant.mockResolvedValue(undefined);
    mockDb.countFileRecords.mockResolvedValue(0);
    mockDb.sumFileRecordBytes.mockResolvedValue(0);
  });

  it('uploads a file and returns 201', async () => {
    const res = await POST(makeRequest('POST', uploadBody), mockParams);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.record).toBeDefined();
  });

  it('calls uploadFile with correct args', async () => {
    await POST(makeRequest('POST', uploadBody), mockParams);
    expect(mockUploadFile).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      expect.objectContaining({
        bucketKey: 'bucket-1',
        fileName: 'test.txt',
        createdBy: 'user-1',
      }),
    );
  });

  it('returns 400 when fileName is missing', async () => {
    const res = await POST(makeRequest('POST', { ...uploadBody, fileName: '' }), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('fileName');
  });

  it('returns 400 when data is missing', async () => {
    const res = await POST(makeRequest('POST', { ...uploadBody, data: '' }), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('data');
  });

  it('returns 401 when x-license-type missing', async () => {
    const res = await POST(makeRequest('POST', uploadBody, { 'x-license-type': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 429 when checkPerRequestLimits fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckPerRequestLimits.mockResolvedValueOnce({ allowed: false, reason: 'File too large', effectiveLimits: { quotas: {} } } as any);
    const res = await POST(makeRequest('POST', uploadBody), mockParams);
    expect(res.status).toBe(429);
  });

  it('returns 429 when rate limit fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, reason: 'Too fast' } as any);
    const res = await POST(makeRequest('POST', uploadBody), mockParams);
    expect(res.status).toBe(429);
  });

  it('returns 429 when resource quota fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckResourceQuota.mockResolvedValueOnce({ allowed: false, reason: 'Too many files' } as any);
    const res = await POST(makeRequest('POST', uploadBody), mockParams);
    expect(res.status).toBe(429);
  });

  it('returns 404 when bucket not found', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('File bucket not found.'));
    const res = await POST(makeRequest('POST', uploadBody), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockUploadFile.mockRejectedValueOnce(new Error('S3 error'));
    const res = await POST(makeRequest('POST', uploadBody), mockParams);
    expect(res.status).toBe(500);
  });
});
