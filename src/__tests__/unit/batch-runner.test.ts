/**
 * Unit tests — batch item runner (`processBatchItem`): canonical usage per item,
 * one budget debit through `onUsageSettled`, usage kept on limit-hit failures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handleChatCompletion: vi.fn(),
  handleEmbeddingRequest: vi.fn(),
  getModelByKey: vi.fn(),
  checkBudget: vi.fn(),
  db: {
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    findBatchJobItemById: vi.fn(),
    findBatchJobById: vi.fn(),
    updateBatchJobItem: vi.fn(),
    incrementBatchJobAggregates: vi.fn(),
  },
}));

vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  assertServiceEnabled: vi.fn().mockResolvedValue(undefined),
  isServiceDisabledError: () => false,
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  GuardrailBlockError: class GuardrailBlockError extends Error {},
  handleChatCompletion: h.handleChatCompletion,
  handleEmbeddingRequest: h.handleEmbeddingRequest,
}));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: h.getModelByKey }));
vi.mock('@/lib/services/files/fileService', () => ({ uploadFile: vi.fn() }));
vi.mock('@/lib/services/usage/usageEvents', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkBudget: h.checkBudget }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => h.db) }));

import { processBatchItem } from '@/lib/services/batch/batchRunner';
import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'u1', licenseType: 'PRO' };

function item(endpoint = '/v1/chat/completions') {
  void endpoint;
  return {
    _id: 'item-1',
    tenantId: 'tenant-1',
    batchId: 'batch-1',
    status: 'pending',
    requestBody: { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.checkBudget.mockResolvedValue({ allowed: true });
  h.db.findBatchJobItemById.mockResolvedValue(item());
  h.db.findBatchJobById.mockResolvedValue({ _id: 'batch-1', status: 'in_progress', endpoint: '/v1/chat/completions' });
  h.db.updateBatchJobItem.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...item(), ...patch }));
  h.db.incrementBatchJobAggregates.mockResolvedValue(null);
});

describe('processBatchItem', () => {
  it('keeps the canonical usage and debits the settled cost once', async () => {
    h.handleChatCompletion.mockImplementation(async (params: { onUsageSettled?: (c: unknown) => void }) => {
      params.onUsageSettled?.({ currency: 'USD', totalCost: 0.25 });
      return {
        response: { choices: [] },
        usage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, totalTokens: 1050, reasoningTokens: 10 },
      };
    });

    await processBatchItem(CTX as never, 'item-1');

    expect(h.db.updateBatchJobItem).toHaveBeenLastCalledWith(
      'item-1',
      expect.objectContaining({
        status: 'succeeded',
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cachedInputTokens: 800, reasoningTokens: 10 },
      }),
    );
    expect(h.db.incrementBatchJobAggregates).toHaveBeenCalledWith(
      'batch-1',
      expect.objectContaining({ itemsSucceeded: 1, usageInputTokens: 1000, usageOutputTokens: 50, usageTotalTokens: 1050 }),
    );
    const debits = h.checkBudget.mock.calls.filter((c) => c[1]);
    expect(debits).toHaveLength(1);
    expect(debits[0][1]).toEqual({ usd: 0.25 });
    expect(h.getModelByKey).not.toHaveBeenCalled();
  });

  it('debits every settle of the item: a Dynamic LLM decider and its child add up', async () => {
    const cost = (totalCost: number) => ({
      currency: 'USD', inputCost: totalCost / 2, outputCost: totalCost / 2, cachedCost: 0, cacheWriteCost: 0, totalCost,
    });
    h.handleChatCompletion.mockImplementation(async (params: { onUsageSettled?: (c: unknown) => void }) => {
      params.onUsageSettled?.(cost(0.001)); // decider
      params.onUsageSettled?.(cost(0.02)); // child
      return { response: { choices: [] }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    });

    await processBatchItem(CTX as never, 'item-1');

    const debits = h.checkBudget.mock.calls.filter((c) => c[1]);
    expect(debits).toHaveLength(1);
    expect(debits[0][1].usd).toBeCloseTo(0.021, 10);
  });

  it('records the burned usage on an output-limit failure and still debits', async () => {
    h.handleChatCompletion.mockImplementation(async (params: { onUsageSettled?: (c: unknown) => void }) => {
      params.onUsageSettled?.({ currency: 'USD', totalCost: 0.1 });
      throw new OutputTokenLimitError(100, {
        usage: { inputTokens: 40, outputTokens: 100, totalTokens: 140 },
        usageBooked: true,
      });
    });

    await processBatchItem(CTX as never, 'item-1');

    expect(h.db.updateBatchJobItem).toHaveBeenLastCalledWith(
      'item-1',
      expect.objectContaining({
        status: 'failed',
        usage: { inputTokens: 40, outputTokens: 100, totalTokens: 140 },
      }),
    );
    expect(h.db.incrementBatchJobAggregates).toHaveBeenCalledWith(
      'batch-1',
      expect.objectContaining({ itemsFailed: 1, usageInputTokens: 40, usageOutputTokens: 100, usageTotalTokens: 140 }),
    );
    expect(h.checkBudget.mock.calls.filter((c) => c[1])).toHaveLength(1);
  });

  it('maps embeddings wire usage (prompt_tokens / total_tokens)', async () => {
    h.db.findBatchJobById.mockResolvedValue({ _id: 'batch-1', status: 'in_progress', endpoint: '/v1/embeddings' });
    h.handleEmbeddingRequest.mockResolvedValue({ response: { usage: { prompt_tokens: 7, total_tokens: 7 } } });
    h.getModelByKey.mockResolvedValue(null);

    await processBatchItem(CTX as never, 'item-1');

    expect(h.db.updateBatchJobItem).toHaveBeenLastCalledWith(
      'item-1',
      expect.objectContaining({ usage: { inputTokens: 7, outputTokens: undefined, totalTokens: 7 } }),
    );
  });
});
