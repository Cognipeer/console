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
  queryRag,
  deleteRagDocument,
} from '@/lib/services/rag/ragService';
import { getDatabase } from '@/lib/database';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { upsertVectors, queryVectorIndex, deleteVectors } from '@/lib/services/vector/vectorService';

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
  });

  describe('deleteRagModule', () => {
    it('deletes the module and returns true', async () => {
      db.deleteRagModule.mockResolvedValue(true);
      const result = await deleteRagModule(DB_NAME, 'ragmod-1');
      expect(result).toBe(true);
      expect(db.deleteRagModule).toHaveBeenCalledWith('ragmod-1');
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

    it('logs the query', async () => {
      await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, queryReq);
      expect(db.createRagQueryLog).toHaveBeenCalledWith(
        expect.objectContaining({ ragModuleKey: 'my-rag', query: 'what is AI?' }),
      );
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
  });
});
