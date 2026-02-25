import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/files', () => ({
  getFileBucket: vi.fn(),
  deleteFileBucket: vi.fn(),
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

import { GET, DELETE } from '@/app/api/files/buckets/[bucketKey]/route';
import { getFileBucket, deleteFileBucket } from '@/lib/services/files';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockGetFileBucket = vi.mocked(getFileBucket);
const mockDeleteFileBucket = vi.mocked(deleteFileBucket);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockBucket = {
  key: 'bucket-abc',
  name: 'My Bucket',
  tenantId: 'tenant-id-1',
  projectId: 'proj-1',
};

const mockParams = { params: Promise.resolve({ bucketKey: 'bucket-abc' }) };

function makeRequest(method: string, headers: Record<string, string> = {}, search = '') {
  return new NextRequest(`http://localhost/api/files/buckets/bucket-abc${search}`, {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

describe('GET /api/files/buckets/[bucketKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetFileBucket.mockResolvedValue(mockBucket as any);
  });

  it('returns bucket on success', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('bucket');
    expect(body.bucket.key).toBe('bucket-abc');
  });

  it('calls getFileBucket with correct args', async () => {
    await GET(makeRequest('GET'), mockParams);
    expect(mockGetFileBucket).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      'bucket-abc',
    );
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await GET(makeRequest('GET', { 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const req = new NextRequest('http://localhost/api/files/buckets/bucket-abc', {
      headers: { 'x-tenant-db-name': 'tenant_test', 'x-tenant-id': 'tenant-id-1' },
    });
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status when project context fails', async () => {
    const { ProjectContextError } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new ProjectContextError('No active project', 400));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 404 when bucket not found', async () => {
    mockGetFileBucket.mockRejectedValueOnce(new Error('File bucket not found.'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetFileBucket.mockRejectedValueOnce(new Error('DB failure'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/files/buckets/[bucketKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    mockDeleteFileBucket.mockResolvedValue(true);
  });

  it('returns success on deletion', async () => {
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls deleteFileBucket with correct args', async () => {
    await DELETE(makeRequest('DELETE'), mockParams);
    expect(mockDeleteFileBucket).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      'bucket-abc',
      { force: false },
    );
  });

  it('passes force=true from query string', async () => {
    await DELETE(makeRequest('DELETE', {}, '?force=true'), mockParams);
    expect(mockDeleteFileBucket).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      'bucket-abc',
      { force: true },
    );
  });

  it('returns 404 when bucket not found', async () => {
    mockDeleteFileBucket.mockResolvedValueOnce(false);
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 409 when bucket has files and no force', async () => {
    mockDeleteFileBucket.mockRejectedValueOnce(
      new Error('Bucket contains files. Remove files or use force delete.'),
    );
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(409);
  });

  it('returns 401 when x-tenant-id is missing', async () => {
    const req = new NextRequest('http://localhost/api/files/buckets/bucket-abc', {
      headers: { 'x-tenant-db-name': 'tenant_test', 'x-user-id': 'user-1' },
    });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status on project context failure', async () => {
    const { ProjectContextError } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new ProjectContextError('Forbidden', 403));
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeleteFileBucket.mockRejectedValueOnce(new Error('unexpected'));
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(500);
  });
});
