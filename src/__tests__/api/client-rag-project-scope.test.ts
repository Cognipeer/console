/**
 * Regression test for F-02 (finance-institution assessment, 2026-09-05):
 * the client RAG API (`client-rag.ts`) resolved document-list/ingest/query/
 * reingest/delete operations without the caller's project, so a token scoped
 * to project A could see or write into another project's module of the same
 * key (the underlying DB layer treats a missing projectId as "tenant-wide,
 * client API" — see `rag.mixin.ts`). Every one of these calls now threads
 * `ctx.projectId` through; this test locks that contract at the plugin layer
 * so a future edit cannot silently drop it again the way it did here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/services/rag/ragService', () => ({
  createRagModule: vi.fn(),
  deleteRagModule: vi.fn(),
  // A module without access control: the routes answer 404 for a module that is not there.
  getRagModule: vi.fn(async () => ({ key: 'kb' })),
  listRagModules: vi.fn(),
  getRagDocumentFullText: vi.fn(),
  getRagDocumentTextLines: vi.fn(),
  updateRagModule: vi.fn(),
  listRagDocuments: vi.fn(),
  ingestDocument: vi.fn(),
  ingestFile: vi.fn(),
  queryRag: vi.fn(),
  deleteRagDocument: vi.fn(),
  reingestDocument: vi.fn(),
  shapeRagQueryResponse: vi.fn((result: unknown) => result),
}));

vi.mock('@/server/api/plugins/rag', () => ({
  documentInProjectScope: vi.fn(),
  // The modules here have no access control: nothing is hidden, no placement is asked for.
  documentHiddenFor: vi.fn(async () => false),
  readDocumentPlacement: vi.fn(async () => ({})),
  refuseAccessChange: vi.fn(async () => false),
  readDocumentChunkConfig: vi.fn().mockReturnValue(undefined),
  readRagModuleCreateFields: vi.fn(),
  readRagModuleUpdateFields: vi.fn(),
  sendInvalidRequest: vi.fn((reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(400).send({ error: 'invalid' })),
  withoutSourceText: vi.fn((doc: unknown) => doc),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import {
  listRagDocuments,
  ingestDocument,
  ingestFile,
  queryRag,
  deleteRagDocument,
  reingestDocument,
} from '@/lib/services/rag/ragService';
import { RagOcrIncompleteError } from '@/lib/services/rag/errors';
import { documentInProjectScope } from '@/server/api/plugins/rag';
import { clientRagApiPlugin } from '@/server/api/plugins/client-rag';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-a',
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};

const runWithTenant = vi.fn(<T>(_db: string, fn: () => T | Promise<T>) => fn());

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

async function buildApp() {
  return createFastifyApiTestApp(clientRagApiPlugin);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
  mockFn(getDatabase).mockResolvedValue(createMockDb({ runWithTenant } as never));
  mockFn(documentInProjectScope).mockResolvedValue({ _id: 'doc-1', ragModuleKey: 'docs-v1', projectId: 'proj-a' });
});

describe('client RAG API — project scope threaded to every service call', () => {
  it('GET .../documents passes the caller project, not a tenant-wide {} filter', async () => {
    mockFn(listRagDocuments).mockResolvedValue([]);
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/rag/modules/docs-v1/documents',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(200);
    expect(listRagDocuments).toHaveBeenCalledWith('tenant_acme', 'docs-v1', { projectId: 'proj-a' });
  });

  it('POST .../ingest (text) passes the caller project to ingestDocument', async () => {
    mockFn(ingestDocument).mockResolvedValue({ _id: 'doc-1' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/rag/modules/docs-v1/ingest',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { fileName: 'a.txt', content: 'hello' },
    });

    expect(res.statusCode).toBe(201);
    expect(ingestDocument).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-a', expect.objectContaining({
      ragModuleKey: 'docs-v1',
    }));
  });

  it('POST .../ingest (base64 file) passes the caller project to ingestFile', async () => {
    mockFn(ingestFile).mockResolvedValue({ _id: 'doc-1' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/rag/modules/docs-v1/ingest',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { fileName: 'a.pdf', data: Buffer.from('hi').toString('base64') },
    });

    expect(res.statusCode).toBe(201);
    expect(ingestFile).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-a', expect.objectContaining({
      ragModuleKey: 'docs-v1',
    }));
  });

  it('POST .../query passes the caller project to queryRag', async () => {
    mockFn(queryRag).mockResolvedValue({ matches: [] });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/rag/modules/docs-v1/query',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'what is our refund policy?' },
    });

    expect(res.statusCode).toBe(200);
    expect(queryRag).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-a', expect.objectContaining({
      ragModuleKey: 'docs-v1',
      query: 'what is our refund policy?',
    }), expect.objectContaining({ caller: expect.objectContaining({ kind: expect.any(String) }) }));
  });

  it('POST .../query answers 400 for a topK that is not a whole number from 1 to 200, and for an empty query', async () => {
    mockFn(queryRag).mockResolvedValue({ matches: [] });
    const app = await buildApp();
    const post = (payload: Record<string, unknown>) => app.inject({
      method: 'POST',
      url: '/api/client/v1/rag/modules/docs-v1/query',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload,
    });

    for (const topK of [-1, 0, 2.5, 201, 100000, '3', true, {}]) {
      const res = await post({ query: 'q', topK });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('topK');
    }
    expect((await post({ query: '' })).statusCode).toBe(400);
    expect(queryRag).not.toHaveBeenCalled();

    expect((await post({ query: 'q', topK: 200 })).statusCode).toBe(200);
    expect((await post({ query: 'q' })).statusCode).toBe(200);
    expect(queryRag).toHaveBeenCalledTimes(2);
    expect(queryRag).toHaveBeenNthCalledWith(1, 'tenant_acme', 'tenant-1', 'proj-a', expect.objectContaining({ topK: 200 }), expect.anything());
    expect(queryRag).toHaveBeenNthCalledWith(2, 'tenant_acme', 'tenant-1', 'proj-a', expect.objectContaining({ topK: undefined }), expect.anything());
  });

  it('DELETE .../documents/:id passes the caller project to deleteRagDocument', async () => {
    mockFn(deleteRagDocument).mockResolvedValue(true);
    const app = await buildApp();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/client/v1/rag/modules/docs-v1/documents/doc-1',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(200);
    expect(deleteRagDocument).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-a', expect.objectContaining({
      documentId: 'doc-1',
      ragModuleKey: 'docs-v1',
    }));
  });

  it('POST .../documents/:id (reingest) passes the caller project to reingestDocument', async () => {
    mockFn(reingestDocument).mockResolvedValue({ _id: 'doc-1' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/rag/modules/docs-v1/documents/doc-1',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { content: 'updated text' },
    });

    expect(res.statusCode).toBe(200);
    expect(reingestDocument).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-a', expect.objectContaining({
      documentId: 'doc-1',
      ragModuleKey: 'docs-v1',
    }));
  });

  it('does not fall back to documentInProjectScope\'s tenant-wide allowance for delete/reingest', async () => {
    // A document that exists but belongs to a different project must 404,
    // not silently resolve tenant-wide.
    mockFn(documentInProjectScope).mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/client/v1/rag/modules/docs-v1/documents/doc-other-project',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(404);
    expect(deleteRagDocument).not.toHaveBeenCalled();
  });
});

describe('client RAG API — a file whose text could not be read', () => {
  it('POST .../ingest answers 422 with the ocr_incomplete code when OCR could not read a scan', async () => {
    mockFn(ingestFile).mockRejectedValue(new RagOcrIncompleteError('scan.pdf', 'it ran out of time', ['ocr_timeout: slow']));
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/rag/modules/docs-v1/ingest',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { fileName: 'scan.pdf', data: Buffer.from('%PDF').toString('base64') },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Failed to convert "scan.pdf" to text. OCR could not read it: it ran out of time.',
      code: 'ocr_incomplete',
    });
  });
});
