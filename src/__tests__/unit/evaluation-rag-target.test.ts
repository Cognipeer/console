/**
 * Unit tests — the `rag` evaluation target.
 *
 * Covers what the retrieval scorers depend on the adapter getting right: the
 * item's user message drives the query, the target's topK / minScore reach
 * queryRag, the ranked matches survive onto TargetOutput.retrieved with their
 * rank, and a target with no module fails loudly instead of retrieving nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// TRAP: factories must be synchronous — an async vi.mock factory silently
// fails to intercept under this setup.
const h = vi.hoisted(() => ({
  queryRag: vi.fn(),
  handleChatCompletion: vi.fn(),
  handleEmbeddingRequest: vi.fn(),
  calculateCost: vi.fn(() => ({ totalCost: 0 })),
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/rag/ragService', () => ({
  queryRag: h.queryRag,
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: h.handleChatCompletion,
  handleEmbeddingRequest: h.handleEmbeddingRequest,
}));
vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: h.calculateCost,
}));
vi.mock('@/lib/database', () => ({
  getDatabase: h.getDatabase,
}));

import { buildTargetInvoker, type EvaluationModelContext } from '@/lib/services/evaluation/adapters';
import type { IEvaluationTarget } from '@/lib/database';
import type { DatasetItem } from '@/lib/services/evaluation/types';

const CTX: EvaluationModelContext = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' };

function ragTarget(overrides: Partial<IEvaluationTarget> = {}): IEvaluationTarget {
  return {
    tenantId: 't1',
    projectId: 'p1',
    key: 'kb-retrieval',
    name: 'KB retrieval',
    kind: 'rag',
    ragModuleKey: 'support-kb',
    createdBy: 'u1',
    ...overrides,
  };
}

const ITEM: DatasetItem = {
  id: 'q1',
  input: [
    { role: 'system', content: 'You are support.' },
    { role: 'user', content: 'How do I get my money back?' },
  ],
  expected: { reference: 'Request a refund within thirty days.' },
};

describe('rag evaluation target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drives retrieval with the item user message and the target retrieval settings', async () => {
    h.queryRag.mockResolvedValue({ matches: [], query: 'q', ragModuleKey: 'support-kb', latencyMs: 12 });
    const invoke = buildTargetInvoker(ragTarget({ retrievalTopK: 8, retrievalMinScore: 0.4 }), CTX);
    const output = await invoke(ITEM);

    expect(h.queryRag).toHaveBeenCalledWith('tenant_db', 't1', 'p1', {
      ragModuleKey: 'support-kb',
      query: 'How do I get my money back?',
      topK: 8,
      minScore: 0.4,
      includeContent: true,
    });
    expect(output.retrieved).toEqual([]);
    expect(output.text).toBe('');
    expect(output.latencyMs).toBe(12);
  });

  it('returns the ranked matches alongside their concatenation', async () => {
    h.queryRag.mockResolvedValue({
      matches: [
        { id: 'v1', score: 0.9, content: 'Refunds within 30 days.', documentId: 'd1', fileName: 'policy.md', chunkIndex: 3 },
        { id: 'v2', score: 0.7, content: 'Contact support to start one.' },
      ],
      query: 'q',
      ragModuleKey: 'support-kb',
      latencyMs: 30,
    });
    const output = await buildTargetInvoker(ragTarget(), CTX)(ITEM);

    expect(output.text).toBe('Refunds within 30 days.\n\nContact support to start one.');
    expect(output.retrieved).toEqual([
      { id: 'v1', score: 0.9, content: 'Refunds within 30 days.', documentId: 'd1', fileName: 'policy.md', chunkIndex: 3, rank: 1 },
      { id: 'v2', score: 0.7, content: 'Contact support to start one.', documentId: undefined, fileName: undefined, chunkIndex: undefined, rank: 2 },
    ]);
  });

  it('keeps a content-less match on retrieved but out of the concatenation', async () => {
    // Vectors ingested outside our pipeline hydrate to no text; the scorers
    // count them as retrieved-and-useless rather than silently losing them.
    h.queryRag.mockResolvedValue({
      matches: [
        { id: 'v1', score: 0.9, content: '' },
        { id: 'v2', score: 0.8, content: 'Real passage.' },
      ],
      query: 'q',
      ragModuleKey: 'support-kb',
      latencyMs: 5,
    });
    const output = await buildTargetInvoker(ragTarget(), CTX)(ITEM);

    expect(output.text).toBe('Real passage.');
    expect(output.retrieved).toHaveLength(2);
    expect(output.retrieved?.[0].rank).toBe(1);
  });

  it('throws a descriptive error when no Knowledge Engine module is configured', async () => {
    const invoke = buildTargetInvoker(ragTarget({ ragModuleKey: undefined }), CTX);
    await expect(invoke(ITEM)).rejects.toThrow(/ragModuleKey/);
    expect(h.queryRag).not.toHaveBeenCalled();
  });
});
