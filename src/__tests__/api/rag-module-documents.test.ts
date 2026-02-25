import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/rag/ragService', () => ({
  listRagDocuments: vi.fn(),
  ingestDocument: vi.fn(),
  ingestFile: vi.fn(),
}));

import { GET, POST } from '@/app/api/rag/modules/[key]/documents/route';
import { listRagDocuments, ingestDocument, ingestFile } from '@/lib/services/rag/ragService';

const mockListRagDocuments = vi.mocked(listRagDocuments);
const mockIngestDocument = vi.mocked(ingestDocument);
const mockIngestFile = vi.mocked(ingestFile);

const mockDocs = [
  { _id: 'doc-1', fileName: 'hello.txt', ragModuleKey: 'mod-1' },
  { _id: 'doc-2', fileName: 'world.md', ragModuleKey: 'mod-1' },
];

const mockParams = { params: Promise.resolve({ key: 'mod-1' }) };

function makeGetRequest(headers: Record<string, string> = {}, search = '') {
  return new NextRequest(`http://localhost/api/rag/modules/mod-1/documents${search}`, {
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

function makePostRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/rag/modules/mod-1/documents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('GET /api/rag/modules/[key]/documents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListRagDocuments.mockResolvedValue(mockDocs as any);
  });

  it('returns document list on success', async () => {
    const res = await GET(makeGetRequest(), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('documents');
    expect(body.documents).toHaveLength(2);
  });

  it('calls listRagDocuments with correct args', async () => {
    await GET(makeGetRequest(), mockParams);
    expect(mockListRagDocuments).toHaveBeenCalledWith(
      'tenant_test',
      'mod-1',
      expect.objectContaining({ projectId: undefined }),
    );
  });

  it('passes x-project-id as projectId', async () => {
    await GET(makeGetRequest({ 'x-project-id': 'proj-abc' }), mockParams);
    expect(mockListRagDocuments).toHaveBeenCalledWith(
      'tenant_test',
      'mod-1',
      expect.objectContaining({ projectId: 'proj-abc' }),
    );
  });

  it('passes search query param', async () => {
    await GET(makeGetRequest({}, '?search=hello'), mockParams);
    expect(mockListRagDocuments).toHaveBeenCalledWith(
      'tenant_test',
      'mod-1',
      expect.objectContaining({ search: 'hello' }),
    );
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await GET(makeGetRequest({ 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    mockListRagDocuments.mockRejectedValueOnce(new Error('DB failure'));
    const res = await GET(makeGetRequest(), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/rag/modules/[key]/documents', () => {
  const mockDocument = { _id: 'doc-3', fileName: 'new.txt', ragModuleKey: 'mod-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockIngestDocument.mockResolvedValue(mockDocument as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockIngestFile.mockResolvedValue(mockDocument as any);
  });

  it('ingests text document and returns 201', async () => {
    const res = await POST(makePostRequest({ fileName: 'test.txt', content: 'Hello world' }), mockParams);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('document');
  });

  it('calls ingestDocument for text mode', async () => {
    await POST(makePostRequest({ fileName: 'test.txt', content: 'Hello world' }), mockParams);
    expect(mockIngestDocument).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      undefined,
      expect.objectContaining({ ragModuleKey: 'mod-1', fileName: 'test.txt', content: 'Hello world' }),
    );
  });

  it('uses ingestFile when data (base64) is provided', async () => {
    const base64 = Buffer.from('file content').toString('base64');
    const res = await POST(
      makePostRequest({ fileName: 'file.pdf', data: base64, contentType: 'application/pdf' }),
      mockParams,
    );
    expect(res.status).toBe(201);
    expect(mockIngestFile).toHaveBeenCalled();
    expect(mockIngestDocument).not.toHaveBeenCalled();
  });

  it('decodes data URL format', async () => {
    const dataUrl = 'data:text/plain;base64,' + Buffer.from('hello').toString('base64');
    await POST(makePostRequest({ fileName: 'note.txt', data: dataUrl }), mockParams);
    expect(mockIngestFile).toHaveBeenCalled();
  });

  it('returns 400 when fileName is missing', async () => {
    const res = await POST(makePostRequest({ content: 'No filename here' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when neither content nor data is provided', async () => {
    const res = await POST(makePostRequest({ fileName: 'empty.txt' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await POST(makePostRequest({ fileName: 'test.txt', content: 'hi' }, { 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-tenant-id is missing', async () => {
    const req = new NextRequest('http://localhost/api/rag/modules/mod-1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-db-name': 'tenant_test' },
      body: JSON.stringify({ fileName: 'test.txt', content: 'hello' }),
    });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on ingestDocument error', async () => {
    mockIngestDocument.mockRejectedValueOnce(new Error('Embedding failed'));
    const res = await POST(makePostRequest({ fileName: 'fail.txt', content: 'fail' }), mockParams);
    expect(res.status).toBe(500);
  });
});
