import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

vi.mock('@/lib/services/rag/ragService', () => ({
  listRagModules: vi.fn(),
  getRagModule: vi.fn(),
  deleteRagModule: vi.fn(),
  ingestDocument: vi.fn(),
  ingestFile: vi.fn(),
  queryRag: vi.fn(),
  listRagDocuments: vi.fn(),
  deleteRagDocument: vi.fn(),
  reingestDocument: vi.fn(),
}));

import { GET as listModulesGET } from '@/app/api/client/v1/rag/modules/route';
import { GET as moduleGET, DELETE as moduleDELETE } from '@/app/api/client/v1/rag/modules/[key]/route';
import { POST as ingestPOST } from '@/app/api/client/v1/rag/modules/[key]/ingest/route';
import { POST as queryPOST } from '@/app/api/client/v1/rag/modules/[key]/query/route';
import { GET as documentsGET } from '@/app/api/client/v1/rag/modules/[key]/documents/route';
import { DELETE as docDELETE, POST as reingestPOST } from '@/app/api/client/v1/rag/modules/[key]/documents/[documentId]/route';

import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  listRagModules,
  getRagModule,
  deleteRagModule,
  ingestDocument,
  queryRag,
  listRagDocuments,
  deleteRagDocument,
  reingestDocument,
} from '@/lib/services/rag/ragService';

const mockRequireApiToken = vi.mocked(requireApiToken);
const mockListRagModules = vi.mocked(listRagModules);
const mockGetRagModule = vi.mocked(getRagModule);
const mockDeleteRagModule = vi.mocked(deleteRagModule);
const mockIngestDocument = vi.mocked(ingestDocument);
const mockQueryRag = vi.mocked(queryRag);
const mockListRagDocuments = vi.mocked(listRagDocuments);
const mockDeleteRagDocument = vi.mocked(deleteRagDocument);
const mockReingestDocument = vi.mocked(reingestDocument);

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
  user: { email: 'user@example.com' },
};

const mockModule = { _id: 'm-1', key: 'faq', name: 'FAQ Module', status: 'active' };
const mockModules = [mockModule];
const mockDocument = { _id: 'doc-1', fileName: 'faq.txt', status: 'indexed' };
const mockDocuments = [mockDocument];
const mockQueryResult = { chunks: [{ text: 'Answer', score: 0.9 }], total: 1 };

const keyParams = { params: Promise.resolve({ key: 'faq' }) };
const docParams = { params: Promise.resolve({ key: 'faq', documentId: 'doc-1' }) };

function makeReq(method: string, path: string, body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/client/v1/rag/modules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListRagModules.mockResolvedValue(mockModules as any);
  });

  it('returns list of RAG modules', async () => {
    const res = await listModulesGET(makeReq('GET', '/api/client/v1/rag/modules'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.modules).toHaveLength(1);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await listModulesGET(makeReq('GET', '/api/client/v1/rag/modules'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/client/v1/rag/modules/[key]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetRagModule.mockResolvedValue(mockModule as any);
  });

  it('returns module by key', async () => {
    const res = await moduleGET(makeReq('GET', '/api/client/v1/rag/modules/faq'), keyParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.module.key).toBe('faq');
  });

  it('returns 404 when module not found', async () => {
    mockGetRagModule.mockResolvedValueOnce(null);
    const res = await moduleGET(makeReq('GET', '/api/client/v1/rag/modules/faq'), keyParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await moduleGET(makeReq('GET', '/api/client/v1/rag/modules/faq'), keyParams);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/client/v1/rag/modules/[key]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetRagModule.mockResolvedValue(mockModule as any);
    mockDeleteRagModule.mockResolvedValue(true);
  });

  it('deletes a module', async () => {
    const res = await moduleDELETE(makeReq('DELETE', '/api/client/v1/rag/modules/faq'), keyParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when module not found', async () => {
    mockGetRagModule.mockResolvedValueOnce(null);
    const res = await moduleDELETE(makeReq('DELETE', '/api/client/v1/rag/modules/faq'), keyParams);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/client/v1/rag/modules/[key]/ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockIngestDocument.mockResolvedValue(mockDocument as any);
  });

  it('ingests a text document', async () => {
    const res = await ingestPOST(
      makeReq('POST', '/api/client/v1/rag/modules/faq/ingest', { fileName: 'faq.txt', content: 'Q: What? A: Yes.' }),
      keyParams,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.document).toBeDefined();
  });

  it('returns 400 when fileName is missing', async () => {
    const res = await ingestPOST(
      makeReq('POST', '/api/client/v1/rag/modules/faq/ingest', { content: 'Some text' }),
      keyParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when neither content nor data provided', async () => {
    const res = await ingestPOST(
      makeReq('POST', '/api/client/v1/rag/modules/faq/ingest', { fileName: 'x.txt' }),
      keyParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await ingestPOST(
      makeReq('POST', '/api/client/v1/rag/modules/faq/ingest', { fileName: 'x.txt', content: 'x' }),
      keyParams,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/client/v1/rag/modules/[key]/query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQueryRag.mockResolvedValue(mockQueryResult as any);
  });

  it('queries a RAG module', async () => {
    const res = await queryPOST(
      makeReq('POST', '/api/client/v1/rag/modules/faq/query', { query: 'How does it work?' }),
      keyParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBeDefined();
  });

  it('returns 400 when query is missing', async () => {
    const res = await queryPOST(makeReq('POST', '/api/client/v1/rag/modules/faq/query', {}), keyParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await queryPOST(makeReq('POST', '/api/client/v1/rag/modules/faq/query', { query: 'x' }), keyParams);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/client/v1/rag/modules/[key]/documents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListRagDocuments.mockResolvedValue(mockDocuments as any);
  });

  it('returns list of documents', async () => {
    const res = await documentsGET(makeReq('GET', '/api/client/v1/rag/modules/faq/documents'), keyParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toHaveLength(1);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await documentsGET(makeReq('GET', '/api/client/v1/rag/modules/faq/documents'), keyParams);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/client/v1/rag/modules/[key]/documents/[documentId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockDeleteRagDocument.mockResolvedValue(true);
  });

  it('deletes a document', async () => {
    const res = await docDELETE(makeReq('DELETE', '/api/client/v1/rag/modules/faq/documents/doc-1'), docParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await docDELETE(makeReq('DELETE', '/api/client/v1/rag/modules/faq/documents/doc-1'), docParams);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/client/v1/rag/modules/[key]/documents/[documentId] (reingest)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReingestDocument.mockResolvedValue(mockDocument as any);
  });

  it('reingests a document with new content', async () => {
    const res = await reingestPOST(
      makeReq('POST', '/api/client/v1/rag/modules/faq/documents/doc-1', { content: 'Updated content' }),
      docParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document).toBeDefined();
  });

  it('reingests with empty body (re-use existing)', async () => {
    const res = await reingestPOST(
      makeReq('POST', '/api/client/v1/rag/modules/faq/documents/doc-1', {}),
      docParams,
    );
    expect(res.status).toBe(200);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await reingestPOST(makeReq('POST', '/api/client/v1/rag/modules/faq/documents/doc-1', {}), docParams);
    expect(res.status).toBe(401);
  });
});
