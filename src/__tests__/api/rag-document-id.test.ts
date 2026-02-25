import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/rag/ragService', () => ({
  getRagDocument: vi.fn(),
  deleteRagDocument: vi.fn(),
  reingestDocument: vi.fn(),
}));

import { GET, DELETE, POST } from '@/app/api/rag/modules/[key]/documents/[documentId]/route';
import { deleteRagDocument, reingestDocument } from '@/lib/services/rag/ragService';

// getRagDocument is exported as getRagDocumentService in the module, imported as getRagDocument
import * as ragService from '@/lib/services/rag/ragService';

const mockGetRagDocument = vi.mocked(ragService.getRagDocument);
const mockDeleteRagDocument = vi.mocked(deleteRagDocument);
const mockReingestDocument = vi.mocked(reingestDocument);

const mockDoc = { _id: 'doc-1', fileName: 'test.txt', ragModuleKey: 'mod-1', content: 'hello' };
const mockParams = { params: Promise.resolve({ key: 'mod-1', documentId: 'doc-1' }) };

function makeRequest(method: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/rag/modules/mod-1/documents/doc-1', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/rag/modules/[key]/documents/[documentId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetRagDocument.mockResolvedValue(mockDoc as any);
  });

  it('returns document on success', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('document');
    expect(body.document._id).toBe('doc-1');
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await GET(makeRequest('GET', undefined, { 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when document not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetRagDocument.mockResolvedValueOnce(null as any);
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on service error', async () => {
    mockGetRagDocument.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/rag/modules/[key]/documents/[documentId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteRagDocument.mockResolvedValue(true);
  });

  it('deletes document and returns success', async () => {
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls deleteRagDocument with correct args', async () => {
    await DELETE(makeRequest('DELETE'), mockParams);
    expect(mockDeleteRagDocument).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      undefined,
      expect.objectContaining({ ragModuleKey: 'mod-1', documentId: 'doc-1' }),
    );
  });

  it('passes x-project-id as projectId', async () => {
    await DELETE(makeRequest('DELETE', undefined, { 'x-project-id': 'proj-1' }), mockParams);
    expect(mockDeleteRagDocument).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      expect.any(Object),
    );
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await DELETE(makeRequest('DELETE', undefined, { 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-tenant-id is missing', async () => {
    const req = new NextRequest('http://localhost/api/rag/modules/mod-1/documents/doc-1', {
      method: 'DELETE',
      headers: { 'x-tenant-db-name': 'tenant_test' },
    });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    mockDeleteRagDocument.mockRejectedValueOnce(new Error('Delete failed'));
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/rag/modules/[key]/documents/[documentId] (reingest)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReingestDocument.mockResolvedValue(mockDoc as any);
  });

  it('reingests with text content', async () => {
    const res = await POST(makeRequest('POST', { content: 'new content' }), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('document');
  });

  it('calls reingestDocument with correct args for text', async () => {
    await POST(makeRequest('POST', { content: 'updated' }), mockParams);
    expect(mockReingestDocument).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      undefined,
      expect.objectContaining({ ragModuleKey: 'mod-1', documentId: 'doc-1', content: 'updated' }),
    );
  });

  it('handles reingest with base64 data', async () => {
    const data = Buffer.from('file data').toString('base64');
    await POST(makeRequest('POST', { data, fileName: 'refile.txt' }), mockParams);
    expect(mockReingestDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      expect.objectContaining({ fileData: expect.any(Buffer), fileName: 'refile.txt' }),
    );
  });

  it('handles empty body (reingest from existing content)', async () => {
    const res = await POST(makeRequest('POST', {}), mockParams);
    expect(res.status).toBe(200);
    expect(mockReingestDocument).toHaveBeenCalled();
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await POST(makeRequest('POST', { content: 'hi' }, { 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    mockReingestDocument.mockRejectedValueOnce(new Error('reingest failed'));
    const res = await POST(makeRequest('POST', {}), mockParams);
    expect(res.status).toBe(500);
  });
});
