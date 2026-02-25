import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/files', () => ({
  deleteFile: vi.fn(),
  downloadFile: vi.fn(),
  getFileRecord: vi.fn(),
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

import { GET, DELETE } from '@/app/api/files/buckets/[bucketKey]/objects/[...objectKey]/route';
import { deleteFile, downloadFile, getFileRecord } from '@/lib/services/files';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockDeleteFile = vi.mocked(deleteFile);
const mockDownloadFile = vi.mocked(downloadFile);
const mockGetFileRecord = vi.mocked(getFileRecord);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockRecord = { key: 'folder/file.txt', size: 100, contentType: 'text/plain' };
const mockParams = { params: Promise.resolve({ bucketKey: 'bucket-1', objectKey: ['folder', 'file.txt'] }) };

function makeRequest(method: 'GET' | 'DELETE', search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/files/buckets/bucket-1/objects/folder/file.txt${search}`, {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

describe('GET /api/files/buckets/[bucketKey]/objects/[...objectKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetFileRecord.mockResolvedValue(mockRecord as any);
  });

  it('returns file record metadata', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record).toBeDefined();
  });

  it('calls getFileRecord with correct args', async () => {
    await GET(makeRequest('GET'), mockParams);
    expect(mockGetFileRecord).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      'bucket-1',
      'folder/file.txt',
    );
  });

  it('returns binary response when download param is set', async () => {
    mockDownloadFile.mockResolvedValueOnce({
      data: Buffer.from('Hello World'),
      contentType: 'text/plain',
      fileName: 'file.txt',
      size: 11,
    } as never);

    const res = await GET(makeRequest('GET', '?download=true'), mockParams);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
  });

  it('returns 401 when headers missing', async () => {
    const res = await GET(makeRequest('GET', '', { 'x-user-id': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when file not found', async () => {
    mockGetFileRecord.mockRejectedValueOnce(new Error('File record not found.'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 409 for markdown conversion unavailable', async () => {
    mockDownloadFile.mockRejectedValueOnce(new Error('Markdown conversion not available for this file.'));
    const res = await GET(makeRequest('GET', '?download=markdown'), mockParams);
    expect(res.status).toBe(409);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetFileRecord.mockRejectedValueOnce(new Error('S3 error'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/files/buckets/[bucketKey]/objects/[...objectKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    mockDeleteFile.mockResolvedValue(true);
  });

  it('deletes a file and returns success', async () => {
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls deleteFile with correct args', async () => {
    await DELETE(makeRequest('DELETE'), mockParams);
    expect(mockDeleteFile).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      'bucket-1',
      'folder/file.txt',
      'user-1',
    );
  });

  it('returns 401 when headers missing', async () => {
    const res = await DELETE(makeRequest('DELETE', '', { 'x-tenant-id': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when file not found', async () => {
    mockDeleteFile.mockRejectedValueOnce(new Error('File record not found.'));
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeleteFile.mockRejectedValueOnce(new Error('Storage error'));
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(500);
  });
});
