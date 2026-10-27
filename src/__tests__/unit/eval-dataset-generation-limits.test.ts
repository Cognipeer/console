/**
 * Unit tests — dataset generation output limits (`generateDatasetItems`).
 * Covers the explicit `max_tokens` a block's call is sent with: ONLY to raise a configured limit that is below the
 * need (600 tokens a pair, at least 2048, capped at the model maximum). With no configured limit, or one that
 * already covers the need, nothing is sent (the driver default / the thinking headroom applies). A lookup failure is
 * harmless. Also the
 * `evaluation.dataset` route, and the final error carrying the first reason blocks yielded nothing (the output-limit
 * notice of a thinking model, a cut-off reply, a provider error). DB + model mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const handleChatCompletion = vi.fn();
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: (...args: unknown[]) => handleChatCompletion(...args),
}));

const db = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  findRagModuleByKey: vi.fn(),
  listRagDocuments: vi.fn(),
  findRagChunksByDocumentId: vi.fn(),
  findModelByKey: vi.fn(),
};
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

import { generateDatasetItems } from '@/lib/services/evaluation/datasetGeneration';
import type { GenerateDatasetItemsParams } from '@/lib/services/evaluation/datasetGeneration';
import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';

const PAIRS = '[{"question":"What is X?","answer":"X is a thing."}]';

function reply(content: string, finishReason?: string) {
  return { response: { choices: [{ ...(finishReason ? { finish_reason: finishReason } : {}), message: { content } }] } };
}

function modelRecord(settings: Record<string, unknown>, metadata?: Record<string, unknown>) {
  return { key: 'gpt', modelId: 'some-model', settings, ...(metadata ? { metadata } : {}) };
}

/** One block of text: `count` pairs are all asked of it. */
function generate(count: number, extra: Partial<GenerateDatasetItemsParams> = {}) {
  return generateDatasetItems({
    tenantDbName: 't',
    tenantId: 'tid',
    projectId: 'p',
    generationModelKey: 'gpt',
    source: { type: 'text', text: 'one block of text' },
    count,
    ...extra,
  });
}

function firstCall(): { route?: string; body: Record<string, unknown> } {
  return handleChatCompletion.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  handleChatCompletion.mockReset();
  db.findModelByKey.mockReset();
  db.findModelByKey.mockResolvedValue(null);
  handleChatCompletion.mockResolvedValue(reply(PAIRS));
});

describe('generateDatasetItems — output limit per block', () => {
  it('sends NO limit when the model has none configured (the driver default applies, a thinking model keeps its room)', async () => {
    await generate(5);
    expect(firstCall().body).not.toHaveProperty('max_tokens');
  });

  it('asks for 600 tokens a pair when it raises a configured limit below the need', async () => {
    db.findModelByKey.mockResolvedValue(modelRecord({ maxTokens: 500 }));
    await generate(5); // one block: all 5 pairs from it
    expect(firstCall().body.max_tokens).toBe(3000);
  });

  it('never raises to less than 2048', async () => {
    db.findModelByKey.mockResolvedValue(modelRecord({ maxTokens: 500 }));
    await generate(2); // 2 pairs: 1200 tokens would do, the floor is 2048
    expect(firstCall().body.max_tokens).toBe(2048);
  });

  it('looks the generation model up by key in the project', async () => {
    await generate(5);
    expect(db.findModelByKey).toHaveBeenCalledWith('gpt', 'p');
  });

  it('is capped at the model maximum', async () => {
    db.findModelByKey.mockResolvedValue(modelRecord({ maxTokens: 500 }, { capabilities: { maxOutputTokens: 1000 } }));
    await generate(5);
    expect(firstCall().body.max_tokens).toBe(1000);
  });

  it('sends nothing when the model maximum is not above the configured limit (no raise is possible)', async () => {
    db.findModelByKey.mockResolvedValue(modelRecord({ maxTokens: 1000 }, { capabilities: { maxOutputTokens: 1000 } }));
    await generate(5);
    expect(firstCall().body).not.toHaveProperty('max_tokens');
  });

  it('leaves a limit the operator configured alone when it already covers the need (a thinking model keeps its headroom)', async () => {
    db.findModelByKey.mockResolvedValue(modelRecord({ maxTokens: 8000 }));
    await generate(5);
    expect(firstCall().body).not.toHaveProperty('max_tokens');

    handleChatCompletion.mockClear();
    db.findModelByKey.mockResolvedValue(modelRecord({ maxCompletionTokens: 4000, maxTokens: 100 }));
    await generate(5);
    expect(firstCall().body).not.toHaveProperty('max_tokens');
  });

  it('works when the model lookup fails: it only costs the tuning', async () => {
    db.findModelByKey.mockRejectedValue(new Error('db down'));
    const result = await generate(5);
    expect(result.items).toHaveLength(1);
    expect(firstCall().body).not.toHaveProperty('max_tokens');
  });

  it("runs on the 'evaluation.dataset' route", async () => {
    await generate(5);
    expect(firstCall().route).toBe('evaluation.dataset');
  });
});

describe('generateDatasetItems — why nothing was generated', () => {
  const twoBlocks: Partial<GenerateDatasetItemsParams> = {
    source: { type: 'text', text: 'first block of text\n\nsecond block of text', chunkSize: 10 },
  };

  it('carries the output-limit notice of a model that spent its budget thinking', async () => {
    handleChatCompletion.mockRejectedValue(new OutputTokenLimitError(2048));
    await expect(generate(2)).rejects.toThrow(
      /^No question-answer pairs could be generated from the source content: The model reached its output token limit \(2048 tokens\)/,
    );
  });

  it('carries the first distinct reason, not every one', async () => {
    handleChatCompletion
      .mockRejectedValueOnce(new Error('boom 1'))
      .mockRejectedValueOnce(new Error('boom 2'));
    const error = (await generate(2, twoBlocks).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('No question-answer pairs could be generated from the source content: boom 1');
  });

  it('says so when a reply was cut off at the limit and held no complete pair', async () => {
    db.findModelByKey.mockResolvedValue(modelRecord({ maxTokens: 500 }));
    handleChatCompletion.mockResolvedValue(reply('[{"question":"q1","answer":"a', 'length'));
    await expect(generate(5)).rejects.toThrow(/cut off at the output limit \(3000 tokens\)\. Raise the model's "Default max tokens"/);
  });

  it('does not name a limit it did not send', async () => {
    db.findModelByKey.mockResolvedValue(modelRecord({ maxTokens: 8000 }));
    handleChatCompletion.mockResolvedValue(reply('[{"question":"q1","answer":"a', 'length'));
    const error = (await generate(5).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("cut off at the model's own output limit");
    expect(error.message).toContain('reasoning effort');
    expect(error.message).not.toMatch(/\d+ tokens\)/);
  });

  it('keeps a cut-off reply that still holds a complete array: nothing is lost', async () => {
    handleChatCompletion.mockResolvedValue(reply(PAIRS, 'length'));
    const result = await generate(5);
    expect(result.items).toHaveLength(1);
  });

  it('leaves the message as it was when nothing explains the empty result', async () => {
    handleChatCompletion.mockResolvedValue(reply('sorry, I cannot do that'));
    await expect(generate(5)).rejects.toThrow(
      new Error('No question-answer pairs could be generated from the source content'),
    );
  });
});
