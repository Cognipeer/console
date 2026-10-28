/**
 * Indexing a document of a knowledge base with access control that is not open to everyone: the model calls that
 * read its text (embeddings; contextual headers) run in an exposure carrying the module's mark, so the usage log
 * rows they write keep their copies of the text under it (rag/access/exposure.ts). An open document, or a module
 * without access control, indexes exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({
  restrictedTagOf: vi.fn(),
  marksAtEmbed: [] as string[][],
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/models/inferenceService', async () => {
  const { currentRestrictedKnowledgeTags } = await import('@/lib/services/rag/access/exposure');
  return {
    handleChatCompletion: vi.fn(),
    handleEmbeddingRequest: vi.fn(async (input: { body: { input: string[] } }) => {
      h.marksAtEmbed.push(currentRestrictedKnowledgeTags());
      return { response: { data: input.body.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) } };
    }),
  };
});
vi.mock('@/lib/services/vector/vectorService', () => ({
  upsertVectors: vi.fn().mockResolvedValue({ upserted: 1 }),
  queryVectorIndex: vi.fn().mockResolvedValue({ matches: [] }),
  deleteVectors: vi.fn().mockResolvedValue({ deleted: 1 }),
  vectorFilterOperatorsOf: vi.fn(() => []),
}));
vi.mock('@/lib/services/reranker', () => ({ runReranker: vi.fn() }));
vi.mock('@/lib/services/rag/ragIngestJob', () => ({ publishRagIngestJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/rag/access/restricted', () => ({
  restrictedTagOf: h.restrictedTagOf,
  noteRestrictedDocuments: vi.fn(async () => null),
}));

import { getDatabase } from '@/lib/database';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { currentRestrictedKnowledgeTags } from '@/lib/services/rag/access/exposure';
import { reingestDocument } from '@/lib/services/rag/ragService';

const MODULE = {
  _id: 'ragmod-1', key: 'handbook', name: 'Handbook', tenantId: 'tenant-1', projectId: 'p1', status: 'active' as const,
  embeddingModelKey: 'embed', vectorProviderKey: 'qdrant', vectorIndexKey: 'idx',
  chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 512, chunkOverlap: 50 },
};
const DOCUMENT = {
  _id: 'doc-1', ragModuleKey: 'handbook', tenantId: 'tenant-1', projectId: 'p1', fileName: 'salaries.md', contentType: 'text/markdown',
  size: 100, status: 'indexed' as const, chunkCount: 1, createdBy: 'user-1', folderId: 'hr',
};
const TEXT = 'Band A pays one hundred. Band B pays two hundred. These are the salary bands for 2026.';

describe('indexing a document', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    h.marksAtEmbed = [];
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findRagDocumentById.mockResolvedValue(DOCUMENT as never);
    db.findRagChunksByDocumentId.mockResolvedValue([]);
    db.updateRagDocument.mockResolvedValue(DOCUMENT as never);
    db.bulkInsertRagChunks.mockResolvedValue(undefined as never);
  });

  it('of a module with access control, closed to everyone: its embeddings are made under the module\'s mark', async () => {
    db.findRagModuleByKey.mockResolvedValue({ ...MODULE, access: { enabled: true } } as never);
    h.restrictedTagOf.mockResolvedValue('p1:handbook');

    await reingestDocument('tenant_acme', 'tenant-1', 'p1', { ragModuleKey: 'handbook', documentId: 'doc-1', content: TEXT, updatedBy: 'user-1' });

    expect(handleEmbeddingRequest).toHaveBeenCalled();
    expect(h.restrictedTagOf).toHaveBeenCalledWith(expect.objectContaining({ documents: [DOCUMENT] }));
    expect(h.marksAtEmbed.every((marks) => marks.includes('p1:handbook'))).toBe(true);
    // the mark belongs to the indexing work alone, not to whatever called it
    expect(currentRestrictedKnowledgeTags()).toEqual([]);
  });

  it('of a module with access control, open to everyone: no mark', async () => {
    db.findRagModuleByKey.mockResolvedValue({ ...MODULE, access: { enabled: true } } as never);
    h.restrictedTagOf.mockResolvedValue(null);

    await reingestDocument('tenant_acme', 'tenant-1', 'p1', { ragModuleKey: 'handbook', documentId: 'doc-1', content: TEXT, updatedBy: 'user-1' });

    expect(handleEmbeddingRequest).toHaveBeenCalled();
    expect(h.marksAtEmbed.every((marks) => marks.length === 0)).toBe(true);
  });

  it('of a module without access control: never asks', async () => {
    db.findRagModuleByKey.mockResolvedValue(MODULE as never);

    await reingestDocument('tenant_acme', 'tenant-1', 'p1', { ragModuleKey: 'handbook', documentId: 'doc-1', content: TEXT, updatedBy: 'user-1' });

    expect(handleEmbeddingRequest).toHaveBeenCalled();
    expect(h.restrictedTagOf).not.toHaveBeenCalled();
    expect(h.marksAtEmbed.every((marks) => marks.length === 0)).toBe(true);
  });
});
