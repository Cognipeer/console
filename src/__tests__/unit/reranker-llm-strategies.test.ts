/**
 * Unit tests - the LLM reranker strategies (llm-judge, llm-listwise) as short side calls.
 *
 * Every scoring call carries an explicit output limit (`maxTokens` of the reranker config, else the strategy's
 * default) and the lowest thinking the model allows. A score cut off by the limit, or a reply holding none, is a
 * failure and never a 0; when more than half of the documents fail the strategy throws a typed error instead of
 * returning placeholder scores (RAG then keeps the vector order).
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
}));

import type { IModel, IReranker } from '@/lib/database';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { CONTEXT_WINDOW_EXCEEDED_REASON, OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { AGENT_REASONING_OVERRIDE } from '@/lib/services/models/reasoning';
import {
  RerankerScoringError,
  isOutputLimitHit,
  llmJudgeStrategy,
  scoringMaxTokens,
} from '@/lib/services/reranker/strategies/llmJudge';
import { llmListwiseStrategy } from '@/lib/services/reranker/strategies/llmListwise';
import type { StrategyContext, StrategyInputDocument } from '@/lib/services/reranker/strategies';

const chat = handleChatCompletion as unknown as Mock;

const reply = (content: string, finishReason = 'stop') => ({
  response: { choices: [{ finish_reason: finishReason, message: { content } }] },
});

function model(overrides: Record<string, unknown> = {}): IModel {
  return {
    key: 'judge-model',
    category: 'llm',
    modelId: 'gpt-5-mini',
    providerDriver: 'openai',
    settings: {},
    ...overrides,
  } as unknown as IModel;
}

function ctxOf(config: Record<string, unknown> = {}, modelOverrides: Record<string, unknown> = {}): StrategyContext {
  return {
    tenantDbName: 'tenant_db',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    reranker: { key: 'rr', config } as unknown as IReranker,
    model: model(modelOverrides),
  };
}

const docs = (count: number, indexOf = (i: number) => i): StrategyInputDocument[] =>
  Array.from({ length: count }, (_, i) => ({ index: indexOf(i), content: `document ${i}` }));

const bodyOf = (call: number) => chat.mock.calls[call][0].body as Record<string | symbol, unknown>;

beforeEach(() => {
  chat.mockReset();
});

// ── Shared helpers ──────────────────────────────────────────────────────────

describe('scoringMaxTokens', () => {
  it('uses the configured limit when it is a positive whole number', () => {
    expect(scoringMaxTokens(256, 32)).toBe(256);
    expect(scoringMaxTokens(1, 32)).toBe(1);
  });

  it('falls back to the strategy default for anything else', () => {
    for (const bad of [undefined, null, 0, -4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '12', {}]) {
      expect(scoringMaxTokens(bad, 32)).toBe(32);
    }
  });
});

describe('isOutputLimitHit', () => {
  it('is true for an output limit error and false for anything else', () => {
    expect(isOutputLimitHit(new OutputTokenLimitError(32))).toBe(true);
    expect(isOutputLimitHit(new Error('boom'))).toBe(false);
    expect(isOutputLimitHit(undefined)).toBe(false);
  });

  it('is false for a full context window: a larger output limit does not cure it', () => {
    expect(isOutputLimitHit(new OutputTokenLimitError(32, { rawFinishReason: CONTEXT_WINDOW_EXCEEDED_REASON }))).toBe(false);
  });
});

// ── llm-judge ───────────────────────────────────────────────────────────────

describe('llm-judge scoring calls', () => {
  it('sends an explicit output limit (default 32) and the lowest thinking the model allows', async () => {
    chat.mockResolvedValue(reply('0.9'));

    const scores = await llmJudgeStrategy.run(ctxOf(), 'query', docs(2), 2);

    expect(scores).toEqual([{ index: 0, score: 0.9 }, { index: 1, score: 0.9 }]);
    expect(chat).toHaveBeenCalledTimes(2);
    for (let call = 0; call < 2; call += 1) {
      expect(bodyOf(call).max_tokens).toBe(32);
      expect(bodyOf(call)[AGENT_REASONING_OVERRIDE]).toEqual({ effort: 'minimal' });
      expect(bodyOf(call).temperature).toBe(0);
    }
  });

  it('takes the limit from the reranker config', async () => {
    chat.mockResolvedValue(reply('0.5'));
    await llmJudgeStrategy.run(ctxOf({ maxTokens: 256 }), 'query', docs(1), 1);
    expect(bodyOf(0).max_tokens).toBe(256);
  });

  it('an unusable config value falls back to the default', async () => {
    chat.mockResolvedValue(reply('0.5'));
    await llmJudgeStrategy.run(ctxOf({ maxTokens: 0 }), 'query', docs(1), 1);
    expect(bodyOf(0).max_tokens).toBe(32);
  });

  it('sends no reasoning for a chat model, which would refuse it', async () => {
    chat.mockResolvedValue(reply('0.5'));
    await llmJudgeStrategy.run(ctxOf({}, { modelId: 'gpt-4o' }), 'query', docs(1), 1);
    expect(AGENT_REASONING_OVERRIDE in bodyOf(0)).toBe(false);
    expect(bodyOf(0).max_tokens).toBe(32);
  });

  it('sends no reasoning for a Dynamic LLM: it is routed to models this cannot know', async () => {
    chat.mockResolvedValue(reply('0.5'));
    const dynamic = { dynamic: { strategy: 'rules', defaultModelKey: 'fallback' } };
    await llmJudgeStrategy.run(ctxOf({}, { settings: dynamic }), 'query', docs(1), 1);
    expect(AGENT_REASONING_OVERRIDE in bodyOf(0)).toBe(false);
  });

  it('reads a score on a 10-point scale and clamps the rest', async () => {
    chat.mockImplementation(async ({ body }: { body: { messages: Array<{ content: string }> } }) => {
      const prompt = body.messages[0].content;
      if (prompt.includes('document 0')) return reply('8');
      if (prompt.includes('document 1')) return reply('0.85');
      return reply('15');
    });
    const scores = await llmJudgeStrategy.run(ctxOf(), 'query', docs(3), 3);
    expect(scores).toEqual([
      { index: 0, score: 0.8 },
      { index: 1, score: 0.85 },
      { index: 2, score: 1 },
    ]);
  });
});

describe('llm-judge failures', () => {
  const failing = (isBad: (prompt: string) => boolean, error: Error = new Error('upstream 500')) =>
    chat.mockImplementation(async ({ body }: { body: { messages: Array<{ content: string }> } }) => {
      if (isBad(body.messages[0].content)) throw error;
      return reply('0.8');
    });

  it('a few failures cost those documents their score and nothing else', async () => {
    // 2 of 4 is not MORE than half
    failing((prompt) => prompt.includes('document 1') || prompt.includes('document 3'));

    const scores = await llmJudgeStrategy.run(ctxOf(), 'query', docs(4), 4);

    expect(scores.map((s) => s.score)).toEqual([0.8, 0, 0.8, 0]);
  });

  it('more than half failing is no ranking: it throws a typed error with the counts', async () => {
    failing((prompt) => !prompt.includes('document 0'));

    const error = await llmJudgeStrategy.run(ctxOf(), 'query', docs(4), 4).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankerScoringError);
    const typed = error as RerankerScoringError;
    expect(typed.strategy).toBe('llm-judge');
    expect(typed.failed).toBe(3);
    expect(typed.total).toBe(4);
    expect(typed.outputLimit).toBe(false);
    expect(typed.message).toContain('llm-judge could not score 3 of 4 documents');
    expect(typed.message).toContain('upstream 500');
  });

  it('a score cut off at the output limit is a failure, never a 0 score', async () => {
    chat.mockResolvedValue(reply('0.', 'length'));

    const error = await llmJudgeStrategy.run(ctxOf({ maxTokens: 16 }), 'query', docs(3), 3).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankerScoringError);
    const typed = error as RerankerScoringError;
    expect(typed.outputLimit).toBe(true);
    expect(typed.message).toContain('cut off at the output limit');
    expect(typed.message).toContain('Raise "maxTokens" in the reranker config (16 tokens now)');
  });

  it('a reply holding no score is a failure', async () => {
    chat.mockResolvedValue(reply('I cannot say'));

    const error = await llmJudgeStrategy.run(ctxOf(), 'query', docs(2), 2).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankerScoringError);
    expect((error as RerankerScoringError).message).toContain('the reply held no score');
    expect((error as RerankerScoringError).outputLimit).toBe(false);
  });

  it('a model that stops at its output limit before it answers points at the reranker config', async () => {
    chat.mockRejectedValue(new OutputTokenLimitError(32));

    const error = await llmJudgeStrategy.run(ctxOf(), 'query', docs(2), 2).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankerScoringError);
    const typed = error as RerankerScoringError;
    expect(typed.outputLimit).toBe(true);
    expect(typed.message).toContain('Raise "maxTokens" in the reranker config (32 tokens now)');
    // the gateway's own message names the request parameter, which a reranker has none of
    expect(typed.message).not.toContain('max_completion_tokens');
  });

  it('a full context window is reported as itself, not as an output limit', async () => {
    chat.mockRejectedValue(new OutputTokenLimitError(32, { rawFinishReason: CONTEXT_WINDOW_EXCEEDED_REASON }));

    const error = await llmJudgeStrategy.run(ctxOf(), 'query', docs(2), 2).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankerScoringError);
    const typed = error as RerankerScoringError;
    expect(typed.outputLimit).toBe(false);
    expect(typed.message).not.toContain('Raise "maxTokens"');
    expect(typed.message).toContain('context window');
  });

  it('a model that is not an LLM is refused before any call', async () => {
    await expect(llmJudgeStrategy.run(ctxOf({}, { category: 'embedding' }), 'query', docs(1), 1)).rejects.toThrow(/category "embedding"/);
    expect(chat).not.toHaveBeenCalled();
  });
});

// ── llm-listwise ────────────────────────────────────────────────────────────

const ranking = (...entries: Array<[number, number]>) => JSON.stringify(entries.map(([index, score]) => ({ index, score })));

describe('llm-listwise ranking call', () => {
  it('sends an explicit output limit (default 1024) and the lowest thinking the model allows', async () => {
    chat.mockResolvedValue(reply(ranking([0, 0.9], [1, 0.2])));

    const result = await llmListwiseStrategy.run(ctxOf(), 'query', docs(2, (i) => 10 + i), 2);

    // prompt positions come back as the caller's document indices
    expect(result).toEqual([{ index: 10, score: 0.9 }, { index: 11, score: 0.2 }]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).max_tokens).toBe(1024);
    expect(bodyOf(0)[AGENT_REASONING_OVERRIDE]).toEqual({ effort: 'minimal' });
  });

  it('takes the limit from the reranker config', async () => {
    chat.mockResolvedValue(reply(ranking([0, 0.5])));
    await llmListwiseStrategy.run(ctxOf({ maxTokens: 4096 }), 'query', docs(1), 1);
    expect(bodyOf(0).max_tokens).toBe(4096);
  });

  it('sends no reasoning for a chat model', async () => {
    chat.mockResolvedValue(reply(ranking([0, 0.5])));
    await llmListwiseStrategy.run(ctxOf({}, { modelId: 'gpt-4.1' }), 'query', docs(1), 1);
    expect(AGENT_REASONING_OVERRIDE in bodyOf(0)).toBe(false);
  });
});

describe('llm-listwise failures', () => {
  it('documents the ranking left out score 0 while at most half of them are missing', async () => {
    chat.mockResolvedValue(reply(ranking([0, 0.9], [1, 0.7])));

    const result = await llmListwiseStrategy.run(ctxOf(), 'query', docs(4), 4);

    expect(result).toHaveLength(4);
    expect(result.filter((r) => r.score === 0).map((r) => r.index).sort()).toEqual([2, 3]);
  });

  it('a ranking that left out most of the documents is no ranking: it throws a typed error', async () => {
    chat.mockResolvedValue(reply(ranking([0, 0.9])));

    const error = await llmListwiseStrategy.run(ctxOf(), 'query', docs(4), 4).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankerScoringError);
    const typed = error as RerankerScoringError;
    expect(typed.strategy).toBe('llm-listwise');
    expect(typed.failed).toBe(3);
    expect(typed.total).toBe(4);
    expect(typed.outputLimit).toBe(false);
    expect(typed.message).toContain('the reply did not rank them');
  });

  it('a reply with no ranking at all throws', async () => {
    chat.mockResolvedValue(reply('Sorry, I cannot rank these.'));
    await expect(llmListwiseStrategy.run(ctxOf(), 'query', docs(3), 3)).rejects.toBeInstanceOf(RerankerScoringError);
  });

  it('a ranking cut off at the output limit that lost most of the list names the limit', async () => {
    chat.mockResolvedValue(reply('[{"index":0,"score":0.9},{"ind', 'length'));

    const error = await llmListwiseStrategy.run(ctxOf({ maxTokens: 64 }), 'query', docs(4), 4).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankerScoringError);
    const typed = error as RerankerScoringError;
    // the cut-off array does not parse at all: every document is missing
    expect(typed.failed).toBe(4);
    expect(typed.outputLimit).toBe(true);
    expect(typed.message).toContain('the ranking was cut off at the output limit');
    expect(typed.message).toContain('Raise "maxTokens" in the reranker config (64 tokens now)');
  });

  it('a cut-off ranking that still covers most of the list is used', async () => {
    chat.mockResolvedValue(reply(ranking([0, 0.9], [1, 0.8], [2, 0.7]), 'length'));

    const result = await llmListwiseStrategy.run(ctxOf(), 'query', docs(4), 4);

    expect(result).toHaveLength(4);
    expect(result.find((r) => r.index === 3)?.score).toBe(0);
  });

  it('a model that stops at its output limit before it answers points at the reranker config', async () => {
    chat.mockRejectedValue(new OutputTokenLimitError(1024));

    const error = await llmListwiseStrategy.run(ctxOf(), 'query', docs(5), 5).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RerankerScoringError);
    const typed = error as RerankerScoringError;
    expect(typed.failed).toBe(5);
    expect(typed.total).toBe(5);
    expect(typed.outputLimit).toBe(true);
    expect(typed.message).toContain('Raise "maxTokens" in the reranker config (1024 tokens now)');
  });

  it('any other error is rethrown as it was', async () => {
    const boom = new Error('upstream 503');
    chat.mockRejectedValue(boom);
    await expect(llmListwiseStrategy.run(ctxOf(), 'query', docs(2), 2)).rejects.toBe(boom);
  });

  it('a full context window is rethrown as it was, not reported as an output limit', async () => {
    const full = new OutputTokenLimitError(1024, { rawFinishReason: CONTEXT_WINDOW_EXCEEDED_REASON });
    chat.mockRejectedValue(full);
    await expect(llmListwiseStrategy.run(ctxOf(), 'query', docs(2), 2)).rejects.toBe(full);
  });
});
