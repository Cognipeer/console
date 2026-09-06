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

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/services/rag/ragService', () => ({
  createRagModule: vi.fn(),
  deleteRagModule: vi.fn(),
  getRagModule: vi.fn(),
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
  readDocumentChunkConfig: vi.fn().mockReturnValue(undefined),
  readRagModuleCreateFields: vi.fn(),
  readRagModuleUpdateFields: vi.fn(),
  sendInvalidRequest: vi.fn((reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(400).send({ error: 'invalid' })),
  withoutSourceText: vi.fn((doc: unknown) => doc),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import {
  listRagDocuments,
  ingestDocument,
  ingestFile,
  queryRag,
  deleteRagDocument,
  reingestDocument,
} from '@/lib/services/rag/ragService';
import { documentInProjectScope } from '@/server/api/plugins/rag';
import { clientRagApiPlugin } from '@/server/api/plugins/client-rag';
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
  mockFn(getDatabase).mockResolvedValue({ runWithTenant });
  mockFn(getPermissionServiceForPath).mockReturnValue(null);
  mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true });
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
    }));
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
