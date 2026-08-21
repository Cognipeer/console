import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: vi.fn().mockResolvedValue('## Converted markdown content'),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: vi.fn().mockResolvedValue({
    response: {
      data: [
        { embedding: [0.1, 0.2, 0.3] },
        { embedding: [0.4, 0.5, 0.6] },
      ],
    },
  }),
}));
vi.mock('@/lib/services/vector/vectorService', () => ({
  upsertVectors: vi.fn().mockResolvedValue({ upserted: 1 }),
  queryVectorIndex: vi.fn().mockResolvedValue({ matches: [] }),
  deleteVectors: vi.fn().mockResolvedValue({ deleted: 1 }),
}));
vi.mock('@/lib/services/reranker', () => ({
  runReranker: vi.fn(),
}));
vi.mock('@/lib/services/files/fileService', () => ({
  uploadFile: vi.fn().mockResolvedValue({ record: { key: 'stored-object-key' } }),
  downloadFile: vi.fn().mockResolvedValue({
    data: Buffer.from('Bytes from the bucket'),
    fileName: 'doc.txt',
    contentType: 'text/plain',
  }),
  deleteFile: vi.fn().mockResolvedValue(true),
}));

import {
  createRagModule,
  updateRagModule,
  deleteRagModule,
  getRagModule,
  getRagModuleById,
  listRagModules,
  listRagDocuments,
  getRagDocument,
  ingestDocument,
  ingestFile,
  queryRag,
  deleteRagDocument,
  reingestDocument,
  reindexReasonForUpdate,
} from '@/lib/services/rag/ragService';
import { hashSourceText, INLINE_SOURCE_MAX_CHARS } from '@/lib/services/rag/ragSource';
import { getDatabase } from '@/lib/database';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { upsertVectors, queryVectorIndex, deleteVectors } from '@/lib/services/vector/vectorService';
import { runReranker } from '@/lib/services/reranker';
import { deleteFile, downloadFile, uploadFile } from '@/lib/services/files/fileService';
import type { IRagDocument } from '@/lib/database';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';

const mockModule = {
  _id: 'ragmod-1',
  key: 'my-rag',
  name: 'My RAG',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  status: 'active' as const,
  embeddingModelKey: 'text-embed-3',
  vectorProviderKey: 'pinecone',
  vectorIndexKey: 'my-index',
  chunkConfig: {
    strategy: 'recursive_character' as const,
    chunkSize: 512,
    chunkOverlap: 50,
  },
  totalDocuments: 0,
  totalChunks: 0,
  createdBy: 'user-1',
};

/** A module wired to a Document Store bucket, so the source can be persisted. */
const mockModuleWithBucket = {
  ...mockModule,
  fileBucketKey: 'kb-bucket',
  fileProviderKey: 'aws-s3',
};

const mockDocument = {
  _id: 'ragdoc-1',
  ragModuleKey: 'my-rag',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  fileName: 'doc.txt',
  contentType: 'text/plain',
  size: 100,
  status: 'indexed' as const,
  chunkCount: 2,
  createdBy: 'user-1',
};

describe('RAG Service', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  // ─── Module CRUD ───────────────────────────────────────────────────

  describe('createRagModule', () => {
    it('creates a RAG module successfully', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      db.createRagModule.mockResolvedValue(mockModule);
      const req = {
        name: 'My RAG',
        embeddingModelKey: 'text-embed-3',
        vectorProviderKey: 'pinecone',
        vectorIndexKey: 'my-index',
        chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 512, chunkOverlap: 50 },
        createdBy: 'user-1',
      };
      const result = await createRagModule(DB_NAME, TENANT_ID, PROJECT_ID, req);
      expect(result).toMatchObject({ key: 'my-rag', status: 'active' });
      expect(db.createRagModule).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID, status: 'active' }));
    });

    it('isolates new modules by module key', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      db.createRagModule.mockResolvedValue(mockModule);
      await createRagModule(DB_NAME, TENANT_ID, PROJECT_ID, {
        name: 'My RAG',
        embeddingModelKey: 'emb',
        vectorProviderKey: 'pin',
        vectorIndexKey: 'idx',
        chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 512, chunkOverlap: 50 },
        createdBy: 'user-1',
      });
      expect(db.createRagModule).toHaveBeenCalledWith(
        expect.objectContaining({ isolateByModule: true }),
      );
    });

    it('honours an explicit isolateByModule of false', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      db.createRagModule.mockResolvedValue(mockModule);
      await createRagModule(DB_NAME, TENANT_ID, PROJECT_ID, {
        name: 'External index',
        embeddingModelKey: 'emb',
        vectorProviderKey: 'pin',
        vectorIndexKey: 'idx',
        chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 512, chunkOverlap: 50 },
        isolateByModule: false,
        createdBy: 'user-1',
      });
      expect(db.createRagModule).toHaveBeenCalledWith(
        expect.objectContaining({ isolateByModule: false }),
      );
    });

    it('switches to tenant database', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      db.createRagModule.mockResolvedValue(mockModule);
      await createRagModule(DB_NAME, TENANT_ID, PROJECT_ID, {
        name: 'X',
        embeddingModelKey: 'emb',
        vectorProviderKey: 'pin',
        vectorIndexKey: 'idx',
        chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 400, chunkOverlap: 0 },
        createdBy: 'user-1',
      });
      expect(db.switchToTenant).toHaveBeenCalledWith(DB_NAME);
    });

    it('throws if module key already exists', async () => {
      db.findRagModuleByKey.mockResolvedValue(mockModule);
      await expect(
        createRagModule(DB_NAME, TENANT_ID, PROJECT_ID, {
          name: 'My RAG',
          key: 'my-rag',
          embeddingModelKey: 'emb',
          vectorProviderKey: 'pin',
          vectorIndexKey: 'idx',
          chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 400, chunkOverlap: 0 },
          createdBy: 'user-1',
        }),
      ).rejects.toThrow(/already exists/i);
    });
  });

  describe('updateRagModule', () => {
    it('updates the module via db', async () => {
      db.updateRagModule.mockResolvedValue({ ...mockModule, name: 'Updated' });
      const result = await updateRagModule(DB_NAME, 'ragmod-1', { name: 'Updated', updatedBy: 'user-1' });
      expect(db.updateRagModule).toHaveBeenCalledWith('ragmod-1', expect.objectContaining({ name: 'Updated' }));
      expect(result?.name).toBe('Updated');
    });

    it('only passes defined fields', async () => {
      db.updateRagModule.mockResolvedValue(mockModule);
      await updateRagModule(DB_NAME, 'ragmod-1', { updatedBy: 'user-1' });
      const call = (db.updateRagModule as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(call.name).toBeUndefined();
      expect(call.updatedBy).toBe('user-1');
    });

    it('flags a re-index when the chunk config moves chunk boundaries', async () => {
      db.findRagModuleById.mockResolvedValue(mockModule);
      db.updateRagModule.mockResolvedValue(mockModule);
      await updateRagModule(DB_NAME, 'ragmod-1', {
        chunkConfig: { strategy: 'recursive_character', chunkSize: 1024, chunkOverlap: 50 },
        updatedBy: 'user-1',
      });
      expect(db.updateRagModule).toHaveBeenCalledWith(
        'ragmod-1',
        expect.objectContaining({ reindexRequired: true }),
      );
    });

    it('flags a re-index when the embedding model changes', async () => {
      db.findRagModuleById.mockResolvedValue(mockModule);
      db.updateRagModule.mockResolvedValue(mockModule);
      await updateRagModule(DB_NAME, 'ragmod-1', {
        embeddingModelKey: 'text-embed-4',
        updatedBy: 'user-1',
      });
      expect(db.updateRagModule).toHaveBeenCalledWith(
        'ragmod-1',
        expect.objectContaining({ reindexRequired: true }),
      );
    });

    it('does not flag a re-index for cosmetic changes', async () => {
      db.findRagModuleById.mockResolvedValue(mockModule);
      db.updateRagModule.mockResolvedValue(mockModule);
      await updateRagModule(DB_NAME, 'ragmod-1', { name: 'Renamed', updatedBy: 'user-1' });
      const call = (db.updateRagModule as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(call.reindexRequired).toBeUndefined();
    });

    it('does not flag a re-index for a parentWindowSize change, which is query-time only', async () => {
      db.findRagModuleById.mockResolvedValue(mockModule);
      db.updateRagModule.mockResolvedValue(mockModule);
      await updateRagModule(DB_NAME, 'ragmod-1', {
        chunkConfig: { ...mockModule.chunkConfig, parentWindowSize: 2048 },
        updatedBy: 'user-1',
      });
      const call = (db.updateRagModule as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(call.reindexRequired).toBeUndefined();
    });
  });

  describe('reindexReasonForUpdate', () => {
    it('names the embedding model as the reason', () => {
      expect(reindexReasonForUpdate(mockModule, { embeddingModelKey: 'other' })).toBe('embedding-model');
    });

    it('names the chunk config as the reason', () => {
      expect(reindexReasonForUpdate(mockModule, {
        chunkConfig: { strategy: 'token', chunkSize: 512, chunkOverlap: 50 },
      })).toBe('chunk-config');
    });

    it('returns undefined when nothing that shapes a vector changed', () => {
      expect(reindexReasonForUpdate(mockModule, {
        embeddingModelKey: mockModule.embeddingModelKey,
        chunkConfig: { ...mockModule.chunkConfig },
      })).toBeUndefined();
    });
  });

  describe('deleteRagModule', () => {
    const moduleDocuments = [
      {
        ...mockDocument,
        _id: 'ragdoc-1',
        chunkCount: 2,
        fileBucketKey: 'kb-bucket',
        sourceTextKey: 'source-1.md',
        fileKey: 'original-1.pdf',
      },
      { ...mockDocument, _id: 'ragdoc-2', chunkCount: 1 },
    ];

    /**
     * Project scoping as the real providers implement it: a projectId filter
     * matches that project alone, and no filter at all lists the module key
     * tenant-wide.
     */
    const listAs = (documents: Array<Partial<IRagDocument>>) => {
      db.listRagDocuments.mockImplementation(async (_key: string, filters?: { projectId?: string }) => (
        filters?.projectId === undefined
          ? documents
          : documents.filter((doc) => doc.projectId === filters.projectId)
      ) as unknown as Promise<IRagDocument[]>);
    };

    const deletedVectorIds = () => (deleteVectors as ReturnType<typeof vi.fn>).mock.calls
      .flatMap((call) => (call[3] as { ids: string[] }).ids);

    beforeEach(() => {
      db.findRagModuleById.mockResolvedValue(mockModuleWithBucket);
      listAs(moduleDocuments);
      db.deleteRagChunksByModuleKey.mockResolvedValue(3);
      db.deleteRagDocumentsByModuleKey.mockResolvedValue(2);
      db.deleteRagModule.mockResolvedValue(true);
    });

    it('deletes the module and returns true', async () => {
      const result = await deleteRagModule(DB_NAME, TENANT_ID, PROJECT_ID, 'ragmod-1');
      expect(result).toBe(true);
      expect(db.deleteRagModule).toHaveBeenCalledWith('ragmod-1');
    });

    it('returns false without touching anything when the module is gone', async () => {
      db.findRagModuleById.mockResolvedValue(null);
      const result = await deleteRagModule(DB_NAME, TENANT_ID, PROJECT_ID, 'ragmod-1');
      expect(result).toBe(false);
      expect(db.deleteRagDocumentsByModuleKey).not.toHaveBeenCalled();
    });

    it("deletes every document's vectors instead of orphaning them", async () => {
      await deleteRagModule(DB_NAME, TENANT_ID, PROJECT_ID, 'ragmod-1');
      expect(deleteVectors).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({
          providerKey: 'pinecone',
          indexKey: 'my-index',
          ids: ['my-rag:ragdoc-1:0', 'my-rag:ragdoc-1:1', 'my-rag:ragdoc-2:0'],
        }),
      );
    });

    it('deletes the chunks and documents the module owned', async () => {
      await deleteRagModule(DB_NAME, TENANT_ID, PROJECT_ID, 'ragmod-1');
      expect(db.deleteRagChunksByModuleKey).toHaveBeenCalledWith('my-rag');
      expect(db.deleteRagDocumentsByModuleKey).toHaveBeenCalledWith('my-rag');
    });

    it('deletes stored sources so the tenant stops paying for them', async () => {
      await deleteRagModule(DB_NAME, TENANT_ID, PROJECT_ID, 'ragmod-1');
      expect(deleteFile).toHaveBeenCalledTimes(2);
      expect(deleteFile).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID, 'kb-bucket', 'source-1.md', expect.any(String),
      );
      expect(deleteFile).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID, 'kb-bucket', 'original-1.pdf', expect.any(String),
      );
    });

    it('still deletes the rows when the vector store is unreachable', async () => {
      (deleteVectors as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('index offline'));
      const result = await deleteRagModule(DB_NAME, TENANT_ID, PROJECT_ID, 'ragmod-1');
      expect(result).toBe(true);
      expect(db.deleteRagDocumentsByModuleKey).toHaveBeenCalledWith('my-rag');
    });

    it("leaves another project's module of the same key completely untouched", async () => {
      // Module keys are unique per project, and the teardown helpers key on
      // ragModuleKey alone: the bulk path would have wiped project B's "my-rag"
      // documents, chunks and vectors along with this one's.
      db.listRagModules.mockResolvedValue([
        mockModuleWithBucket,
        { ...mockModule, _id: 'ragmod-2', projectId: 'proj-2' },
      ]);
      listAs([
        { ...mockDocument, _id: 'ragdoc-1', chunkCount: 2 },
        { ...mockDocument, _id: 'ragdoc-other', projectId: 'proj-2', chunkCount: 1 },
      ]);

      await deleteRagModule(DB_NAME, TENANT_ID, PROJECT_ID, 'ragmod-1');

      expect(db.deleteRagChunksByModuleKey).not.toHaveBeenCalled();
      expect(db.deleteRagDocumentsByModuleKey).not.toHaveBeenCalled();
      expect(db.deleteRagDocument).toHaveBeenCalledWith('ragdoc-1');
      expect(db.deleteRagChunksByDocumentId).toHaveBeenCalledWith('ragdoc-1');
      expect(db.deleteRagDocument).not.toHaveBeenCalledWith('ragdoc-other');
      expect(deletedVectorIds()).not.toContain('my-rag:ragdoc-other:0');
    });

    it('cleans up documents ingested through the client API, which carry no project', async () => {
      // /client/v1 passes projectId undefined, so a document's project never
      // matches its module's. Enumerating project-scoped deleted those rows in
      // bulk and left their vectors and bucket objects behind forever.
      listAs([{
        ...mockDocument,
        _id: 'ragdoc-client',
        projectId: undefined,
        chunkCount: 1,
        fileBucketKey: 'kb-bucket',
        sourceTextKey: 'client-source.md',
      }]);

      await deleteRagModule(DB_NAME, TENANT_ID, PROJECT_ID, 'ragmod-1');

      expect(deletedVectorIds()).toContain('my-rag:ragdoc-client:0');
      expect(deleteFile).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID, 'kb-bucket', 'client-source.md', expect.any(String),
      );
    });
  });

  describe('getRagModule', () => {
    it('returns module by key', async () => {
      db.findRagModuleByKey.mockResolvedValue(mockModule);
      const result = await getRagModule(DB_NAME, 'my-rag', PROJECT_ID);
      expect(result).toMatchObject({ key: 'my-rag' });
      expect(db.findRagModuleByKey).toHaveBeenCalledWith('my-rag', PROJECT_ID);
    });

    it('returns null when not found', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      const result = await getRagModule(DB_NAME, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getRagModuleById', () => {
    it('returns module by id', async () => {
      db.findRagModuleById.mockResolvedValue(mockModule);
      const result = await getRagModuleById(DB_NAME, 'ragmod-1');
      expect(result).toMatchObject({ _id: 'ragmod-1' });
    });
  });

  describe('listRagModules', () => {
    it('returns empty list by default', async () => {
      db.listRagModules.mockResolvedValue([]);
      const result = await listRagModules(DB_NAME);
      expect(result).toEqual([]);
    });

    it('passes filters to db', async () => {
      db.listRagModules.mockResolvedValue([mockModule]);
      const result = await listRagModules(DB_NAME, { projectId: PROJECT_ID, status: 'active' });
      expect(db.listRagModules).toHaveBeenCalledWith({ projectId: PROJECT_ID, status: 'active' });
      expect(result).toHaveLength(1);
    });
  });

  // ─── Document CRUD ─────────────────────────────────────────────────

  describe('listRagDocuments', () => {
    it('returns documents for a module', async () => {
      db.listRagDocuments.mockResolvedValue([mockDocument]);
      const result = await listRagDocuments(DB_NAME, 'my-rag');
      expect(result).toHaveLength(1);
      expect(db.listRagDocuments).toHaveBeenCalledWith('my-rag', undefined);
    });

    it('leaves the inline source out of the listing', async () => {
      db.listRagDocuments.mockResolvedValue([{ ...mockDocument, sourceText: 'a very long document' }]);
      const [document] = await listRagDocuments(DB_NAME, 'my-rag');
      expect(document.sourceText).toBeUndefined();
      expect(document.fileName).toBe('doc.txt');
    });

    it('drops the inline source from every row, not only the first', async () => {
      // Each row can carry INLINE_SOURCE_MAX_CHARS of sourceText, so nothing
      // that leaves this function may still reference one.
      db.listRagDocuments.mockResolvedValue([
        { ...mockDocument, _id: 'a', sourceText: 'x'.repeat(1_000) },
        { ...mockDocument, _id: 'b', sourceText: 'y'.repeat(1_000) },
        { ...mockDocument, _id: 'c' },
      ]);

      const documents = await listRagDocuments(DB_NAME, 'my-rag');

      expect(documents).toHaveLength(3);
      expect(documents.every((doc) => doc.sourceText === undefined)).toBe(true);
    });
  });

  describe('getRagDocument', () => {
    it('returns document by id', async () => {
      db.findRagDocumentById.mockResolvedValue(mockDocument);
      const result = await getRagDocument(DB_NAME, 'ragdoc-1');
      expect(result).toMatchObject({ _id: 'ragdoc-1' });
    });

    it('returns null if not found', async () => {
      db.findRagDocumentById.mockResolvedValue(null);
      const result = await getRagDocument(DB_NAME, 'nope');
      expect(result).toBeNull();
    });
  });

  // ─── ingestDocument ─────────────────────────────────────────────────

  describe('ingestDocument', () => {
    const ingestReq = {
      ragModuleKey: 'my-rag',
      fileName: 'sample.txt',
      content: 'This is a sample document with enough content to be chunked properly.',
      createdBy: 'user-1',
    };

    beforeEach(() => {
      db.findRagModuleByKey.mockResolvedValue(mockModule);
      db.createRagDocument.mockResolvedValue({ ...mockDocument, _id: 'ragdoc-1', status: 'processing', chunkCount: 0 });
      db.updateRagDocument.mockResolvedValue(null);
      db.updateRagModule.mockResolvedValue(null);
      db.bulkInsertRagChunks.mockResolvedValue(undefined);
    });

    it('throws if RAG module not found', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      await expect(ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq)).rejects.toThrow(/not found/i);
    });

    it('throws if RAG module is not active', async () => {
      db.findRagModuleByKey.mockResolvedValue({ ...mockModule, status: 'disabled' });
      await expect(ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq)).rejects.toThrow(/not active/i);
    });

    it('creates document record before embedding', async () => {
      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);
      expect(db.createRagDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          ragModuleKey: 'my-rag',
          fileName: 'sample.txt',
          status: 'processing',
        }),
      );
    });

    it('calls embedding service with chunked texts', async () => {
      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);
      expect(handleEmbeddingRequest).toHaveBeenCalledWith(
        expect.objectContaining({ modelKey: 'text-embed-3' }),
      );
    });

    it('upserts vectors to vector store', async () => {
      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);
      expect(upsertVectors).toHaveBeenCalledWith(
        DB_NAME,
        TENANT_ID,
        PROJECT_ID,
        expect.objectContaining({ providerKey: 'pinecone', indexKey: 'my-index' }),
      );
    });

    it('updates document status to indexed after success', async () => {
      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);
      expect(db.updateRagDocument).toHaveBeenCalledWith(
        'ragdoc-1',
        expect.objectContaining({ status: 'indexed' }),
      );
    });

    it('updates module total counts', async () => {
      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);
      expect(db.updateRagModule).toHaveBeenCalledWith(
        'ragmod-1',
        expect.objectContaining({ totalDocuments: 1 }),
      );
    });

    it('marks document as failed and rethrows on embedding error', async () => {
      (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Embed fail'));
      await expect(ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq)).rejects.toThrow('Embed fail');
      expect(db.updateRagDocument).toHaveBeenCalledWith(
        'ragdoc-1',
        expect.objectContaining({ status: 'failed', errorMessage: 'Embed fail' }),
      );
    });

    it('handles empty content (zero chunks) gracefully', async () => {
      const result = await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...ingestReq, content: '   ' });
      expect(result.chunkCount).toBe(0);
      expect(result.status).toBe('indexed');
    });

    // ── Source persistence ──

    it('stores the extracted text inline with its hash', async () => {
      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);
      expect(db.createRagDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceText: ingestReq.content,
          sourceHash: hashSourceText(ingestReq.content),
        }),
      );
      expect(uploadFile).not.toHaveBeenCalled();
    });

    it('keeps the inline source out of the returned document', async () => {
      const result = await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);
      expect(result.sourceText).toBeUndefined();
    });

    it('uploads the text to the bucket once it outgrows the inline cap', async () => {
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModuleWithBucket,
        chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 20_000, chunkOverlap: 0 },
      });
      const content = 'lorem ipsum '.repeat(Math.ceil(INLINE_SOURCE_MAX_CHARS / 12) + 10);

      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...ingestReq, content });

      expect(uploadFile).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({ bucketKey: 'kb-bucket', contentType: 'text/markdown' }),
      );
      expect(db.createRagDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceTextKey: 'stored-object-key',
          fileBucketKey: 'kb-bucket',
        }),
      );
      const [created] = (db.createRagDocument as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(created.sourceText).toBeUndefined();
    });

    it('ingests anyway when the bucket rejects the upload', async () => {
      db.findRagModuleByKey.mockResolvedValue(mockModuleWithBucket);
      (uploadFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bucket full'));

      const result = await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, {
        ...ingestReq,
        fileData: Buffer.from('raw bytes'),
      });

      expect(result.status).toBe('indexed');
      const [created] = (db.createRagDocument as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(created.fileKey).toBeUndefined();
    });

    // ── Content-hash de-duplication ──

    it('skips re-embedding a document whose content has not changed', async () => {
      db.findRagDocumentByFileName.mockResolvedValue({
        ...mockDocument,
        _id: 'ragdoc-existing',
        sourceHash: hashSourceText(ingestReq.content),
      });

      const result = await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);

      expect(result._id).toBe('ragdoc-existing');
      expect(db.createRagDocument).not.toHaveBeenCalled();
      expect(upsertVectors).not.toHaveBeenCalled();
    });

    it('re-embeds when the same file name arrives with different content', async () => {
      db.findRagDocumentByFileName.mockResolvedValue({
        ...mockDocument,
        _id: 'ragdoc-existing',
        sourceHash: hashSourceText('something else entirely'),
      });

      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);

      expect(db.createRagDocument).toHaveBeenCalled();
      expect(upsertVectors).toHaveBeenCalled();
    });

    it('re-embeds unchanged content when force is set', async () => {
      db.findRagDocumentByFileName.mockResolvedValue({
        ...mockDocument,
        _id: 'ragdoc-existing',
        sourceHash: hashSourceText(ingestReq.content),
      });

      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...ingestReq, force: true });

      expect(db.findRagDocumentByFileName).not.toHaveBeenCalled();
      expect(upsertVectors).toHaveBeenCalled();
    });

    it('re-embeds when the previous attempt for that file name failed', async () => {
      db.findRagDocumentByFileName.mockResolvedValue({
        ...mockDocument,
        _id: 'ragdoc-existing',
        status: 'failed' as const,
        sourceHash: hashSourceText(ingestReq.content),
      });

      await ingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, ingestReq);

      expect(upsertVectors).toHaveBeenCalled();
    });
  });

  // ─── ingestFile ─────────────────────────────────────────────────────

  describe('ingestFile', () => {
    beforeEach(() => {
      db.findRagModuleByKey.mockResolvedValue(mockModuleWithBucket);
      db.createRagDocument.mockResolvedValue({ ...mockDocument, _id: 'ragdoc-1', status: 'processing', chunkCount: 0 });
      db.updateRagDocument.mockResolvedValue(null);
      db.updateRagModule.mockResolvedValue(null);
    });

    it('keeps the original bytes so a re-index can re-run the converter', async () => {
      await ingestFile(DB_NAME, TENANT_ID, PROJECT_ID, {
        ragModuleKey: 'my-rag',
        fileName: 'handbook.txt',
        fileData: Buffer.from('The employee handbook, in plain text.'),
        contentType: 'text/plain',
        createdBy: 'user-1',
      });

      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(uploadFile).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({ bucketKey: 'kb-bucket', fileName: 'handbook.txt' }),
      );
      expect(db.createRagDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          fileKey: 'stored-object-key',
          fileBucketKey: 'kb-bucket',
          fileProviderKey: 'aws-s3',
        }),
      );
    });

    it('stores nothing when the module has no bucket', async () => {
      db.findRagModuleByKey.mockResolvedValue(mockModule);
      await ingestFile(DB_NAME, TENANT_ID, PROJECT_ID, {
        ragModuleKey: 'my-rag',
        fileName: 'handbook.txt',
        fileData: Buffer.from('The employee handbook, in plain text.'),
        contentType: 'text/plain',
        createdBy: 'user-1',
      });
      expect(uploadFile).not.toHaveBeenCalled();
      expect(db.createRagDocument).toHaveBeenCalledWith(
        expect.objectContaining({ sourceText: 'The employee handbook, in plain text.' }),
      );
    });
  });

  // ─── queryRag ───────────────────────────────────────────────────────

  describe('queryRag', () => {
    const queryReq = {
      ragModuleKey: 'my-rag',
      query: 'what is AI?',
      topK: 3,
    };

    beforeEach(() => {
      db.findRagModuleByKey.mockResolvedValue(mockModule);
      (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        matches: [
          { id: 'my-rag:ragdoc-1:0', score: 0.95, metadata: { _documentId: 'ragdoc-1', _fileName: 'doc.txt', _chunkIndex: 0 } },
        ],
      });
      db.findRagChunksByVectorIds.mockResolvedValue([
        { vectorId: 'my-rag:ragdoc-1:0', content: 'Chunk content here', tenantId: TENANT_ID, ragModuleKey: 'my-rag', documentId: 'ragdoc-1', chunkIndex: 0 },
      ]);
      db.createRagQueryLog.mockResolvedValue({ tenantId: TENANT_ID, ragModuleKey: 'my-rag', query: 'what is AI?', topK: 3, matchCount: 1 });
    });

    it('throws if RAG module not found', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      await expect(queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq)).rejects.toThrow(/not found/i);
    });

    it('embeds the query text', async () => {
      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);
      expect(handleEmbeddingRequest).toHaveBeenCalledWith(
        expect.objectContaining({ modelKey: 'text-embed-3' }),
      );
    });

    it('queries vector store with embedded vector', async () => {
      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);
      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME,
        TENANT_ID,
        PROJECT_ID,
        expect.objectContaining({ providerKey: 'pinecone', indexKey: 'my-index' }),
      );
    });

    it('returns matches with hydrated content', async () => {
      const result = await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].content).toBe('Chunk content here');
      expect(result.matches[0].score).toBe(0.95);
    });

    it('logs the query with its retrieval telemetry', async () => {
      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);
      expect(db.createRagQueryLog).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          ragModuleKey: 'my-rag',
          query: 'what is AI?',
          topK: 3,
          matchCount: 1,
          preFilterMatchCount: 1,
          topScore: 0.95,
          avgScore: 0.95,
          hybrid: false,
          latencyMs: expect.any(Number),
          metadata: expect.objectContaining({
            embeddingMs: expect.any(Number),
            vectorLatencyMs: expect.any(Number),
          }),
        }),
      );
    });

    it('records what the threshold discarded, not just what survived', async () => {
      (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        matches: [
          { id: 'a', score: 0.4, metadata: {} },
          { id: 'b', score: 0.3, metadata: {} },
        ],
      });
      db.findRagChunksByVectorIds.mockResolvedValue([]);

      const result = await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, { ...queryReq, minScore: 0.8 });

      expect(result.matches).toHaveLength(0);
      expect(db.createRagQueryLog).toHaveBeenCalledWith(
        expect.objectContaining({
          matchCount: 0,
          preFilterMatchCount: 2,
          minScoreApplied: 0.8,
          // The best score the STORE returned. Logging the surviving best would
          // put a 0 in front of the zero-result panel and the histogram, which
          // exist to explain and re-tune exactly this query.
          topScore: 0.4,
          avgScore: 0,
        }),
      );
    });

    // ── Threshold scale ──

    it('thresholds a reranked module on the reranker score, not the pre-rerank similarity', async () => {
      // vectorScore is ALWAYS the pre-rerank similarity, so thresholding on it
      // applies the operator's calibrated number to a distribution they never
      // saw — quietly emptying a module that has both a reranker and a minScore.
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        rerankerKey: 'my-reranker',
        defaultMinScore: 0.8,
      });
      (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        matches: [{ id: 'my-rag:ragdoc-1:0', score: 0.42, metadata: {} }],
      });
      (runReranker as ReturnType<typeof vi.fn>).mockResolvedValue({
        latencyMs: 7,
        results: [{ index: 0, id: 'my-rag:ragdoc-1:0', score: 0.93, originalScore: 0.42, content: 'Chunk content here' }],
      });

      const result = await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].score).toBe(0.93);
    });

    it('judges every hybrid match on one scale, dense-found or keyword-only', async () => {
      // Under 'rrf' only the matches the dense channel found carry denseScore,
      // so preferring it put one threshold against two different scales inside
      // a single result list — the dense-found match was dropped and the
      // keyword-only one kept, in that order.
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        hybrid: { enabled: true, mode: 'rrf' as const },
        defaultMinScore: 0.5,
      });
      (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        matches: [
          { id: 'dense-found', score: 0.9, denseScore: 0.31, metadata: {} },
          { id: 'keyword-only', score: 0.7, lexicalScore: 12.4, metadata: {} },
        ],
      });
      db.findRagChunksByVectorIds.mockResolvedValue([]);

      const result = await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      expect(result.matches.map((m) => m.id)).toEqual(['dense-found', 'keyword-only']);
    });

    it('returns correct metadata fields', async () => {
      const result = await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);
      expect(result.query).toBe('what is AI?');
      expect(result.ragModuleKey).toBe('my-rag');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('uses topK=5 by default', async () => {
      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, { ragModuleKey: 'my-rag', query: 'test' });
      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({ query: expect.objectContaining({ topK: 5 }) }),
      );
    });

    it('applies filter when provided', async () => {
      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, { ...queryReq, filter: { category: 'tech' } });
      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({ query: expect.objectContaining({ filter: { category: 'tech' } }) }),
      );
    });

    it("ANDs the module's default filter into every query", async () => {
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        defaultFilter: { source: 'crawler' },
      });

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, { ...queryReq, filter: { category: 'tech' } });

      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({
          query: expect.objectContaining({
            filter: { $and: [{ source: 'crawler' }, { category: 'tech' }] },
          }),
        }),
      );
    });

    it("applies the module's default filter when the caller sends none", async () => {
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        defaultFilter: { source: 'crawler' },
      });

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({
          query: expect.objectContaining({ filter: { source: 'crawler' } }),
        }),
      );
    });

    it('rejects a filter on a field the module does not expose', async () => {
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        filterableFields: ['source', 'depth'],
      });

      await expect(
        queryRag(DB_NAME, TENANT_ID, PROJECT_ID, { ...queryReq, filter: { secret: 'x' } }),
      ).rejects.toThrow(/not allowed/i);
      expect(queryVectorIndex).not.toHaveBeenCalled();
    });

    it('allows a filter that stays within the exposed fields', async () => {
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        filterableFields: ['source', 'depth'],
      });

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, {
        ...queryReq,
        filter: { source: 'crawler', depth: { $lte: 2 } },
      });

      expect(queryVectorIndex).toHaveBeenCalled();
    });

    it('rejects a malformed filter before touching the vector store', async () => {
      await expect(
        queryRag(DB_NAME, TENANT_ID, PROJECT_ID, { ...queryReq, filter: { depth: { $gt: 'high' } } }),
      ).rejects.toThrow(/requires a number/);
      expect(queryVectorIndex).not.toHaveBeenCalled();
    });

    // ── Module isolation ──

    it('ANDs the module key in when isolation is on', async () => {
      db.findRagModuleByKey.mockResolvedValue({ ...mockModule, isolateByModule: true });

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({
          query: expect.objectContaining({ filter: { _ragModule: 'my-rag' } }),
        }),
      );
    });

    it('keeps the default and request filters alongside the isolation guard', async () => {
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        isolateByModule: true,
        defaultFilter: { source: 'crawler' },
      });

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, { ...queryReq, filter: { category: 'tech' } });

      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({
          query: expect.objectContaining({
            filter: {
              $and: [{ source: 'crawler' }, { category: 'tech' }, { _ragModule: 'my-rag' }],
            },
          }),
        }),
      );
    });

    it('defaults isolation on when another module shares the index', async () => {
      db.countRagModulesByVectorIndexKey.mockResolvedValue(1);

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      expect(db.countRagModulesByVectorIndexKey).toHaveBeenCalledWith(
        'my-index',
        { projectId: PROJECT_ID, excludeKey: 'my-rag' },
      );
      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({
          query: expect.objectContaining({ filter: { _ragModule: 'my-rag' } }),
        }),
      );
    });

    it('leaves isolation off for a sole owner, whose index may be externally populated', async () => {
      db.countRagModulesByVectorIndexKey.mockResolvedValue(0);

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({ query: expect.objectContaining({ filter: undefined }) }),
      );
    });

    it('never isolates a module that opted out, however many share the index', async () => {
      db.findRagModuleByKey.mockResolvedValue({ ...mockModule, isolateByModule: false });
      db.countRagModulesByVectorIndexKey.mockResolvedValue(4);

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      expect(db.countRagModulesByVectorIndexKey).not.toHaveBeenCalled();
      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({ query: expect.objectContaining({ filter: undefined }) }),
      );
    });

    // ── Hybrid ──

    it('passes the query text and fusion settings when hybrid is enabled', async () => {
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        hybrid: { enabled: true, mode: 'weighted' as const, alpha: 0.7 },
      });

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      expect(queryVectorIndex).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({
          query: expect.objectContaining({
            text: 'what is AI?',
            hybrid: { mode: 'weighted', alpha: 0.7, k: undefined },
          }),
        }),
      );
      expect(db.createRagQueryLog).toHaveBeenCalledWith(
        expect.objectContaining({ hybrid: true }),
      );
    });

    it('sends no query text when hybrid is off', async () => {
      db.findRagModuleByKey.mockResolvedValue({
        ...mockModule,
        hybrid: { enabled: false, mode: 'rrf' as const },
      });

      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

      const [, , , request] = (queryVectorIndex as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(request.query.text).toBeUndefined();
      expect(request.query.hybrid).toBeUndefined();
    });

    // ── Parent windows ──

    describe('parent windows', () => {
      const source = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.';

      beforeEach(() => {
        db.findRagModuleByKey.mockResolvedValue({
          ...mockModule,
          chunkConfig: { ...mockModule.chunkConfig, parentWindowSize: 600 },
        });
        db.findRagChunksByVectorIds.mockResolvedValue([{
          vectorId: 'my-rag:ragdoc-1:0',
          content: 'Delta epsilon zeta.',
          charStart: 18,
          charEnd: 37,
          tenantId: TENANT_ID,
          ragModuleKey: 'my-rag',
          documentId: 'ragdoc-1',
          chunkIndex: 0,
        }]);
      });

      it('returns the window around the chunk rather than the chunk', async () => {
        db.findRagDocumentById.mockResolvedValue({ ...mockDocument, sourceText: source });

        const result = await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

        expect(result.matches[0].content).toBe(source);
      });

      it('reads each document source once however many matches it produced', async () => {
        (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
          matches: [
            { id: 'my-rag:ragdoc-1:0', score: 0.95, metadata: { _documentId: 'ragdoc-1' } },
            { id: 'my-rag:ragdoc-1:1', score: 0.91, metadata: { _documentId: 'ragdoc-1' } },
          ],
        });
        db.findRagDocumentById.mockResolvedValue({ ...mockDocument, sourceText: source });

        await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

        expect(db.findRagDocumentById).toHaveBeenCalledTimes(1);
      });

      it('falls back to the chunk when the source is gone', async () => {
        db.findRagDocumentById.mockResolvedValue({ ...mockDocument });

        const result = await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

        expect(result.matches[0].content).toBe('Delta epsilon zeta.');
      });

      it('touches no document when the module has no parent window', async () => {
        db.findRagModuleByKey.mockResolvedValue(mockModule);

        await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);

        expect(db.findRagDocumentById).not.toHaveBeenCalled();
      });
    });
  });

  // ─── deleteRagDocument ──────────────────────────────────────────────

  describe('deleteRagDocument', () => {
    const deleteReq = { ragModuleKey: 'my-rag', documentId: 'ragdoc-1' };

    beforeEach(() => {
      db.findRagModuleByKey.mockResolvedValue({ ...mockModule, totalDocuments: 3, totalChunks: 10 });
      db.findRagDocumentById.mockResolvedValue({ ...mockDocument, chunkCount: 3 });
      db.updateRagModule.mockResolvedValue(null);
      db.deleteRagDocument.mockResolvedValue(true);
      db.deleteRagChunksByDocumentId.mockResolvedValue(3);
    });

    it('throws if RAG module not found', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      await expect(deleteRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, deleteReq)).rejects.toThrow(/not found/i);
    });

    it('throws if document not found', async () => {
      db.findRagDocumentById.mockResolvedValue(null);
      await expect(deleteRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, deleteReq)).rejects.toThrow(/Document not found/i);
    });

    it('deletes vectors from vector store', async () => {
      await deleteRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, deleteReq);
      expect(deleteVectors).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({ providerKey: 'pinecone', indexKey: 'my-index' }),
      );
    });

    it('deletes chunk records from MongoDB', async () => {
      await deleteRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, deleteReq);
      expect(db.deleteRagChunksByDocumentId).toHaveBeenCalledWith('ragdoc-1');
    });

    it('updates module stats after deletion', async () => {
      await deleteRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, deleteReq);
      expect(db.updateRagModule).toHaveBeenCalledWith(
        'ragmod-1',
        expect.objectContaining({ totalDocuments: 2, totalChunks: 7 }),
      );
    });

    it('deletes the document record and returns true', async () => {
      const result = await deleteRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, deleteReq);
      expect(result).toBe(true);
      expect(db.deleteRagDocument).toHaveBeenCalledWith('ragdoc-1');
    });

    it('skips vector deletion when chunkCount is 0', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...mockDocument, chunkCount: 0 });
      await deleteRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, deleteReq);
      expect(deleteVectors).not.toHaveBeenCalled();
    });

    it('deletes the stored source alongside the record', async () => {
      db.findRagDocumentById.mockResolvedValue({
        ...mockDocument,
        chunkCount: 3,
        fileBucketKey: 'kb-bucket',
        sourceTextKey: 'source-1.md',
        fileKey: 'original-1.pdf',
      });

      await deleteRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, deleteReq);

      expect(deleteFile).toHaveBeenCalledTimes(2);
    });
  });

  // ─── reingestDocument ───────────────────────────────────────────────

  describe('reingestDocument', () => {
    const reingestReq = {
      ragModuleKey: 'my-rag',
      documentId: 'ragdoc-1',
      updatedBy: 'user-1',
    };

    beforeEach(() => {
      db.findRagModuleByKey.mockResolvedValue(mockModuleWithBucket);
      db.updateRagDocument.mockResolvedValue(null);
      db.updateRagModule.mockResolvedValue(null);
      db.deleteRagChunksByDocumentId.mockResolvedValue(2);
    });

    const indexedText = () => {
      const [rows] = (db.bulkInsertRagChunks as ReturnType<typeof vi.fn>).mock.calls[0];
      return (rows as Array<{ content: string }>).map((r) => r.content).join('');
    };

    it('re-runs the converter over the stored original bytes', async () => {
      db.findRagDocumentById.mockResolvedValue({
        ...mockDocument,
        fileBucketKey: 'kb-bucket',
        fileKey: 'original-1.txt',
        sourceText: 'A stale extraction',
      });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, reingestReq);

      expect(downloadFile).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID, 'kb-bucket', 'original-1.txt',
      );
      expect(indexedText()).toContain('Bytes from the bucket');
    });

    it('falls back to the stored text when there are no original bytes', async () => {
      db.findRagDocumentById.mockResolvedValue({
        ...mockDocument,
        sourceText: 'The document exactly as it was indexed.',
      });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, reingestReq);

      expect(db.findRagChunksByDocumentId).not.toHaveBeenCalled();
      expect(indexedText()).toContain('The document exactly as it was indexed.');
    });

    it('prefers explicit content over anything stored', async () => {
      db.findRagDocumentById.mockResolvedValue({
        ...mockDocument,
        fileBucketKey: 'kb-bucket',
        fileKey: 'original-1.txt',
        sourceText: 'The stored text',
      });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, {
        ...reingestReq,
        content: 'Fresh content from the caller',
      });

      expect(downloadFile).not.toHaveBeenCalled();
      expect(indexedText()).toContain('Fresh content from the caller');
    });

    it('joins the chunks only when no source survives at all', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...mockDocument });
      db.findRagChunksByDocumentId.mockResolvedValue([
        { vectorId: 'v0', content: 'first half', tenantId: TENANT_ID, ragModuleKey: 'my-rag', documentId: 'ragdoc-1', chunkIndex: 0 },
        { vectorId: 'v1', content: 'half second', tenantId: TENANT_ID, ragModuleKey: 'my-rag', documentId: 'ragdoc-1', chunkIndex: 1 },
      ]);

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, reingestReq);

      expect(indexedText()).toContain('first half');
    });

    it('throws when there is neither a source nor a chunk to rebuild from', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...mockDocument });
      db.findRagChunksByDocumentId.mockResolvedValue([]);

      await expect(
        reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, reingestReq),
      ).rejects.toThrow(/no existing chunks/i);
    });

    it('stores the new source and drops the object it replaced', async () => {
      db.findRagDocumentById.mockResolvedValue({
        ...mockDocument,
        fileBucketKey: 'kb-bucket',
        sourceTextKey: 'old-source.md',
        sourceText: 'The previous extraction',
      });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, {
        ...reingestReq,
        content: 'Fresh content from the caller',
      });

      expect(deleteFile).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID, 'kb-bucket', 'old-source.md', 'user-1',
      );
      expect(db.updateRagDocument).toHaveBeenLastCalledWith(
        'ragdoc-1',
        expect.objectContaining({
          status: 'indexed',
          sourceText: 'Fresh content from the caller',
          sourceHash: hashSourceText('Fresh content from the caller'),
          sourceTextKey: undefined,
        }),
      );
    });

    it('leaves the bucket alone when the content is unchanged', async () => {
      const unchanged = 'The document exactly as it was indexed.';
      db.findRagDocumentById.mockResolvedValue({
        ...mockDocument,
        sourceText: unchanged,
        sourceHash: hashSourceText(unchanged),
      });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, reingestReq);

      expect(uploadFile).not.toHaveBeenCalled();
      expect(deleteFile).not.toHaveBeenCalled();
    });

    it('never promotes a chunk join to the stored source', async () => {
      // The join repeats every overlap region. Storing it would make that
      // corruption the document's canonical, authoritative source for every
      // future re-index.
      db.findRagDocumentById.mockResolvedValue({ ...mockDocument });
      db.findRagChunksByDocumentId.mockResolvedValue([
        { vectorId: 'v0', content: 'first half overlap', tenantId: TENANT_ID, ragModuleKey: 'my-rag', documentId: 'ragdoc-1', chunkIndex: 0 },
        { vectorId: 'v1', content: 'overlap second half', tenantId: TENANT_ID, ragModuleKey: 'my-rag', documentId: 'ragdoc-1', chunkIndex: 1 },
      ]);

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, reingestReq);

      expect(uploadFile).not.toHaveBeenCalled();
      const [, update] = (db.updateRagDocument as ReturnType<typeof vi.fn>).mock.lastCall!;
      expect(update.sourceText).toBeUndefined();
      expect(update.sourceTextKey).toBeUndefined();
      expect(update.sourceHash).toBeUndefined();
    });

    // ── Metadata ──

    const indexedMetadata = () => {
      const [rows] = (db.bulkInsertRagChunks as ReturnType<typeof vi.fn>).mock.calls[0];
      return (rows as Array<{ metadata: Record<string, unknown> }>)[0].metadata;
    };
    const vectorMetadata = () => {
      const call = (upsertVectors as ReturnType<typeof vi.fn>).mock.calls[0];
      return (call[3] as { vectors: Array<{ metadata: Record<string, unknown> }> }).vectors[0].metadata;
    };

    it("keeps the document's own metadata when the re-index job supplies none", async () => {
      // The re-index job calls this with no metadata at all, and those keys are
      // exactly what defaultFilter/filterableFields filter on — stripping them
      // made every filtered query return nothing after a re-index.
      db.findRagDocumentById.mockResolvedValue({
        ...mockDocument,
        sourceText: 'The document exactly as it was indexed.',
        metadata: { source: 'crawler', url: 'https://example.com/a' },
      });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, reingestReq);

      expect(indexedMetadata()).toMatchObject({ source: 'crawler', url: 'https://example.com/a' });
      expect(vectorMetadata()).toMatchObject({ source: 'crawler', url: 'https://example.com/a' });
    });

    it('lets explicit re-index metadata override a key without erasing the rest', async () => {
      db.findRagDocumentById.mockResolvedValue({
        ...mockDocument,
        sourceText: 'The document exactly as it was indexed.',
        metadata: { source: 'crawler', url: 'https://example.com/a' },
      });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, {
        ...reingestReq,
        metadata: { source: 'manual' },
      });

      expect(vectorMetadata()).toMatchObject({ source: 'manual', url: 'https://example.com/a' });
      // The row has to agree with the vectors about what it is filterable by.
      const [, update] = (db.updateRagDocument as ReturnType<typeof vi.fn>).mock.lastCall!;
      expect(update.metadata).toEqual({ source: 'manual', url: 'https://example.com/a' });
    });

    it('deletes the old vectors before writing the new ones', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...mockDocument, chunkCount: 2, sourceText: 'Some source text' });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, reingestReq);

      expect(deleteVectors).toHaveBeenCalledWith(
        DB_NAME, TENANT_ID, PROJECT_ID,
        expect.objectContaining({ ids: ['my-rag:ragdoc-1:0', 'my-rag:ragdoc-1:1'] }),
      );
    });
  });
});
