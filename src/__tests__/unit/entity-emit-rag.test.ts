/**
 * Entity health emission — knowledge bases. `queryRag` is the funnel for the
 * HTTP API, agents, MCP and the answer service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';
import type { IRagModule, IRagQueryLog } from '@/lib/database';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: vi.fn() }));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: vi.fn(),
}));
vi.mock('@/lib/services/vector/vectorService', () => ({
  upsertVectors: vi.fn(),
  queryVectorIndex: vi.fn(),
  deleteVectors: vi.fn(),
}));
vi.mock('@/lib/services/reranker', () => ({ runReranker: vi.fn() }));
vi.mock('@/lib/services/rag/ragIngestJob', () => ({ publishRagIngestJob: vi.fn() }));
vi.mock('@/lib/services/files/fileService', () => ({
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock('@/lib/services/entityMetrics/entityMetricsRollup', () => ({
  recordEntityMetric: vi.fn(),
}));
vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn().mockReturnValue({}),
}));

import { queryRag } from '@/lib/services/rag/ragService';
import { getDatabase } from '@/lib/database';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { queryVectorIndex } from '@/lib/services/vector/vectorService';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';

const ragModule = {
  _id: 'ragmod-1',
  key: 'my-rag',
  name: 'My RAG',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  status: 'active' as const,
  embeddingModelKey: 'text-embed-3',
  vectorProviderKey: 'pinecone',
  vectorIndexKey: 'my-index',
  chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 512, chunkOverlap: 50 },
};

const request = { ragModuleKey: 'my-rag', query: 'what is AI?', topK: 3 };

describe('queryRag -> entity health', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findRagModuleByKey.mockResolvedValue(ragModule as unknown as IRagModule);
    db.findRagChunksByVectorIds.mockResolvedValue([]);
    db.createRagQueryLog.mockResolvedValue({} as unknown as IRagQueryLog);
    (recordUsageEvent as ReturnType<typeof vi.fn>).mockReturnValue({});
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
    });
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [{ id: 'v1', score: 0.9, metadata: { text: 'hello' } }],
    });
  });

  it('records a success with latency and no empty-result flag', async () => {
    await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, request);

    expect(recordEntityMetric).toHaveBeenCalledTimes(1);
    expect(recordEntityMetric).toHaveBeenCalledWith(expect.objectContaining({
      tenantDbName: DB_NAME,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      entityType: 'kb',
      entityKey: 'my-rag',
      source: 'service',
      outcome: 'ok',
      latencyMs: expect.any(Number),
      emptyResults: 0,
    }));
  });

  it('flags a query that retrieved nothing as an empty result', async () => {
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ matches: [] });
    await queryRag(DB_NAME, TENANT_ID, PROJECT_ID, request);

    expect(recordEntityMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ok',
      emptyResults: 1,
    }));
  });

  it('records a failure, writes a usage event, rethrows unchanged and writes no query log row', async () => {
    const boom = new Error('vector store down');
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockRejectedValue(boom);

    await expect(queryRag(DB_NAME, TENANT_ID, PROJECT_ID, request)).rejects.toBe(boom);

    expect(recordEntityMetric).toHaveBeenCalledTimes(1);
    expect(recordEntityMetric).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'kb',
      entityKey: 'my-rag',
      source: 'service',
      outcome: 'error',
    }));
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      service: 'rag',
      refKey: 'my-rag',
      status: 'error',
      latencyMs: expect.any(Number),
    }));
    expect(db.createRagQueryLog).not.toHaveBeenCalled();
  });

  it('records an embedding failure as a knowledge-base error', async () => {
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('embedding model down'));

    await expect(queryRag(DB_NAME, TENANT_ID, PROJECT_ID, request)).rejects.toThrow('embedding model down');
    expect(recordEntityMetric).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('records a caller abort as cancelled, not as an error', async () => {
    const ac = new AbortController();
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ac.abort();
      throw new Error('aborted');
    });

    await expect(queryRag(DB_NAME, TENANT_ID, PROJECT_ID, request, { signal: ac.signal })).rejects.toThrow('aborted');
    expect(recordEntityMetric).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled' }));
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });

  it('does not mint a health row for an unknown module key', async () => {
    db.findRagModuleByKey.mockResolvedValue(null);

    await expect(queryRag(DB_NAME, TENANT_ID, PROJECT_ID, request)).rejects.toThrow(/not found/i);
    expect(recordEntityMetric).not.toHaveBeenCalled();
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });

  it('does not record a rejected request filter as a knowledge-base error', async () => {
    await expect(
      queryRag(DB_NAME, TENANT_ID, PROJECT_ID, { ...request, filter: { $bogus: 1 } as never }),
    ).rejects.toThrow(/Invalid filter/);
    expect(recordEntityMetric).not.toHaveBeenCalled();
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });

  it('attributes to the module project and key when the caller passes no project', async () => {
    await queryRag(DB_NAME, TENANT_ID, undefined, request);
    expect(recordEntityMetric).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      entityKey: 'my-rag',
      outcome: 'ok',
    }));

    (recordEntityMetric as ReturnType<typeof vi.fn>).mockClear();
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('vector store down'));
    await expect(queryRag(DB_NAME, TENANT_ID, undefined, request)).rejects.toThrow('vector store down');
    expect(recordEntityMetric).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      entityKey: 'my-rag',
      outcome: 'error',
    }));
  });
});
