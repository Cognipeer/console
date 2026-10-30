/**
 * Unit tests — batch item runner and replies cut off at the output limit.
 * A reply cut off WITH text stays a succeeded item (the text is returned, as the sync endpoint does) but the item
 * records the finish reason and a `truncated` flag; a finished reply records its reason only; an item with no finish
 * reason (embeddings, an empty choices list) gets neither key. DB + inference mocked.
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
import { OutputTokenLimitError, UpstreamFinishError } from '@/lib/services/models/openaiErrors';

const CTX = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'u1' };

function item() {
  return {
    _id: 'item-1',
    tenantId: 'tenant-1',
    batchId: 'batch-1',
    status: 'pending',
    requestBody: { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] },
  };
}

function chatReply(finishReason: unknown, content = 'an answer') {
  return {
    response: { choices: [{ ...(finishReason === undefined ? {} : { finish_reason: finishReason }), message: { content } }] },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

/** The patch the item ended with (the last update; the first one marks it running). */
function finalPatch(): Record<string, unknown> {
  const calls = h.db.updateBatchJobItem.mock.calls;
  return calls[calls.length - 1][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.db.findBatchJobItemById.mockResolvedValue(item());
  h.db.findBatchJobById.mockResolvedValue({ _id: 'batch-1', status: 'in_progress', endpoint: '/v1/chat/completions' });
  h.db.updateBatchJobItem.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...item(), ...patch }));
  h.db.incrementBatchJobAggregates.mockResolvedValue(null);
});

describe('processBatchItem — a reply cut off at the output limit', () => {
  it('stays succeeded, keeps the text, and records the finish reason and a truncated flag', async () => {
    h.handleChatCompletion.mockResolvedValue(chatReply('length', 'It was a dark and'));

    await processBatchItem(CTX as never, 'item-1');

    expect(finalPatch()).toMatchObject({
      status: 'succeeded',
      responseStatusCode: 200,
      finishReason: 'length',
      truncated: true,
    });
    expect((finalPatch().responseBody as { choices: Array<{ message: { content: string } }> }).choices[0].message.content)
      .toBe('It was a dark and');
    // Counted as a success: the item produced an answer.
    expect(h.db.incrementBatchJobAggregates).toHaveBeenCalledWith(
      'batch-1',
      expect.objectContaining({ itemsSucceeded: 1 }),
    );
  });

  it.each([['max_tokens'], ['LENGTH'], [' Length ']])('reads the finish reason %j as a cut-off', async (reason) => {
    h.handleChatCompletion.mockResolvedValue(chatReply(reason));
    await processBatchItem(CTX as never, 'item-1');
    expect(finalPatch()).toMatchObject({ status: 'succeeded', truncated: true });
    // Stored normalized (trimmed, lower case), as every finish reason is.
    expect(finalPatch().finishReason).toBe(String(reason).trim().toLowerCase());
  });

  it('records a finished reply\'s reason without the flag', async () => {
    h.handleChatCompletion.mockResolvedValue(chatReply('stop'));

    await processBatchItem(CTX as never, 'item-1');

    expect(finalPatch()).toMatchObject({ status: 'succeeded', finishReason: 'stop' });
    expect(finalPatch()).not.toHaveProperty('truncated');
  });

  it('does not store a finish reason the response does not have (optional keys only when present)', async () => {
    h.handleChatCompletion.mockResolvedValue(chatReply(undefined));
    await processBatchItem(CTX as never, 'item-1');
    expect(finalPatch()).not.toHaveProperty('finishReason');
    expect(finalPatch()).not.toHaveProperty('truncated');

    h.handleChatCompletion.mockResolvedValue({ response: { choices: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
    await processBatchItem(CTX as never, 'item-1');
    expect(finalPatch()).not.toHaveProperty('finishReason');
  });

  it('embeddings have no finish reason', async () => {
    h.db.findBatchJobById.mockResolvedValue({ _id: 'batch-1', status: 'in_progress', endpoint: '/v1/embeddings' });
    h.handleEmbeddingRequest.mockResolvedValue({ response: { data: [], usage: { prompt_tokens: 7, total_tokens: 7 } } });

    await processBatchItem(CTX as never, 'item-1');

    expect(finalPatch()).toMatchObject({ status: 'succeeded' });
    expect(finalPatch()).not.toHaveProperty('finishReason');
    expect(finalPatch()).not.toHaveProperty('truncated');
  });

  it('an item the gateway failed for the output limit (nothing to show) is a failure, not a truncated success', async () => {
    h.handleChatCompletion.mockRejectedValue(
      new OutputTokenLimitError(100, { usage: { inputTokens: 40, outputTokens: 100, totalTokens: 140 } }),
    );

    await processBatchItem(CTX as never, 'item-1');

    expect(finalPatch()).toMatchObject({ status: 'failed' });
    expect(finalPatch()).not.toHaveProperty('truncated');
    expect(finalPatch()).not.toHaveProperty('finishReason');
  });
});

describe('processBatchItem — an error finish', () => {
  it('keeps the usage the UpstreamFinishError carries on the failed item and in the aggregates', async () => {
    h.handleChatCompletion.mockRejectedValue(
      new UpstreamFinishError('MALFORMED_FUNCTION_CALL', {
        usage: { inputTokens: 40, outputTokens: 7, totalTokens: 47 },
        usageBooked: true,
      }),
    );

    await processBatchItem(CTX as never, 'item-1');

    expect(finalPatch()).toMatchObject({
      status: 'failed',
      usage: { inputTokens: 40, outputTokens: 7, totalTokens: 47 },
    });
    expect(h.db.incrementBatchJobAggregates).toHaveBeenCalledWith(
      'batch-1',
      expect.objectContaining({ itemsFailed: 1, usageInputTokens: 40, usageOutputTokens: 7, usageTotalTokens: 47 }),
    );
  });
});
